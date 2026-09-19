import type { EntityManager } from '@mikro-orm/postgresql'
import { add, gt, toDecimal, ZERO } from '../decimal'
import type { Decimal } from '../decimal'
import { resolveOccupancy } from '../components/warehouseCost'
import { loadCatalogSnapshot, tryResolve } from '../catalog'
import { loadInventorySnapshot, lotExpiryDate } from '../inventory'
import { PricingDeadstockDecision, PricingWarehouseCost } from '../../data/entities'
import type { CatalogProductSnapshot, ProductInventorySnapshot, WarehouseCostSnapshot } from '../types'
import { computeCarryingCost, monthsFromDays, type CarryingCost } from './carryingCost'
import { classifyDeadstock, type DeadstockAssessment } from './classify'
import { computeDeadstockMarkdown, recoverableAtFloor, type DeadstockMarkdown } from './markdown'
import {
  buildProductSalesMetrics,
  daysBetween,
  emptyProductSalesMetrics,
  groupSalesRowsByProduct,
  MS_PER_DAY,
  type DeadstockSalesRow,
  type ProductSalesMetrics,
} from './metrics'
import { isUndefinedTableError, reportMissingTableOnce } from './missingTable'
import { defaultDeadstockPolicy, type DeadstockPolicy } from './policy'

/**
 * How far back sales are read. Longer than a year on purpose: the seasonality test needs a full
 * cycle BEHIND the dormancy it is judging, and a 365-day window gives it none.
 */
export const DEFAULT_HISTORY_DAYS = 430

/**
 * Past this many stocked products the screen stops computing the whole catalogue in one pass.
 *
 * Sorting is by derived metrics, so the ranking cannot be pushed into SQL and every row has to be
 * built before any row can be ordered. The cap is a guard against that becoming a silent timeout on
 * a catalogue far larger than this distributor's 204 products; the response says it was applied.
 */
export const MAX_PRODUCTS = 5000

const ORDER_STATUSES_THAT_ARE_NOT_SALES = ['canceled', 'cancelled', 'rejected', 'draft']

export type DeadstockScope = { organizationId: string; tenantId: string }

export type DeadstockLoadOptions = {
  asOf?: Date
  historyDays?: number
  policy?: DeadstockPolicy
  /** Restricts the pass to these products. Used when one row is needed, not the whole catalogue. */
  productIds?: string[]
}

type CatalogProductRow = {
  id: string
  sku?: string | null
  title?: string | null
  launchAt?: Date | null
  isActive?: boolean | null
  deletedAt?: Date | null
}

type CatalogVariantRow = {
  id: string
  sku?: string | null
  isDefault?: boolean | null
  product?: { id?: string } | null
}

type SalesOrderRow = {
  id: string
  status?: string | null
  placedAt?: Date | null
  createdAt?: Date | null
  customerEntityId?: string | null
}

type SalesOrderLineRow = {
  id: string
  productId?: string | null
  quantity?: string | null
  totalNetAmount?: string | null
  order?: { id?: string } | null
}

type MovementRow = {
  catalogVariantId: string
  type?: string | null
  receivedAt?: Date | null
  performedAt?: Date | null
}

type ClassLike = new (...args: never[]) => unknown

/** Where the age of the stock came from, because the two sources disagree in seeded data. */
export type StockAgeSource = 'receipt_movement' | 'last_delivery' | 'unknown'

export type DeadstockPosition = {
  productId: string
  variantId: string | null
  sku: string | null
  title: string | null
  isActive: boolean
  onHandQuantity: Decimal
  unitCost: Decimal
  hasUnitCost: boolean
  stockAgeDays: number | null
  stockAgeSource: StockAgeSource
  nearestExpiryAt: Date | null
  metrics: ProductSalesMetrics
  assessment: DeadstockAssessment
  carrying: CarryingCost
  markdown: DeadstockMarkdown | null
  decision: PricingDeadstockDecision | null
}

export type DeadstockLoadResult = {
  positions: DeadstockPosition[]
  asOf: Date
  historyStartsAt: Date
  policy: DeadstockPolicy
  warehouse: WarehouseCostSnapshot | null
  /** True when the catalogue was larger than `MAX_PRODUCTS` and the tail was not computed. */
  truncated: boolean
  warnings: string[]
}

function warehouseSnapshotOf(rows: PricingWarehouseCost[], asOf: Date): WarehouseCostSnapshot | null {
  const applicable = rows
    .filter((row) => row.validFrom.getTime() <= asOf.getTime())
    .filter((row) => !row.validTo || row.validTo.getTime() > asOf.getTime())
    .sort((left, right) => right.validFrom.getTime() - left.validFrom.getTime())
  const row = applicable[0]
  if (!row) return null
  return {
    basis: row.basis,
    costPerMonth: row.costPerMonth,
    capitalCostAnnualRate: row.capitalCostAnnualRate,
    defaultTurnoverDays: row.defaultTurnoverDays,
  }
}

/**
 * The age of the stock on hand.
 *
 * The receipt movement is the right answer and is preferred. It is also, in seeded data, the same
 * value for every variant — the movement seeder writes a fixed cadence, so a uniform 28 days comes
 * out of a real column. The purchase position's last delivery is kept as a second source rather
 * than as a formality: on a deployment whose WMS never recorded a receipt it is the only date
 * there is, and production must not be the first time that path runs. Which one was used is
 * reported, so a suspicious figure can be traced to its source instead of to this function.
 */
function resolveStockAge(
  asOf: Date,
  receiptAt: Date | null,
  lastDeliveryAt: Date | null,
): { days: number | null; source: StockAgeSource } {
  if (receiptAt) return { days: Math.max(0, daysBetween(receiptAt, asOf)), source: 'receipt_movement' }
  if (lastDeliveryAt) return { days: Math.max(0, daysBetween(lastDeliveryAt, asOf)), source: 'last_delivery' }
  return { days: null, source: 'unknown' }
}

function nearestExpiryOf(stock: ProductInventorySnapshot | null): Date | null {
  if (!stock) return null
  let nearest: Date | null = null
  for (const lot of stock.lots) {
    const expiry = lotExpiryDate(lot)
    if (!expiry) continue
    if (!nearest || expiry.getTime() < nearest.getTime()) nearest = expiry
  }
  return nearest
}

function decisionInForce(decisions: PricingDeadstockDecision[], asOf: Date): PricingDeadstockDecision | null {
  const sorted = [...decisions].sort((left, right) => right.decidedAt.getTime() - left.decidedAt.getTime())
  return sorted[0] ?? null
}

function dismissedUntilOf(decision: PricingDeadstockDecision | null): Date | null {
  if (!decision || decision.verdict !== 'dismissed') return null
  // A dismissal without a review date is permanent by the operator's choice; represented as a date
  // far enough ahead that the comparison in `classifyDeadstock` stays a plain date comparison.
  return decision.reviewAt ?? new Date(8_640_000_000_000_000)
}

/**
 * Builds one row per stocked product: what it sold, what it is doing now, what keeping it costs and
 * how low it may go.
 *
 * Eight queries regardless of catalogue size. Reads every peer module through the entity classes
 * they register in DI, so a deployment without WMS or without sales still answers — with emptier
 * rows and the warnings that say why.
 */
export async function loadDeadstock(
  em: EntityManager,
  container: { resolve: (name: string) => unknown },
  scope: DeadstockScope,
  options: DeadstockLoadOptions = {},
): Promise<DeadstockLoadResult> {
  const asOf = options.asOf ?? new Date()
  const historyDays = options.historyDays ?? DEFAULT_HISTORY_DAYS
  const historyStartsAt = new Date(asOf.getTime() - historyDays * MS_PER_DAY)
  const policy = options.policy ?? defaultDeadstockPolicy()
  const warnings: string[] = []
  const scopeFilter = { tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null }

  const productClass = tryResolve<ClassLike>(container, 'CatalogProduct')
  if (!productClass) {
    return {
      positions: [],
      asOf,
      historyStartsAt,
      policy,
      warehouse: null,
      truncated: false,
      warnings: ['pricing_engine.deadstock.warnings.catalogUnavailable'],
    }
  }

  const requested = options.productIds ? Array.from(new Set(options.productIds.filter(Boolean))) : null
  const products = (await em.find(
    productClass,
    { ...scopeFilter, ...(requested ? { id: { $in: requested } } : {}) } as never,
    { limit: MAX_PRODUCTS + 1 } as never,
  )) as CatalogProductRow[]
  const truncated = products.length > MAX_PRODUCTS
  const scoped = truncated ? products.slice(0, MAX_PRODUCTS) : products
  if (truncated) warnings.push('pricing_engine.deadstock.warnings.catalogTruncated')

  const productIds = scoped.map((product) => product.id)
  if (productIds.length === 0) {
    return { positions: [], asOf, historyStartsAt, policy, warehouse: null, truncated, warnings }
  }

  const variantClass = tryResolve<ClassLike>(container, 'CatalogProductVariant')
  const variants = variantClass
    ? ((await em.find(variantClass, {
        ...scopeFilter,
        product: { $in: productIds },
      } as never)) as CatalogVariantRow[])
    : []

  const variantIdByProductId = new Map<string, string>()
  const productIdByVariantId = new Map<string, string>()
  for (const variant of variants) {
    const owner = variant.product?.id
    if (!owner) continue
    productIdByVariantId.set(variant.id, owner)
    const current = variantIdByProductId.get(owner)
    if (!current || variant.isDefault) variantIdByProductId.set(owner, variant.id)
  }

  // Set when the decisions table is not there yet, so the response can say the column is blank for
  // a reason rather than showing an empty Decision cell that looks like nobody has judged anything.
  let decisionsTableMissing = false

  const [catalog, inventory, warehouseRows, decisionRows] = await Promise.all([
    loadCatalogSnapshot(em, container, scope, productIds),
    loadInventorySnapshot(em, container, scope, productIds, variantIdByProductId, { asOf }),
    em.find(PricingWarehouseCost, { ...scopeFilter } as never),
    // Same tolerance as the pricing path: without the table there are no decisions, and every
    // other figure on this screen — rotation, carrying cost, the floor — is still worth showing.
    em
      .find(PricingDeadstockDecision, { ...scopeFilter, catalogProductId: { $in: productIds } } as never)
      .catch((error: unknown) => {
        if (!isUndefinedTableError(error)) throw error
        reportMissingTableOnce('pricing_deadstock_decisions')
        decisionsTableMissing = true
        return [] as PricingDeadstockDecision[]
      }),
  ])

  const warehouse = warehouseSnapshotOf(warehouseRows, asOf)
  if (!warehouse) warnings.push('pricing_engine.deadstock.warnings.warehouseCostMissing')
  if (decisionsTableMissing) warnings.push('pricing_engine.deadstock.warnings.decisionsUnavailable')

  const salesRowsByProduct = await loadSalesRows(em, container, scope, productIds, historyStartsAt)
  const receiptByVariant = await loadReceiptRange(em, container, scope, Array.from(productIdByVariantId.keys()))

  const decisionsByProduct = new Map<string, PricingDeadstockDecision[]>()
  for (const decision of decisionRows) {
    const bucket = decisionsByProduct.get(decision.catalogProductId) ?? []
    bucket.push(decision)
    decisionsByProduct.set(decision.catalogProductId, bucket)
  }

  const positions: DeadstockPosition[] = []
  for (const product of scoped) {
    const snapshot: CatalogProductSnapshot | null = catalog.byProductId.get(product.id) ?? null
    const stock = inventory.byProductId.get(product.id) ?? null
    const onHandQuantity = stock ? toDecimal(stock.rotation.onHandQuantity) : ZERO

    const purchase = snapshot?.purchase ?? null
    const unitCost = toDecimal(purchase?.lastDeliveryUnitCost ?? '0')
    const hasUnitCost = gt(unitCost, ZERO)

    const rows = salesRowsByProduct.get(product.id) ?? []
    const metrics =
      rows.length === 0
        ? emptyProductSalesMetrics(product.id)
        : buildProductSalesMetrics(product.id, { rows, asOf, trendDays: policy.dyingAfterDays })

    let latestReceipt: Date | null = null
    let firstReceipt: Date | null = null
    for (const variantId of stock?.variantIds ?? []) {
      const received = receiptByVariant.get(variantId)
      if (!received) continue
      if (!latestReceipt || received.last.getTime() > latestReceipt.getTime()) latestReceipt = received.last
      if (!firstReceipt || received.first.getTime() < firstReceipt.getTime()) firstReceipt = received.first
    }
    const stockAge = resolveStockAge(asOf, latestReceipt, purchase?.lastDeliveryAt ?? null)

    const decision = decisionInForce(decisionsByProduct.get(product.id) ?? [], asOf)

    const assessment = classifyDeadstock({
      metrics,
      onHandQuantity,
      policy,
      asOf,
      historyStartsAt,
      // The FIRST receipt, deliberately: this dates how long the product has been sellable, not how
      // long the current pile has stood. The latest receipt belongs to the carrying cost above.
      //
      // And NO fallback to `lastDeliveryAt`. It is the LAST delivery by definition, so using it as
      // the start of the availability clock repeats the very bug this line fixes — a regularly
      // restocked product would read as permanently new. Where there is no receipt history the
      // answer is "unknown", which `classifyDeadstock` handles by letting the verdict through.
      stockSince: firstReceipt,
      launchAt: product.launchAt ?? null,
      dismissedUntil: dismissedUntilOf(decision),
    })

    const occupancy = warehouse ? resolveOccupancy(warehouse, snapshot, null) : null
    const carrying = computeCarryingCost({
      onHandQuantity,
      unitCost,
      occupancyShare: occupancy?.share ?? ZERO,
      warehouse,
      monthsOnHand: monthsFromDays(stockAge.days),
    })

    const markdown = hasUnitCost
      ? computeDeadstockMarkdown({
          productClass: assessment.productClass,
          suppression: assessment.suppression,
          // No quote is being priced here, so there is no accumulated cost to serve. Purchase cost
          // stands in for both, and the `dying` rung is therefore measured against the purchase
          // price rather than against a delivered cost this screen cannot know.
          unitCostNet: unitCost,
          purchaseUnitCost: unitCost,
          onHandQuantity,
          carrying,
          policy,
        })
      : null

    if (!hasUnitCost && gt(onHandQuantity, ZERO)) {
      warnings.push('pricing_engine.deadstock.warnings.purchaseCostMissing')
    }

    positions.push({
      productId: product.id,
      variantId: variantIdByProductId.get(product.id) ?? null,
      sku: product.sku ?? snapshot?.sku ?? null,
      title: product.title ?? snapshot?.title ?? null,
      isActive: product.isActive !== false,
      onHandQuantity,
      unitCost,
      hasUnitCost,
      stockAgeDays: stockAge.days,
      stockAgeSource: stockAge.source,
      nearestExpiryAt: nearestExpiryOf(stock),
      metrics,
      assessment,
      carrying,
      markdown,
      decision,
    })
  }

  return {
    positions,
    asOf,
    historyStartsAt,
    policy,
    warehouse,
    truncated,
    warnings: Array.from(new Set(warnings)),
  }
}

/**
 * Sold lines per product, read through the classes the sales module registers in DI.
 *
 * Orders first, then their lines, rather than one populated query: the relation would drag every
 * order column into memory once per line, and the order set is fourteen months of a distributor's
 * trading. Cancelled, rejected and draft orders are excluded — they are intentions, not sales, and
 * counting them would make a product look alive because somebody once started a basket.
 */
async function loadSalesRows(
  em: EntityManager,
  container: { resolve: (name: string) => unknown },
  scope: DeadstockScope,
  productIds: string[],
  since: Date,
): Promise<Map<string, DeadstockSalesRow[]>> {
  const orderClass = tryResolve<ClassLike>(container, 'SalesOrder')
  const lineClass = tryResolve<ClassLike>(container, 'SalesOrderLine')
  if (!orderClass || !lineClass) return new Map()

  const scopeFilter = { tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null }

  const orders = (await em.find(orderClass, {
    ...scopeFilter,
    $or: [{ placedAt: { $gte: since } }, { placedAt: null, createdAt: { $gte: since } }],
  } as never)) as SalesOrderRow[]

  const usable = orders.filter(
    (order) => !ORDER_STATUSES_THAT_ARE_NOT_SALES.includes((order.status ?? '').toLowerCase()),
  )
  if (usable.length === 0) return new Map()

  const orderById = new Map<string, SalesOrderRow>()
  for (const order of usable) orderById.set(order.id, order)

  const lines = (await em.find(lineClass, {
    ...scopeFilter,
    kind: 'product',
    order: { $in: Array.from(orderById.keys()) },
    productId: { $in: productIds },
  } as never)) as SalesOrderLineRow[]

  const rows: DeadstockSalesRow[] = []
  for (const line of lines) {
    const orderId = line.order?.id
    const productId = line.productId
    if (!orderId || !productId) continue
    const order = orderById.get(orderId)
    if (!order) continue
    const occurredAt = order.placedAt ?? order.createdAt ?? null
    if (!occurredAt) continue
    rows.push({
      productId,
      orderId,
      customerId: order.customerEntityId ?? null,
      occurredAt,
      quantity: line.quantity ?? '0',
      revenueNet: line.totalNetAmount ?? '0',
    })
  }

  return groupSalesRowsByProduct(rows)
}

/**
 * Latest receipt per variant.
 *
 * Separate from `loadInventorySnapshot`, which reads movements only inside the 180-day rotation
 * window and only to net issues. Stock old enough to be deadstock was received before that window
 * opened, so the query that finds its age has to look further back than the query that measures its
 * rotation.
 */
async function loadReceiptRange(
  em: EntityManager,
  container: { resolve: (name: string) => unknown },
  scope: DeadstockScope,
  variantIds: string[],
): Promise<Map<string, { first: Date; last: Date }>> {
  const range = new Map<string, { first: Date; last: Date }>()
  if (variantIds.length === 0) return range

  const movementClass = tryResolve<ClassLike>(container, 'InventoryMovement')
  if (!movementClass) return range

  const movements = (await em.find(movementClass, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
    type: 'receipt',
    catalogVariantId: { $in: variantIds },
  } as never)) as MovementRow[]

  // Both ends, because they answer different questions: the FIRST receipt says how long the product
  // has been sellable at all, the LAST says how long the pile currently standing there has stood.
  for (const movement of movements) {
    const at = movement.receivedAt ?? movement.performedAt ?? null
    if (!at) continue
    const current = range.get(movement.catalogVariantId)
    if (!current) {
      range.set(movement.catalogVariantId, { first: at, last: at })
      continue
    }
    if (at.getTime() < current.first.getTime()) current.first = at
    if (at.getTime() > current.last.getTime()) current.last = at
  }

  return range
}

export function totalsOf(positions: DeadstockPosition[]): {
  tiedCapital: Decimal
  monthlyCarry: Decimal
  recoverableAtFloor: Decimal
  atRiskCount: number
} {
  let tiedCapital = ZERO
  let monthlyCarry = ZERO
  let recoverable = ZERO
  let atRiskCount = 0
  for (const position of positions) {
    if (!position.markdown) continue
    atRiskCount += 1
    tiedCapital = add(tiedCapital, position.carrying.tiedCapital)
    monthlyCarry = add(monthlyCarry, position.carrying.positionPerMonth)
    recoverable = add(recoverable, recoverableAtFloor(position.markdown, position.onHandQuantity))
  }
  return { tiedCapital, monthlyCarry, recoverableAtFloor: recoverable, atRiskCount }
}
