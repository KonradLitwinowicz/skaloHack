/**
 * Recurring-order detection for a single customer.
 *
 * The distributor's question is "what is this customer about to order, and how sure are we?".
 * The only honest source for that is the customer's own order history, so this module takes raw
 * order lines and nothing else: no per-customer rules, no seeded expectations, no product
 * allow-list. Feed it orders imported from a real ERP and it starts predicting from them on the
 * next request, with no code change and no retraining step.
 *
 * The hard requirement it exists to enforce is the NEGATIVE one: a product bought twice is not a
 * pattern. Four independent gates (occurrences, span, coverage, staleness) reject far more
 * candidates than they pass, and each rejection reason is preserved so the UI can explain a
 * missing row rather than silently dropping it.
 *
 * Everything here is pure and date-deterministic — the same observations and the same `now`
 * always produce the same forecast, which is what makes the backtest in `orderForecastBacktest.ts`
 * meaningful.
 */

export type OrderObservation = {
  orderId: string
  placedAt: Date
  productId: string | null
  productVariantId: string | null
  productName: string
  sku: string | null
  quantity: number
  quantityUnit: string | null
  lineNetAmount: number
  orderNetAmount: number
  currencyCode: string | null
}

export const PREDICTION_FEEDBACK_KINDS = ['confirmed', 'dismissed', 'snoozed'] as const

export type PredictionFeedbackKind = (typeof PREDICTION_FEEDBACK_KINDS)[number]

export type PredictionFeedbackInput = {
  productId: string | null
  productVariantId: string | null
  kind: PredictionFeedbackKind
  validUntil: Date | null
}

export type ForecastCalibration = {
  hits: number
  trials: number
}

export type OrderForecastWeights = {
  support: number
  regularity: number
  coverage: number
  recency: number
}

export type OrderForecastOptions = {
  lookbackDays: number
  minOccurrences: number
  minSpanDays: number
  overdueToleranceFactor: number
  maxOverdueDays: number
  overdueGraceFactor: number
  recencyFloor: number
  maxDispersion: number
  supportSaturation: number
  weekdayShareThreshold: number
  weeklyGridToleranceDays: number
  weekdayCalendarMinOrders: number
  minConfidence: number
  maxConfidence: number
  maxPredictions: number
  historyDepth: number
  weights: OrderForecastWeights
  highConfidenceThreshold: number
  mediumConfidenceThreshold: number
  calibrationPrior: number
  calibrationStrength: number
  calibrationFloor: number
  calibrationCeiling: number
  confirmedFeedbackBoost: number
}

/**
 * Defaults tuned for wholesale HoReCa supply, where the shortest real rhythm is weekly and the
 * longest a supplier cares about is roughly quarterly.
 *
 * `minSpanDays: 21` is the single most load-bearing number: it is what makes three deliveries
 * inside one week fail to become a "weekly pattern". Three occurrences spread over three weeks
 * are evidence; three occurrences spread over four days are one restock split across invoices.
 *
 * `maxConfidence` is a deliberate ceiling below 1: a forecast about a human being's next purchase
 * is never certain, and a row reading "100%" would invite the operator to stop checking it.
 *
 * How late a delivery may be and still count as forthcoming is bounded TWICE, and the tighter bound
 * wins. `overdueToleranceFactor: 1` says a customer who has missed a whole cycle has broken the
 * rhythm rather than delayed it — a weekly order two weeks silent has stopped, not slipped.
 * `maxOverdueDays: 21` is the absolute ceiling that keeps long rhythms honest: the relative bound
 * alone would let a 40-day rhythm go unordered for over three months and still be presented as
 * something about to arrive, which is not a prediction anybody can act on.
 *
 * The weekday is treated as evidence in its own right, not as a decoration on the date.
 * `weekdayShareThreshold: 0.6` is what makes a habitual weekday hold — and it holds whether or not
 * the interval sits on a clean 7-day grid, because a customer who orders every nine days but always
 * on a Tuesday has a Tuesday habit that a pure interval step would walk straight off.
 * `weekdayCalendarMinOrders: 12` guards the weaker weekday rule underneath it: a weekday missing
 * from six orders is missing by chance, and constraining a date to that sample would invent a habit
 * out of noise. Missing from twelve, it is a day this customer does not receive on.
 *
 * Every threshold is passed through `resolveForecastOptions`, so a caller — a tenant setting, an
 * A/B run, a test — overrides one value without forking the rest.
 */
export const DEFAULT_FORECAST_OPTIONS: OrderForecastOptions = {
  lookbackDays: 540,
  minOccurrences: 3,
  minSpanDays: 21,
  overdueToleranceFactor: 1,
  maxOverdueDays: 21,
  overdueGraceFactor: 0.5,
  recencyFloor: 0.15,
  maxDispersion: 0.6,
  supportSaturation: 8,
  weekdayShareThreshold: 0.6,
  weeklyGridToleranceDays: 1.5,
  weekdayCalendarMinOrders: 12,
  minConfidence: 0.35,
  maxConfidence: 0.97,
  maxPredictions: 25,
  historyDepth: 8,
  weights: { support: 1, regularity: 1.2, coverage: 1, recency: 0.8 },
  highConfidenceThreshold: 0.75,
  mediumConfidenceThreshold: 0.55,
  calibrationPrior: 0.7,
  calibrationStrength: 6,
  calibrationFloor: 0.6,
  calibrationCeiling: 1.15,
  confirmedFeedbackBoost: 0.5,
}

export const PREDICTION_REJECTION_REASONS = [
  'tooFewOrders',
  'spanTooShort',
  'irregular',
  'abandoned',
  'belowConfidence',
  'dismissed',
  'snoozed',
] as const

export type PredictionRejectionReason = (typeof PREDICTION_REJECTION_REASONS)[number]

export type CadenceKind = 'weekly' | 'interval'

export type PredictionCadence = {
  kind: CadenceKind
  intervalDays: number
  dominantWeekday: number | null
  weekdayShare: number
  weekdayHits: number
}

export type PredictionEvidence = {
  occurrences: number
  firstOrderedAt: string
  lastOrderedAt: string
  spanDays: number
  daysSinceLastOrder: number
  medianIntervalDays: number
  intervalSpreadDays: number
  expectedOccurrences: number
  coverage: number
  support: number
  regularity: number
  recency: number
  rawConfidence: number
  calibrationFactor: number
}

/**
 * The purchases the prediction was read from, newest first.
 *
 * A confidence percentage asks to be trusted; this is what lets an operator check it instead. Two
 * minutes with these rows answers the question a number cannot — is that really their pattern, or
 * did a one-off delivery in March drag the whole thing sideways — and the order ids make each row
 * a link back to the document it came from.
 */
export type PredictionHistoryEntry = {
  orderedAt: string
  quantity: number
  orderIds: string[]
}

export type ConfidenceBand = 'high' | 'medium' | 'low'

export type OrderPrediction = {
  productKey: string
  productId: string | null
  productVariantId: string | null
  productName: string
  sku: string | null
  predictedQuantity: number
  quantityMin: number
  quantityMax: number
  quantityUnit: string | null
  predictedUnitNetAmount: number | null
  predictedLineNetAmount: number | null
  currencyCode: string | null
  nextExpectedAt: string
  daysUntilNextExpected: number
  overdueDays: number
  cadence: PredictionCadence
  confidence: number
  confidenceBand: ConfidenceBand
  acknowledged: boolean
  history: PredictionHistoryEntry[]
  evidence: PredictionEvidence
}

export type RejectedPrediction = {
  productKey: string
  productName: string
  reason: PredictionRejectionReason
  occurrences: number
  lastOrderedAt: string | null
}

export type CustomerOrderRhythm = {
  orderCount: number
  firstOrderAt: string | null
  lastOrderAt: string | null
  daysSinceLastOrder: number | null
  medianIntervalDays: number | null
  intervalSpreadDays: number | null
  dominantWeekday: number | null
  weekdayShare: number
  /** Every ISO weekday this customer has actually placed an order on, ascending. */
  orderWeekdays: number[]
  nextExpectedOrderAt: string | null
  daysUntilNextOrder: number | null
  orderOverdueDays: number
  typicalOrderNetAmount: number | null
  currencyCode: string | null
  confidence: number
}

export type OrderForecast = {
  rhythm: CustomerOrderRhythm
  predictions: OrderPrediction[]
  rejected: RejectedPrediction[]
  options: OrderForecastOptions
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

export function resolveForecastOptions(overrides?: Partial<OrderForecastOptions>): OrderForecastOptions {
  if (!overrides) return DEFAULT_FORECAST_OPTIONS
  return {
    ...DEFAULT_FORECAST_OPTIONS,
    ...overrides,
    weights: { ...DEFAULT_FORECAST_OPTIONS.weights, ...(overrides.weights ?? {}) },
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * All day arithmetic runs on UTC midnight buckets.
 *
 * A wholesale delivery placed at 23:40 local time and one placed at 00:20 the next morning belong
 * to different calendar days but to the same weekly slot; anchoring on UTC midnight keeps the
 * weekday histogram from splitting one habit across two weekdays because of a timestamp's hour.
 */
export function toDayStart(value: Date): number {
  return Math.floor(value.getTime() / MILLISECONDS_PER_DAY) * MILLISECONDS_PER_DAY
}

function dayDiff(laterMs: number, earlierMs: number): number {
  return Math.round((laterMs - earlierMs) / MILLISECONDS_PER_DAY)
}

function addDays(baseMs: number, days: number): number {
  return baseMs + days * MILLISECONDS_PER_DAY
}

function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function weekdayOf(ms: number): number {
  const jsDay = new Date(ms).getUTCDay()
  return jsDay === 0 ? 7 : jsDay
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

/**
 * Median absolute deviation — the spread measure this module uses everywhere instead of a standard
 * deviation. A single holiday-week double order inflates a standard deviation enough to hide an
 * otherwise perfect weekly rhythm; the MAD ignores it, which is the behaviour a buyer would expect.
 */
export function medianAbsoluteDeviation(values: number[], center: number): number {
  if (values.length === 0) return 0
  return median(values.map((value) => Math.abs(value - center)))
}

/**
 * Keeps the predicted quantity in the same domain as the observed ones.
 *
 * A median over an even number of whole-unit purchases lands on a half — and "21.5 packs" is not a
 * quantity anybody can pick, order or deliver. When every historical quantity was a whole number,
 * the prediction is rounded to one; when the customer genuinely buys fractional amounts (litres,
 * kilograms), the median is left alone.
 */
export function quantizeQuantity(value: number, observed: number[]): number {
  const allWhole = observed.every((quantity) => Number.isInteger(quantity))
  if (!allWhole) return value
  return Math.max(1, Math.round(value))
}

export function productKeyOf(productVariantId: string | null, productId: string | null): string {
  if (productVariantId) return `variant:${productVariantId}`
  if (productId) return `product:${productId}`
  return 'unknown'
}

type Occurrence = {
  dayMs: number
  quantity: number
  lineNetAmount: number
  orderIds: string[]
}

type ProductSeries = {
  productKey: string
  productId: string | null
  productVariantId: string | null
  productName: string
  sku: string | null
  quantityUnit: string | null
  currencyCode: string | null
  occurrences: Occurrence[]
}

function groupObservations(observations: OrderObservation[], options: OrderForecastOptions, nowMs: number): ProductSeries[] {
  const horizonMs = addDays(nowMs, -options.lookbackDays)
  const byProduct = new Map<string, ProductSeries>()
  const byProductAndDay = new Map<string, Occurrence>()

  for (const observation of observations) {
    const dayMs = toDayStart(observation.placedAt)
    if (!Number.isFinite(dayMs) || dayMs < horizonMs || dayMs > nowMs) continue
    if (!Number.isFinite(observation.quantity) || observation.quantity <= 0) continue

    const productKey = productKeyOf(observation.productVariantId, observation.productId)
    if (productKey === 'unknown') continue

    let series = byProduct.get(productKey)
    if (!series) {
      series = {
        productKey,
        productId: observation.productId,
        productVariantId: observation.productVariantId,
        productName: observation.productName,
        sku: observation.sku,
        quantityUnit: observation.quantityUnit,
        currencyCode: observation.currencyCode,
        occurrences: [],
      }
      byProduct.set(productKey, series)
    }

    const dayKey = `${productKey}@${dayMs}`
    const existing = byProductAndDay.get(dayKey)
    if (existing) {
      existing.quantity += observation.quantity
      existing.lineNetAmount += observation.lineNetAmount
      if (!existing.orderIds.includes(observation.orderId)) existing.orderIds.push(observation.orderId)
      continue
    }
    const occurrence: Occurrence = {
      dayMs,
      quantity: observation.quantity,
      lineNetAmount: observation.lineNetAmount,
      orderIds: [observation.orderId],
    }
    byProductAndDay.set(dayKey, occurrence)
    series.occurrences.push(occurrence)
  }

  for (const series of byProduct.values()) {
    series.occurrences.sort((a, b) => a.dayMs - b.dayMs)
  }
  return [...byProduct.values()]
}

type CadenceAnalysis = {
  intervals: number[]
  medianIntervalDays: number
  intervalSpreadDays: number
  regularity: number
  dominantWeekday: number
  weekdayHits: number
  weekdayShare: number
  weekdayAligned: boolean
  isWeekly: boolean
}

function analyseCadence(dayValues: number[], options: OrderForecastOptions): CadenceAnalysis | null {
  if (dayValues.length < 2) return null

  const intervals: number[] = []
  for (let index = 1; index < dayValues.length; index += 1) {
    intervals.push(dayDiff(dayValues[index] as number, dayValues[index - 1] as number))
  }
  const medianIntervalDays = median(intervals)
  if (medianIntervalDays <= 0) return null

  const intervalSpreadDays = medianAbsoluteDeviation(intervals, medianIntervalDays)
  const dispersion = intervalSpreadDays / medianIntervalDays
  const regularity = clamp(1 - dispersion / options.maxDispersion, 0, 1)

  const weekdayCounts = new Map<number, number>()
  for (const dayMs of dayValues) {
    const weekday = weekdayOf(dayMs)
    weekdayCounts.set(weekday, (weekdayCounts.get(weekday) ?? 0) + 1)
  }
  let dominantWeekday = weekdayOf(dayValues[dayValues.length - 1] as number)
  let weekdayHits = 0
  for (const [weekday, count] of weekdayCounts) {
    if (count > weekdayHits) {
      weekdayHits = count
      dominantWeekday = weekday
    }
  }
  const weekdayShare = weekdayHits / dayValues.length

  const nearestWeekMultiple = Math.max(1, Math.round(medianIntervalDays / 7))
  const gridDistance = Math.abs(medianIntervalDays - nearestWeekMultiple * 7)
  const weekdayAligned = weekdayShare >= options.weekdayShareThreshold
  const isWeekly = weekdayAligned && gridDistance <= options.weeklyGridToleranceDays

  return {
    intervals,
    medianIntervalDays,
    intervalSpreadDays,
    regularity,
    dominantWeekday,
    weekdayHits,
    weekdayShare,
    weekdayAligned,
    isWeekly,
  }
}

/**
 * Fraction of the cycles inside the observed span that the customer actually used.
 *
 * This is the gate that catches the pattern a median interval hides: eight weekly orders followed
 * by a three-month gap still have a median interval of exactly 7 days and a MAD of 0, so both the
 * cadence and the spread look perfect. Coverage is what notices the missing cycles.
 */
function computeCoverage(occurrenceCount: number, spanDays: number, medianIntervalDays: number): {
  coverage: number
  expectedOccurrences: number
} {
  if (medianIntervalDays <= 0) return { coverage: 0, expectedOccurrences: occurrenceCount }
  const expectedOccurrences = Math.floor(spanDays / medianIntervalDays) + 1
  if (expectedOccurrences <= 0) return { coverage: 0, expectedOccurrences: occurrenceCount }
  return {
    coverage: clamp(occurrenceCount / expectedOccurrences, 0, 1),
    expectedOccurrences,
  }
}

function computeSupport(occurrenceCount: number, options: OrderForecastOptions): number {
  const floor = options.minOccurrences
  const ceiling = Math.max(floor + 1, options.supportSaturation)
  return clamp((occurrenceCount - floor + 1) / (ceiling - floor + 1), 0, 1)
}

/**
 * The most lateness that still counts as "late" rather than "stopped", in days past the due date.
 *
 * Both bounds are needed and the tighter one wins. The relative bound alone lets a quarterly
 * product drift for months; the absolute bound alone would call a weekly customer lapsed three
 * weeks in, when the cycle they missed two weeks ago already said so.
 */
export function maxOverdueDaysFor(medianIntervalDays: number, options: OrderForecastOptions): number {
  return Math.min(options.maxOverdueDays, options.overdueToleranceFactor * medianIntervalDays)
}

/**
 * Decays from 1 to 0 across the window between "slightly late" and "no longer buying this".
 *
 * A delivery that has just slipped is still worth showing — it is exactly the call to make today —
 * but it must not keep the confidence it held while the rhythm was intact, and past
 * `maxOverdueDaysFor` it is not shown at all.
 *
 * The decay stops at `recencyFloor` rather than reaching zero, because the geometric mean treats a
 * zero factor as fatal: a row exactly at the limit would vanish reported as "below the confidence
 * threshold" when the honest reason, one line later, is that the rhythm was abandoned. The floor
 * keeps the last day inside the window scoring low but explicable.
 */
function computeRecency(daysSinceLastOrder: number, medianIntervalDays: number, options: OrderForecastOptions): number {
  const overdueDays = Math.max(0, daysSinceLastOrder - medianIntervalDays)
  const graceDays = medianIntervalDays * options.overdueGraceFactor
  const limitDays = maxOverdueDaysFor(medianIntervalDays, options)
  if (overdueDays <= graceDays) return 1
  if (limitDays <= graceDays) return options.recencyFloor
  const decayed = (limitDays - overdueDays) / (limitDays - graceDays)
  return clamp(options.recencyFloor + (1 - options.recencyFloor) * decayed, options.recencyFloor, 1)
}

/**
 * Weighted geometric mean, deliberately not an arithmetic one.
 *
 * Each factor answers a different question — "is there enough evidence", "is the rhythm steady",
 * "did the customer keep it up", "is it still current" — and a near-zero answer to any one of them
 * invalidates the prediction regardless of the other three. An arithmetic mean lets three strong
 * factors carry a fatal one; a geometric mean cannot.
 */
function combineConfidence(
  factors: { support: number; regularity: number; coverage: number; recency: number },
  weights: OrderForecastWeights,
): number {
  const entries: Array<[number, number]> = [
    [factors.support, weights.support],
    [factors.regularity, weights.regularity],
    [factors.coverage, weights.coverage],
    [factors.recency, weights.recency],
  ]
  const weightSum = entries.reduce((total, [, weight]) => total + weight, 0)
  if (weightSum <= 0) return 0
  let logSum = 0
  for (const [value, weight] of entries) {
    if (value <= 0) return 0
    logSum += weight * Math.log(value)
  }
  return clamp(Math.exp(logSum / weightSum), 0, 1)
}

/**
 * Turns the customer's own historical hit rate into a multiplier centred on the prior.
 *
 * A customer whose predictions land exactly as often as the prior expects is left untouched; one
 * whose rhythm has proven more dependable than the prior gets a small lift, one who keeps
 * surprising us gets marked down. The Laplace smoothing means a customer with three scored cycles
 * cannot swing the multiplier the way a customer with fifty can, which is the whole point — this
 * is the part of the system that gets sharper as more orders arrive.
 */
export function calibrationFactorFor(
  calibration: ForecastCalibration | null | undefined,
  options: OrderForecastOptions,
): number {
  if (!calibration || calibration.trials <= 0) return 1
  const smoothedHitRate =
    (calibration.hits + options.calibrationPrior * options.calibrationStrength) /
    (calibration.trials + options.calibrationStrength)
  if (options.calibrationPrior <= 0) return 1
  return clamp(smoothedHitRate / options.calibrationPrior, options.calibrationFloor, options.calibrationCeiling)
}

function bandFor(confidence: number, options: OrderForecastOptions): ConfidenceBand {
  if (confidence >= options.highConfidenceThreshold) return 'high'
  if (confidence >= options.mediumConfidenceThreshold) return 'medium'
  return 'low'
}

/**
 * Snaps a projected date onto the customer's habitual weekday.
 *
 * Only ever moves the date by less than half a week, so a weekday snap cannot silently turn a
 * 7-day rhythm into an 11-day one; if the projection already lands on the right weekday it is
 * returned untouched.
 */
export function snapToWeekday(dayMs: number, weekday: number): number {
  const current = weekdayOf(dayMs)
  let delta = weekday - current
  if (delta > 3) delta -= 7
  if (delta < -3) delta += 7
  return addDays(dayMs, delta)
}

/**
 * Pulls a projected date off a weekday the customer never orders on.
 *
 * A rhythm of nine or seventeen days has no single weekday to snap to, but it still has weekdays it
 * never lands on: a wholesaler whose van does not run at the weekend leaves fourteen months of
 * history without one Saturday order, and a projection falling there asks an operator to plan a
 * delivery on a closed day. The move is bounded by half a week and prefers the earlier day when two
 * are equally close, so a date never drifts later than the rhythm said and one cycle never becomes
 * the next.
 */
export function snapToObservedWeekday(dayMs: number, weekdays: number[]): number {
  const current = weekdayOf(dayMs)
  if (weekdays.length === 0 || weekdays.includes(current)) return dayMs
  let bestDelta: number | null = null
  for (const weekday of weekdays) {
    let delta = weekday - current
    if (delta > 3) delta -= 7
    if (delta < -3) delta += 7
    if (
      bestDelta === null ||
      Math.abs(delta) < Math.abs(bestDelta) ||
      (Math.abs(delta) === Math.abs(bestDelta) && delta < bestDelta)
    ) {
      bestDelta = delta
    }
  }
  return bestDelta === null ? dayMs : addDays(dayMs, bestDelta)
}

/**
 * The weekdays this customer actually places orders on.
 *
 * Read from every order in the window rather than from one product's handful of purchases: which
 * weekday a delivery can land on is a property of the customer's week — their van slot, their
 * kitchen's quiet day, their office hours — not of the towels. Three purchases cannot tell a
 * never-used weekday from one they happened to miss, so below `weekdayCalendarMinOrders` orders the
 * calendar is returned empty and constrains nothing.
 */
export function buildOrderWeekdayCalendar(
  observations: OrderObservation[],
  options: OrderForecastOptions,
  todayMs: number,
): number[] {
  const horizonMs = addDays(todayMs, -options.lookbackDays)
  const orderDays = new Map<string, number>()
  for (const observation of observations) {
    const dayMs = toDayStart(observation.placedAt)
    if (!Number.isFinite(dayMs) || dayMs < horizonMs || dayMs > todayMs) continue
    if (!orderDays.has(observation.orderId)) orderDays.set(observation.orderId, dayMs)
  }
  const distinctDays = new Set(orderDays.values())
  if (distinctDays.size < options.weekdayCalendarMinOrders) return []
  const weekdays = new Set<number>()
  for (const dayMs of distinctDays) weekdays.add(weekdayOf(dayMs))
  return [...weekdays].sort((a, b) => a - b)
}

/**
 * One step forward from the last purchase — deliberately NOT rolled on to the next future slot.
 *
 * Rolling forward reads well until the customer is late, and then it lies in the most damaging
 * direction available: a customer 41 days past due on a monthly product gets a date a fortnight in
 * the FUTURE, which tells the distributor to relax about exactly the account they should be phoning
 * today. Returning the date the delivery was actually due, and letting `overdueDays` say how far
 * past it we are, keeps the two numbers telling the same story — and sorting by that date puts the
 * most overdue rows at the top of the list, where the calls to make are.
 *
 * The interval places the date and the weekday corrects it, in that order and never the reverse.
 * A habitual weekday takes the date onto it — whether or not the interval sits on a clean 7-day
 * grid, because ordering every nine days but always on a Tuesday is a Tuesday habit. Failing that,
 * the customer's own order calendar takes the date off a weekday they never use. Both moves are
 * bounded by half a week, so neither can turn one cycle into the next.
 */
function projectNextOccurrence(
  lastDayMs: number,
  medianIntervalDays: number,
  cadence: { weekdayAligned: boolean; dominantWeekday: number; calendarWeekdays: number[] },
  todayMs: number,
): { nextExpectedMs: number; overdueDays: number } {
  const step = Math.max(1, Math.round(medianIntervalDays))
  const projected = addDays(lastDayMs, step)
  const candidate = cadence.weekdayAligned
    ? snapToWeekday(projected, cadence.dominantWeekday)
    : snapToObservedWeekday(projected, cadence.calendarWeekdays)
  return {
    nextExpectedMs: candidate,
    overdueDays: candidate < todayMs ? dayDiff(todayMs, candidate) : 0,
  }
}

type FeedbackDecision = {
  dismissed: boolean
  snoozed: boolean
  confirmed: boolean
}

function resolveFeedback(
  productKey: string,
  feedback: PredictionFeedbackInput[],
  nowMs: number,
): FeedbackDecision {
  const decision: FeedbackDecision = { dismissed: false, snoozed: false, confirmed: false }
  for (const entry of feedback) {
    if (productKeyOf(entry.productVariantId, entry.productId) !== productKey) continue
    if (entry.validUntil && entry.validUntil.getTime() < nowMs) continue
    if (entry.kind === 'dismissed') decision.dismissed = true
    if (entry.kind === 'snoozed') decision.snoozed = true
    if (entry.kind === 'confirmed') decision.confirmed = true
  }
  return decision
}

export type BuildOrderForecastInput = {
  observations: OrderObservation[]
  now: Date
  options?: Partial<OrderForecastOptions>
  feedback?: PredictionFeedbackInput[]
  calibration?: ForecastCalibration | null
}

export function buildOrderForecast(input: BuildOrderForecastInput): OrderForecast {
  const options = resolveForecastOptions(input.options)
  const nowMs = input.now.getTime()
  const todayMs = toDayStart(input.now)
  const feedback = input.feedback ?? []
  const calibrationFactor = calibrationFactorFor(input.calibration, options)

  const calendarWeekdays = buildOrderWeekdayCalendar(input.observations, options, todayMs)
  const series = groupObservations(input.observations, options, todayMs)
  const predictions: OrderPrediction[] = []
  const rejected: RejectedPrediction[] = []

  for (const entry of series) {
    const occurrences = entry.occurrences
    const lastOrderedMs = occurrences.length > 0 ? (occurrences[occurrences.length - 1] as Occurrence).dayMs : null
    const rejectionBase = {
      productKey: entry.productKey,
      productName: entry.productName,
      occurrences: occurrences.length,
      lastOrderedAt: lastOrderedMs === null ? null : toIsoDate(lastOrderedMs),
    }

    if (occurrences.length < options.minOccurrences) {
      rejected.push({ ...rejectionBase, reason: 'tooFewOrders' })
      continue
    }

    const firstOrderedMs = (occurrences[0] as Occurrence).dayMs
    const lastMs = lastOrderedMs as number
    const spanDays = dayDiff(lastMs, firstOrderedMs)
    if (spanDays < options.minSpanDays) {
      rejected.push({ ...rejectionBase, reason: 'spanTooShort' })
      continue
    }

    const cadence = analyseCadence(occurrences.map((occurrence) => occurrence.dayMs), options)
    if (!cadence) {
      rejected.push({ ...rejectionBase, reason: 'irregular' })
      continue
    }

    const daysSinceLastOrder = dayDiff(todayMs, lastMs)
    if (
      daysSinceLastOrder >
      cadence.medianIntervalDays + maxOverdueDaysFor(cadence.medianIntervalDays, options)
    ) {
      rejected.push({ ...rejectionBase, reason: 'abandoned' })
      continue
    }

    const decision = resolveFeedback(entry.productKey, feedback, nowMs)
    if (decision.dismissed) {
      rejected.push({ ...rejectionBase, reason: 'dismissed' })
      continue
    }
    if (decision.snoozed) {
      rejected.push({ ...rejectionBase, reason: 'snoozed' })
      continue
    }

    const { coverage, expectedOccurrences } = computeCoverage(occurrences.length, spanDays, cadence.medianIntervalDays)
    const support = computeSupport(occurrences.length, options)
    const recency = computeRecency(daysSinceLastOrder, cadence.medianIntervalDays, options)
    const rawConfidence = combineConfidence(
      { support, regularity: cadence.regularity, coverage, recency },
      options.weights,
    )

    let confidence = clamp(rawConfidence * calibrationFactor, 0, options.maxConfidence)
    if (decision.confirmed) {
      confidence = clamp(confidence + (1 - confidence) * options.confirmedFeedbackBoost, 0, options.maxConfidence)
    }
    if (confidence < options.minConfidence) {
      rejected.push({ ...rejectionBase, reason: 'belowConfidence' })
      continue
    }

    const quantities = occurrences.map((occurrence) => occurrence.quantity)
    const predictedQuantity = quantizeQuantity(median(quantities), quantities)
    const unitAmounts = occurrences
      .filter((occurrence) => occurrence.quantity > 0 && occurrence.lineNetAmount > 0)
      .map((occurrence) => occurrence.lineNetAmount / occurrence.quantity)
    const predictedUnitNetAmount = unitAmounts.length > 0 ? median(unitAmounts) : null

    const projection = projectNextOccurrence(
      lastMs,
      cadence.medianIntervalDays,
      { weekdayAligned: cadence.weekdayAligned, dominantWeekday: cadence.dominantWeekday, calendarWeekdays },
      todayMs,
    )

    predictions.push({
      productKey: entry.productKey,
      productId: entry.productId,
      productVariantId: entry.productVariantId,
      productName: entry.productName,
      sku: entry.sku,
      predictedQuantity,
      quantityMin: Math.min(...quantities),
      quantityMax: Math.max(...quantities),
      quantityUnit: entry.quantityUnit,
      predictedUnitNetAmount,
      predictedLineNetAmount:
        predictedUnitNetAmount === null ? null : predictedUnitNetAmount * predictedQuantity,
      currencyCode: entry.currencyCode,
      nextExpectedAt: toIsoDate(projection.nextExpectedMs),
      daysUntilNextExpected: dayDiff(projection.nextExpectedMs, todayMs),
      overdueDays: projection.overdueDays,
      cadence: {
        kind: cadence.isWeekly ? 'weekly' : 'interval',
        intervalDays: cadence.medianIntervalDays,
        dominantWeekday: cadence.weekdayAligned ? cadence.dominantWeekday : null,
        weekdayShare: cadence.weekdayShare,
        weekdayHits: cadence.weekdayHits,
      },
      confidence,
      confidenceBand: bandFor(confidence, options),
      acknowledged: decision.confirmed,
      history: [...occurrences]
        .reverse()
        .slice(0, options.historyDepth)
        .map((occurrence) => ({
          orderedAt: toIsoDate(occurrence.dayMs),
          quantity: occurrence.quantity,
          orderIds: occurrence.orderIds,
        })),
      evidence: {
        occurrences: occurrences.length,
        firstOrderedAt: toIsoDate(firstOrderedMs),
        lastOrderedAt: toIsoDate(lastMs),
        spanDays,
        daysSinceLastOrder,
        medianIntervalDays: cadence.medianIntervalDays,
        intervalSpreadDays: cadence.intervalSpreadDays,
        expectedOccurrences,
        coverage,
        support,
        regularity: cadence.regularity,
        recency,
        rawConfidence,
        calibrationFactor,
      },
    })
  }

  predictions.sort((a, b) => {
    if (a.daysUntilNextExpected !== b.daysUntilNextExpected) {
      return a.daysUntilNextExpected - b.daysUntilNextExpected
    }
    return b.confidence - a.confidence
  })

  return {
    rhythm: buildCustomerRhythm(input.observations, options, todayMs, calendarWeekdays),
    predictions: predictions.slice(0, options.maxPredictions),
    rejected,
    options,
  }
}

/**
 * The customer-level habit, computed from order dates alone.
 *
 * Runs on the same cadence machinery as the per-product analysis but never rejects: a supplier
 * opening a customer card still wants "orders roughly every 9 days, usually Tuesday" even when no
 * single product is regular enough to predict, and the absence of predictions next to a healthy
 * rhythm is itself a useful signal — the customer buys often, but never the same thing twice.
 */
function buildCustomerRhythm(
  observations: OrderObservation[],
  options: OrderForecastOptions,
  todayMs: number,
  calendarWeekdays: number[],
): CustomerOrderRhythm {
  const horizonMs = addDays(todayMs, -options.lookbackDays)
  const orderTotals = new Map<string, { dayMs: number; netAmount: number; currencyCode: string | null }>()
  for (const observation of observations) {
    const dayMs = toDayStart(observation.placedAt)
    if (!Number.isFinite(dayMs) || dayMs < horizonMs || dayMs > todayMs) continue
    if (orderTotals.has(observation.orderId)) continue
    orderTotals.set(observation.orderId, {
      dayMs,
      netAmount: observation.orderNetAmount,
      currencyCode: observation.currencyCode,
    })
  }

  const orders = [...orderTotals.values()].sort((a, b) => a.dayMs - b.dayMs)
  const empty: CustomerOrderRhythm = {
    orderCount: orders.length,
    firstOrderAt: null,
    lastOrderAt: null,
    daysSinceLastOrder: null,
    medianIntervalDays: null,
    intervalSpreadDays: null,
    dominantWeekday: null,
    weekdayShare: 0,
    orderWeekdays: calendarWeekdays,
    nextExpectedOrderAt: null,
    daysUntilNextOrder: null,
    orderOverdueDays: 0,
    typicalOrderNetAmount: null,
    currencyCode: null,
    confidence: 0,
  }
  if (orders.length === 0) return empty

  const firstOrder = orders[0] as { dayMs: number }
  const lastOrder = orders[orders.length - 1] as { dayMs: number }
  const currencyCodes = new Set(orders.map((order) => order.currencyCode ?? ''))
  const typicalOrderNetAmount = median(orders.map((order) => order.netAmount).filter((amount) => amount > 0))

  const base: CustomerOrderRhythm = {
    ...empty,
    firstOrderAt: toIsoDate(firstOrder.dayMs),
    lastOrderAt: toIsoDate(lastOrder.dayMs),
    daysSinceLastOrder: dayDiff(todayMs, lastOrder.dayMs),
    typicalOrderNetAmount: typicalOrderNetAmount > 0 ? typicalOrderNetAmount : null,
    currencyCode: currencyCodes.size === 1 ? (orders[0] as { currencyCode: string | null }).currencyCode : null,
  }

  const cadence = analyseCadence(orders.map((order) => order.dayMs), options)
  if (!cadence) return base

  const { coverage } = computeCoverage(orders.length, dayDiff(lastOrder.dayMs, firstOrder.dayMs), cadence.medianIntervalDays)
  const projection = projectNextOccurrence(
    lastOrder.dayMs,
    cadence.medianIntervalDays,
    { weekdayAligned: cadence.weekdayAligned, dominantWeekday: cadence.dominantWeekday, calendarWeekdays },
    todayMs,
  )

  return {
    ...base,
    medianIntervalDays: cadence.medianIntervalDays,
    intervalSpreadDays: cadence.intervalSpreadDays,
    dominantWeekday: cadence.weekdayAligned ? cadence.dominantWeekday : null,
    weekdayShare: cadence.weekdayShare,
    nextExpectedOrderAt: toIsoDate(projection.nextExpectedMs),
    daysUntilNextOrder: dayDiff(projection.nextExpectedMs, todayMs),
    orderOverdueDays: projection.overdueDays,
    confidence: combineConfidence(
      {
        support: computeSupport(orders.length, options),
        regularity: cadence.regularity,
        coverage,
        recency: computeRecency(base.daysSinceLastOrder ?? 0, cadence.medianIntervalDays, options),
      },
      options.weights,
    ),
  }
}
