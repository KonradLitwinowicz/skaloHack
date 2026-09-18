import { format, money, sub, toDecimal } from '../../decimal'
import { ceilToMultiple, packLadder } from '../quantity'
import {
  basketProfitOf,
  buildSuggestion,
  isKindRequested,
  maxPerKind,
  rankByBasketProfitGain,
  replaceLine,
  suggestionExplainKey,
  type AdvisorRun,
} from '../runner'
import type { Suggestion } from '../schemas'

const KIND = 'full_pack_rounding' as const

/**
 * Round a line up to a whole carton or pallet using the product's own unit conversions.
 *
 * Crossing a pack boundary is NOT automatically cheaper per unit: the seeded box row costs
 * 1.85 material + 1.5 min of warehouse time, and `packaging_cost` charges a whole extra pack the
 * moment the count crosses. The generator therefore reports the re-run result — including a rise —
 * instead of asserting a saving; a rise ships with `raisesCustomerPrice: true` so no
 * customer-facing surface can show it.
 */
export async function generateFullPackRoundingSuggestions(run: AdvisorRun): Promise<Suggestion[]> {
  if (!isKindRequested(run.options, KIND)) return []

  const suggestions: Suggestion[] = []
  const baselineProfit = basketProfitOf(run.baseline)

  for (let lineIndex = 0; lineIndex < run.context.lines.length; lineIndex += 1) {
    const baselineLine = run.baseline.lines[lineIndex]
    if (!baselineLine) continue
    const product = run.inputs.catalog.byProductId.get(baselineLine.line.productId) ?? null
    const currentQuantity = toDecimal(baselineLine.line.quantity)

    for (const pack of packLadder(product?.unitConversions ?? {})) {
      const rounded = ceilToMultiple(currentQuantity, pack.factor)
      if (rounded === currentQuantity) continue

      const variant = await run.price(
        replaceLine(run.context.lines, lineIndex, { quantity: format(rounded, 0) }),
      )
      const variantLine = variant.lines[lineIndex]
      if (!variantLine) continue

      const priceBefore = toDecimal(baselineLine.unitPriceNet)
      const priceAfter = toDecimal(variantLine.unitPriceNet)
      const raises = priceAfter > priceBefore
      if (raises && basketProfitOf(variant) <= baselineProfit) continue

      suggestions.push(
        buildSuggestion(run, {
          code: KIND,
          anchorLine: baselineLine,
          variant,
          variantLine,
          change: {
            productId: baselineLine.line.productId,
            fromQuantity: baselineLine.line.quantity,
            toQuantity: variantLine.line.quantity,
          },
          explainKey: suggestionExplainKey(KIND, raises ? 'explainRaises' : 'explain'),
          explainValues: {
            sku: product?.sku ?? baselineLine.line.productId,
            packUnitCode: pack.unitCode,
            packFactor: format(pack.factor, 0),
            fromQuantity: baselineLine.line.quantity,
            toQuantity: variantLine.line.quantity,
            unitPriceBefore: money(priceBefore),
            unitPriceAfter: money(priceAfter),
            unitPriceDelta: money(sub(priceAfter, priceBefore)),
          },
        }),
      )
    }
  }

  return rankByBasketProfitGain(suggestions).slice(0, maxPerKind(run.options))
}
