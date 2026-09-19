import { add, div, money, toDecimal, ZERO } from '../decimal'
import type { Decimal } from '../decimal'

/**
 * The windows every row is measured over. Short windows answer "is it moving right now", the year
 * answers "was it ever worth stocking", and the operator sorts by whichever question they are
 * asking. They are days rather than named periods so the same arithmetic serves all four.
 */
export const DEADSTOCK_WINDOW_DAYS = [7, 30, 90, 365] as const

export const MS_PER_DAY = 86_400_000
export const MONTHS_IN_YEAR = 12

/** One sold line, already scoped and already filtered to real product sales by the loader. */
export type DeadstockSalesRow = {
  productId: string
  orderId: string
  customerId: string | null
  occurredAt: Date
  quantity: string
  revenueNet: string
}

export type DeadstockWindowMetrics = {
  windowDays: number
  unitsSold: string
  revenueNet: string
  orderCount: number
  distinctCustomers: number
}

export type ProductSalesMetrics = {
  productId: string
  windows: DeadstockWindowMetrics[]
  firstSaleAt: Date | null
  lastSaleAt: Date | null
  daysSinceLastSale: number | null
  lifetimeUnits: string
  lifetimeRevenueNet: string
  lifetimeOrderCount: number
  lifetimeCustomerCount: number
  /** Units in the most recent `trendDays`, and in the equally long period before it. */
  trailingUnits: string
  previousUnits: string
  /** Units per calendar month across all years, index 0 = January. Feeds the seasonality test. */
  calendarMonthUnits: string[]
  /** Days between the first observed sale and `asOf`; 0 when the product never sold. */
  observedDays: number
}

export type MetricsArgs = {
  rows: DeadstockSalesRow[]
  asOf: Date
  /** Length of each half of the trend comparison, normally the policy's `dyingAfterDays`. */
  trendDays: number
  windows?: readonly number[]
}

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY)
}

type WindowAccumulator = {
  windowDays: number
  since: number
  units: Decimal
  revenue: Decimal
  orders: Set<string>
  customers: Set<string>
}

function emptyWindow(windowDays: number, asOf: Date): WindowAccumulator {
  return {
    windowDays,
    since: asOf.getTime() - windowDays * MS_PER_DAY,
    units: ZERO,
    revenue: ZERO,
    orders: new Set<string>(),
    customers: new Set<string>(),
  }
}

/**
 * Aggregates one product's sold lines into every figure the classifier and the screen need.
 *
 * Single pass, because the caller holds every line of a 14-month history for 200 products and a
 * pass per window would be four times that for no gain.
 */
export function buildProductSalesMetrics(productId: string, args: MetricsArgs): ProductSalesMetrics {
  const { rows, asOf, trendDays } = args
  const windowDays = args.windows ?? DEADSTOCK_WINDOW_DAYS
  const windows = windowDays.map((days) => emptyWindow(days, asOf))

  const trailingSince = asOf.getTime() - trendDays * MS_PER_DAY
  const previousSince = asOf.getTime() - 2 * trendDays * MS_PER_DAY

  const calendarMonths: Decimal[] = new Array(MONTHS_IN_YEAR).fill(ZERO)
  const lifetimeOrders = new Set<string>()
  const lifetimeCustomers = new Set<string>()

  let lifetimeUnits = ZERO
  let lifetimeRevenue = ZERO
  let trailingUnits = ZERO
  let previousUnits = ZERO
  let firstSaleAt: Date | null = null
  let lastSaleAt: Date | null = null

  for (const row of rows) {
    const at = row.occurredAt.getTime()
    const quantity = toDecimal(row.quantity)
    const revenue = toDecimal(row.revenueNet)

    lifetimeUnits = add(lifetimeUnits, quantity)
    lifetimeRevenue = add(lifetimeRevenue, revenue)
    lifetimeOrders.add(row.orderId)
    if (row.customerId) lifetimeCustomers.add(row.customerId)

    if (!firstSaleAt || at < firstSaleAt.getTime()) firstSaleAt = row.occurredAt
    if (!lastSaleAt || at > lastSaleAt.getTime()) lastSaleAt = row.occurredAt

    // Calendar month across all years: a product that sells every July sells in July, and which
    // July it was does not matter to the question being asked.
    const month = row.occurredAt.getUTCMonth()
    calendarMonths[month] = add(calendarMonths[month]!, quantity)

    if (at >= trailingSince) trailingUnits = add(trailingUnits, quantity)
    else if (at >= previousSince) previousUnits = add(previousUnits, quantity)

    for (const window of windows) {
      if (at < window.since) continue
      window.units = add(window.units, quantity)
      window.revenue = add(window.revenue, revenue)
      window.orders.add(row.orderId)
      if (row.customerId) window.customers.add(row.customerId)
    }
  }

  return {
    productId,
    windows: windows.map((window) => ({
      windowDays: window.windowDays,
      unitsSold: money(window.units),
      revenueNet: money(window.revenue),
      orderCount: window.orders.size,
      distinctCustomers: window.customers.size,
    })),
    firstSaleAt,
    lastSaleAt,
    daysSinceLastSale: lastSaleAt ? Math.max(0, daysBetween(lastSaleAt, asOf)) : null,
    lifetimeUnits: money(lifetimeUnits),
    lifetimeRevenueNet: money(lifetimeRevenue),
    lifetimeOrderCount: lifetimeOrders.size,
    lifetimeCustomerCount: lifetimeCustomers.size,
    trailingUnits: money(trailingUnits),
    previousUnits: money(previousUnits),
    calendarMonthUnits: calendarMonths.map((value) => money(value)),
    observedDays: firstSaleAt ? Math.max(0, daysBetween(firstSaleAt, asOf)) : 0,
  }
}

/** A product with stock but no sold line at all still needs a row, and every figure in it is zero. */
export function emptyProductSalesMetrics(productId: string, windows: readonly number[] = DEADSTOCK_WINDOW_DAYS): ProductSalesMetrics {
  return {
    productId,
    windows: windows.map((days) => ({
      windowDays: days,
      unitsSold: money(ZERO),
      revenueNet: money(ZERO),
      orderCount: 0,
      distinctCustomers: 0,
    })),
    firstSaleAt: null,
    lastSaleAt: null,
    daysSinceLastSale: null,
    lifetimeUnits: money(ZERO),
    lifetimeRevenueNet: money(ZERO),
    lifetimeOrderCount: 0,
    lifetimeCustomerCount: 0,
    trailingUnits: money(ZERO),
    previousUnits: money(ZERO),
    calendarMonthUnits: new Array(MONTHS_IN_YEAR).fill(money(ZERO)),
    observedDays: 0,
  }
}

export function groupSalesRowsByProduct(rows: DeadstockSalesRow[]): Map<string, DeadstockSalesRow[]> {
  const byProduct = new Map<string, DeadstockSalesRow[]>()
  for (const row of rows) {
    const bucket = byProduct.get(row.productId)
    if (bucket) bucket.push(row)
    else byProduct.set(row.productId, [row])
  }
  return byProduct
}

export function windowMetricsOf(metrics: ProductSalesMetrics, windowDays: number): DeadstockWindowMetrics | null {
  return metrics.windows.find((window) => window.windowDays === windowDays) ?? null
}

/**
 * Units sold per day over the longest window that actually contains history.
 *
 * Dividing by the nominal window length would understate the rate of a product first sold three
 * weeks ago by a factor of seventeen, and that product would then look like deadstock.
 */
export function dailySalesRate(metrics: ProductSalesMetrics, windowDays: number): Decimal {
  const window = windowMetricsOf(metrics, windowDays)
  if (!window) return ZERO
  const effectiveDays = Math.max(1, Math.min(windowDays, metrics.observedDays || windowDays))
  return div(toDecimal(window.unitsSold), toDecimal(String(effectiveDays)))
}
