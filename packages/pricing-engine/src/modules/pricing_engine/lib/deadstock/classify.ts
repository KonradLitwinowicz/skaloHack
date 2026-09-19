import { div, gt, mul, toDecimal, ZERO } from '../decimal'
import type { Decimal } from '../decimal'
import { dailySalesRate, daysBetween, MONTHS_IN_YEAR, type ProductSalesMetrics } from './metrics'
import type { DeadstockPolicy } from './policy'

/**
 * `never_sold` is deliberately its own class rather than the extreme of `dead`.
 *
 * They are different mistakes with different remedies: dead stock was a correct buy whose demand
 * ended, and never-sold stock was a buy that was wrong on the day it was made. The second is also
 * the only class with no evidence whatsoever about how long clearing it will take, which is why it
 * gets the longer carry horizon.
 */
export type DeadstockClass = 'healthy' | 'slow' | 'dying' | 'dead' | 'never_sold'

/** Why a verdict is being withheld. A suppressed row keeps its metrics and loses its accusation. */
export type DeadstockSuppression = 'new_product' | 'seasonal' | 'decision_dismissed'

export const DEADSTOCK_AT_RISK_CLASSES: readonly DeadstockClass[] = ['slow', 'dying', 'dead', 'never_sold']

export type DeadstockAssessment = {
  productClass: DeadstockClass
  /** The class before suppression, kept so the screen can say what was withheld and why. */
  rawClass: DeadstockClass
  suppression: DeadstockSuppression | null
  reasonKey: string
  coverDays: Decimal | null
  availableDays: number | null
  seasonalityKnown: boolean
  peakMonths: number[]
  nextPeakMonth: number | null
  warnings: string[]
}

export type ClassifyArgs = {
  metrics: ProductSalesMetrics
  onHandQuantity: Decimal
  policy: DeadstockPolicy
  asOf: Date
  /** Earliest date the loaded history could cover. Bounds what "never sold" is allowed to mean. */
  historyStartsAt: Date
  /** FIRST stock receipt, not the most recent one. See `resolveAvailableDays`. */
  stockSince: Date | null
  /** Catalog `launchAt`, where the product has one. */
  launchAt: Date | null
  /** End of an operator dismissal still in force, if any. */
  dismissedUntil: Date | null
}

const RATE_WINDOW_DAYS = 90
/** How far ahead a season may be and still explain today's silence. */
const SEASON_LOOKAHEAD_MONTHS = 6
/**
 * Above this many peak months a product is not seasonal, it is merely uneven.
 *
 * `peakMonthsOf` answers "which months clear half the best month", and on a short, noisy history
 * that is true of most months for most products — so on its own it suppressed 30 positions on the
 * reference dataset against the 9 genuinely seasonal SKUs in it. A real season is a minority of the
 * year; anything selling in half of it or more is just lumpy, and lumpy stock that has gone quiet
 * for six months is exactly what this screen exists to surface.
 */
const SEASON_MAX_PEAK_MONTHS = 5

/**
 * Below this many lifetime orders, a "season" is an artefact of having almost no data.
 *
 * A product bought twice in fourteen months has two peak months by construction — the two months it
 * happened to be bought in — and every other month is "out of season". That is how the reference
 * dataset's one-off tail, which is the plainest deadstock there is, dressed itself up as seasonal:
 * of 26 suppressions, the ones to check first had 2, 4 and 6 lifetime orders. Seasonality is a
 * claim that demand RETURNS, and a claim about recurrence needs enough occurrences to recur.
 */
const SEASON_MIN_ORDERS = 8

/**
 * The calendar months this product actually sells in.
 *
 * Aggregated across years on purpose: the question is whether July is a selling month, not whether
 * last July was. Returns an empty list when nothing ever sold, and all twelve when demand is flat —
 * in both cases there is no season to be out of.
 */
export function peakMonthsOf(metrics: ProductSalesMetrics, seasonalRatio: Decimal): number[] {
  let best = ZERO
  for (const value of metrics.calendarMonthUnits) {
    const units = toDecimal(value)
    if (gt(units, best)) best = units
  }
  if (!gt(best, ZERO)) return []
  const threshold = mul(best, seasonalRatio)
  const months: number[] = []
  for (let month = 0; month < MONTHS_IN_YEAR; month += 1) {
    if (toDecimal(metrics.calendarMonthUnits[month]!) >= threshold) months.push(month)
  }
  return months
}

function nextPeakMonthWithin(peakMonths: number[], currentMonth: number, lookahead: number): number | null {
  if (peakMonths.length === 0 || peakMonths.length === MONTHS_IN_YEAR) return null
  for (let step = 1; step <= lookahead; step += 1) {
    const month = (currentMonth + step) % MONTHS_IN_YEAR
    if (peakMonths.includes(month)) return month
  }
  return null
}

/**
 * How long this product has had a fair chance to sell.
 *
 * Selling needs BOTH conditions, so the clock starts at the LATER of "listed" and "first stocked" —
 * a product listed a year ago but first stocked last week has had a week, not a year.
 *
 * `stockSince` must therefore be the FIRST receipt, never the most recent one. Passing the latest
 * receipt here is the bug this function was written with: a product restocked every four weeks
 * would report four weeks of availability forever, the newness suppressor would fire on all of it,
 * and the screen would show an empty worklist with every verdict silently withheld. Measured on the
 * reference dataset before the fix: 85 suppressed, 0 accused, every one of them "too new".
 *
 * A sale older than that start date overrides it, because a sale is proof the product was already
 * available — whatever the receipt and launch records say.
 */
function resolveAvailableDays(args: ClassifyArgs): number | null {
  const gates: number[] = []
  if (args.launchAt) gates.push(args.launchAt.getTime())
  if (args.stockSince) gates.push(args.stockSince.getTime())

  let start = gates.length > 0 ? Math.max(...gates) : null
  const firstSale = args.metrics.firstSaleAt?.getTime() ?? null
  if (firstSale !== null) start = start === null ? firstSale : Math.min(start, firstSale)

  if (start === null) return null
  return Math.max(0, daysBetween(new Date(start), args.asOf))
}

function resolveCoverDays(metrics: ProductSalesMetrics, onHandQuantity: Decimal): Decimal | null {
  if (!gt(onHandQuantity, ZERO)) return null
  const rate = dailySalesRate(metrics, RATE_WINDOW_DAYS)
  if (!gt(rate, ZERO)) return null
  return div(onHandQuantity, rate)
}

function rawClassOf(args: ClassifyArgs, coverDays: Decimal | null): { productClass: DeadstockClass; reasonKey: string } {
  const { metrics, policy, onHandQuantity } = args

  if (!gt(onHandQuantity, ZERO)) {
    return { productClass: 'healthy', reasonKey: 'pricing_engine.deadstock.reason.noStock' }
  }

  if (!gt(toDecimal(metrics.lifetimeUnits), ZERO)) {
    return { productClass: 'never_sold', reasonKey: 'pricing_engine.deadstock.reason.neverSold' }
  }

  const dormantDays = metrics.daysSinceLastSale ?? Number.POSITIVE_INFINITY
  if (dormantDays >= policy.deadAfterDays) {
    return { productClass: 'dead', reasonKey: 'pricing_engine.deadstock.reason.dormant' }
  }

  if (dormantDays >= policy.dyingAfterDays) {
    return { productClass: 'dying', reasonKey: 'pricing_engine.deadstock.reason.dormantShort' }
  }

  // Still selling, but the trend says it is on its way out. The comparison needs a previous period
  // to fall FROM: a product whose first ever sales landed in the trailing period has collapsed from
  // nothing, which is growth.
  const previous = toDecimal(metrics.previousUnits)
  const trailing = toDecimal(metrics.trailingUnits)
  if (gt(previous, ZERO) && trailing < mul(previous, policy.dyingRatio)) {
    return { productClass: 'dying', reasonKey: 'pricing_engine.deadstock.reason.collapsingTrend' }
  }

  if (coverDays !== null && gt(coverDays, policy.slowCoverDays)) {
    return { productClass: 'slow', reasonKey: 'pricing_engine.deadstock.reason.excessCover' }
  }

  return { productClass: 'healthy', reasonKey: 'pricing_engine.deadstock.reason.healthy' }
}

/**
 * Turns one product's metrics into a verdict, or into an explicit refusal to give one.
 *
 * Pure, because the three rules that matter most — a new product is not a failed one, a seasonal
 * product is not a dead one, and a dismissal expires — are the rules that will be argued about, and
 * arguments are settled by tests rather than by reading a query.
 */
export function classifyDeadstock(args: ClassifyArgs): DeadstockAssessment {
  const { metrics, policy, asOf } = args
  const warnings: string[] = []

  const coverDays = resolveCoverDays(metrics, args.onHandQuantity)
  const { productClass: rawClass, reasonKey } = rawClassOf(args, coverDays)

  const historyDays = Math.max(0, daysBetween(args.historyStartsAt, asOf))
  const seasonalityKnown = historyDays >= 365 && gt(toDecimal(metrics.lifetimeUnits), ZERO)
  const peakMonths = seasonalityKnown ? peakMonthsOf(metrics, policy.seasonalRatio) : []
  const currentMonth = asOf.getUTCMonth()
  const nextPeakMonth = seasonalityKnown
    ? nextPeakMonthWithin(peakMonths, currentMonth, SEASON_LOOKAHEAD_MONTHS)
    : null

  const availableDays = resolveAvailableDays(args)

  if (!seasonalityKnown && DEADSTOCK_AT_RISK_CLASSES.includes(rawClass)) {
    // Said out loud rather than assumed away: with under a year of history, "it does not sell in
    // September" and "it only sells in May" are the same observation.
    warnings.push('pricing_engine.deadstock.warnings.seasonalityUnknown')
  }

  const noVerdict = !DEADSTOCK_AT_RISK_CLASSES.includes(rawClass)
  const base: Omit<DeadstockAssessment, 'productClass' | 'suppression' | 'reasonKey'> = {
    rawClass,
    coverDays,
    availableDays,
    seasonalityKnown,
    peakMonths,
    nextPeakMonth,
    warnings,
  }

  if (noVerdict) {
    return { ...base, productClass: rawClass, suppression: null, reasonKey }
  }

  if (args.dismissedUntil && args.dismissedUntil.getTime() > asOf.getTime()) {
    return {
      ...base,
      productClass: 'healthy',
      suppression: 'decision_dismissed',
      reasonKey: 'pricing_engine.deadstock.reason.dismissed',
    }
  }

  if (availableDays === null) {
    // No dated evidence of when this became sellable. The verdict goes THROUGH, with the gap named.
    //
    // Suppressing here would be the more cautious-looking choice and the wrong one: it would hide a
    // product precisely because the platform knows least about it, and absence of a date is not
    // evidence of newness. Measured on the reference dataset, that inversion hid all fifteen
    // never-sold positions — the single most obvious deadstock class — behind "too new".
    warnings.push('pricing_engine.deadstock.warnings.availabilityUnknown')
  }

  if (availableDays !== null && availableDays < policy.minObservationDays) {
    return {
      ...base,
      productClass: 'healthy',
      suppression: 'new_product',
      reasonKey: 'pricing_engine.deadstock.reason.tooNew',
    }
  }

  // Out of season, with the season ahead: the demand is absent, not gone. Clearing stock now is
  // exactly the wrong move, and a tool that proposes it stops being opened.
  const concentrated = peakMonths.length > 0 && peakMonths.length <= SEASON_MAX_PEAK_MONTHS
  const repeats = metrics.lifetimeOrderCount >= SEASON_MIN_ORDERS
  if (
    seasonalityKnown &&
    concentrated &&
    repeats &&
    nextPeakMonth !== null &&
    !peakMonths.includes(currentMonth)
  ) {
    return {
      ...base,
      productClass: 'healthy',
      suppression: 'seasonal',
      reasonKey: 'pricing_engine.deadstock.reason.seasonal',
    }
  }

  return { ...base, productClass: rawClass, suppression: null, reasonKey }
}
