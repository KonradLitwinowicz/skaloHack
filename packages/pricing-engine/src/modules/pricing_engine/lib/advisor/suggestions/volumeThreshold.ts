import { add, format, money, sub, toDecimal } from '../../decimal'
import type { PricingBasketLine } from '../../types'
import { scaleQuantity, uniqueAscending } from '../quantity'
import {
  buildSuggestion,
  improvesBasketProfit,
  isKindRequested,
  maxPerKind,
  rankByBasketProfitGain,
  replaceLine,
  suggestionExplainKey,
  type AdvisorRun,
} from '../runner'
import type { Suggestion } from '../schemas'

const KIND = 'volume_threshold' as const

// Growth steps only. Fixed per-order cost amortises as 1/q, so the curve is steep at small
// quantities and flat at large ones; three multiplicative steps sample it without turning one
// advisory call into a hundred pipeline runs.
//
// The pack ladder deliberately does NOT appear here. `full_pack_rounding` owns whole-pack
// quantities and explains them better, naming the carton or pallet being filled; generating the
// same quantity from both kinds produced two cards for one action, and `maxPerKind` caps only
// within a kind, so the count on screen overstated how many distinct moves the rep actually had.
const GROWTH_FACTORS = ['1.25', '1.5', '2']

function candidateQuantities(current: bigint): bigint[] {
  return uniqueAscending(GROWTH_FACTORS.map((factor) => scaleQuantity(current, factor))).filter(
    (value) => value > current,
  )
}

/**
 * The honest volume suggestion this data supports. `next_tier_volume` / `next_tier_discount` are
 * ANNUAL purchase thresholds against the distributor's own supplier (`annual_volume x 1.25` on the
 * seeded tenant), not per-order rebate tiers, so they are reported as an awareness flag rather than
 * used to claim the order itself earns a discount. The price fall the suggestion promises is real
 * and measured: it comes from `operational_cost_base` and `logistics_cost`, both of which are fixed
 * per order and therefore fall as 1/q.
 */
export async function generateVolumeThresholdSuggestions(run: AdvisorRun): Promise<Suggestion[]> {
  if (!isKindRequested(run.options, KIND)) return []

  const suggestions: Suggestion[] = []

  for (let lineIndex = 0; lineIndex < run.context.lines.length; lineIndex += 1) {
    const baselineLine = run.baseline.lines[lineIndex]
    if (!baselineLine) continue
    const product = run.inputs.catalog.byProductId.get(baselineLine.line.productId) ?? null
    const currentQuantity = toDecimal(baselineLine.line.quantity)

    for (const candidate of candidateQuantities(currentQuantity)) {
      const variantLines: PricingBasketLine[] = replaceLine(run.context.lines, lineIndex, {
        quantity: format(candidate, 0),
      })
      const variant = await run.price(variantLines)
      const variantLine = variant.lines[lineIndex]
      if (!variantLine) continue

      const priceBefore = toDecimal(baselineLine.unitPriceNet)
      const priceAfter = toDecimal(variantLine.unitPriceNet)
      if (priceAfter >= priceBefore) continue
      if (!improvesBasketProfit(run, variant)) continue

      const purchase = product?.purchase ?? null
      const addedUnits = sub(candidate, currentQuantity)
      const crossesNextTier =
        purchase?.nextTierVolume != null &&
        add(toDecimal(purchase.annualVolume), addedUnits) >= toDecimal(purchase.nextTierVolume)

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
          explainKey: suggestionExplainKey(KIND, crossesNextTier ? 'explainNextTier' : 'explain'),
          explainValues: {
            sku: product?.sku ?? baselineLine.line.productId,
            fromQuantity: baselineLine.line.quantity,
            toQuantity: variantLine.line.quantity,
            unitPriceBefore: money(priceBefore),
            unitPriceAfter: money(priceAfter),
            unitPriceSaving: money(sub(priceBefore, priceAfter)),
            nextTierVolume: purchase?.nextTierVolume ?? '',
            nextTierDiscount: purchase?.nextTierDiscount ?? '',
          },
        }),
      )
    }
  }

  return rankByBasketProfitGain(suggestions).slice(0, maxPerKind(run.options))
}
