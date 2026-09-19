import { money, sub, toDecimal } from '../../decimal'
import {
  buildSuggestion,
  highestValueLineIndex,
  isKindRequested,
  maxPerKind,
  rankByCustomerSaving,
  suggestionExplainKey,
  type AdvisorRun,
} from '../runner'
import { NON_CHANNEL_SCENARIO_CODES } from '../../seedDefaults'
import type { Suggestion } from '../schemas'

const KIND = 'order_channel_change' as const

/**
 * Move the customer off the expensive ordering channel. `pricing_order_scenarios.step_multipliers`
 * scales `order_intake` from 4.00 (rep visit) down to 0.35 (structured file) and nothing else, so
 * this is a pure, measured per-order labour saving with no new data behind it.
 *
 * The saving is per ORDER, not per unit, so the suggestion is anchored on the basket's
 * highest-value line and the basket figures carry the rest.
 */
export async function generateOrderChannelChangeSuggestions(run: AdvisorRun): Promise<Suggestion[]> {
  if (!isKindRequested(run.options, KIND)) return []

  const currentCode = run.context.orderScenarioCode ?? null
  const anchorIndex = highestValueLineIndex(run.baseline)
  const anchorLine = run.baseline.lines[anchorIndex]
  if (!anchorLine) return []

  const suggestions: Suggestion[] = []

  for (const code of run.inputs.orderScenarioCodes) {
    if (code === currentCode) continue
    // A behaviour is not a channel. `pricing_order_scenarios` stores both, and the code list this
    // loop walks is unfiltered, so the exclusion has to happen here.
    if (NON_CHANNEL_SCENARIO_CODES.includes(code)) continue
    if (!run.inputs.params.orderScenario(code)) continue

    const variant = await run.price(run.context.lines, { orderScenarioCode: code })
    const variantLine = variant.lines[anchorIndex]
    if (!variantLine) continue

    const costBefore = toDecimal(anchorLine.unitCostNet)
    const costAfter = toDecimal(variantLine.unitCostNet)
    if (costAfter >= costBefore) continue

    suggestions.push(
      buildSuggestion(run, {
        code: KIND,
        anchorLine,
        variant,
        variantLine,
        change: { productId: anchorLine.line.productId, toOrderScenarioCode: code },
        explainKey: suggestionExplainKey(KIND),
        explainValues: {
          fromScenario: currentCode ?? '',
          toScenario: code,
          unitPriceBefore: money(toDecimal(anchorLine.unitPriceNet)),
          unitPriceAfter: money(toDecimal(variantLine.unitPriceNet)),
          unitCostSaving: money(sub(costBefore, costAfter)),
          basketTotalBefore: run.baseline.totalNet,
          basketTotalAfter: variant.totalNet,
        },
      }),
    )
  }

  return rankByCustomerSaving(suggestions).slice(0, maxPerKind(run.options))
}
