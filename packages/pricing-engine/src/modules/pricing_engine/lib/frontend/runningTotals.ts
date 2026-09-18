import type { QuoteBreakdownComponent } from './quoteTypes'

// The API returns each component's own contribution; the waterfall needs the cumulative value.
// Recomputing it here keeps the wire payload minimal and the display honest about ordering.
export function withRunningTotals(breakdown: QuoteBreakdownComponent[]): QuoteBreakdownComponent[] {
  let running = 0
  return breakdown.map((component) => {
    const value = Number(component.value ?? 0)
    running = component.effect === 'add' ? running + value : running * value
    return { ...component, runningTotal: running.toFixed(4) }
  })
}
