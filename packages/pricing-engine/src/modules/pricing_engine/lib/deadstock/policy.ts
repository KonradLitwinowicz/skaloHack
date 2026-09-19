import { gt, toDecimal, ZERO } from '../decimal'
import type { Decimal } from '../decimal'

/**
 * Parameter row this feature is configured from.
 *
 * Deadstock thresholds are judgements about a particular business, not constants of retail, so they
 * live in `pricing_component_params` under a synthetic component code — the same trick
 * `objective_weights` uses to get time-versioned, scope-resolved configuration without an entity or
 * a migration of its own.
 *
 * NOTE ON SCOPE: `params.componentPayload` returns the FIRST matching row whole and does not merge
 * rows across the scope chain. A product-scoped row therefore has to carry every field below; a row
 * naming only `deadAfterDays` takes the remaining figures from the constants here, not from the
 * global row it appears to refine.
 */
export const DEADSTOCK_COMPONENT_CODE = 'deadstock_policy'

/** No sale in this many days, with stock on the shelf, is dead rather than slow. */
export const DEFAULT_DEAD_AFTER_DAYS = 180
/** Still selling, but the last sale is older than this and the trend has collapsed. */
export const DEFAULT_DYING_AFTER_DAYS = 90
/** Trailing period below this fraction of the period before it is a collapse, not a dip. */
export const DEFAULT_DYING_RATIO = '0.25'
/** Stock cover beyond this many days is more stock than the demand justifies. */
export const DEFAULT_SLOW_COVER_DAYS = 120
/** Below this much observable history nothing is judged: a new product has no track record. */
export const DEFAULT_MIN_OBSERVATION_DAYS = 90
/** A calendar month reaching this fraction of the best month counts as part of the season. */
export const DEFAULT_SEASONAL_RATIO = '0.5'
/** The shallow rung: worth much less, still worth something. */
export const DEFAULT_DYING_MARGIN_PERCENT = '5'
/** How long clearing a dead position is expected to take, and therefore how much carry it saves. */
export const DEFAULT_CLEAR_HORIZON_MONTHS = '6'
/** Stock that never sold once has no evidence it will, so its horizon is the longer one. */
export const DEFAULT_NEVER_SOLD_HORIZON_MONTHS = '12'

/** A horizon longer than this is a typo, not a plan; carry over it would swallow any floor. */
const MAX_HORIZON_MONTHS = toDecimal('60')
/** Beyond this the window stops being a threshold and starts being "never". */
const MAX_THRESHOLD_DAYS = 3650

export type DeadstockPolicy = {
  deadAfterDays: number
  dyingAfterDays: number
  dyingRatio: Decimal
  slowCoverDays: Decimal
  minObservationDays: number
  seasonalRatio: Decimal
  dyingMarginPercent: string
  clearHorizonMonths: Decimal
  neverSoldHorizonMonths: Decimal
  /** True only when the payload carried every figure consumed here. */
  supplied: boolean
  /** Keys that were present but unusable, so the screen can say which rows were ignored. */
  rejected: string[]
}

const POSITIVE_NUMERIC_TEXT = /^\d+(\.\d+)?$/

function readPositiveDecimal(value: unknown): Decimal | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!POSITIVE_NUMERIC_TEXT.test(text)) return null
  const parsed = toDecimal(text)
  return gt(parsed, ZERO) ? parsed : null
}

function readWholeDays(value: unknown): number | null {
  const parsed = readPositiveDecimal(value)
  if (parsed === null) return null
  const text = typeof value === 'number' ? String(value) : String(value).trim()
  const days = Number.parseInt(text, 10)
  if (!Number.isFinite(days) || days <= 0 || days > MAX_THRESHOLD_DAYS) return null
  return days
}

/** A ratio is a fraction of something, so 0 < value <= 1. A percentage here would be a unit error. */
function readFraction(value: unknown): Decimal | null {
  const parsed = readPositiveDecimal(value)
  if (parsed === null) return null
  return parsed <= toDecimal('1') ? parsed : null
}

function readMargin(value: unknown): string | null {
  const parsed = readPositiveDecimal(value)
  if (parsed === null) return null
  // At 100% margin the minimum-price equation has no finite solution, so the rung would produce no
  // floor at all — and a rung without a floor is worse than no rung.
  return parsed < toDecimal('100') ? String(value).trim() : null
}

function readHorizon(value: unknown): Decimal | null {
  const parsed = readPositiveDecimal(value)
  if (parsed === null) return null
  return parsed <= MAX_HORIZON_MONTHS ? parsed : null
}

export function defaultDeadstockPolicy(): DeadstockPolicy {
  return {
    deadAfterDays: DEFAULT_DEAD_AFTER_DAYS,
    dyingAfterDays: DEFAULT_DYING_AFTER_DAYS,
    dyingRatio: toDecimal(DEFAULT_DYING_RATIO),
    slowCoverDays: toDecimal(String(DEFAULT_SLOW_COVER_DAYS)),
    minObservationDays: DEFAULT_MIN_OBSERVATION_DAYS,
    seasonalRatio: toDecimal(DEFAULT_SEASONAL_RATIO),
    dyingMarginPercent: DEFAULT_DYING_MARGIN_PERCENT,
    clearHorizonMonths: toDecimal(DEFAULT_CLEAR_HORIZON_MONTHS),
    neverSoldHorizonMonths: toDecimal(DEFAULT_NEVER_SOLD_HORIZON_MONTHS),
    supplied: false,
    rejected: [],
  }
}

/**
 * Reads the policy, falling back field by field and naming every field it had to reject.
 *
 * Silent fallback is the failure mode to avoid here: an operator who typed `0.25` where the code
 * wanted `25` would otherwise see a plausible list computed from defaults and believe it reflected
 * the number they entered.
 */
export function readDeadstockPolicy(payload: Record<string, unknown> | null): DeadstockPolicy {
  const policy = defaultDeadstockPolicy()
  if (!payload) return policy

  const rejected: string[] = []
  let present = 0

  const take = <T,>(key: string, read: (value: unknown) => T | null, assign: (value: T) => void) => {
    if (!(key in payload)) return
    present += 1
    const value = read(payload[key])
    if (value === null) rejected.push(key)
    else assign(value)
  }

  take('deadAfterDays', readWholeDays, (value) => { policy.deadAfterDays = value })
  take('dyingAfterDays', readWholeDays, (value) => { policy.dyingAfterDays = value })
  take('dyingRatio', readFraction, (value) => { policy.dyingRatio = value })
  take('slowCoverDays', readWholeDays, (value) => { policy.slowCoverDays = toDecimal(String(value)) })
  take('minObservationDays', readWholeDays, (value) => { policy.minObservationDays = value })
  take('seasonalRatio', readFraction, (value) => { policy.seasonalRatio = value })
  take('dyingMarginPercent', readMargin, (value) => { policy.dyingMarginPercent = value })
  take('clearHorizonMonths', readHorizon, (value) => { policy.clearHorizonMonths = value })
  take('neverSoldHorizonMonths', readHorizon, (value) => { policy.neverSoldHorizonMonths = value })

  // The two dormancy thresholds are a ladder, and a ladder with its rungs crossed classifies
  // everything as the more severe class. Both go back to defaults together, because keeping one
  // supplied value and one default would produce a third ordering nobody configured.
  if (policy.dyingAfterDays >= policy.deadAfterDays) {
    rejected.push('dyingAfterDays', 'deadAfterDays')
    policy.dyingAfterDays = DEFAULT_DYING_AFTER_DAYS
    policy.deadAfterDays = DEFAULT_DEAD_AFTER_DAYS
  }

  policy.rejected = rejected
  policy.supplied = present > 0 && rejected.length === 0
  return policy
}
