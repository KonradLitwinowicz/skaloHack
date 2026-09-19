import { runForecastBacktest, DEFAULT_BACKTEST_OPTIONS } from '../orderForecastBacktest'
import { buildOrderForecast, calibrationFactorFor, DEFAULT_FORECAST_OPTIONS, type OrderObservation } from '../orderForecast'

const DAY_MS = 24 * 60 * 60 * 1000

function dayMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00.000Z`)
}

type SeriesSpec = {
  startDate: string
  count: number
  intervalDays: number
  productId: string
  jitterDays?: number[]
  quantity?: number
}

function series(spec: SeriesSpec): OrderObservation[] {
  const quantity = spec.quantity ?? 10
  return Array.from({ length: spec.count }, (_, index) => {
    const jitter = spec.jitterDays?.[index % (spec.jitterDays?.length ?? 1)] ?? 0
    const ms = dayMs(spec.startDate) + (index * spec.intervalDays + jitter) * DAY_MS
    return {
      orderId: `${spec.productId}-${index}`,
      placedAt: new Date(ms + 8 * 60 * 60 * 1000),
      productId: spec.productId,
      productVariantId: `${spec.productId}-variant`,
      productName: spec.productId,
      sku: spec.productId.toUpperCase(),
      quantity,
      quantityUnit: 'szt',
      lineNetAmount: quantity * 4,
      orderNetAmount: quantity * 4,
      currencyCode: 'PLN',
    }
  })
}

/** Dates drawn from a bag with no rhythm at all — the control case for every "it found a pattern" claim. */
function scatteredDays(startDate: string, offsets: number[], productId: string): OrderObservation[] {
  return offsets.map((offset, index) => ({
    orderId: `${productId}-scatter-${index}`,
    placedAt: new Date(dayMs(startDate) + offset * DAY_MS),
    productId,
    productVariantId: `${productId}-variant`,
    productName: productId,
    sku: productId.toUpperCase(),
    quantity: 3 + (index % 5),
    quantityUnit: 'szt',
    lineNetAmount: 12,
    orderNetAmount: 12,
    currencyCode: 'PLN',
  }))
}

describe('runForecastBacktest', () => {
  it('scores a year of unbroken weekly deliveries as almost always right', () => {
    const result = runForecastBacktest({
      observations: series({ startDate: '2025-05-05', count: 50, intervalDays: 7, productId: 'towels' }),
    })

    expect(result.cutoffs).toBeGreaterThan(0)
    expect(result.cutoffs).toBeLessThanOrEqual(DEFAULT_BACKTEST_OPTIONS.maxCutoffs)
    expect(result.trials).toBeGreaterThan(0)
    expect(result.hitRate).toBeGreaterThan(0.9)
    expect(result.misses).toBeLessThan(result.hits)
    expect(result.evaluatedFrom).not.toBeNull()
    expect(result.evaluatedTo).not.toBeNull()
  })

  it('scores a rhythm nobody could have predicted far below a real one', () => {
    const regular = runForecastBacktest({
      observations: series({ startDate: '2025-05-05', count: 50, intervalDays: 7, productId: 'towels' }),
    })
    const scattered = runForecastBacktest({
      observations: scatteredDays(
        '2025-05-05',
        [0, 3, 19, 22, 41, 44, 45, 73, 88, 91, 119, 140, 141, 168, 199, 203, 230, 260, 291, 310, 333, 340],
        'chaos',
      ),
    })

    expect(regular.hitRate ?? 0).toBeGreaterThan(scattered.hitRate ?? 0)
  })

  it('reports nothing rather than guessing when there is no history to replay', () => {
    const empty = runForecastBacktest({ observations: [] })

    expect(empty.trials).toBe(0)
    expect(empty.hitRate).toBeNull()
    expect(empty.recall).toBeNull()
    expect(empty.evaluatedFrom).toBeNull()
  })

  it('skips the warm-up period instead of scoring predictions made with no evidence', () => {
    const shortHistory = runForecastBacktest({
      observations: series({ startDate: '2026-03-02', count: 6, intervalDays: 7, productId: 'towels' }),
    })

    expect(shortHistory.cutoffs).toBe(0)
    expect(shortHistory.trials).toBe(0)
  })

  it('counts a product that arrived without being predicted as a missed opportunity', () => {
    const observations = [
      ...series({ startDate: '2025-05-05', count: 50, intervalDays: 7, productId: 'towels' }),
      ...scatteredDays('2025-11-03', [0, 31, 66, 102, 140, 171], 'surprise'),
    ]

    const result = runForecastBacktest({ observations })

    expect(result.missedOpportunities).toBeGreaterThan(0)
    expect(result.recall).not.toBeNull()
    expect(result.recall as number).toBeLessThan(1)
  })

  it('widens with the tolerance the distributor is willing to accept', () => {
    const observations = series({
      startDate: '2025-05-05',
      count: 50,
      intervalDays: 7,
      productId: 'towels',
      jitterDays: [0, 2, -2, 1, 3, -1],
    })

    const strict = runForecastBacktest({ observations, backtest: { toleranceDays: 0 } })
    const forgiving = runForecastBacktest({ observations, backtest: { toleranceDays: 4 } })

    expect(forgiving.hitRate ?? 0).toBeGreaterThan(strict.hitRate ?? 0)
  })
})

describe('backtest feeding back into confidence', () => {
  it('lifts the confidence of a customer the replay proved dependable', () => {
    const observations = series({ startDate: '2025-05-05', count: 50, intervalDays: 7, productId: 'towels' })
    const now = new Date(dayMs('2026-04-20') + 9 * 60 * 60 * 1000)
    const backtest = runForecastBacktest({ observations })

    const uncalibrated = buildOrderForecast({ observations, now }).predictions[0]!
    const calibrated = buildOrderForecast({
      observations,
      now,
      calibration: { hits: backtest.hits, trials: backtest.trials },
    }).predictions[0]!

    expect(backtest.trials).toBeGreaterThan(0)
    expect(calibrated.evidence.calibrationFactor).toBeGreaterThan(1)
    expect(calibrated.evidence.rawConfidence).toBe(uncalibrated.evidence.rawConfidence)
    expect(calibrationFactorFor({ hits: backtest.hits, trials: backtest.trials }, DEFAULT_FORECAST_OPTIONS)).toBe(
      calibrated.evidence.calibrationFactor,
    )
  })

  it('pulls a poorly performing customer down below the raw rhythm score', () => {
    const observations = series({ startDate: '2025-05-05', count: 50, intervalDays: 7, productId: 'towels' })
    const now = new Date(dayMs('2026-04-20') + 9 * 60 * 60 * 1000)

    const calibrated = buildOrderForecast({
      observations,
      now,
      calibration: { hits: 3, trials: 40 },
    }).predictions[0]!

    expect(calibrated.evidence.calibrationFactor).toBeLessThan(1)
    expect(calibrated.confidence).toBeLessThan(calibrated.evidence.rawConfidence)
  })
})
