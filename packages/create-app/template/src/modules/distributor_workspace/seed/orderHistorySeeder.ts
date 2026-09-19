/**
 * Writes a plausible order history for the seeded HoReCa customers.
 *
 * The forecast engine needs something to find. The database ships with five orders, which is not
 * enough for any recurrence detector to say anything honest, so this seeder manufactures the
 * history a distributor would already have — and then gets out of the way: it writes ordinary
 * `sales_orders` / `sales_order_lines` rows through the sales module's own entities, so an ERP
 * import that lands in the same tables is indistinguishable to everything downstream.
 *
 * Three properties make the output worth trusting as a test of the detector rather than a
 * rehearsal of it:
 *
 * - **Deterministic, not fixed.** Every random choice comes from a PRNG seeded with the customer
 *   handle, so a rerun reproduces the same history exactly while the forty customers still differ
 *   from one another in weekday, interval, product selection and basket size.
 * - **Imperfect on purpose.** Deliveries slip a day, cycles get skipped, quantities move with the
 *   season. A history of perfectly spaced identical orders would prove only that the detector can
 *   read a metronome.
 * - **Salted with noise.** Every run plants one-off purchases that look like the opening of a
 *   pattern and must never be predicted. The report counts them, so a run can be checked against
 *   what the forecast subsequently refuses to show.
 *
 * Idempotent: each order carries `external_reference = horeca-history:<handle>:<date>`, and a
 * rerun skips the references that already exist rather than duplicating a day.
 */

import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { SalesOrder, SalesOrderLine } from '@open-mercato/core/modules/sales/data/entities'
import { HORECA_CUSTOMERS, type HorecaCustomerSeed } from './horecaCustomerData'
import { HORECA_SOURCE_PREFIX } from './customerSeeder'
import {
  DISCONTINUED_ORDER_PROBABILITY,
  DISCONTINUED_POOL_CATEGORIES,
  DISCONTINUED_WINDOW_FRACTION,
  MONTHLY_DEMAND_INDEX,
  ORDER_INTERVAL_VARIANTS,
  RESERVED_POOL_SIZE,
  SEASONAL_MONTH_SETS,
  SEASONAL_ORDER_PROBABILITY,
  SEASONAL_POOL_CATEGORIES,
  WEEKDAY_OFFSETS,
  orderProfileFor,
  type StandingLineSeed,
} from './orderHistoryData'
import { bump, emptyReport, type DistributorSeedScope, type SeedReport, type SeedRunOptions } from './types'

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const DEFAULT_HISTORY_MONTHS = 14
const DAYS_PER_MONTH = 30
const HISTORY_REFERENCE_PREFIX = 'horeca-history:'
const CURRENCY_CODE = 'PLN'
const TAX_RATE = 0.23

/** Orders newer than this are still moving through the warehouse; everything older is closed. */
const FULFILMENT_LAG_DAYS = 3
const PAYMENT_LAG_DAYS = 10

type CatalogRow = {
  slug: string
  product_id: string
  variant_id: string
  title: string
  sku: string | null
  default_unit: string | null
  unit_price_net: string | null
}

type CatalogProduct = {
  productId: string
  variantId: string
  title: string
  sku: string | null
  unit: string
  unitPriceNet: number
}

type CustomerRow = {
  id: string
  source: string
}

type LineOrigin = 'standing' | 'noise' | 'discontinued' | 'seasonal'

type PlannedLine = {
  product: CatalogProduct
  quantity: number
  origin: LineOrigin
}

/**
 * Products taken off the shared catalog and given a lifecycle of their own.
 *
 * Carved out ONCE for the whole run and removed from the ordinary pools, because a product only
 * one customer stopped buying is not a discontinued product — somebody else still orders it. The
 * seasonal entries carry the months they sell in, so a run produces a product that is genuinely
 * absent from the data for most of the year rather than merely rare.
 */
type ReservedPools = {
  discontinued: CatalogProduct[]
  seasonal: Array<{ product: CatalogProduct; months: number[] }>
}

export function carveReservedPools(catalogByCategory: Map<string, CatalogProduct[]>): ReservedPools {
  const discontinued: CatalogProduct[] = []
  const seasonal: Array<{ product: CatalogProduct; months: number[] }> = []

  for (const slug of DISCONTINUED_POOL_CATEGORIES) {
    const bucket = catalogByCategory.get(slug)
    if (!bucket || bucket.length <= RESERVED_POOL_SIZE) continue
    discontinued.push(...bucket.splice(bucket.length - RESERVED_POOL_SIZE, RESERVED_POOL_SIZE))
  }

  let seasonalSlot = 0
  for (const slug of SEASONAL_POOL_CATEGORIES) {
    const bucket = catalogByCategory.get(slug)
    if (!bucket || bucket.length <= RESERVED_POOL_SIZE) continue
    for (const product of bucket.splice(bucket.length - RESERVED_POOL_SIZE, RESERVED_POOL_SIZE)) {
      const months = SEASONAL_MONTH_SETS[seasonalSlot % SEASONAL_MONTH_SETS.length] ?? []
      seasonal.push({ product, months })
      seasonalSlot += 1
    }
  }

  return { discontinued, seasonal }
}

type PlannedOrder = {
  placedAt: Date
  externalReference: string
  orderNumber: string
  lines: PlannedLine[]
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * mulberry32 — a 32-bit PRNG chosen for being short enough to read and stable across Node versions,
 * which `Math.random` is not. Seeding it from the customer handle is what makes a rerun of this
 * seeder reproduce byte-identical history.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state)
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4294967296
  }
}

function toDayStart(value: Date): number {
  return Math.floor(value.getTime() / MILLISECONDS_PER_DAY) * MILLISECONDS_PER_DAY
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function weekdayOf(ms: number): number {
  const jsDay = new Date(ms).getUTCDay()
  return jsDay === 0 ? 7 : jsDay
}

function normaliseWeekday(weekday: number): number {
  const wrapped = ((weekday - 1) % 7 + 7) % 7
  return wrapped + 1
}

function pick<T>(items: T[], random: () => number): T {
  return items[Math.floor(random() * items.length) % items.length] as T
}

function toAmount(value: number): string {
  return value.toFixed(4)
}

async function loadCatalogByCategory(
  em: EntityManager,
  scope: DistributorSeedScope,
  slugs: string[],
): Promise<Map<string, CatalogProduct[]>> {
  const byCategory = new Map<string, CatalogProduct[]>()
  if (slugs.length === 0) return byCategory

  const placeholders = slugs.map(() => '?').join(', ')
  const rows = await em.getConnection().execute<CatalogRow[]>(
    `select c.slug as slug,
            p.id as product_id,
            v.id as variant_id,
            p.title as title,
            p.sku as sku,
            p.default_unit as default_unit,
            vp.unit_price_net as unit_price_net
     from catalog_product_categories c
     join catalog_product_category_assignments a
       on a.category_id = c.id
      and a.organization_id = c.organization_id
      and a.tenant_id = c.tenant_id
     join catalog_products p
       on p.id = a.product_id
      and p.deleted_at is null
      and p.is_active = true
     join catalog_product_variants v
       on v.product_id = p.id
      and v.is_default = true
      and v.deleted_at is null
     left join catalog_product_variant_prices vp
       on vp.variant_id = v.id
      and vp.currency_code = ?
      and vp.min_quantity = 1
     where c.organization_id = ?
       and c.tenant_id = ?
       and c.deleted_at is null
       and c.slug in (${placeholders})
     order by c.slug, p.title`,
    [CURRENCY_CODE, scope.organizationId, scope.tenantId, ...slugs],
  )

  for (const row of rows) {
    const unitPriceNet = row.unit_price_net === null ? Number.NaN : Number(row.unit_price_net)
    if (!Number.isFinite(unitPriceNet) || unitPriceNet <= 0) continue
    const bucket = byCategory.get(row.slug) ?? []
    bucket.push({
      productId: row.product_id,
      variantId: row.variant_id,
      title: row.title,
      sku: row.sku,
      unit: row.default_unit ?? 'pc',
      unitPriceNet,
    })
    byCategory.set(row.slug, bucket)
  }
  return byCategory
}

async function loadHorecaCustomerIds(
  em: EntityManager,
  scope: DistributorSeedScope,
): Promise<Map<string, string>> {
  const rows = await em.getConnection().execute<CustomerRow[]>(
    `select id, source
     from customer_entities
     where organization_id = ?
       and tenant_id = ?
       and deleted_at is null
       and source like ?`,
    [scope.organizationId, scope.tenantId, `${HORECA_SOURCE_PREFIX}%`],
  )
  const byHandle = new Map<string, string>()
  for (const row of rows) {
    byHandle.set(row.source.slice(HORECA_SOURCE_PREFIX.length), row.id)
  }
  return byHandle
}

async function loadExistingReferences(
  em: EntityManager,
  scope: DistributorSeedScope,
): Promise<Set<string>> {
  const rows = await em.getConnection().execute<Array<{ external_reference: string }>>(
    `select external_reference
     from sales_orders
     where organization_id = ?
       and tenant_id = ?
       and external_reference like ?`,
    [scope.organizationId, scope.tenantId, `${HISTORY_REFERENCE_PREFIX}%`],
  )
  return new Set(rows.map((row) => row.external_reference))
}

function orderNumberFor(handle: string, dateIso: string): string {
  const compactHandle = handle.replace(/[^a-z0-9]/gi, '').slice(-12).toUpperCase()
  return `HH-${compactHandle}-${dateIso.replace(/-/g, '')}`
}

type CustomerPlanInput = {
  seed: HorecaCustomerSeed
  catalogByCategory: Map<string, CatalogProduct[]>
  reserved: ReservedPools
  historyStartMs: number
  historyEndMs: number
}

type CustomerPlan = {
  orders: PlannedOrder[]
  noiseLines: number
  discontinuedLines: number
  seasonalLines: number
  standingProducts: number
}

/**
 * Turns one customer's profile into a concrete list of orders.
 *
 * The slot counter advances on every delivery window whether or not an order is emitted, so a
 * skipped week does not shift the phase of the monthly lines that ride on it — the same way a
 * customer who misses a Monday still buys gloves in the first week of the month.
 */
export function planCustomerHistory(input: CustomerPlanInput): CustomerPlan {
  const { seed, catalogByCategory, reserved, historyStartMs, historyEndMs } = input
  const profile = orderProfileFor(seed.segment)
  const random = mulberry32(hashString(seed.handle))

  const intervalDays = pick([...ORDER_INTERVAL_VARIANTS], random)
  const weekday = normaliseWeekday(profile.preferredWeekday + pick([...WEEKDAY_OFFSETS], random))
  const demandIndex = MONTHLY_DEMAND_INDEX[seed.segment]

  const standingProducts = new Map<StandingLineSeed, { product: CatalogProduct; phase: number }>()
  for (const line of profile.standingLines) {
    const candidates = catalogByCategory.get(line.categorySlug)
    if (!candidates || candidates.length === 0) continue
    standingProducts.set(line, {
      product: pick(candidates, random),
      phase: Math.floor(random() * line.everyNthOrder),
    })
  }

  const noisePool: CatalogProduct[] = []
  for (const slug of profile.noiseCategorySlugs) {
    noisePool.push(...(catalogByCategory.get(slug) ?? []))
  }

  let firstSlotMs = historyStartMs
  while (weekdayOf(firstSlotMs) !== weekday) {
    firstSlotMs += MILLISECONDS_PER_DAY
  }

  const discontinuedCutoffMs =
    historyStartMs + (historyEndMs - historyStartMs) * DISCONTINUED_WINDOW_FRACTION
  const discontinuedChoice =
    reserved.discontinued.length > 0 ? pick(reserved.discontinued, random) : null
  const seasonalChoice = reserved.seasonal.length > 0 ? pick(reserved.seasonal, random) : null

  const orders: PlannedOrder[] = []
  let noiseLines = 0
  let discontinuedLines = 0
  let seasonalLines = 0
  let slotIndex = 0

  for (let slotMs = firstSlotMs; slotMs <= historyEndMs; slotMs += intervalDays * MILLISECONDS_PER_DAY) {
    const currentSlot = slotIndex
    slotIndex += 1
    if (random() < profile.skipOrderProbability) continue

    const jitter =
      profile.orderDayJitterDays === 0
        ? 0
        : Math.round((random() * 2 - 1) * profile.orderDayJitterDays)
    const placedMs = slotMs + jitter * MILLISECONDS_PER_DAY
    if (placedMs < historyStartMs || placedMs > historyEndMs) continue

    const monthIndex = new Date(placedMs).getUTCMonth()
    const seasonalFactor = demandIndex[monthIndex] ?? 1
    const lines: PlannedLine[] = []

    for (const [line, assignment] of standingProducts) {
      if ((currentSlot - assignment.phase) % line.everyNthOrder !== 0) continue
      if (random() < line.skipProbability) continue
      const wobble = 1 + (random() * 2 - 1) * line.quantityJitter
      const quantity = Math.max(1, Math.round(line.quantityBase * wobble * seasonalFactor))
      lines.push({ product: assignment.product, quantity, origin: 'standing' })
    }

    if (discontinuedChoice && placedMs <= discontinuedCutoffMs && random() < DISCONTINUED_ORDER_PROBABILITY) {
      lines.push({
        product: discontinuedChoice,
        quantity: 1 + Math.floor(random() * 5),
        origin: 'discontinued',
      })
      discontinuedLines += 1
    }

    if (seasonalChoice && seasonalChoice.months.includes(monthIndex) && random() < SEASONAL_ORDER_PROBABILITY) {
      lines.push({
        product: seasonalChoice.product,
        quantity: 3 + Math.floor(random() * 12),
        origin: 'seasonal',
      })
      seasonalLines += 1
    }

    if (noisePool.length > 0 && random() < profile.noiseOrderProbability) {
      const noiseCount = 1 + Math.floor(random() * profile.maxNoiseLinesPerOrder)
      for (let index = 0; index < noiseCount; index += 1) {
        const product = pick(noisePool, random)
        if (lines.some((existing) => existing.product.variantId === product.variantId)) continue
        lines.push({ product, quantity: 1 + Math.floor(random() * 4), origin: 'noise' })
        noiseLines += 1
      }
    }

    if (lines.length === 0) continue

    const dateIso = isoDate(placedMs)
    orders.push({
      placedAt: new Date(placedMs + 9 * 60 * 60 * 1000),
      externalReference: `${HISTORY_REFERENCE_PREFIX}${seed.handle}:${dateIso}`,
      orderNumber: orderNumberFor(seed.handle, dateIso),
      lines,
    })
  }

  return { orders, noiseLines, discontinuedLines, seasonalLines, standingProducts: standingProducts.size }
}

function resolveStatuses(placedAtMs: number, nowMs: number): {
  status: string
  fulfillmentStatus: string
  paymentStatus: string
} {
  const ageDays = (nowMs - placedAtMs) / MILLISECONDS_PER_DAY
  if (ageDays >= PAYMENT_LAG_DAYS) {
    return { status: 'confirmed', fulfillmentStatus: 'fulfilled', paymentStatus: 'paid' }
  }
  if (ageDays >= FULFILMENT_LAG_DAYS) {
    return { status: 'confirmed', fulfillmentStatus: 'fulfilled', paymentStatus: 'partial' }
  }
  return { status: 'confirmed', fulfillmentStatus: 'pending', paymentStatus: 'unpaid' }
}

function writeOrder(
  em: EntityManager,
  scope: DistributorSeedScope,
  customerEntityId: string,
  planned: PlannedOrder,
  nowMs: number,
): void {
  const placedAtMs = planned.placedAt.getTime()
  const statuses = resolveStatuses(placedAtMs, nowMs)

  let subtotalNet = 0
  for (const line of planned.lines) {
    subtotalNet += line.product.unitPriceNet * line.quantity
  }
  const taxTotal = subtotalNet * TAX_RATE
  const grandTotalGross = subtotalNet + taxTotal
  const paidTotal = statuses.paymentStatus === 'paid' ? grandTotalGross : 0

  const order = em.create(SalesOrder, {
    id: randomUUID(),
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    orderNumber: planned.orderNumber,
    externalReference: planned.externalReference,
    customerEntityId,
    currencyCode: CURRENCY_CODE,
    status: statuses.status,
    fulfillmentStatus: statuses.fulfillmentStatus,
    paymentStatus: statuses.paymentStatus,
    placedAt: planned.placedAt,
    expectedDeliveryAt: new Date(placedAtMs + MILLISECONDS_PER_DAY),
    subtotalNetAmount: toAmount(subtotalNet),
    subtotalGrossAmount: toAmount(grandTotalGross),
    discountTotalAmount: '0',
    taxTotalAmount: toAmount(taxTotal),
    shippingNetAmount: '0',
    shippingGrossAmount: '0',
    surchargeTotalAmount: '0',
    grandTotalNetAmount: toAmount(subtotalNet),
    grandTotalGrossAmount: toAmount(grandTotalGross),
    paidTotalAmount: toAmount(paidTotal),
    refundedTotalAmount: '0',
    outstandingAmount: toAmount(grandTotalGross - paidTotal),
    lineItemCount: planned.lines.length,
    createdAt: planned.placedAt,
    updatedAt: planned.placedAt,
  })
  em.persist(order)

  planned.lines.forEach((line, index) => {
    const totalNet = line.product.unitPriceNet * line.quantity
    const totalGross = totalNet * (1 + TAX_RATE)
    em.persist(
      em.create(SalesOrderLine, {
        id: randomUUID(),
        order,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        lineNumber: index + 1,
        kind: 'product',
        productId: line.product.productId,
        productVariantId: line.product.variantId,
        name: line.product.title,
        quantity: toAmount(line.quantity),
        quantityUnit: line.product.unit,
        normalizedQuantity: line.quantity.toFixed(6),
        normalizedUnit: line.product.unit,
        currencyCode: CURRENCY_CODE,
        unitPriceNet: toAmount(line.product.unitPriceNet),
        unitPriceGross: toAmount(line.product.unitPriceNet * (1 + TAX_RATE)),
        discountAmount: '0',
        discountPercent: '0',
        taxRate: TAX_RATE.toFixed(4),
        taxAmount: toAmount(totalGross - totalNet),
        totalNetAmount: toAmount(totalNet),
        totalGrossAmount: toAmount(totalGross),
        reservedQuantity: '0',
        fulfilledQuantity: statuses.fulfillmentStatus === 'fulfilled' ? toAmount(line.quantity) : '0',
        invoicedQuantity: statuses.paymentStatus === 'paid' ? toAmount(line.quantity) : '0',
        returnedQuantity: '0',
        catalogSnapshot: { sku: line.product.sku, title: line.product.title },
        createdAt: planned.placedAt,
        updatedAt: planned.placedAt,
      }),
    )
  })
}

export async function seedHorecaOrderHistory(
  em: EntityManager,
  scope: DistributorSeedScope,
  options: SeedRunOptions = {},
): Promise<SeedReport> {
  const report = emptyReport()
  const months = options.months ?? DEFAULT_HISTORY_MONTHS
  const nowMs = Date.now()
  const historyEndMs = toDayStart(new Date(nowMs))
  const historyStartMs = historyEndMs - months * DAYS_PER_MONTH * MILLISECONDS_PER_DAY

  const customers =
    typeof options.limit === 'number' ? HORECA_CUSTOMERS.slice(0, options.limit) : HORECA_CUSTOMERS

  const customerIdsByHandle = await loadHorecaCustomerIds(em, scope)
  if (customerIdsByHandle.size === 0) {
    report.warnings.push(
      'No HoReCa customers found for this scope — run `mercato distributor_workspace seed-customers` first.',
    )
    return report
  }

  const requiredSlugs = new Set<string>()
  for (const customer of customers) {
    const profile = orderProfileFor(customer.segment)
    for (const line of profile.standingLines) requiredSlugs.add(line.categorySlug)
    for (const slug of profile.noiseCategorySlugs) requiredSlugs.add(slug)
  }
  for (const slug of DISCONTINUED_POOL_CATEGORIES) requiredSlugs.add(slug)
  for (const slug of SEASONAL_POOL_CATEGORIES) requiredSlugs.add(slug)
  const catalogByCategory = await loadCatalogByCategory(em, scope, [...requiredSlugs])
  const missingSlugs = [...requiredSlugs].filter((slug) => (catalogByCategory.get(slug) ?? []).length === 0)
  if (missingSlugs.length > 0) {
    report.warnings.push(`No priced products in ${missingSlugs.length} categories: ${missingSlugs.join(', ')}`)
  }
  if (catalogByCategory.size === 0) {
    report.warnings.push(
      'No priced catalog products found for this scope — run `mercato distributor_workspace seed-catalog` first.',
    )
    return report
  }

  const reserved = carveReservedPools(catalogByCategory)
  const existingReferences = await loadExistingReferences(em, scope)
  const lineCounts: Record<LineOrigin, number> = { standing: 0, noise: 0, discontinued: 0, seasonal: 0 }
  let plannedLines = 0

  for (const customer of customers) {
    const customerEntityId = customerIdsByHandle.get(customer.handle)
    if (!customerEntityId) {
      report.warnings.push(`Customer "${customer.handle}" is not seeded in this scope — skipped.`)
      report.skipped += 1
      continue
    }

    const plan = planCustomerHistory({
      seed: customer,
      catalogByCategory,
      reserved,
      historyStartMs,
      historyEndMs,
    })
    if (plan.standingProducts === 0) {
      report.warnings.push(`No catalog products matched the "${customer.segment}" profile — skipped ${customer.handle}.`)
      report.skipped += 1
      continue
    }

    let writtenForCustomer = 0
    for (const planned of plan.orders) {
      if (existingReferences.has(planned.externalReference)) {
        report.skipped += 1
        continue
      }
      existingReferences.add(planned.externalReference)
      plannedLines += planned.lines.length
      for (const line of planned.lines) lineCounts[line.origin] += 1
      if (!options.dryRun) writeOrder(em, scope, customerEntityId, planned, nowMs)
      writtenForCustomer += 1
      report.created += 1
    }

    bump(report, 'orders', writtenForCustomer)
    bump(report, 'customers', writtenForCustomer > 0 ? 1 : 0)
    if (!options.dryRun && writtenForCustomer > 0) await em.flush()
  }

  bump(report, 'lines', plannedLines)
  bump(report, 'noiseLines', lineCounts.noise)
  bump(report, 'discontinuedLines', lineCounts.discontinued)
  bump(report, 'seasonalLines', lineCounts.seasonal)
  bump(report, 'months', months)
  report.warnings.push(
    `Planted ${lineCounts.noise} one-off noise lines, ${lineCounts.discontinued} lines on ${reserved.discontinued.length} products that stop selling mid-window, and ${lineCounts.seasonal} lines on ${reserved.seasonal.length} seasonal products — none of these may be predicted as a recurring order.`,
  )
  return report
}
