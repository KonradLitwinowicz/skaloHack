import type { z } from 'zod'
import { EXPIRING_SOON_DAYS, startOfUtcDay } from '@open-mercato/core/modules/wms/lib/expiry'
import type {
  DEADSTOCK_CLASSES,
  DEADSTOCK_SORT_KEYS,
  DEADSTOCK_SUPPRESSIONS,
  deadstockListResponseSchema,
  deadstockRowSchema,
} from '../deadstock/schemas'

export type DeadstockListResponse = z.infer<typeof deadstockListResponseSchema>
export type DeadstockRowView = z.infer<typeof deadstockRowSchema>
export type DeadstockSortKey = (typeof DEADSTOCK_SORT_KEYS)[number]
export type DeadstockClassName = (typeof DEADSTOCK_CLASSES)[number]
export type DeadstockSuppressionName = (typeof DEADSTOCK_SUPPRESSIONS)[number]

export const CLASS_LABEL_KEYS: Record<DeadstockClassName, string> = {
  healthy: 'pricing_engine.deadstock.class.healthy',
  slow: 'pricing_engine.deadstock.class.slow',
  dying: 'pricing_engine.deadstock.class.dying',
  dead: 'pricing_engine.deadstock.class.dead',
  never_sold: 'pricing_engine.deadstock.class.neverSold',
}

/**
 * Severity, not decoration. `never_sold` is the worst outcome on this screen — the money was spent
 * on goods that never found a buyer — so it carries the same weight as `dead` rather than a softer
 * one for being an older mistake.
 */
export const CLASS_TONE: Record<DeadstockClassName, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  healthy: 'secondary',
  slow: 'outline',
  dying: 'default',
  dead: 'destructive',
  never_sold: 'destructive',
}

export const SUPPRESSION_LABEL_KEYS: Record<DeadstockSuppressionName, string> = {
  new_product: 'pricing_engine.deadstock.suppression.newProduct',
  seasonal: 'pricing_engine.deadstock.suppression.seasonal',
  decision_dismissed: 'pricing_engine.deadstock.suppression.dismissed',
}

/**
 * Money and quantities arrive as fixed-point strings and are formatted for reading only.
 *
 * Parsing to a float here is safe and nowhere else: this value is about to become pixels. Every
 * figure that will be compared, summed or compared against a floor stays a string until the engine
 * turns it back into a scaled integer.
 */
/**
 * Money, in the application's locale, with the currency shown as a CODE rather than a symbol.
 *
 * Two independent decisions are packed in here, and both were measured before being made.
 *
 * ## The locale is passed in, never left to the browser
 *
 * `toLocaleString(undefined, …)` follows the BROWSER's locale, not the application's, so a Polish
 * interface on an English-configured browser prints "83,794.76 PLN" — where the comma is a thousands
 * separator in one reading and a decimal separator in the other. A distributor glancing at that can
 * read eighty-three thousand as eighty-three.
 *
 * ## Code, not symbol — and `Intl` rather than appending it by hand
 *
 * This distributor's data carries PLN and USD together. `currencyDisplay: 'symbol'` renders the
 * first as "520,94 zł" and the second as "680,00 USD": two different notations for the same role,
 * side by side, leaving the reader to work out that these are currencies rather than two ways of
 * writing one. A code is the same shape every time.
 *
 * Appending the code manually — which is what this function used to do — looked equivalent and was
 * not. Measured: for JPY it printed "83 794,76 JPY" where the correct form carries no decimal part
 * at all ("83 795 JPY"), and in `en-US` and `ko-KR` it put the code after the number where those
 * locales put it before ("PLN 83,794.76"). `Intl` knows both facts; a template string cannot.
 */
export function formatAmount(value: string, currencyCode: string, locale: string): string {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return value
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currencyCode,
      currencyDisplay: 'code',
    }).format(parsed)
  } catch {
    // An unknown or malformed currency code makes `Intl` throw. The number is still worth showing.
    return `${parsed.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currencyCode}`
  }
}

export function formatQuantity(value: string, locale: string): string {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return value
  const decimals = Number.isInteger(parsed) ? 0 : 2
  return parsed.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

export type ExpiryFlag = { kind: 'expiringSoon'; days: number } | { kind: 'pastDue'; days: number }

/**
 * Whether a dormant position is ALSO running out of time, and which of the two it is.
 *
 * Three boundary details, each of which has already cost this codebase something:
 *
 * 1. The window is `EXPIRING_SOON_DAYS`, imported from the module that owns expiry. A threshold
 *    copied into a second place drifts.
 * 2. The comparison is CLOSED (`<=`). An open interval here against a closed one there produced
 *    two different answers for one lot on one dashboard earlier today.
 * 3. Both dates are floored to the UTC day before subtracting, matching how the owning module
 *    builds its filter. Comparing raw timestamps would make the answer depend on the hour the page
 *    happened to be opened.
 *
 * Past-due is its own kind, not a negative count: "expires in -10 d" is not a sentence, and stock
 * already over its date needs a different word rather than a smaller number.
 */
export function resolveExpiryFlag(nearestExpiryAt: string | null, now: Date = new Date()): ExpiryFlag | null {
  if (!nearestExpiryAt) return null
  const parsed = Date.parse(nearestExpiryAt)
  if (!Number.isFinite(parsed)) return null

  const msPerDay = 86_400_000
  const days = Math.round(
    (startOfUtcDay(new Date(parsed)).getTime() - startOfUtcDay(now).getTime()) / msPerDay,
  )

  if (days < 0) return { kind: 'pastDue', days: Math.abs(days) }
  return days <= EXPIRING_SOON_DAYS ? { kind: 'expiringSoon', days } : null
}
