import { money, rate as formatRate, toDecimal, ZERO } from '../decimal'
import type { PipelineRunResult } from '../pipeline'
import type {
  PricingBasketLine,
  PricingConfidence,
  PricingContext,
  PricingLineResult,
} from '../types'
import type { PricingInputs } from '../../services/pricingService'
import {
  basketProfit,
  marginPercent,
  minPriceForMargin,
  profitNeutralUnitPrice,
  unitProfit,
} from './margin'
import type { AdvisorOptions, Suggestion, SuggestionChange, SuggestionKind } from './schemas'

export const DEFAULT_MAX_PER_KIND = 1

export type PriceBasket = (lines: PricingBasketLine[], overrides?: BasketOverrides) => Promise<PipelineRunResult>

export type BasketOverrides = { orderScenarioCode?: string }

export type AdvisorRun = {
  context: PricingContext
  baseline: PipelineRunResult
  inputs: PricingInputs
  price: PriceBasket
  options: AdvisorOptions
}

const CONFIDENCE_RANK: Record<PricingConfidence, number> = { default: 0, estimated: 1, measured: 2 }

/** A suggestion is only as trustworthy as its weakest input, so the run reports the floor. */
export function weakestConfidence(line: PricingLineResult): PricingConfidence {
  return line.breakdown.reduce<PricingConfidence>((weakest, component) => {
    return CONFIDENCE_RANK[component.confidence] < CONFIDENCE_RANK[weakest] ? component.confidence : weakest
  }, 'measured')
}

export function toCamelCase(code: string): string {
  return code.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

export function suggestionTitleKey(kind: SuggestionKind): string {
  return `pricing_engine.advisor.suggestion.${toCamelCase(kind)}.title`
}

export function suggestionExplainKey(kind: SuggestionKind, branch: string = 'explain'): string {
  return `pricing_engine.advisor.suggestion.${toCamelCase(kind)}.${branch}`
}

export function breakEvenKey(kind: SuggestionKind): string {
  return `pricing_engine.advisor.breakEven.${toCamelCase(kind)}`
}

export function maxPerKind(options: AdvisorOptions): number {
  return options.maxPerKind ?? DEFAULT_MAX_PER_KIND
}

export function isKindRequested(options: AdvisorOptions, kind: SuggestionKind): boolean {
  return !options.kinds || options.kinds.includes(kind)
}

/**
 * The minimum margin the engine would actually enforce on this line, resolved through the SAME
 * scope precedence the guardrails component uses. `options.minMarginPercent` lets a rep ask
 * "what if I insisted on 15%" without changing the stored rule.
 */
export function resolveMinMarginPercent(
  run: AdvisorRun,
  line: PricingBasketLine,
): { value: string; source: 'guardrail' | 'requested' } | null {
  if (run.options.minMarginPercent !== undefined) {
    return { value: run.options.minMarginPercent, source: 'requested' }
  }
  const product = run.inputs.catalog.byProductId.get(line.productId) ?? null
  const guardrail = run.inputs.params.guardrail({
    productId: line.productId,
    productGroupCode: product?.productGroupCode ?? null,
    customerId: run.context.customerId ?? null,
    customerGroupCode: run.context.customerGroupCode ?? null,
  })
  if (!guardrail?.minMarginPercent) return null
  return { value: guardrail.minMarginPercent, source: 'guardrail' }
}

function profitLines(result: PipelineRunResult) {
  return result.lines.map((line) => ({
    totalPriceNet: line.totalPriceNet,
    unitCostNet: line.unitCostNet,
    quantity: line.line.quantity,
  }))
}

export type SuggestionDraft = {
  code: SuggestionKind
  anchorLine: PricingLineResult
  variant: PipelineRunResult
  variantLine: PricingLineResult
  change: SuggestionChange
  explainKey: string
  explainValues: Record<string, string>
  confidence?: PricingConfidence
  extraBaselineLines?: PipelineRunResult[]
  extraVariantLines?: PipelineRunResult[]
}

/**
 * Turns a before/after pair of pipeline runs into the both-sides figures the advisor promises.
 * `extraBaselineLines` exists for consolidation, where "before" is two separate baskets rather than
 * one — the comparison is only honest when both sides count the same orders.
 */
export function buildSuggestion(run: AdvisorRun, draft: SuggestionDraft): Suggestion {
  const priceBefore = toDecimal(draft.anchorLine.unitPriceNet)
  const priceAfter = toDecimal(draft.variantLine.unitPriceNet)
  const costBefore = toDecimal(draft.anchorLine.unitCostNet)
  const costAfter = toDecimal(draft.variantLine.unitCostNet)

  const beforeRuns = [run.baseline, ...(draft.extraBaselineLines ?? [])]
  const afterRuns = [draft.variant, ...(draft.extraVariantLines ?? [])]
  const basketBefore = basketProfit(beforeRuns.flatMap(profitLines))
  const basketAfter = basketProfit(afterRuns.flatMap(profitLines))

  const minMargin = resolveMinMarginPercent(run, draft.variantLine.line)
  const floor = minMargin ? minPriceForMargin(costAfter, minMargin.value) : null

  return {
    code: draft.code,
    titleKey: suggestionTitleKey(draft.code),
    explainKey: draft.explainKey,
    explainValues: {
      ...draft.explainValues,
      currency: run.context.currencyCode,
      basketProfitBefore: money(basketBefore),
      basketProfitAfter: money(basketAfter),
    },
    breakEvenConditionKey: breakEvenKey(draft.code),
    change: draft.change,
    customerUnitPriceBefore: money(priceBefore),
    customerUnitPriceAfter: money(priceAfter),
    supplierProfitBefore: money(unitProfit(priceBefore, costBefore)),
    supplierProfitAfter: money(unitProfit(priceAfter, costAfter)),
    basketProfitBefore: money(basketBefore),
    basketProfitAfter: money(basketAfter),
    supplierMarginPercentBefore: formatRate(marginPercent(priceBefore, costBefore)),
    supplierMarginPercentAfter: formatRate(marginPercent(priceAfter, costAfter)),
    profitNeutralUnitPrice: money(profitNeutralUnitPrice(costAfter, priceBefore, costBefore)),
    guardrailFloorUnitPrice: floor === null ? null : money(floor),
    confidence: draft.confidence ?? weakestConfidence(draft.variantLine),
    raisesCustomerPrice: priceAfter > priceBefore,
  }
}

export function basketProfitOf(result: PipelineRunResult) {
  return basketProfit(profitLines(result))
}

export function replaceLine(
  lines: PricingBasketLine[],
  index: number,
  patch: Partial<PricingBasketLine>,
): PricingBasketLine[] {
  return lines.map((line, position) => (position === index ? { ...line, ...patch } : line))
}

/** Ranks by absolute basket profit gain — the zloty figure, never the margin percentage. */
export function rankByBasketProfitGain(suggestions: Suggestion[]): Suggestion[] {
  return [...suggestions].sort((left, right) => {
    const leftGain = toDecimal(left.basketProfitAfter) - toDecimal(left.basketProfitBefore)
    const rightGain = toDecimal(right.basketProfitAfter) - toDecimal(right.basketProfitBefore)
    if (rightGain === leftGain) return 0
    return rightGain > leftGain ? 1 : -1
  })
}

/**
 * For suggestions that cut cost at a fixed markup, absolute profit necessarily falls while the
 * customer's price falls further — so ranking them by profit gain would discard every one of them.
 * They are ranked by what the customer actually saves; `profitNeutralUnitPrice` is what the rep
 * charges instead if the zloty matter more than the headline discount.
 */
export function rankByCustomerSaving(suggestions: Suggestion[]): Suggestion[] {
  return [...suggestions].sort((left, right) => {
    const leftSaving = toDecimal(left.customerUnitPriceBefore) - toDecimal(left.customerUnitPriceAfter)
    const rightSaving = toDecimal(right.customerUnitPriceBefore) - toDecimal(right.customerUnitPriceAfter)
    if (rightSaving === leftSaving) return 0
    return rightSaving > leftSaving ? 1 : -1
  })
}

export function improvesBasketProfit(run: AdvisorRun, variant: PipelineRunResult): boolean {
  return basketProfitOf(variant) > basketProfitOf(run.baseline)
}

export function highestValueLineIndex(result: PipelineRunResult): number {
  let bestIndex = 0
  let bestValue = ZERO
  result.lines.forEach((line, index) => {
    const value = toDecimal(line.totalPriceNet)
    if (value > bestValue) {
      bestValue = value
      bestIndex = index
    }
  })
  return bestIndex
}
