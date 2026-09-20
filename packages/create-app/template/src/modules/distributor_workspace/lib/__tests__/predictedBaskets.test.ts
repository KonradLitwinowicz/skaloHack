import { buildOrderForecast, weekdayOf, type CustomerOrderRhythm, type OrderObservation } from '../orderForecast'
import {
  DEFAULT_BASKET_OPTIONS,
  buildPredictedBaskets,
  projectDeliveryDates,
} from '../predictedBaskets'

const DAY_MS = 24 * 60 * 60 * 1000
const MONDAY = 1
const TUESDAY = 2
const WEDNESDAY = 3
const FRIDAY = 5

const SILENT_RHYTHM: CustomerOrderRhythm = {
  orderCount: 1,
  firstOrderAt: null,
  lastOrderAt: null,
  daysSinceLastOrder: null,
  medianIntervalDays: null,
  intervalSpreadDays: null,
  dominantWeekday: null,
  weekdayShare: 0,
  orderWeekdays: [],
  nextExpectedOrderAt: null,
  daysUntilNextOrder: null,
  orderOverdueDays: 0,
  typicalOrderNetAmount: null,
  currencyCode: null,
  confidence: 0,
}

function dayMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00.000Z`)
}

/**
 * One customer with a single weekly delivery slot, carrying three products on three different
 * cadences — the shape every standing order in this business takes.
 */
function horecaHistory(weeks: number, upToIso: string): OrderObservation[] {
  const observations: OrderObservation[] = []
  const lastMs = dayMs(upToIso)
  for (let index = weeks - 1; index >= 0; index -= 1) {
    const placedMs = lastMs - index * 7 * DAY_MS
    const slot = weeks - 1 - index
    const orderId = `order-${slot}`
    const lines: Array<{ id: string; quantity: number; every: number }> = [
      { id: 'towels', quantity: 12, every: 1 },
      { id: 'detergent', quantity: 6, every: 2 },
      { id: 'gloves', quantity: 4, every: 4 },
    ]
    for (const line of lines) {
      if (slot % line.every !== 0) continue
      observations.push({
        orderId,
        placedAt: new Date(placedMs + 9 * 60 * 60 * 1000),
        productId: line.id,
        productVariantId: `${line.id}-variant`,
        productName: line.id,
        sku: line.id.toUpperCase(),
        quantity: line.quantity,
        quantityUnit: 'szt',
        lineNetAmount: line.quantity * 5,
        orderNetAmount: 0,
        currencyCode: 'PLN',
      })
    }
  }
  const totals = new Map<string, number>()
  for (const observation of observations) {
    totals.set(observation.orderId, (totals.get(observation.orderId) ?? 0) + observation.lineNetAmount)
  }
  return observations.map((observation) => ({
    ...observation,
    orderNetAmount: totals.get(observation.orderId) ?? 0,
  }))
}

function forecastFor(observations: OrderObservation[], nowIso: string) {
  const now = new Date(`${nowIso}T10:00:00.000Z`)
  const forecast = buildOrderForecast({ observations, now })
  return { forecast, baskets: buildPredictedBaskets({ predictions: forecast.predictions, rhythm: forecast.rhythm, now }) }
}

describe('projectDeliveryDates', () => {
  it('projects the customer own delivery slot, snapped to their weekday', () => {
    const { forecast } = forecastFor(horecaHistory(16, '2026-09-16'), '2026-09-19')
    const dates = projectDeliveryDates(forecast.rhythm, DEFAULT_BASKET_OPTIONS)

    expect(dates).toHaveLength(DEFAULT_BASKET_OPTIONS.maxDeliveries)
    for (const date of dates) {
      const jsDay = new Date(date).getUTCDay()
      expect(jsDay === 0 ? 7 : jsDay).toBe(WEDNESDAY)
    }
    expect(dates[0]).toBeLessThan(dates[1] as number)
  })

  it('returns nothing when the customer has no readable order rhythm', () => {
    const dates = projectDeliveryDates(SILENT_RHYTHM, DEFAULT_BASKET_OPTIONS)

    expect(dates).toEqual([])
  })

  /**
   * A rhythm with no weekday to snap to still has weekdays it never lands on. Eight cycles of an
   * eleven-day interval walk through the whole week, and two of those slots would otherwise fall on
   * a closed weekend.
   */
  it('keeps every projected delivery off weekdays the customer never orders on', () => {
    const dates = projectDeliveryDates(
      {
        ...SILENT_RHYTHM,
        orderCount: 16,
        lastOrderAt: '2026-06-30',
        medianIntervalDays: 11,
        orderWeekdays: [MONDAY, TUESDAY, FRIDAY],
      },
      DEFAULT_BASKET_OPTIONS,
    )

    expect(dates).toHaveLength(DEFAULT_BASKET_OPTIONS.maxDeliveries)
    for (const date of dates) {
      expect([MONDAY, TUESDAY, FRIDAY]).toContain(weekdayOf(date))
    }
  })
})

describe('buildPredictedBaskets', () => {
  it('puts every product due on the same delivery into one basket', () => {
    const { baskets } = forecastFor(horecaHistory(16, '2026-09-16'), '2026-09-19')

    expect(baskets.length).toBeGreaterThan(1)
    const first = baskets[0]!
    expect(first.weekday).toBe(WEDNESDAY)
    expect(first.onRhythm).toBe(true)
    expect(first.lineCount).toBe(first.lines.length)
    expect(first.totalNetAmount).toBe(
      first.lines.reduce((total, line) => total + (line.predictedLineNetAmount ?? 0), 0),
    )
  })

  /**
   * The point of projecting past the next delivery: the week after is a DIFFERENT basket, and a
   * distributor loading vans needs to know which one carries the fortnightly chemicals.
   */
  it('projects several deliveries ahead, with different baskets on different cycles', () => {
    const { baskets } = forecastFor(horecaHistory(16, '2026-09-16'), '2026-09-19')

    const sizes = baskets.map((basket) => basket.lineCount)
    expect(new Set(sizes).size).toBeGreaterThan(1)
    expect(baskets.map((basket) => basket.cycleIndex)).toEqual(baskets.map((_, index) => index))

    const dates = baskets.map((basket) => Date.parse(`${basket.expectedAt}T00:00:00.000Z`))
    for (let index = 1; index < dates.length; index += 1) {
      expect(dates[index]).toBeGreaterThan(dates[index - 1] as number)
    }
  })

  it('trusts a delivery further out less than the next one', () => {
    const { baskets } = forecastFor(horecaHistory(16, '2026-09-16'), '2026-09-19')

    expect(baskets.length).toBeGreaterThan(2)
    expect(baskets[0]!.confidence).toBeGreaterThan(baskets[baskets.length - 1]!.confidence)
    for (const basket of baskets) {
      expect(basket.confidence).toBeGreaterThan(0)
      expect(basket.confidence).toBeLessThanOrEqual(1)
    }
  })

  it('never lists the same product twice inside one delivery', () => {
    const { baskets } = forecastFor(horecaHistory(16, '2026-09-16'), '2026-09-19')

    for (const basket of baskets) {
      const keys = basket.lines.map((line) => line.productKey)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('withholds a total when the basket mixes currencies', () => {
    const now = new Date('2026-09-19T10:00:00.000Z')
    const observations = horecaHistory(16, '2026-09-16').map((observation) =>
      observation.productId === 'gloves' ? { ...observation, currencyCode: 'EUR' } : observation,
    )
    const forecast = buildOrderForecast({ observations, now })
    const baskets = buildPredictedBaskets({ predictions: forecast.predictions, rhythm: forecast.rhythm, now })

    // The fixture must actually produce a mixed basket, or the assertions below would pass vacuously.
    const mixed = baskets.find((basket) => new Set(basket.lines.map((line) => line.currencyCode)).size > 1)
    expect(mixed).toBeTruthy()
    expect(mixed?.totalNetAmount).toBeNull()
    expect(mixed?.currencyCode).toBeNull()
  })

  it('still produces a basket when the customer has no readable order rhythm', () => {
    const now = new Date('2026-09-19T10:00:00.000Z')
    // One dependable product, but each delivery on its own order id and no weekday regularity at
    // the customer level: the product rhythm must survive the missing delivery rhythm.
    const observations = horecaHistory(16, '2026-09-16')
      .filter((observation) => observation.productId === 'towels')
      .map((observation, index) => ({ ...observation, orderId: `solo-${index}` }))

    const forecast = buildOrderForecast({ observations, now })
    const baskets = buildPredictedBaskets({
      predictions: forecast.predictions,
      rhythm: { ...forecast.rhythm, medianIntervalDays: null, lastOrderAt: null },
      now,
    })

    expect(forecast.predictions.length).toBeGreaterThan(0)
    expect(baskets).toHaveLength(1)
    expect(baskets[0]!.onRhythm).toBe(false)
    expect(baskets[0]!.lineCount).toBe(forecast.predictions.length)
  })

  it('returns nothing to show when nothing was predicted', () => {
    const now = new Date('2026-09-19T10:00:00.000Z')
    const forecast = buildOrderForecast({ observations: [], now })

    expect(buildPredictedBaskets({ predictions: [], rhythm: forecast.rhythm, now })).toEqual([])
  })
})
