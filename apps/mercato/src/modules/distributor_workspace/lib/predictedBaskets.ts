/**
 * Turns per-product predictions into the thing a distributor actually handles: a delivery.
 *
 * A customer does not order a product, they order a basket. The per-product layer underneath
 * (`orderForecast.ts`) is where the evidence lives — this product, this rhythm, this many past
 * purchases — but a list of loose products is not a unit of work. Nobody picks one line, nobody
 * loads one line onto a van, and nobody phones a customer to ask about one line. They ask "what is
 * going out on Monday", and the answer is a basket with a date, a line count and a value.
 *
 * The grouping is not a cosmetic `group by date`. A customer has ONE delivery rhythm — their van
 * slot — and products ride on it at multiples of that rhythm: towels every week, chemicals every
 * second week, gloves every fourth. So the baskets are built on the customer's own projected
 * delivery dates and each product prediction is attached to the delivery it falls on. That is how
 * standing orders behave, and it is why a weekly customer's monthly items arrive inside a weekly
 * delivery rather than in a delivery of their own.
 *
 * Predictions that match no delivery anchor still form a basket of their own rather than being
 * dropped: a customer with no readable order rhythm can still have one dependable product, and
 * losing it here would make the basket view strictly worse than the product view it replaces.
 */

import type { ConfidenceBand, CustomerOrderRhythm, OrderPrediction } from './orderForecast'
import { median, snapToObservedWeekday, snapToWeekday, toDayStart, weekdayOf } from './orderForecast'

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

export type BasketOptions = {
  /** How far a product's own due date may sit from a delivery date and still ride on it. */
  toleranceDays: number
  /** How many deliveries ahead to project from the customer's rhythm. */
  maxDeliveries: number
  /**
   * Confidence retained per additional cycle projected forward.
   *
   * The second delivery ahead is a weaker claim than the next one and the fifth weaker still, and
   * a flat number across all of them would quietly present a guess about five weeks' time with the
   * assurance of tomorrow's van.
   */
  cycleDecay: number
  highConfidenceThreshold: number
  mediumConfidenceThreshold: number
}

export const DEFAULT_BASKET_OPTIONS: BasketOptions = {
  toleranceDays: 3,
  maxDeliveries: 8,
  cycleDecay: 0.88,
  highConfidenceThreshold: 0.75,
  mediumConfidenceThreshold: 0.55,
}

export type PredictedBasket = {
  expectedAt: string
  /** 0 for the delivery due next, 1 for the one after it, and so on. */
  cycleIndex: number
  weekday: number
  daysUntilExpected: number
  overdueDays: number
  lines: OrderPrediction[]
  lineCount: number
  totalQuantity: number
  totalNetAmount: number | null
  currencyCode: string | null
  confidence: number
  confidenceBand: ConfidenceBand
  acknowledgedLines: number
  /** True when this basket sits on the customer's own delivery rhythm rather than on one product's. */
  onRhythm: boolean
}

export function resolveBasketOptions(overrides?: Partial<BasketOptions>): BasketOptions {
  return { ...DEFAULT_BASKET_OPTIONS, ...(overrides ?? {}) }
}

function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function parseIsoDate(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`)
}

function dayDiff(laterMs: number, earlierMs: number): number {
  return Math.round((laterMs - earlierMs) / MILLISECONDS_PER_DAY)
}

/**
 * The customer's next few delivery dates, projected from their own order rhythm.
 *
 * Starts one interval after the last order and runs forward, so a customer who is late still gets
 * an anchor in the past — the delivery that did not come is exactly the one the operator needs to
 * see, and dropping it would silently move every overdue line into a basket of its own.
 *
 * Every projected slot passes the same weekday correction the per-product dates do: onto the
 * customer's habitual weekday when they have one, otherwise off any weekday they have never ordered
 * on. A van slot the customer keeps on Tuesdays stays on Tuesdays eight cycles out, instead of
 * drifting a day per cycle on a rhythm the median rounded.
 */
export function projectDeliveryDates(
  rhythm: CustomerOrderRhythm,
  options: BasketOptions,
): number[] {
  if (!rhythm.lastOrderAt || rhythm.medianIntervalDays === null || rhythm.medianIntervalDays <= 0) {
    return []
  }
  const step = Math.max(1, Math.round(rhythm.medianIntervalDays))
  const lastMs = parseIsoDate(rhythm.lastOrderAt)
  if (!Number.isFinite(lastMs)) return []

  const dates: number[] = []
  for (let index = 1; index <= options.maxDeliveries; index += 1) {
    const projected = lastMs + index * step * MILLISECONDS_PER_DAY
    const candidate =
      rhythm.dominantWeekday === null
        ? snapToObservedWeekday(projected, rhythm.orderWeekdays)
        : snapToWeekday(projected, rhythm.dominantWeekday)
    dates.push(candidate)
  }
  return dates
}

function bandFor(confidence: number, options: BasketOptions): ConfidenceBand {
  if (confidence >= options.highConfidenceThreshold) return 'high'
  if (confidence >= options.mediumConfidenceThreshold) return 'medium'
  return 'low'
}

export type BuildPredictedBasketsInput = {
  predictions: OrderPrediction[]
  rhythm: CustomerOrderRhythm
  now: Date
  options?: Partial<BasketOptions>
}

export function buildPredictedBaskets(input: BuildPredictedBasketsInput): PredictedBasket[] {
  const options = resolveBasketOptions(input.options)
  const todayMs = toDayStart(input.now)
  const anchors = projectDeliveryDates(input.rhythm, options)
  const toleranceMs = options.toleranceDays * MILLISECONDS_PER_DAY
  const lastAnchorMs = anchors.length > 0 ? (anchors[anchors.length - 1] as number) : null

  type Bucket = { lines: Array<{ prediction: OrderPrediction; cycle: number }>; onRhythm: boolean }
  const byAnchor = new Map<number, Bucket>()

  const assign = (dueMs: number, prediction: OrderPrediction, cycle: number): void => {
    let bestAnchor: number | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const anchor of anchors) {
      const distance = Math.abs(anchor - dueMs)
      if (distance <= toleranceMs && distance < bestDistance) {
        bestAnchor = anchor
        bestDistance = distance
      }
    }
    // No delivery to ride on: open an anchor of this product's own, reusing one already opened
    // nearby so two products due a day apart do not become two separate deliveries.
    if (bestAnchor === null) {
      for (const [anchor, bucket] of byAnchor) {
        if (bucket.onRhythm) continue
        const distance = Math.abs(anchor - dueMs)
        if (distance <= toleranceMs && distance < bestDistance) {
          bestAnchor = anchor
          bestDistance = distance
        }
      }
    }
    const anchorMs = bestAnchor ?? dueMs
    const bucket = byAnchor.get(anchorMs) ?? { lines: [], onRhythm: anchors.includes(anchorMs) }
    if (!bucket.lines.some((entry) => entry.prediction.productKey === prediction.productKey)) {
      bucket.lines.push({ prediction, cycle })
    }
    byAnchor.set(anchorMs, bucket)
  }

  /**
   * Each product is projected across the whole delivery window, not just onto its next due date.
   *
   * A weekly customer's basket next Monday and their basket the Monday after are different baskets:
   * the weekly staples appear in both, the fortnightly chemicals in only one of them. Stopping at
   * the first occurrence would answer "what is in the next delivery" and leave "what is coming the
   * week after" — the question a distributor plans stock and van loads against — unanswerable.
   */
  for (const prediction of input.predictions) {
    const firstDueMs = parseIsoDate(prediction.nextExpectedAt)
    if (!Number.isFinite(firstDueMs)) continue
    const step = Math.max(1, Math.round(prediction.cadence.intervalDays)) * MILLISECONDS_PER_DAY
    const horizonMs = lastAnchorMs ?? firstDueMs

    let cycle = 0
    for (let dueMs = firstDueMs; dueMs <= horizonMs && cycle < options.maxDeliveries; dueMs += step) {
      assign(dueMs, prediction, cycle)
      cycle += 1
    }
  }

  const orderedAnchors = [...byAnchor.keys()].sort((a, b) => a - b)
  const cycleIndexByAnchor = new Map(orderedAnchors.map((anchor, index) => [anchor, index]))

  const baskets: PredictedBasket[] = []
  for (const [anchorMs, bucket] of byAnchor) {
    const cycleIndex = cycleIndexByAnchor.get(anchorMs) ?? 0
    const lines = bucket.lines
      .map((entry) => ({
        ...entry.prediction,
        confidence: entry.prediction.confidence * Math.pow(options.cycleDecay, entry.cycle),
      }))
      .sort((a, b) => b.confidence - a.confidence)
      .map((line) => ({ ...line, confidenceBand: bandFor(line.confidence, options) }))

    const currencies = new Set(lines.map((line) => line.currencyCode ?? ''))
    const singleCurrency = currencies.size === 1 ? lines[0]?.currencyCode ?? null : null
    const amounts = lines.map((line) => line.predictedLineNetAmount)
    const everyLinePriced = amounts.every((amount) => amount !== null)
    const basketConfidence = median(lines.map((line) => line.confidence))

    baskets.push({
      expectedAt: toIsoDate(anchorMs),
      cycleIndex,
      weekday: weekdayOf(anchorMs),
      daysUntilExpected: dayDiff(anchorMs, todayMs),
      overdueDays: anchorMs < todayMs ? dayDiff(todayMs, anchorMs) : 0,
      lines,
      lineCount: lines.length,
      totalQuantity: lines.reduce((total, line) => total + line.predictedQuantity, 0),
      // A total is money only when every line carries a price and they are all in one currency;
      // a partial sum under a currency symbol is a number nobody can act on.
      totalNetAmount:
        everyLinePriced && singleCurrency !== null
          ? amounts.reduce((total, amount) => total + (amount ?? 0), 0)
          : null,
      currencyCode: singleCurrency,
      /**
       * The median line, not the strongest and not the average.
       * A basket's headline number should describe what a typical line in it is worth trusting;
       * the maximum would let one dependable staple vouch for six guesses riding alongside it.
       */
      confidence: basketConfidence,
      confidenceBand: bandFor(basketConfidence, options),
      acknowledgedLines: lines.filter((line) => line.acknowledged).length,
      onRhythm: bucket.onRhythm,
    })
  }

  return baskets.sort((a, b) => {
    if (a.daysUntilExpected !== b.daysUntilExpected) return a.daysUntilExpected - b.daysUntilExpected
    return b.confidence - a.confidence
  })
}
