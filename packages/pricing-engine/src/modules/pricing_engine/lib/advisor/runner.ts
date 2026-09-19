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
import { measureObjectiveMetrics, resolveObjectives, scoreObjectives } from './objectives'
import type {
  AdvisorOptions,
  Suggestion,
  SuggestionChange,
  SuggestionKind,
  SuggestionSubject,
} from './schemas'

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

// `change.productId` is not a subject: `order_channel_change` and `basket_consolidation` both set it
// to the highest-value line merely as an anchor for the before/after arithmetic, while the change
// they describe applies to the whole order. Presence of an id therefore cannot decide this — the
// kind must, and it is spelled out rather than inferred.
const WHOLE_ORDER_KINDS: SuggestionKind[] = ['order_channel_change', 'basket_consolidation']

/**
 * Which product the card is about. A card titled "Round up to a whole pack" over a five-line basket
 * is unactionable without it, and the change payload carries only an id — the rep needs the name.
 * Null for suggestions that act on the whole order, because naming one line there would be a lie.
 */
function resolveSubject(run: AdvisorRun, draft: SuggestionDraft): SuggestionSubject | null {
  if (WHOLE_ORDER_KINDS.includes(draft.code)) return null
  const productId = draft.change.toProductId ?? draft.change.productId ?? null
  if (!productId) return null
  const product = run.inputs.catalog.byProductId.get(productId) ?? null
  return {
    productId,
    sku: product?.sku ?? draft.variantLine.line.sku ?? null,
    title: product?.title ?? null,
  }
}

/** Two kinds proposing the same move are one move. Identity is the change, never the kind. */
function changeIdentity(suggestion: Suggestion): string {
  const { productId, fromQuantity, toQuantity, toProductId, toOrderScenarioCode } = suggestion.change
  return [productId, fromQuantity, toQuantity, toProductId, toOrderScenarioCode]
    .map((part) => part ?? '')
    .join('|')
}

/**
 * Only line-level moves can collide. `basket_consolidation` emits one suggestion per basket in
 * `consolidateWith` and records nothing in `change` that tells them apart, so collapsing on that
 * payload would silently drop four of five merge options — deduplication must not become deletion.
 */
function isDeduplicable(suggestion: Suggestion): boolean {
  return Boolean(suggestion.change.toQuantity || suggestion.change.toProductId)
}

// When two kinds land on the same quantity, the pack-rounding card wins: it names the carton or
// pallet being filled, so it explains the identical action strictly better than a bare "order more".
const IDENTICAL_CHANGE_PRIORITY: SuggestionKind[] = [
  'full_pack_rounding',
  'volume_threshold',
  'cheaper_equivalent',
  'basket_consolidation',
  'order_channel_change',
]

function kindPriority(kind: SuggestionKind): number {
  const index = IDENTICAL_CHANGE_PRIORITY.indexOf(kind)
  return index === -1 ? IDENTICAL_CHANGE_PRIORITY.length : index
}

/**
 * Collapses suggestions that describe the same change across different kinds. `maxPerKind` caps
 * only within one kind, so without this the screen counted one action as several — and a count
 * nobody can reconcile with the cards below it is worse than no count.
 */
export function dedupeByChange(suggestions: Suggestion[]): Suggestion[] {
  const winners = new Map<string, Suggestion>()
  const slots: Array<string | Suggestion> = []
  for (const suggestion of suggestions) {
    if (!isDeduplicable(suggestion)) {
      slots.push(suggestion)
      continue
    }
    const identity = changeIdentity(suggestion)
    const incumbent = winners.get(identity)
    if (!incumbent) {
      winners.set(identity, suggestion)
      slots.push(identity)
      continue
    }
    if (kindPriority(suggestion.code) < kindPriority(incumbent.code)) winners.set(identity, suggestion)
  }
  return slots.map((slot) => (typeof slot === 'string' ? (winners.get(slot) as Suggestion) : slot))
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

  // Scored here rather than in the service because this is the only place both priced runs are
  // still in hand: downstream a suggestion is a flat record of formatted strings.
  const subjectProductId = draft.variantLine.line.productId
  const objectives = resolveObjectives(run.inputs.params, {
    productId: subjectProductId,
    productGroupCode: run.inputs.catalog.byProductId.get(subjectProductId)?.productGroupCode ?? null,
    customerId: run.context.customerId ?? null,
    customerGroupCode: run.context.customerGroupCode ?? null,
  })
  const objectiveScore = scoreObjectives(
    objectives,
    measureObjectiveMetrics({
      anchorLine: draft.anchorLine,
      variantLine: draft.variantLine,
      beforeRuns,
      afterRuns,
      basketProfitBefore: basketBefore,
      basketProfitAfter: basketAfter,
    }),
  )

  return {
    code: draft.code,
    titleKey: suggestionTitleKey(draft.code),
    subject: resolveSubject(run, draft),
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
    objectiveScore,
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
