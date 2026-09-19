import { classifyDeadstock, peakMonthsOf, type ClassifyArgs } from '../lib/deadstock/classify'
import { buildProductSalesMetrics, emptyProductSalesMetrics, type DeadstockSalesRow } from '../lib/deadstock/metrics'
import { defaultDeadstockPolicy } from '../lib/deadstock/policy'
import { toDecimal } from '../lib/decimal'

const ASOF = new Date('2026-09-19T00:00:00.000Z')
/** Fourteen months, the span the HoReCa order-history seeder produces. */
const HISTORY_STARTS_AT = new Date('2025-07-19T00:00:00.000Z')
const PRODUCT = 'product-1'

function daysAgo(days: number): Date {
  return new Date(ASOF.getTime() - days * 86_400_000)
}

function sale(days: number, quantity: string, orderId = `order-${days}`): DeadstockSalesRow {
  return {
    productId: PRODUCT,
    orderId,
    customerId: 'customer-1',
    occurredAt: daysAgo(days),
    quantity,
    revenueNet: '10',
  }
}

/** One sale every 30 days for `months` months, so no calendar month stands out as a season. */
function evenMonthlySales(months: number, quantity: string): DeadstockSalesRow[] {
  return Array.from({ length: months }, (_, index) => sale(index * 30 + 1, quantity, `order-${index}`))
}

function metricsOf(rows: DeadstockSalesRow[]) {
  return rows.length === 0
    ? emptyProductSalesMetrics(PRODUCT)
    : buildProductSalesMetrics(PRODUCT, { rows, asOf: ASOF, trendDays: defaultDeadstockPolicy().dyingAfterDays })
}

function args(rows: DeadstockSalesRow[], overrides: Partial<ClassifyArgs> = {}): ClassifyArgs {
  return {
    metrics: metricsOf(rows),
    onHandQuantity: toDecimal('100'),
    policy: defaultDeadstockPolicy(),
    asOf: ASOF,
    historyStartsAt: HISTORY_STARTS_AT,
    stockSince: daysAgo(400),
    launchAt: null,
    dismissedUntil: null,
    ...overrides,
  }
}

describe('classifyDeadstock — the verdict', () => {
  it('calls stock that never sold a single unit never_sold, not dead', () => {
    const result = classifyDeadstock(args([]))

    expect(result.productClass).toBe('never_sold')
    expect(result.reasonKey).toBe('pricing_engine.deadstock.reason.neverSold')
    expect(result.suppression).toBeNull()
  })

  it('calls stock dormant past the dead threshold dead', () => {
    // Sold monthly from August 2025 to March 2026, then nothing: 200 days of silence.
    const rows = Array.from({ length: 8 }, (_, index) => sale(200 + index * 30, '10', `order-${index}`))
    const result = classifyDeadstock(args(rows))

    expect(result.productClass).toBe('dead')
    expect(result.reasonKey).toBe('pricing_engine.deadstock.reason.dormant')
  })

  it('calls stock dormant past the dying threshold but short of dead dying', () => {
    const rows = Array.from({ length: 9 }, (_, index) => sale(120 + index * 30, '10', `order-${index}`))
    const result = classifyDeadstock(args(rows))

    expect(result.productClass).toBe('dying')
    expect(result.reasonKey).toBe('pricing_engine.deadstock.reason.dormantShort')
  })

  it('calls a product still selling but collapsing dying', () => {
    // 100 units in the previous quarter, 10 in the trailing one: a fall to a tenth.
    const rows = [sale(100, '100', 'order-old'), sale(5, '10', 'order-new')]
    const result = classifyDeadstock(args(rows))

    expect(result.productClass).toBe('dying')
    expect(result.reasonKey).toBe('pricing_engine.deadstock.reason.collapsingTrend')
  })

  it('does not call growth a collapse when there is no previous period to fall from', () => {
    const rows = [sale(5, '10', 'order-new')]
    const result = classifyDeadstock(args(rows, { onHandQuantity: toDecimal('1') }))

    expect(result.productClass).toBe('healthy')
  })

  it('calls a steady seller with far too much stock slow, not dead', () => {
    // 12 units a year against 100 on hand: roughly 3000 days of cover, but it does sell.
    const rows = evenMonthlySales(12, '1')
    const result = classifyDeadstock(args(rows))

    expect(result.productClass).toBe('slow')
    expect(result.reasonKey).toBe('pricing_engine.deadstock.reason.excessCover')
  })

  it('leaves a product with healthy cover alone', () => {
    const rows = evenMonthlySales(12, '100')
    const result = classifyDeadstock(args(rows, { onHandQuantity: toDecimal('10') }))

    expect(result.productClass).toBe('healthy')
    expect(result.reasonKey).toBe('pricing_engine.deadstock.reason.healthy')
  })

  it('judges nothing when there is no stock to judge', () => {
    const result = classifyDeadstock(args([], { onHandQuantity: toDecimal('0') }))

    expect(result.productClass).toBe('healthy')
    expect(result.reasonKey).toBe('pricing_engine.deadstock.reason.noStock')
  })
})

describe('classifyDeadstock — the suppressors', () => {
  it('withholds the verdict from a product that has not been sellable long enough', () => {
    const result = classifyDeadstock(args([], { stockSince: daysAgo(30) }))

    expect(result.rawClass).toBe('never_sold')
    expect(result.productClass).toBe('healthy')
    expect(result.suppression).toBe('new_product')
    expect(result.reasonKey).toBe('pricing_engine.deadstock.reason.tooNew')
  })

  it('takes the shortest of the dates that could have started the clock', () => {
    // Listed a year ago, stocked last week: it has had a week to sell, not a year.
    const result = classifyDeadstock(args([], { launchAt: daysAgo(365), stockSince: daysAgo(7) }))

    expect(result.availableDays).toBe(7)
    expect(result.suppression).toBe('new_product')
  })

  /** Twelve orders across one winter: November, December and January, then silence. */
  function winterSeason(): DeadstockSalesRow[] {
    const days = [313, 310, 306, 303, 285, 281, 278, 274, 256, 252, 249, 245]
    return days.map((day, index) => sale(day, '40', `order-${index}`))
  }

  it('withholds the verdict from a winter product measured in September', () => {
    const result = classifyDeadstock(args(winterSeason()))

    expect(result.rawClass).toBe('dead')
    expect(result.productClass).toBe('healthy')
    expect(result.suppression).toBe('seasonal')
    expect(result.peakMonths).toEqual([0, 10, 11])
    expect(result.nextPeakMonth).toBe(10)
  })

  // A product bought twice has two "peak months" by construction — the two it was bought in — and
  // every other month is out of season. That is how a one-off tail dresses itself up as seasonal,
  // and it is the plainest deadstock there is.
  it('does not let a product bought a handful of times claim a season', () => {
    const rows = [sale(313, '40', 'order-0'), sale(283, '50', 'order-1')]
    const result = classifyDeadstock(args(rows))

    expect(result.rawClass).toBe('dead')
    expect(result.suppression).toBeNull()
    expect(result.productClass).toBe('dead')
  })

  // Demand spread across most of the year is uneven, not seasonal: there is no season to be out of.
  it('does not treat a product selling in most months as seasonal', () => {
    const rows = evenMonthlySales(12, '10')
    const result = classifyDeadstock(args(rows, { onHandQuantity: toDecimal('100') }))

    expect(result.suppression).toBeNull()
  })

  // Absence of a date is not evidence of newness. Suppressing here would hide exactly the products
  // the platform knows least about, which in practice are the never-sold ones.
  it('lets the verdict through when no date can establish how long it has been sellable', () => {
    const result = classifyDeadstock(args([], { stockSince: null, launchAt: null }))

    expect(result.availableDays).toBeNull()
    expect(result.productClass).toBe('never_sold')
    expect(result.suppression).toBeNull()
    expect(result.warnings).toContain('pricing_engine.deadstock.warnings.availabilityUnknown')
  })

  it('withholds the verdict while an operator dismissal is still in force', () => {
    const rows = Array.from({ length: 8 }, (_, index) => sale(200 + index * 30, '10', `order-${index}`))
    const result = classifyDeadstock(args(rows, { dismissedUntil: daysAgo(-30) }))

    expect(result.rawClass).toBe('dead')
    expect(result.productClass).toBe('healthy')
    expect(result.suppression).toBe('decision_dismissed')
  })

  it('lets the verdict through again once the dismissal has lapsed', () => {
    const rows = Array.from({ length: 8 }, (_, index) => sale(200 + index * 30, '10', `order-${index}`))
    const result = classifyDeadstock(args(rows, { dismissedUntil: daysAgo(1) }))

    expect(result.productClass).toBe('dead')
    expect(result.suppression).toBeNull()
  })

  it('says out loud that it cannot tell a dead product from a seasonal one without a year of history', () => {
    const rows = [sale(200, '10')]
    const result = classifyDeadstock(args(rows, { historyStartsAt: daysAgo(210) }))

    expect(result.seasonalityKnown).toBe(false)
    expect(result.productClass).toBe('dead')
    expect(result.warnings).toContain('pricing_engine.deadstock.warnings.seasonalityUnknown')
  })
})

describe('peakMonthsOf', () => {
  it('returns nothing to be out of when a product never sold', () => {
    expect(peakMonthsOf(emptyProductSalesMetrics(PRODUCT), toDecimal('0.5'))).toEqual([])
  })

  it('returns every month when demand is flat, because flat demand has no season', () => {
    const rows = evenMonthlySales(12, '10')
    const metrics = buildProductSalesMetrics(PRODUCT, { rows, asOf: ASOF, trendDays: 90 })

    expect(peakMonthsOf(metrics, toDecimal('0.5'))).toHaveLength(12)
  })
})
