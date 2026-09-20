import type { QuoteLine, QuoteResponse } from './quoteTypes'

export const PRODUCT_COST_CODE = 'product_cost'

export type CostComponentTotal = {
  code: string
  labelKey: string
  /** Summed across every line of the basket, at the quantity each line carries. */
  amount: number
  /** The weakest confidence any line reported for this component. */
  confidence: 'measured' | 'estimated' | 'default'
}

export type BasketCostBreakdown = {
  /** What the goods themselves cost us across the whole basket. */
  goods: number
  /** Everything else the basket costs to serve: intake, picking, packing, storage, delivery. */
  handling: number
  total: number
  components: CostComponentTotal[]
}

const CONFIDENCE_RANK = { default: 0, estimated: 1, measured: 2 } as const

function toNumber(value: string | null | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Turns the per-line, per-unit breakdown the engine returns into one list of what the basket costs
 * and why.
 *
 * The summary card printed a single number and called it the cost to serve, which left the
 * operator with no way to see that most of it was goods, or that it moves with quantity because
 * the per-document and per-line parts are spread over the units.
 *
 * Only `add` components count. A `mul` component scales the running total rather than contributing
 * an amount of its own, so summing it alongside the others would double-count.
 */
export function summariseBasketCost(quote: QuoteResponse | null): BasketCostBreakdown | null {
  if (!quote || !Array.isArray(quote.lines) || quote.lines.length === 0) return null

  const byCode = new Map<string, CostComponentTotal>()
  for (const line of quote.lines as QuoteLine[]) {
    const quantity = toNumber(line.quantity)
    for (const component of line.breakdown ?? []) {
      if (component.effect !== 'add') continue
      const amount = toNumber(component.value) * quantity
      const current = byCode.get(component.code)
      if (current) {
        current.amount += amount
        if (CONFIDENCE_RANK[component.confidence] < CONFIDENCE_RANK[current.confidence]) {
          current.confidence = component.confidence
        }
      } else {
        byCode.set(component.code, {
          code: component.code,
          labelKey: component.labelKey,
          amount,
          confidence: component.confidence,
        })
      }
    }
  }

  if (byCode.size === 0) return null

  const components = [...byCode.values()].sort((left, right) => right.amount - left.amount)
  const goods = byCode.get(PRODUCT_COST_CODE)?.amount ?? 0
  const total = components.reduce((sum, component) => sum + component.amount, 0)

  return { goods, handling: total - goods, total, components }
}
