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

/** Above this many ids an `in (...)` list costs more to parse than it saves in rows. */
const PRODUCT_ID_FILTER_LIMIT = 500

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
  /**
   * Products in the catalogue, whether or not any of them is stocked.
   *
   * Positions are built only for stocked products (see `resolveStockedProductIds`), so the count
   * of positions no longer answers "how big is the catalogue" and the screen needs both numbers.
   */
  catalogCount: number
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
      catalogCount: 0,
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

  const catalogCount = scoped.length

  // Deadstock is a question about capital sitting on a shelf, so only stocked products can answer
  // it. Building a full position for every product in the catalogue meant loading the sales,
  // receipts and snapshots of ~2 600 products that hold nothing — on the reference tenant 1 494
  // variants carry stock out of 4 105. Where the warehouse module is absent, or the caller named
  // products explicitly, nothing is narrowed and the behaviour is what it always was.
  const stockedProductIds = requested ? null : await resolveStockedProductIds(em, container, scope)
  const stockedProducts = stockedProductIds
    ? scoped.filter((product) => stockedProductIds.has(product.id))
    : scoped

  const productIds = stockedProducts.map((product) => product.id)
  if (productIds.length === 0) {
    return { positions: [], asOf, historyStartsAt, policy, warehouse: null, truncated, catalogCount, warnings }
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
  for (const product of stockedProducts) {
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
    catalogCount,
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

  const tables = resolveSalesTableNames(em, orderClass, lineClass)
  if (tables) return loadSalesRowsFromSql(em, scope, productIds, since, tables)
  return loadSalesRowsThroughOrm(em, orderClass, lineClass, scope, productIds, since)
}

/**
 * Table names for the sales entities, read off the ORM metadata rather than written here.
 *
 * The classes themselves still come from DI (`tryResolve` above), so a build without the sales
 * module keeps behaving as it always did — no orders, no rows. This only avoids hard-coding the
 * names of another module's tables while the rows are read as plain SQL.
 */
/**
 * Products that hold stock right now.
 *
 * Matches the route's own definition of "stocked" — `onHandQuantity !== '0.0000'` — which sums
 * `quantity_on_hand` across the product's balance rows and does not subtract reservations. A
 * negative sum counts: it is a real position that needs looking at, not an empty shelf.
 *
 * Returns null when the warehouse tables cannot be named, so the caller keeps the whole catalogue
 * rather than silently reporting an empty warehouse.
 *
 * Exported for its own tests: this decides which products reach the screen at all.
 */
export async function resolveStockedProductIds(
  em: EntityManager,
  container: { resolve: (name: string) => unknown },
  scope: DeadstockScope,
): Promise<Set<string> | null> {
  const balanceClass = tryResolve<ClassLike>(container, 'InventoryBalance')
  const variantClass = tryResolve<ClassLike>(container, 'CatalogProductVariant')
  if (!balanceClass || !variantClass) return null
  const balances = resolveTableName(em, balanceClass)
  const variants = resolveTableName(em, variantClass)
  if (!balances || !variants) return null

  try {
    const rows = await em.getConnection().execute<Array<{ product_id: string | null }>>(
      `select v.product_id as product_id
       from ${balances} b
       join ${variants} v
         on v.id = b.catalog_variant_id
        and v.deleted_at is null
       where b.organization_id = ?
         and b.tenant_id = ?
         and b.deleted_at is null
       group by v.product_id
       having sum(coalesce(b.quantity_on_hand, 0)) <> 0`,
      [scope.organizationId, scope.tenantId],
    )
    const ids = new Set<string>()
    for (const row of rows) if (row.product_id) ids.add(row.product_id)
    return ids
  } catch {
    return null
  }
}

function resolveTableName(em: EntityManager, entityClass: ClassLike): string | null {
  try {
    const metadata = (em as unknown as {
      getMetadata?: () => { find?: (name: string) => { tableName?: string } | undefined }
    }).getMetadata?.()
    const table = metadata?.find?.(entityClass.name)?.tableName
    return typeof table === 'string' && table ? table : null
  } catch {
    return null
  }
}

function resolveSalesTableNames(
  em: EntityManager,
  orderClass: ClassLike,
  lineClass: ClassLike,
): { orders: string; lines: string } | null {
  const orders = resolveTableName(em, orderClass)
  const lines = resolveTableName(em, lineClass)
  return orders && lines ? { orders, lines } : null
}

type ReceiptRangeSqlRow = {
  catalog_variant_id: string | null
  first_at: Date | string | null
  last_at: Date | string | null
}

/**
 * The same two ends, aggregated by the database.
 *
 * Every receipt movement of every variant used to be hydrated to compute a min and a max —
 * 34 290 entities on the reference tenant for roughly 4 000 answers.
 */
export async function loadReceiptRangeFromSql(
  em: EntityManager,
  scope: DeadstockScope,
  variantIds: string[],
  table: string,
): Promise<Map<string, { first: Date; last: Date }>> {
  const range = new Map<string, { first: Date; last: Date }>()
  if (variantIds.length === 0) return range
  const wanted = new Set(variantIds)
  const narrow = variantIds.length <= PRODUCT_ID_FILTER_LIMIT
  const variantFilter = narrow
    ? ` and m.catalog_variant_id in (${variantIds.map(() => '?').join(', ')})`
    : ''

  const rows = await em.getConnection().execute<ReceiptRangeSqlRow[]>(
    `select m.catalog_variant_id as catalog_variant_id,
            min(coalesce(m.received_at, m.performed_at)) as first_at,
            max(coalesce(m.received_at, m.performed_at)) as last_at
     from ${table} m
     where m.organization_id = ?
       and m.tenant_id = ?
       and m.deleted_at is null
       and m.type = 'receipt'
       and m.catalog_variant_id is not null
       and coalesce(m.received_at, m.performed_at) is not null${variantFilter}
     group by m.catalog_variant_id`,
    [scope.organizationId, scope.tenantId, ...(narrow ? variantIds : [])],
  )

  for (const row of rows) {
    if (!row.catalog_variant_id) continue
    if (!narrow && !wanted.has(row.catalog_variant_id)) continue
    const first = toDateOrNull(row.first_at)
    const last = toDateOrNull(row.last_at)
    if (!first || !last) continue
    range.set(row.catalog_variant_id, { first, last })
  }
  return range
}

function toDateOrNull(value: Date | string | null): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

type SalesSqlRow = {
  product_id: string | null
  order_id: string | null
  customer_entity_id: string | null
  occurred_at: Date | string | null
  quantity: string | number | null
  total_net_amount: string | number | null
}

/**
 * One statement, plain rows.
 *
 * The ORM path below hydrates an entity per order and per line — fourteen months of a
 * distributor's trading is 6.5k orders and 87k lines on the reference tenant, and building that
 * many managed entities (plus their identity map) is what made this screen hold a pool connection
 * for twenty seconds and starve the rest of the dashboard. `computeSalesMetrics` only ever reads
 * the six fields below.
 *
 * Exported for its own tests: the statement decides which orders count as sales and which rows
 * reach the metrics, and it is not reachable from `loadDeadstockPositions` without standing up
 * the catalogue and inventory loaders too.
 */
export async function loadSalesRowsFromSql(
  em: EntityManager,
  scope: DeadstockScope,
  productIds: string[],
  since: Date,
  tables: { orders: string; lines: string },
): Promise<Map<string, DeadstockSalesRow[]>> {
  if (productIds.length === 0) return new Map()
  const wanted = new Set(productIds)
  const statusPlaceholders = ORDER_STATUSES_THAT_ARE_NOT_SALES.map(() => '?').join(', ')
  // Narrowing by product id pays only while the list is short. Asked for the whole catalogue it
  // would be thousands of placeholders for a filter that excludes nothing, so the set does the
  // work in the loop below instead.
  const narrowByProduct = productIds.length <= PRODUCT_ID_FILTER_LIMIT
  const productFilter = narrowByProduct
    ? ` and l.product_id in (${productIds.map(() => '?').join(', ')})`
    : ' and l.product_id is not null'
  const rows = await em.getConnection().execute<SalesSqlRow[]>(
    `select l.product_id as product_id,
            o.id as order_id,
            o.customer_entity_id as customer_entity_id,
            coalesce(o.placed_at, o.created_at) as occurred_at,
            l.quantity as quantity,
            l.total_net_amount as total_net_amount
     from ${tables.orders} o
     join ${tables.lines} l
       on l.order_id = o.id
      and l.organization_id = o.organization_id
      and l.tenant_id = o.tenant_id
      and l.deleted_at is null
      and l.kind = 'product'
     where o.organization_id = ?
       and o.tenant_id = ?
       and o.deleted_at is null
       and lower(coalesce(o.status, '')) not in (${statusPlaceholders})
       and coalesce(o.placed_at, o.created_at) >= ?${productFilter}`,
    [
      scope.organizationId,
      scope.tenantId,
      ...ORDER_STATUSES_THAT_ARE_NOT_SALES,
      since,
      ...(narrowByProduct ? productIds : []),
    ],
  )

  const collected: DeadstockSalesRow[] = []
  for (const row of rows) {
    if (!row.product_id || !row.order_id || !row.occurred_at) continue
    if (!narrowByProduct && !wanted.has(row.product_id)) continue
    const occurredAt = row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at)
    if (!Number.isFinite(occurredAt.getTime())) continue
    collected.push({
      productId: row.product_id,
      orderId: row.order_id,
      customerId: row.customer_entity_id ?? null,
      occurredAt,
      quantity: row.quantity === null || row.quantity === undefined ? '0' : String(row.quantity),
      revenueNet:
        row.total_net_amount === null || row.total_net_amount === undefined
          ? '0'
          : String(row.total_net_amount),
    })
  }
  return groupSalesRowsByProduct(collected)
}

/** Kept for a container whose ORM metadata cannot name the sales tables. */
async function loadSalesRowsThroughOrm(
  em: EntityManager,
  orderClass: ClassLike,
  lineClass: ClassLike,
  scope: DeadstockScope,
  productIds: string[],
  since: Date,
): Promise<Map<string, DeadstockSalesRow[]>> {
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

  const table = resolveTableName(em, movementClass)
  if (table) return loadReceiptRangeFromSql(em, scope, variantIds, table)

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
