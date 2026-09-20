import type { QuoteBreakdownComponent } from './quoteTypes'

type TranslateFn = (key: string, fallback?: string) => string

// Explanations are stored as key + values so a calculation from March can be re-rendered in any
// locale. Interpolation happens here, at the edge, never in the ledger.
// The ledger keeps four decimals so repeated arithmetic does not drift; a person reads zloty and
// grosze. Anything that looks like a four-decimal amount is shown rounded to two — percentages and
// counts carry their own shape and pass through untouched.
const FOUR_DECIMAL_AMOUNT = /^-?\d+\.\d{4}$/

function displayValue(value: unknown): string {
  const text = String(value)
  if (!FOUR_DECIMAL_AMOUNT.test(text)) return text
  const rounded = Number(text).toFixed(2)
  return rounded === '-0.00' ? '0.00' : rounded
}

export function renderExplain(t: TranslateFn, component: QuoteBreakdownComponent): string {
  const template = t(component.explainKey, component.explainKey)
  return template.replace(/\{(\w+)\}/g, (match, token: string) => {
    const value = component.explainValues?.[token]
    if (value === undefined || value === null) return match
    return displayValue(value)
  })
}
