import {
  buildProductSalesMetrics,
  dailySalesRate,
  emptyProductSalesMetrics,
  groupSalesRowsByProduct,
  windowMetricsOf,
  type DeadstockSalesRow,
} from '../lib/deadstock/metrics'
import { money } from '../lib/decimal'

const ASOF = new Date('2026-09-19T00:00:00.000Z')
const PRODUCT = 'product-1'

function daysAgo(days: number): Date {
  return new Date(ASOF.getTime() - days * 86_400_000)
}

function row(overrides: Partial<DeadstockSalesRow> = {}): DeadstockSalesRow {
  return {
    productId: PRODUCT,
    orderId: 'order-1',
    customerId: 'customer-1',
    occurredAt: daysAgo(1),
    quantity: '1',
    revenueNet: '10',
    ...overrides,
  }
}

function build(rows: DeadstockSalesRow[], trendDays = 90) {
  return buildProductSalesMetrics(PRODUCT, { rows, asOf: ASOF, trendDays })
}

describe('buildProductSalesMetrics', () => {
  it('counts a line into every window that contains it and none that does not', () => {
    const metrics = build([row({ occurredAt: daysAgo(45), quantity: '4', revenueNet: '100' })])

    expect(windowMetricsOf(metrics, 7)?.unitsSold).toBe(money(0n))
    expect(windowMetricsOf(metrics, 30)?.unitsSold).toBe(money(0n))
    expect(windowMetricsOf(metrics, 90)?.unitsSold).toBe('4.0000')
    expect(windowMetricsOf(metrics, 365)?.unitsSold).toBe('4.0000')
    expect(windowMetricsOf(metrics, 365)?.revenueNet).toBe('100.0000')
  })

  it('counts orders and customers as distinct, not as lines', () => {
    const metrics = build([
      row({ orderId: 'a', customerId: 'c1', occurredAt: daysAgo(2) }),
      row({ orderId: 'a', customerId: 'c1', occurredAt: daysAgo(2) }),
      row({ orderId: 'b', customerId: 'c1', occurredAt: daysAgo(3) }),
      row({ orderId: 'c', customerId: 'c2', occurredAt: daysAgo(4) }),
    ])

    const week = windowMetricsOf(metrics, 7)
    expect(week?.orderCount).toBe(3)
    expect(week?.distinctCustomers).toBe(2)
    expect(week?.unitsSold).toBe('4.0000')
  })

  it('splits the trend comparison at the trailing boundary without double counting', () => {
    // trendDays = 30: trailing is [0, 30), previous is [30, 60).
    const metrics = build(
      [
        row({ occurredAt: daysAgo(5), quantity: '2' }),
        row({ occurredAt: daysAgo(29), quantity: '3' }),
        row({ occurredAt: daysAgo(31), quantity: '7' }),
        row({ occurredAt: daysAgo(59), quantity: '1' }),
        row({ occurredAt: daysAgo(70), quantity: '99' }),
      ],
      30,
    )

    expect(metrics.trailingUnits).toBe('5.0000')
    expect(metrics.previousUnits).toBe('8.0000')
  })

  it('reports first and last sale and the dormancy between the last one and today', () => {
    const metrics = build([
      row({ occurredAt: daysAgo(300), quantity: '1' }),
      row({ occurredAt: daysAgo(120), quantity: '1' }),
    ])

    expect(metrics.firstSaleAt?.toISOString()).toBe(daysAgo(300).toISOString())
    expect(metrics.lastSaleAt?.toISOString()).toBe(daysAgo(120).toISOString())
    expect(metrics.daysSinceLastSale).toBe(120)
    expect(metrics.observedDays).toBe(300)
  })

  it('buckets units by calendar month across years, so a season reads as one season', () => {
    const metrics = build([
      row({ occurredAt: new Date('2025-07-10T00:00:00.000Z'), quantity: '5' }),
      row({ occurredAt: new Date('2026-07-14T00:00:00.000Z'), quantity: '6' }),
      row({ occurredAt: new Date('2026-02-02T00:00:00.000Z'), quantity: '1' }),
    ])

    expect(metrics.calendarMonthUnits[6]).toBe('11.0000')
    expect(metrics.calendarMonthUnits[1]).toBe('1.0000')
    expect(metrics.calendarMonthUnits[0]).toBe('0.0000')
  })

  it('leaves every figure at zero for a product that never sold', () => {
    const metrics = emptyProductSalesMetrics(PRODUCT)

    expect(metrics.lifetimeUnits).toBe('0.0000')
    expect(metrics.daysSinceLastSale).toBeNull()
    expect(metrics.observedDays).toBe(0)
    expect(metrics.windows).toHaveLength(4)
  })
})

describe('dailySalesRate', () => {
  it('divides by the observed history, not by the nominal window', () => {
    // 20 units sold over the 10 days this product has existed is 2/day, not 20/90.
    const metrics = build([row({ occurredAt: daysAgo(10), quantity: '10' }), row({ occurredAt: daysAgo(1), quantity: '10' })])

    expect(money(dailySalesRate(metrics, 90))).toBe('2.0000')
  })

  it('uses the full window once history is longer than it', () => {
    const metrics = build([
      row({ occurredAt: daysAgo(200), quantity: '1000' }),
      row({ occurredAt: daysAgo(30), quantity: '90' }),
    ])

    // Only the 90-day window counts: 90 units over 90 days.
    expect(money(dailySalesRate(metrics, 90))).toBe('1.0000')
  })
})

describe('groupSalesRowsByProduct', () => {
  it('keeps each product rows together', () => {
    const grouped = groupSalesRowsByProduct([
      row({ productId: 'a' }),
      row({ productId: 'b' }),
      row({ productId: 'a' }),
    ])

    expect(grouped.get('a')).toHaveLength(2)
    expect(grouped.get('b')).toHaveLength(1)
  })
})
