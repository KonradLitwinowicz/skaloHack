import { div, HUNDRED, isZero, max, min, money, mul, rate, sub, toDecimal } from '../decimal'

// `pricing_shadow_observations.delta_percent` is `numeric(7,4)`. A line invoiced at a fraction of
// what the engine wants produces a percentage Postgres cannot store, and an overflow there would
// abort the observation write — which is exactly the case worth recording. Clamping keeps the row.
const DELTA_PERCENT_LIMIT = toDecimal('999.9999')

export type ShadowObservationDraft = {
  invoicedUnitPriceNet: string
  engineUnitPriceNet: string
  /**
   * Signed, in the observation's currency: `engine - invoiced`. Positive means the engine wants
   * more than was billed. An unsigned magnitude would answer "how far apart" but not "which way",
   * and the direction is the whole point of the screen this feeds.
   */
  deltaAbsolute: string
  deltaPercent: string
  /**
   * False when the invoiced amount is zero: no ratio exists against a zero base, so `deltaPercent`
   * carries a filler `0` that a reader must not mistake for agreement.
   */
  hasDeltaPercent: boolean
  /** True when the real percentage exceeded `numeric(7,4)` and was clamped to the column's range. */
  deltaPercentClamped: boolean
}

export function buildShadowObservationDraft(
  invoicedUnitPriceNet: string | number | null | undefined,
  engineUnitPriceNet: string | number | null | undefined,
): ShadowObservationDraft {
  const invoiced = toDecimal(invoicedUnitPriceNet)
  const engine = toDecimal(engineUnitPriceNet)
  const delta = sub(engine, invoiced)

  const hasDeltaPercent = !isZero(invoiced)
  const rawPercent = hasDeltaPercent ? mul(div(delta, invoiced), HUNDRED) : 0n
  const clampedPercent = min(max(rawPercent, -DELTA_PERCENT_LIMIT), DELTA_PERCENT_LIMIT)

  return {
    invoicedUnitPriceNet: money(invoiced),
    engineUnitPriceNet: money(engine),
    deltaAbsolute: money(delta),
    deltaPercent: rate(clampedPercent),
    hasDeltaPercent,
    deltaPercentClamped: clampedPercent !== rawPercent,
  }
}
