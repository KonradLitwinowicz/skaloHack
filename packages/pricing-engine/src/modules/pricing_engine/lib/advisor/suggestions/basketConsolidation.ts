import { money, sub, toDecimal } from '../../decimal'
import type { PricingBasketLine } from '../../types'
import {
  buildSuggestion,
  highestValueLineIndex,
  isKindRequested,
  maxPerKind,
  rankByCustomerSaving,
  suggestionExplainKey,
  type AdvisorRun,
} from '../runner'
import type { Suggestion } from '../schemas'

const KIND = 'basket_consolidation' as const

/**
 * Merge two orders into one.
 *
 * The specification asked for a delivery-date move, but `PricingContext` carries no delivery date
 * and `logistics_cost` reads only the zone — so that lever has nothing to bind to. Merging is
 * computable today and saves exactly what is paid once per order instead of twice: the per-order
 * process steps (dispatch, invoicing, order intake) and one `costPerStop`, which ranges from about
 * 36 PLN a drop in the Warsaw centre zone to over 800 in the far zone.
 *
 * "Before" is both baskets priced separately, so the comparison counts the same goods on both sides.
 */
export async function generateBasketConsolidationSuggestions(run: AdvisorRun): Promise<Suggestion[]> {
  if (!isKindRequested(run.options, KIND)) return []
  const others = run.options.consolidateWith ?? []
  if (others.length === 0) return []

  const anchorIndex = highestValueLineIndex(run.baseline)
  const anchorLine = run.baseline.lines[anchorIndex]
  if (!anchorLine) return []

  const suggestions: Suggestion[] = []

  for (const other of others) {
    const otherLines: PricingBasketLine[] = other
      .filter((line) => Boolean(line.productId))
      .map((line) => ({
        productId: line.productId as string,
        variantId: line.variantId ?? null,
        sku: line.sku ?? null,
        quantity: line.quantity,
        enteredQuantity: line.enteredQuantity ?? null,
        enteredUnitCode: line.enteredUnitCode ?? null,
      }))
    if (otherLines.length === 0) continue

    const separate = await run.price(otherLines)
    const merged = await run.price([...run.context.lines, ...otherLines])
    const mergedLine = merged.lines[anchorIndex]
    if (!mergedLine) continue

    const costBefore = toDecimal(anchorLine.unitCostNet)
    const costAfter = toDecimal(mergedLine.unitCostNet)
    if (costAfter >= costBefore) continue

    suggestions.push(
      buildSuggestion(run, {
        code: KIND,
        anchorLine,
        variant: merged,
        variantLine: mergedLine,
        change: { productId: anchorLine.line.productId },
        explainKey: suggestionExplainKey(KIND),
        explainValues: {
          mergedLineCount: String(otherLines.length),
          deliveryZoneCode: run.context.deliveryZoneCode ?? '',
          unitPriceBefore: money(toDecimal(anchorLine.unitPriceNet)),
          unitPriceAfter: money(toDecimal(mergedLine.unitPriceNet)),
          unitCostSaving: money(sub(costBefore, costAfter)),
          separateTotalNet: money(toDecimal(run.baseline.totalNet) + toDecimal(separate.totalNet)),
          mergedTotalNet: merged.totalNet,
        },
        extraBaselineLines: [separate],
      }),
    )
  }

  return rankByCustomerSaving(suggestions).slice(0, maxPerKind(run.options))
}
