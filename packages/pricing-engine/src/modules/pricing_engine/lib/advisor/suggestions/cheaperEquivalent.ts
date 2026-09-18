import { money, mul, ONE, percentToFactor, sub, toDecimal, type Decimal } from '../../decimal'
import type { CatalogProductSnapshot } from '../../types'
import {
  buildSuggestion,
  isKindRequested,
  maxPerKind,
  rankByCustomerSaving,
  replaceLine,
  suggestionExplainKey,
  type AdvisorRun,
} from '../runner'
import type { Suggestion } from '../schemas'

const KIND = 'cheaper_equivalent' as const
const MAX_SIBLINGS_PER_LINE = 3

/** Mirrors `product_cost`: list cost less the current annual tier discount. Do not re-derive it. */
function effectiveCost(product: CatalogProductSnapshot): Decimal | null {
  const purchase = product.purchase
  if (!purchase?.lastDeliveryUnitCost) return null
  return mul(
    toDecimal(purchase.lastDeliveryUnitCost),
    sub(ONE, percentToFactor(purchase.currentTierDiscount)),
  )
}

/**
 * Cheaper products in the same `product_group_code`.
 *
 * `product_group_code` is a CATEGORY, not an interchangeability relation — "HoReCa dishwasher
 * chemistry" holds a dozen products that are not substitutes for one another, and no substitutes
 * table exists. Every suggestion from this generator therefore ships at `confidence: 'default'` and
 * needs a human to confirm the two products do the same job.
 */
export async function generateCheaperEquivalentSuggestions(run: AdvisorRun): Promise<Suggestion[]> {
  if (!isKindRequested(run.options, KIND)) return []

  const suggestions: Suggestion[] = []

  for (let lineIndex = 0; lineIndex < run.context.lines.length; lineIndex += 1) {
    const baselineLine = run.baseline.lines[lineIndex]
    if (!baselineLine) continue
    const product = run.inputs.catalog.byProductId.get(baselineLine.line.productId) ?? null
    const groupCode = product?.productGroupCode ?? null
    if (!product || !groupCode) continue
    const ownCost = effectiveCost(product)
    if (ownCost === null) continue

    const siblings = Array.from(run.inputs.catalog.byProductId.values())
      .filter((candidate) => candidate.productId !== product.productId)
      .filter((candidate) => candidate.productGroupCode === groupCode)
      .map((candidate) => ({ candidate, cost: effectiveCost(candidate) }))
      .filter((entry): entry is { candidate: CatalogProductSnapshot; cost: Decimal } => entry.cost !== null)
      .filter((entry) => entry.cost < ownCost)
      .sort((left, right) => (left.cost === right.cost ? 0 : left.cost < right.cost ? -1 : 1))
      .slice(0, MAX_SIBLINGS_PER_LINE)

    for (const sibling of siblings) {
      const variant = await run.price(
        replaceLine(run.context.lines, lineIndex, {
          productId: sibling.candidate.productId,
          sku: sibling.candidate.sku ?? null,
        }),
      )
      const variantLine = variant.lines[lineIndex]
      if (!variantLine) continue

      const priceBefore = toDecimal(baselineLine.unitPriceNet)
      const priceAfter = toDecimal(variantLine.unitPriceNet)
      if (priceAfter >= priceBefore) continue

      suggestions.push(
        buildSuggestion(run, {
          code: KIND,
          anchorLine: baselineLine,
          variant,
          variantLine,
          change: {
            productId: baselineLine.line.productId,
            toProductId: sibling.candidate.productId,
          },
          explainKey: suggestionExplainKey(KIND),
          explainValues: {
            fromSku: product.sku ?? product.productId,
            toSku: sibling.candidate.sku ?? sibling.candidate.productId,
            productGroupCode: groupCode,
            unitPriceBefore: money(priceBefore),
            unitPriceAfter: money(priceAfter),
            unitPriceSaving: money(sub(priceBefore, priceAfter)),
          },
          confidence: 'default',
        }),
      )
    }
  }

  return rankByCustomerSaving(suggestions).slice(0, maxPerKind(run.options))
}
