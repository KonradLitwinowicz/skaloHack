import {
  buildOrderForecast,
  calibrationFactorFor,
  DEFAULT_FORECAST_OPTIONS,
  median,
  medianAbsoluteDeviation,
  weekdayOf,
  type OrderObservation,
} from '../orderForecast'

const DAY_MS = 24 * 60 * 60 * 1000
const MONDAY = 1
const THURSDAY = 4

function dayMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00.000Z`)
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

type SeriesSpec = {
  startDate: string
  count: number
  intervalDays: number
  productId: string
  productName?: string
  quantity?: number | number[]
  unitPrice?: number
  skipIndexes?: number[]
  jitterDays?: number[]
}

/**
 * Builds one observation per cycle. The hour is deliberately late in the day so the suite also
 * proves that weekday detection buckets on the calendar date rather than on the timestamp.
 */
function series(spec: SeriesSpec): OrderObservation[] {
  const observations: OrderObservation[] = []
  const quantities = Array.isArray(spec.quantity) ? spec.quantity : null
  const flatQuantity = Array.isArray(spec.quantity) ? null : spec.quantity ?? 10
  const unitPrice = spec.unitPrice ?? 5

  for (let index = 0; index < spec.count; index += 1) {
    if (spec.skipIndexes?.includes(index)) continue
    const jitter = spec.jitterDays?.[index] ?? 0
    const ms = dayMs(spec.startDate) + (index * spec.intervalDays + jitter) * DAY_MS
    const quantity = quantities ? (quantities[index] ?? quantities[quantities.length - 1] ?? 10) : (flatQuantity as number)
    observations.push({
      orderId: `${spec.productId}-order-${index}`,
      placedAt: new Date(ms + 21 * 60 * 60 * 1000),
      productId: spec.productId,
      productVariantId: `${spec.productId}-variant`,
      productName: spec.productName ?? spec.productId,
      sku: spec.productId.toUpperCase(),
      quantity,
      quantityUnit: 'szt',
      lineNetAmount: quantity * unitPrice,
      orderNetAmount: quantity * unitPrice,
      currencyCode: 'PLN',
    })
  }
  return observations
}

/** Every series shares one order per calendar day, the way a real multi-line delivery does. */
function mergeIntoSharedOrders(groups: OrderObservation[][]): OrderObservation[] {
  const merged: OrderObservation[] = []
  for (const group of groups) {
    for (const observation of group) {
      const day = isoDate(observation.placedAt.getTime())
      merged.push({
        ...observation,
        orderId: `order-${day}`,
        orderNetAmount: 0,
      })
    }
  }
  const totals = new Map<string, number>()
  for (const observation of merged) {
    totals.set(observation.orderId, (totals.get(observation.orderId) ?? 0) + observation.lineNetAmount)
  }
  return merged.map((observation) => ({
    ...observation,
    orderNetAmount: totals.get(observation.orderId) ?? observation.lineNetAmount,
  }))
}

const NOW = new Date('2026-04-13T10:00:00.000Z')

describe('statistics helpers', () => {
  it('takes the middle value of an odd-length sample and the midpoint of an even one', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBe(0)
  })

  it('ignores a single outlier the way a standard deviation would not', () => {
    const steady = [7, 7, 7, 7, 40]
    expect(medianAbsoluteDeviation(steady, median(steady))).toBe(0)
  })

  it('reports ISO weekdays with Sunday as 7', () => {
    expect(weekdayOf(dayMs('2026-01-05'))).toBe(MONDAY)
    expect(weekdayOf(dayMs('2026-01-11'))).toBe(7)
  })
})

describe('buildOrderForecast — patterns that should be found', () => {
  it('detects a clean weekly Monday rhythm and projects the next Monday', () => {
    const forecast = buildOrderForecast({
      observations: series({ startDate: '2026-01-05', count: 14, intervalDays: 7, productId: 'towels' }),
      now: NOW,
    })

    expect(forecast.predictions).toHaveLength(1)
    const prediction = forecast.predictions[0]!
    expect(prediction.cadence.kind).toBe('weekly')
    expect(prediction.cadence.intervalDays).toBe(7)
    expect(prediction.cadence.dominantWeekday).toBe(MONDAY)
    expect(prediction.cadence.weekdayShare).toBe(1)
    expect(weekdayOf(dayMs(prediction.nextExpectedAt))).toBe(MONDAY)
    expect(prediction.nextExpectedAt).toBe('2026-04-13')
    expect(prediction.overdueDays).toBe(0)
    expect(prediction.confidence).toBe(DEFAULT_FORECAST_OPTIONS.maxConfidence)
    expect(prediction.confidenceBand).toBe('high')
    expect(prediction.evidence.occurrences).toBe(14)
    expect(prediction.evidence.coverage).toBe(1)
  })

  it('survives a day of jitter without losing the weekly classification', () => {
    const forecast = buildOrderForecast({
      observations: series({
        startDate: '2026-01-05',
        count: 12,
        intervalDays: 7,
        productId: 'detergent',
        jitterDays: [0, 0, 1, 0, -1, 0, 0, 1, 0, 0, 0, 0],
      }),
      now: new Date('2026-03-30T10:00:00.000Z'),
    })

    const prediction = forecast.predictions[0]!
    expect(prediction.cadence.kind).toBe('weekly')
    expect(prediction.cadence.dominantWeekday).toBe(MONDAY)
    expect(prediction.confidence).toBeGreaterThan(DEFAULT_FORECAST_OPTIONS.mediumConfidenceThreshold)
  })

  it('classifies a fortnightly Thursday rhythm as weekly-grid with a 14 day interval', () => {
    const forecast = buildOrderForecast({
      observations: series({ startDate: '2026-01-08', count: 8, intervalDays: 14, productId: 'gloves' }),
      now: new Date('2026-04-16T10:00:00.000Z'),
    })

    const prediction = forecast.predictions[0]!
    expect(prediction.cadence.intervalDays).toBe(14)
    expect(prediction.cadence.dominantWeekday).toBe(THURSDAY)
    expect(weekdayOf(dayMs(prediction.nextExpectedAt))).toBe(THURSDAY)
  })

  it('keeps an irregular-but-persistent rhythm as an interval pattern, not a weekday one', () => {
    const forecast = buildOrderForecast({
      observations: series({
        startDate: '2026-01-05',
        count: 10,
        intervalDays: 9,
        productId: 'sacks',
      }),
      now: new Date('2026-04-06T10:00:00.000Z'),
    })

    const prediction = forecast.predictions[0]!
    expect(prediction.cadence.kind).toBe('interval')
    expect(prediction.cadence.dominantWeekday).toBeNull()
    expect(prediction.cadence.intervalDays).toBe(9)
  })
})

describe('buildOrderForecast — the rejections that keep the list honest', () => {
  it('refuses to call two purchases a pattern', () => {
    const forecast = buildOrderForecast({
      observations: series({ startDate: '2026-03-02', count: 2, intervalDays: 7, productId: 'napkins' }),
      now: NOW,
    })

    expect(forecast.predictions).toHaveLength(0)
    expect(forecast.rejected).toEqual([
      expect.objectContaining({ reason: 'tooFewOrders', occurrences: 2 }),
    ])
  })

  it('refuses three purchases crammed into one week', () => {
    const forecast = buildOrderForecast({
      observations: series({ startDate: '2026-04-06', count: 3, intervalDays: 2, productId: 'restock' }),
      now: NOW,
    })

    expect(forecast.predictions).toHaveLength(0)
    expect(forecast.rejected[0]).toEqual(expect.objectContaining({ reason: 'spanTooShort' }))
  })

  it('drops a perfectly regular product the customer stopped buying', () => {
    const forecast = buildOrderForecast({
      observations: series({ startDate: '2025-09-01', count: 12, intervalDays: 7, productId: 'discontinued' }),
      now: NOW,
    })

    expect(forecast.predictions).toHaveLength(0)
    expect(forecast.rejected[0]).toEqual(expect.objectContaining({ reason: 'abandoned' }))
  })

  it('leaves one-off noise out of a basket that also holds a real rhythm', () => {
    const observations = mergeIntoSharedOrders([
      series({ startDate: '2026-01-05', count: 14, intervalDays: 7, productId: 'towels' }),
      series({ startDate: '2026-02-09', count: 1, intervalDays: 7, productId: 'party-cups' }),
      series({ startDate: '2026-03-16', count: 2, intervalDays: 7, productId: 'grill-foil' }),
    ])

    const forecast = buildOrderForecast({ observations, now: NOW })

    expect(forecast.predictions.map((prediction) => prediction.productId)).toEqual(['towels'])
    expect(forecast.rejected.map((entry) => entry.productKey)).toEqual(
      expect.arrayContaining(['variant:party-cups-variant', 'variant:grill-foil-variant']),
    )
  })

  it('penalises a rhythm with skipped cycles below one that was kept up', () => {
    const intact = buildOrderForecast({
      observations: series({ startDate: '2026-01-05', count: 14, intervalDays: 7, productId: 'towels' }),
      now: NOW,
    }).predictions[0]!

    const patchy = buildOrderForecast({
      observations: series({
        startDate: '2026-01-05',
        count: 14,
        intervalDays: 7,
        productId: 'towels',
        skipIndexes: [3, 4, 5, 8, 10],
      }),
      now: NOW,
    }).predictions[0]!

    expect(patchy.evidence.coverage).toBeLessThan(intact.evidence.coverage)
    expect(patchy.confidence).toBeLessThan(intact.confidence)
  })

  it('marks an overdue rhythm as overdue and lowers its confidence', () => {
    const observations = series({ startDate: '2026-01-05', count: 12, intervalDays: 7, productId: 'towels' })
    const onTime = buildOrderForecast({ observations, now: new Date('2026-03-30T10:00:00.000Z') }).predictions[0]!
    const late = buildOrderForecast({ observations, now: new Date('2026-04-05T10:00:00.000Z') }).predictions[0]!

    expect(onTime.overdueDays).toBe(0)
    expect(late.overdueDays).toBeGreaterThan(0)
    expect(late.evidence.recency).toBeLessThan(onTime.evidence.recency)
    expect(late.confidence).toBeLessThan(onTime.confidence)
  })

  /**
   * The rule the owner asked for in as many words: proposing an order to somebody who has been
   * silent for weeks is not a prediction. One missed cycle is the limit on a short rhythm.
   */
  it('stops predicting once a weekly customer has missed a whole cycle', () => {
    const observations = series({ startDate: '2026-01-05', count: 12, intervalDays: 7, productId: 'towels' })

    const stillLate = buildOrderForecast({ observations, now: new Date('2026-04-06T10:00:00.000Z') })
    const gone = buildOrderForecast({ observations, now: new Date('2026-04-09T10:00:00.000Z') })

    expect(stillLate.predictions).toHaveLength(1)
    expect(stillLate.predictions[0]!.overdueDays).toBe(7)
    expect(gone.predictions).toHaveLength(0)
    expect(gone.rejected[0]).toEqual(expect.objectContaining({ reason: 'abandoned' }))
  })

  /**
   * The absolute ceiling exists for exactly this case: a relative-only bound would let a 40-day
   * rhythm go unordered for over three months and still be shown as something about to arrive.
   */
  it('caps how late a long rhythm may be, however long its interval', () => {
    const quarterly = series({ startDate: '2025-06-02', count: 8, intervalDays: 40, productId: 'descaler' })

    // Last delivery 2026-03-09, interval 40 days: due 2026-04-18, and the absolute ceiling of 21
    // overdue days runs out on 2026-05-09 — long before the relative bound of 40 would have.
    const withinCap = buildOrderForecast({ observations: quarterly, now: new Date('2026-05-09T10:00:00.000Z') })
    const pastCap = buildOrderForecast({ observations: quarterly, now: new Date('2026-05-10T10:00:00.000Z') })

    expect(withinCap.predictions).toHaveLength(1)
    expect(withinCap.predictions[0]!.evidence.lastOrderedAt).toBe('2026-03-09')
    expect(withinCap.predictions[0]!.overdueDays).toBe(DEFAULT_FORECAST_OPTIONS.maxOverdueDays)
    expect(pastCap.predictions).toHaveLength(0)
    expect(pastCap.rejected[0]).toEqual(expect.objectContaining({ reason: 'abandoned' }))
  })

  /**
   * The regression this locks down: an overdue prediction used to be rolled forward onto the next
   * future slot while still reporting the overdue count, so a customer weeks past due was shown a
   * date in the future next to the words "overdue by 41 days".
   */
  it('reports the date the delivery is due rather than rolling on to a later slot', () => {
    const monthly = series({ startDate: '2026-01-05', count: 10, intervalDays: 28, productId: 'gloves' })
    const prediction = buildOrderForecast({
      observations: monthly,
      now: new Date('2026-09-28T10:00:00.000Z'),
    }).predictions[0]!

    expect(prediction.evidence.lastOrderedAt).toBe('2026-09-14')
    expect(prediction.nextExpectedAt).toBe('2026-10-12')
    expect(prediction.overdueDays).toBe(0)
    expect(prediction.daysUntilNextExpected).toBe(14)
  })

  it('keeps the overdue count and the expected date telling the same story once the slot passes', () => {
    const prediction = buildOrderForecast({
      observations: series({ startDate: '2026-01-05', count: 10, intervalDays: 28, productId: 'gloves' }),
      now: new Date('2026-10-19T10:00:00.000Z'),
    }).predictions[0]!

    expect(prediction.nextExpectedAt).toBe('2026-10-12')
    expect(prediction.overdueDays).toBe(7)
    expect(prediction.daysUntilNextExpected).toBe(-7)
  })

  it('sorts the most overdue rows to the top, where the calls to make are', () => {
    const forecast = buildOrderForecast({
      observations: mergeIntoSharedOrders([
        series({ startDate: '2026-01-05', count: 14, intervalDays: 7, productId: 'on-time' }),
        series({ startDate: '2026-01-06', count: 6, intervalDays: 14, productId: 'slipping' }),
      ]),
      now: NOW,
    })

    expect(forecast.predictions).toHaveLength(2)
    const [first, second] = forecast.predictions
    expect(first!.productId).toBe('slipping')
    expect(first!.overdueDays).toBeGreaterThan(0)
    expect(first!.daysUntilNextExpected).toBeLessThan(second!.daysUntilNextExpected)
    expect(second!.overdueDays).toBe(0)
  })
})

describe('buildOrderForecast — predicted quantities', () => {
  it('rounds to a whole unit when every past purchase was a whole unit', () => {
    const forecast = buildOrderForecast({
      observations: series({
        startDate: '2026-01-05',
        count: 8,
        intervalDays: 7,
        productId: 'trays',
        quantity: [20, 21, 22, 23, 24, 25, 26, 27],
      }),
      now: new Date('2026-03-02T10:00:00.000Z'),
    })

    expect(forecast.predictions[0]!.predictedQuantity).toBe(24)
    expect(Number.isInteger(forecast.predictions[0]!.predictedQuantity)).toBe(true)
  })

  it('leaves a fractional prediction alone when the customer genuinely buys fractions', () => {
    const forecast = buildOrderForecast({
      observations: series({
        startDate: '2026-01-05',
        count: 8,
        intervalDays: 7,
        productId: 'detergent-litres',
        quantity: [2.5, 3.5, 2.5, 3.5, 2.5, 3.5, 2.5, 3.5],
      }),
      now: new Date('2026-03-02T10:00:00.000Z'),
    })

    expect(forecast.predictions[0]!.predictedQuantity).toBe(3)
  })

  it('uses the median so a single bulk purchase does not inflate every future line', () => {
    const forecast = buildOrderForecast({
      observations: series({
        startDate: '2026-01-05',
        count: 9,
        intervalDays: 7,
        productId: 'towels',
        quantity: [10, 12, 10, 11, 200, 10, 12, 10, 11],
      }),
      now: new Date('2026-03-09T10:00:00.000Z'),
    })

    const prediction = forecast.predictions[0]!
    expect(prediction.predictedQuantity).toBe(11)
    expect(prediction.quantityMax).toBe(200)
    expect(prediction.predictedUnitNetAmount).toBe(5)
    expect(prediction.predictedLineNetAmount).toBe(55)
  })

  it('sums repeated lines of the same product inside one delivery', () => {
    const base = series({ startDate: '2026-01-05', count: 8, intervalDays: 7, productId: 'towels', quantity: 6 })
    const duplicated = base.flatMap((observation) => [observation, { ...observation }])

    const forecast = buildOrderForecast({ observations: duplicated, now: new Date('2026-03-02T10:00:00.000Z') })

    expect(forecast.predictions[0]!.predictedQuantity).toBe(12)
    expect(forecast.predictions[0]!.evidence.occurrences).toBe(8)
  })
})

describe('buildOrderForecast — operator feedback', () => {
  const observations = series({ startDate: '2026-03-02', count: 6, intervalDays: 7, productId: 'towels' })

  it('hides a product the operator dismissed', () => {
    const forecast = buildOrderForecast({
      observations,
      now: NOW,
      feedback: [
        { productId: 'towels', productVariantId: 'towels-variant', kind: 'dismissed', validUntil: null },
      ],
    })

    expect(forecast.predictions).toHaveLength(0)
    expect(forecast.rejected[0]).toEqual(expect.objectContaining({ reason: 'dismissed' }))
  })

  it('ignores feedback that has already expired', () => {
    const forecast = buildOrderForecast({
      observations,
      now: NOW,
      feedback: [
        {
          productId: 'towels',
          productVariantId: 'towels-variant',
          kind: 'dismissed',
          validUntil: new Date('2026-03-01T00:00:00.000Z'),
        },
      ],
    })

    expect(forecast.predictions).toHaveLength(1)
  })

  it('raises confidence toward certainty when the operator confirmed it with the customer', () => {
    const plain = buildOrderForecast({ observations, now: NOW }).predictions[0]!
    const confirmed = buildOrderForecast({
      observations,
      now: NOW,
      feedback: [
        { productId: 'towels', productVariantId: 'towels-variant', kind: 'confirmed', validUntil: null },
      ],
    }).predictions[0]!

    expect(plain.confidence).toBeLessThan(DEFAULT_FORECAST_OPTIONS.maxConfidence)
    expect(confirmed.confidence).toBeGreaterThan(plain.confidence)
    expect(confirmed.confidence).toBeLessThanOrEqual(DEFAULT_FORECAST_OPTIONS.maxConfidence)
    expect(confirmed.acknowledged).toBe(true)
  })
})

describe('calibrationFactorFor', () => {
  it('leaves confidence untouched when there is nothing to calibrate against', () => {
    expect(calibrationFactorFor(null, DEFAULT_FORECAST_OPTIONS)).toBe(1)
    expect(calibrationFactorFor({ hits: 0, trials: 0 }, DEFAULT_FORECAST_OPTIONS)).toBe(1)
  })

  it('marks down a customer whose predictions keep missing and lifts a dependable one', () => {
    const unreliable = calibrationFactorFor({ hits: 4, trials: 40 }, DEFAULT_FORECAST_OPTIONS)
    const dependable = calibrationFactorFor({ hits: 38, trials: 40 }, DEFAULT_FORECAST_OPTIONS)

    expect(unreliable).toBeLessThan(1)
    expect(dependable).toBeGreaterThan(1)
    expect(unreliable).toBeGreaterThanOrEqual(DEFAULT_FORECAST_OPTIONS.calibrationFloor)
    expect(dependable).toBeLessThanOrEqual(DEFAULT_FORECAST_OPTIONS.calibrationCeiling)
  })

  it('lets a long record move the factor further than a short one', () => {
    const shortRecord = calibrationFactorFor({ hits: 0, trials: 3 }, DEFAULT_FORECAST_OPTIONS)
    const longRecord = calibrationFactorFor({ hits: 0, trials: 60 }, DEFAULT_FORECAST_OPTIONS)

    expect(longRecord).toBeLessThan(shortRecord)
  })
})

describe('buildOrderForecast — customer rhythm summary', () => {
  it('describes how often the customer orders even when no single product qualifies', () => {
    const observations = mergeIntoSharedOrders([
      series({ startDate: '2026-01-06', count: 6, intervalDays: 14, productId: 'a' }),
      series({ startDate: '2026-01-20', count: 5, intervalDays: 14, productId: 'b' }),
    ]).map((observation, index) => ({ ...observation, productId: `one-off-${index}`, productVariantId: null }))

    const forecast = buildOrderForecast({ observations, now: new Date('2026-04-07T10:00:00.000Z') })

    expect(forecast.predictions).toHaveLength(0)
    expect(forecast.rhythm.orderCount).toBeGreaterThan(5)
    expect(forecast.rhythm.medianIntervalDays).toBeGreaterThan(0)
    expect(forecast.rhythm.typicalOrderNetAmount).toBeGreaterThan(0)
    expect(forecast.rhythm.currencyCode).toBe('PLN')
  })

  it('reports the habitual ordering weekday and the next expected order date', () => {
    const forecast = buildOrderForecast({
      observations: series({ startDate: '2026-01-05', count: 14, intervalDays: 7, productId: 'towels' }),
      now: NOW,
    })

    expect(forecast.rhythm.dominantWeekday).toBe(MONDAY)
    expect(forecast.rhythm.medianIntervalDays).toBe(7)
    expect(forecast.rhythm.nextExpectedOrderAt).toBe('2026-04-13')
    expect(forecast.rhythm.confidence).toBeGreaterThan(0.8)
  })

  it('returns an empty rhythm rather than throwing when the customer has never ordered', () => {
    const forecast = buildOrderForecast({ observations: [], now: NOW })

    expect(forecast.predictions).toHaveLength(0)
    expect(forecast.rhythm.orderCount).toBe(0)
    expect(forecast.rhythm.medianIntervalDays).toBeNull()
  })
})

describe('buildOrderForecast — option overrides', () => {
  it('applies a single override without discarding the remaining defaults', () => {
    const observations = series({ startDate: '2026-03-02', count: 2, intervalDays: 7, productId: 'napkins' })

    const strict = buildOrderForecast({ observations, now: NOW })
    const permissive = buildOrderForecast({
      observations,
      now: NOW,
      options: { minOccurrences: 2, minSpanDays: 5 },
    })

    expect(strict.predictions).toHaveLength(0)
    expect(permissive.options.minOccurrences).toBe(2)
    expect(permissive.options.maxDispersion).toBe(DEFAULT_FORECAST_OPTIONS.maxDispersion)
    expect(permissive.options.weights).toEqual(DEFAULT_FORECAST_OPTIONS.weights)
  })

  it('never returns more rows than the configured cap', () => {
    const groups = Array.from({ length: 8 }, (_, index) =>
      series({ startDate: '2026-01-05', count: 14, intervalDays: 7, productId: `product-${index}` }),
    )

    const forecast = buildOrderForecast({
      observations: mergeIntoSharedOrders(groups),
      now: NOW,
      options: { maxPredictions: 3 },
    })

    expect(forecast.predictions).toHaveLength(3)
  })
})
