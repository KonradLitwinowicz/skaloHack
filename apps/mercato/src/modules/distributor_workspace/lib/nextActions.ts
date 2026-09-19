import { z } from 'zod'
import { buildExpiryWindowDateFilter } from '@open-mercato/core/modules/wms/lib/expiry'

export const NEXT_ACTION_KINDS = [
  'expiringStock',
  'quoteRequestsToAnswer',
  'quotesAwaitingReply',
  'ordersToFulfil',
  'criticalStock',
] as const

export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number]

export type NextActionTone = 'error' | 'warning' | 'info'

export type NextActionSignal = {
  kind: NextActionKind
  count: number
  deadlineAt: string | null
  amount: number | null
  currencyCode: string | null
}

export type NextAction = {
  kind: NextActionKind
  count: number
  href: string
  tone: NextActionTone
  deadlineAt: string | null
  daysUntilDeadline: number | null
  amount: number | null
  currencyCode: string | null
}

// The SAME window the WMS expiry screens use. A second, narrower window here put three different
// numbers for one thing on one screen: this widget said 2, the expiry card said 12, and the list
// both of them link to showed 14. A figure the operator cannot reconcile with the screen next to
// it is worse than no figure, so there is one window and it lives in the WMS module.
export { EXPIRING_SOON_DAYS as EXPIRY_WATCH_DAYS } from '@open-mercato/core/modules/wms/lib/expiry'
export const QUOTE_SILENCE_DAYS = 3

export type ExpiryWatchWindow = {
  /** Start of the UTC day, inclusive. */
  from: Date
  /** Start of the UTC day EXPIRING_SOON_DAYS later, inclusive — the WMS bound is `$lte`. */
  toInclusive: Date
}

/**
 * The window bounds are READ BACK from the WMS filter instead of being recomputed, so the widget
 * cannot drift from the expiry card and the lot list again. `buildExpiryWindowDateFilter`
 * (packages/core/src/modules/wms/lib/expiry.ts) is the single source: it returns
 * `{ $gte: today, $lte: today + EXPIRING_SOON_DAYS }` — a CLOSED interval, which is also what
 * loadOperationalDashboard.ts feeds the `expiringSoon` KPI. A lot expiring exactly at midnight of
 * day +30 therefore counts here as well.
 *
 * It returns a QueryEngine filter (`Record<string, unknown>`), hence the schema: if the WMS window
 * ever changes shape this throws instead of quietly reporting a number nobody can reconcile.
 */
const expiringSoonFilterSchema = z.object({
  expires_at: z.object({
    $gte: z.date(),
    $lte: z.date(),
  }),
})

export function resolveExpiryWatchWindow(now: Date): ExpiryWatchWindow {
  const parsed = expiringSoonFilterSchema.safeParse(buildExpiryWindowDateFilter('expiringSoon', now))
  if (!parsed.success) {
    throw new Error('[internal] WMS expiringSoon window no longer exposes $gte/$lte Date bounds')
  }
  return { from: parsed.data.expires_at.$gte, toInclusive: parsed.data.expires_at.$lte }
}

// How long a customer who asked for a quote in the portal is expected to wait for an answer.
// One day, because the only thing the customer can see is silence: there is no document on their
// side to look at and no status to check, so the deadline starts running the moment they submit.
export const QUOTE_REQUEST_RESPONSE_DAYS = 1

const URGENCY_HORIZON_DAYS = 14
const CRITICAL_DEADLINE_DAYS = 2
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Ranking rule, in one place because it is the whole point of this widget.
 *
 * Two axes decide what the operator opens first:
 *
 * 1. Irreversibility (this table) — how much of the value is gone for good if
 *    nobody reacts. Stock that passes its expiry date is a write-off and
 *    nothing brings it back. A customer request nobody answered sits just under
 *    that: there is no document to re-issue because we never made an offer, and
 *    the customer only ever sees silence, so the deal ends without us learning
 *    that it did — heavier than a quote we did send, lighter than goods we
 *    physically throw away. An expired quote can be re-issued, so it costs a
 *    deal, not the goods. An order waiting to be picked has its revenue already
 *    booked; lateness costs service level. Stock below the safety level has a
 *    supplier lead time in front of it and no single-day cliff at all.
 * 2. Deadline pressure — how close the clock is, scored on a 14-day horizon.
 *
 * Score = weight * (HORIZON + pressure). Because pressure can at most double
 * the weight, a near deadline can lift a lighter kind above a heavier one that
 * is still two weeks out, while at comparable deadlines irreversibility always
 * wins: goods expiring in three days outrank a quote that has been silent for a
 * week, because the expiry date cannot be undone.
 */
const IRREVERSIBILITY_WEIGHT: Record<NextActionKind, number> = {
  expiringStock: 100,
  quoteRequestsToAnswer: 85,
  quotesAwaitingReply: 70,
  ordersToFulfil: 50,
  criticalStock: 40,
}

const ACTION_HREF: Record<NextActionKind, string> = {
  expiringStock: '/backend/wms/lots?expiryWindow=expiringSoon',
  quoteRequestsToAnswer: '/backend/sales/quotes',
  quotesAwaitingReply: '/backend/sales/quotes',
  ordersToFulfil: '/backend/sales/orders',
  criticalStock: '/backend/wms/inventory?lowStock=belowSafety',
}

const BASE_TONE: Record<NextActionKind, NextActionTone> = {
  expiringStock: 'warning',
  quoteRequestsToAnswer: 'warning',
  quotesAwaitingReply: 'info',
  ordersToFulfil: 'info',
  criticalStock: 'warning',
}

export function daysUntil(deadlineAt: string | null, now: Date): number | null {
  if (!deadlineAt) return null
  const deadline = Date.parse(deadlineAt)
  if (!Number.isFinite(deadline)) return null
  return Math.floor((deadline - now.getTime()) / MILLISECONDS_PER_DAY)
}

function deadlinePressure(daysUntilDeadline: number | null): number {
  if (daysUntilDeadline === null) return 0
  if (daysUntilDeadline < 0) return URGENCY_HORIZON_DAYS
  if (daysUntilDeadline >= URGENCY_HORIZON_DAYS) return 0
  return URGENCY_HORIZON_DAYS - daysUntilDeadline
}

function urgencyScore(kind: NextActionKind, daysUntilDeadline: number | null): number {
  return IRREVERSIBILITY_WEIGHT[kind] * (URGENCY_HORIZON_DAYS + deadlinePressure(daysUntilDeadline))
}

function resolveTone(kind: NextActionKind, daysUntilDeadline: number | null): NextActionTone {
  if (daysUntilDeadline !== null && daysUntilDeadline <= CRITICAL_DEADLINE_DAYS) return 'error'
  return BASE_TONE[kind]
}

function normalizeAmount(amount: number | null): number | null {
  if (amount === null || !Number.isFinite(amount)) return null
  return amount
}

/**
 * Amounts are only ever a last-resort ordering hint, never a financial claim:
 * two signals can carry different currencies and are still compared raw here.
 */
function compareActions(left: NextAction, right: NextAction): number {
  const scoreDifference =
    urgencyScore(right.kind, right.daysUntilDeadline) - urgencyScore(left.kind, left.daysUntilDeadline)
  if (scoreDifference !== 0) return scoreDifference
  const amountDifference = (right.amount ?? 0) - (left.amount ?? 0)
  if (amountDifference !== 0) return amountDifference
  if (right.count !== left.count) return right.count - left.count
  if (left.kind === right.kind) return 0
  return left.kind < right.kind ? -1 : 1
}

export function buildNextActions(signals: readonly NextActionSignal[], now: Date): NextAction[] {
  return signals
    .filter((signal) => Number.isFinite(signal.count) && signal.count > 0)
    .map((signal): NextAction => {
      const daysUntilDeadline = daysUntil(signal.deadlineAt, now)
      return {
        kind: signal.kind,
        count: Math.trunc(signal.count),
        href: ACTION_HREF[signal.kind],
        tone: resolveTone(signal.kind, daysUntilDeadline),
        deadlineAt: daysUntilDeadline === null ? null : signal.deadlineAt,
        daysUntilDeadline,
        amount: normalizeAmount(signal.amount),
        currencyCode: signal.currencyCode,
      }
    })
    .sort(compareActions)
}
