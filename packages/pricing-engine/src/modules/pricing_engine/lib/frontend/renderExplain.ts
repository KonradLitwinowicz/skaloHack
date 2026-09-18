import type { QuoteBreakdownComponent } from './quoteTypes'

type TranslateFn = (key: string, fallback?: string) => string

// Explanations are stored as key + values so a calculation from March can be re-rendered in any
// locale. Interpolation happens here, at the edge, never in the ledger.
export function renderExplain(t: TranslateFn, component: QuoteBreakdownComponent): string {
  const template = t(component.explainKey, component.explainKey)
  return template.replace(/\{(\w+)\}/g, (match, token: string) => {
    const value = component.explainValues?.[token]
    if (value === undefined || value === null) return match
    return String(value)
  })
}
