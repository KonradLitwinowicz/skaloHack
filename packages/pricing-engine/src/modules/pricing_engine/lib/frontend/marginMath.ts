// Client-side money maths for the margin screens.
//
// The server ledger runs on `lib/decimal.ts` (BigInt, scale 12) and stays the source of truth.
// This file is display-only arithmetic on `Number`, so it must never be used to produce a value
// that gets persisted — it exists so that four lanes render ONE set of figures instead of four.
//
// Percentages follow the engine's convention: a whole-number percent (66.0000 means 66%), the
// same shape as `numeric(7,4)` in the database and `percentToFactor` in `lib/decimal.ts:109`.

const DECIMAL_PLACES = 4
const GROUP_SEPARATOR = ' '
const DECIMAL_SEPARATOR = ','

export type LineMargin = {
  revenueNet: string
  costNet: string
  profitNet: string
  marginPercent: string
  markupPercent: string
}

export type BasketLineInput = {
  unitPriceNet: string
  unitCostNet: string
  quantity: string
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(parsed) ? parsed : 0
}

// Every exit from this file goes through here: a division by zero anywhere upstream would
// otherwise surface to a sales rep as "NaN PLN".
function toFixedString(value: number): string {
  if (!Number.isFinite(value)) return (0).toFixed(DECIMAL_PLACES)
  const formatted = value.toFixed(DECIMAL_PLACES)
  return formatted === `-${(0).toFixed(DECIMAL_PLACES)}` ? (0).toFixed(DECIMAL_PLACES) : formatted
}

// A zero denominator reports 0%, not infinity: a zero-cost line has no finite markup, and the
// screens that consume this would rather show a flat 0 than a symbol a rep cannot act on.
function ratioPercent(numerator: number, denominator: number): string {
  if (denominator === 0) return toFixedString(0)
  return toFixedString((numerator / denominator) * 100)
}

function summarize(revenue: number, cost: number): LineMargin {
  const profit = revenue - cost
  return {
    revenueNet: toFixedString(revenue),
    costNet: toFixedString(cost),
    profitNet: toFixedString(profit),
    // margin is measured against PRICE, markup against COST — see marginFromMarkup below.
    marginPercent: ratioPercent(profit, revenue),
    markupPercent: ratioPercent(profit, cost),
  }
}

export function lineMargin(unitPriceNet: string, unitCostNet: string, quantity: string): LineMargin {
  const quantityValue = toNumber(quantity)
  return summarize(toNumber(unitPriceNet) * quantityValue, toNumber(unitCostNet) * quantityValue)
}

export function basketMargin(lines: BasketLineInput[]): LineMargin {
  let revenue = 0
  let cost = 0
  for (const line of lines) {
    const quantityValue = toNumber(line.quantity)
    revenue += toNumber(line.unitPriceNet) * quantityValue
    cost += toNumber(line.unitCostNet) * quantityValue
  }
  return summarize(revenue, cost)
}

/**
 * margin = (price - cost) / price  =>  price_min = cost / (1 - margin/100).
 * Mirrors the server clamp at `lib/components/guardrails.ts:51-58`.
 * Returns null at margin >= 100, where the equation has no finite solution.
 */
export function minUnitPriceForMargin(unitCostNet: string, minMarginPercent: string): string | null {
  const denominator = 1 - toNumber(minMarginPercent) / 100
  if (denominator <= 0) return null
  return toFixedString(toNumber(unitCostNet) / denominator)
}

/**
 * P1 = C1 + (P0 - C0): the customer receives the entire cost saving and the supplier's ABSOLUTE
 * unit profit is unchanged (margin percent rises, because the same profit sits on a lower price).
 * Re-applying the old markup instead would hand part of the saving back to the supplier.
 */
export function profitNeutralUnitPrice(newCostNet: string, oldPriceNet: string, oldCostNet: string): string {
  return toFixedString(toNumber(newCostNet) + (toNumber(oldPriceNet) - toNumber(oldCostNet)))
}

/**
 * Markup is on COST (66% markup means price = cost x 1.66); margin is on PRICE.
 * margin = markup / (1 + markup), so a 66% markup is a 39.7590% margin — the two are never equal
 * and treating them as interchangeable is the single most expensive mistake on this screen.
 */
export function marginFromMarkup(markupPercent: string): string {
  const markupFactor = toNumber(markupPercent) / 100
  const denominator = 1 + markupFactor
  if (denominator === 0) return toFixedString(0)
  return toFixedString((markupFactor / denominator) * 100)
}

/** The inverse: markup = margin / (1 - margin). Undefined at margin >= 100, which returns 0. */
export function markupFromMargin(marginPercent: string): string {
  const marginFactor = toNumber(marginPercent) / 100
  const denominator = 1 - marginFactor
  if (denominator <= 0) return toFixedString(0)
  return toFixedString((marginFactor / denominator) * 100)
}

/**
 * The only money formatter the pricing screens may use: '1 234,56 PLN'.
 * Money on screen is zloty and grosze. The engine's four-decimal strings stay internal so that
 * repeated arithmetic does not drift; only this last step, the one a person reads, rounds to a
 * coin. Deliberately not `Intl.NumberFormat`: the grouping and separators are fixed so the same
 * ledger figure never renders two ways depending on the browser locale.
 */
const DISPLAY_DECIMAL_PLACES = 2

export function formatMoney(value: string, currencyCode: string): string {
  const amount = toNumber(value)
  const rounded = Number.isFinite(amount) ? amount.toFixed(DISPLAY_DECIMAL_PLACES) : (0).toFixed(DISPLAY_DECIMAL_PLACES)
  const fixed = rounded === `-${(0).toFixed(DISPLAY_DECIMAL_PLACES)}` ? (0).toFixed(DISPLAY_DECIMAL_PLACES) : rounded
  const negative = fixed.startsWith('-')
  const [integerPart, fractionPart] = (negative ? fixed.slice(1) : fixed).split('.')
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_SEPARATOR)
  const body = `${grouped}${DECIMAL_SEPARATOR}${fractionPart}`
  const signed = negative ? `-${body}` : body
  return currencyCode ? `${signed} ${currencyCode}` : signed
}
