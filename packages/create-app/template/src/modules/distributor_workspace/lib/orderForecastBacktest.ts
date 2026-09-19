/**
 * How well the forecast has actually done for this customer, measured against their own history.
 *
 * The naive way to answer "did the prediction come true?" is a ledger: write every prediction to a
 * table and score it later. That table would be biased (rows only exist for customers someone
 * happened to open), stale (nothing rescores it when an order is corrected or cancelled), and
 * empty for the first weeks after a real data import — exactly when the supplier most needs to
 * know whether to trust the numbers.
 *
 * Replaying the history answers the same question with no table at all. The forecast is a pure
 * function of (observations, now), so "what would we have predicted on 12 May?" is recoverable by
 * calling it with the orders that existed on 12 May. Every scored cycle is a real prediction
 * against a real outcome, the score updates itself whenever the underlying orders change, and an
 * ERP import arrives already scored.
 *
 * The score feeds back into confidence through `calibrationFactorFor`, which is where the system
 * gets sharper as orders accumulate. Backtest runs therefore pass no calibration of their own —
 * scoring a calibrated forecast with the score it produced would be circular.
 */

import {
  buildOrderForecast,
  productKeyOf,
  toDayStart,
  type OrderForecastOptions,
  type OrderObservation,
} from './orderForecast'

export type BacktestOptions = {
  evaluationWindowDays: number
  cutoffStepDays: number
  maxCutoffs: number
  warmupDays: number
  toleranceDays: number
}

/**
 * `toleranceDays: 3` is the distributor's own definition of a hit: a Monday delivery that lands on
 * Thursday is the same standing order, not a new one. Tightening it to 0 would score the calendar
 * rather than the habit.
 */
export const DEFAULT_BACKTEST_OPTIONS: BacktestOptions = {
  evaluationWindowDays: 180,
  cutoffStepDays: 14,
  maxCutoffs: 14,
  warmupDays: 90,
  toleranceDays: 3,
}

export type BacktestResult = {
  cutoffs: number
  trials: number
  hits: number
  misses: number
  missedOpportunities: number
  hitRate: number | null
  recall: number | null
  toleranceDays: number
  evaluatedFrom: string | null
  evaluatedTo: string | null
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

export function resolveBacktestOptions(overrides?: Partial<BacktestOptions>): BacktestOptions {
  return { ...DEFAULT_BACKTEST_OPTIONS, ...(overrides ?? {}) }
}

function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function emptyResult(toleranceDays: number): BacktestResult {
  return {
    cutoffs: 0,
    trials: 0,
    hits: 0,
    misses: 0,
    missedOpportunities: 0,
    hitRate: null,
    recall: null,
    toleranceDays,
    evaluatedFrom: null,
    evaluatedTo: null,
  }
}

type DatedObservation = {
  observation: OrderObservation
  dayMs: number
  productKey: string
}

/**
 * Cutoff dates are sampled backwards from the most recent order, not forwards from the oldest.
 *
 * A customer with two years of history and one with four months then get scored on the same recent
 * behaviour rather than on whatever happened to fit inside a fixed window, and `maxCutoffs` keeps
 * the cost of a customer-card request bounded no matter how deep the history goes.
 */
function buildCutoffs(latestDayMs: number, earliestDayMs: number, options: BacktestOptions): number[] {
  const firstAllowed = earliestDayMs + options.warmupDays * MILLISECONDS_PER_DAY
  const windowStart = latestDayMs - options.evaluationWindowDays * MILLISECONDS_PER_DAY
  const lowerBound = Math.max(firstAllowed, windowStart)
  const step = Math.max(1, options.cutoffStepDays) * MILLISECONDS_PER_DAY

  const cutoffs: number[] = []
  for (
    let cutoff = latestDayMs - step;
    cutoff >= lowerBound && cutoffs.length < options.maxCutoffs;
    cutoff -= step
  ) {
    cutoffs.push(cutoff)
  }
  return cutoffs.reverse()
}

export type RunForecastBacktestInput = {
  observations: OrderObservation[]
  options?: Partial<OrderForecastOptions>
  backtest?: Partial<BacktestOptions>
}

export function runForecastBacktest(input: RunForecastBacktestInput): BacktestResult {
  const backtestOptions = resolveBacktestOptions(input.backtest)
  const dated: DatedObservation[] = []
  for (const observation of input.observations) {
    const dayMs = toDayStart(observation.placedAt)
    if (!Number.isFinite(dayMs)) continue
    const productKey = productKeyOf(observation.productVariantId, observation.productId)
    if (productKey === 'unknown') continue
    dated.push({ observation, dayMs, productKey })
  }
  if (dated.length === 0) return emptyResult(backtestOptions.toleranceDays)

  dated.sort((a, b) => a.dayMs - b.dayMs)
  const earliestDayMs = (dated[0] as DatedObservation).dayMs
  const latestDayMs = (dated[dated.length - 1] as DatedObservation).dayMs
  const cutoffs = buildCutoffs(latestDayMs, earliestDayMs, backtestOptions)
  if (cutoffs.length === 0) return emptyResult(backtestOptions.toleranceDays)

  const toleranceMs = backtestOptions.toleranceDays * MILLISECONDS_PER_DAY
  let hits = 0
  let misses = 0
  let missedOpportunities = 0

  for (const cutoffMs of cutoffs) {
    const past = dated.filter((entry) => entry.dayMs < cutoffMs)
    if (past.length === 0) continue

    const forecast = buildOrderForecast({
      observations: past.map((entry) => entry.observation),
      now: new Date(cutoffMs),
      options: input.options,
    })
    if (forecast.predictions.length === 0) continue

    const future = dated.filter((entry) => entry.dayMs >= cutoffMs)
    const predictedKeys = new Set(forecast.predictions.map((prediction) => prediction.productKey))

    for (const prediction of forecast.predictions) {
      const expectedMs = Date.parse(`${prediction.nextExpectedAt}T00:00:00.000Z`)
      const landed = future.some(
        (entry) =>
          entry.productKey === prediction.productKey && Math.abs(entry.dayMs - expectedMs) <= toleranceMs,
      )
      if (landed) hits += 1
      else misses += 1
    }

    const horizonMs = cutoffMs + Math.max(1, backtestOptions.cutoffStepDays) * MILLISECONDS_PER_DAY
    const actualKeysInHorizon = new Set(
      future.filter((entry) => entry.dayMs <= horizonMs).map((entry) => entry.productKey),
    )
    for (const key of actualKeysInHorizon) {
      if (!predictedKeys.has(key)) missedOpportunities += 1
    }
  }

  const trials = hits + misses
  return {
    cutoffs: cutoffs.length,
    trials,
    hits,
    misses,
    missedOpportunities,
    hitRate: trials > 0 ? hits / trials : null,
    recall: hits + missedOpportunities > 0 ? hits / (hits + missedOpportunities) : null,
    toleranceDays: backtestOptions.toleranceDays,
    evaluatedFrom: toIsoDate(cutoffs[0] as number),
    evaluatedTo: toIsoDate(cutoffs[cutoffs.length - 1] as number),
  }
}
