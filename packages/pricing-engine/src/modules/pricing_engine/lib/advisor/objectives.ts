import { z } from 'zod'
import { add, div, money, mul, ONE, sub, toDecimal, ZERO, type Decimal } from '../decimal'
import { LOGISTICS_COST_CODE } from '../components/logisticsCost'
import { OPERATIONAL_COST_BASE_CODE } from '../components/operationalCostBase'
import { PACKAGING_COST_CODE } from '../components/packagingCost'
import { PRODUCT_COST_CODE } from '../components/productCost'
import { WAREHOUSE_COST_CODE } from '../components/warehouseCost'
import type { PipelineRunResult } from '../pipeline'
import { pricingParamScopeSchema } from '../../data/validators'
import type { ParameterLookup, PricingLineResult, ScopeRefs } from '../types'
import type { Suggestion } from './schemas'

/**
 * Operator-defined objectives and weights (spec Deliverable F).
 *
 * A weight is only meaningful if the engine can measure the thing being weighted on a concrete
 * before/after pair. Every metric below is read off the two priced runs a suggestion already
 * carries, so an objective scores the day it is created rather than decorating a ranking it does
 * not actually move.
 */

/** Synthetic component code. Objectives are ordinary `pricing_component_params` rows — no migration. */
export const OBJECTIVE_WEIGHTS_COMPONENT_CODE = 'objective_weights'

export const pricingObjectiveMetricSchema = z.enum([
  'marginPercent',
  'profitNet',
  'revenueNet',
  'unitCostNet',
  'productCost',
  'operationalCost',
  'packagingCost',
  'warehouseCost',
  'logisticsCost',
])

export const pricingObjectiveDirectionSchema = z.enum(['maximise', 'minimise'])

const weightString = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine((value) => /^\d+(\.\d+)?$/.test(value), {
    message: 'pricing_engine.params.errors.invalidWeight',
  })

export const pricingObjectiveSchema = z.object({
  code: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(300),
  metric: pricingObjectiveMetricSchema,
  direction: pricingObjectiveDirectionSchema,
  weight: weightString,
})

export const objectiveWeightsPayloadSchema = z.object({
  objectives: z.array(pricingObjectiveSchema).max(12),
})

export const objectiveContributionSchema = z.object({
  code: z.string(),
  label: z.string(),
  metric: pricingObjectiveMetricSchema,
  weight: z.string(),
  /** The raw `after - before` move of the metric, in the metric's own unit. */
  delta: z.string(),
  /** That move, made dimensionless against the before-value and signed by the direction. */
  normalised: z.string(),
  contribution: z.string(),
})

export const objectiveScoreSchema = z.object({
  total: z.string(),
  contributions: z.array(objectiveContributionSchema),
})

export type PricingObjectiveMetric = z.infer<typeof pricingObjectiveMetricSchema>
export type PricingObjectiveDirection = z.infer<typeof pricingObjectiveDirectionSchema>
export type PricingObjective = z.infer<typeof pricingObjectiveSchema>
export type ObjectiveContribution = z.infer<typeof objectiveContributionSchema>
export type ObjectiveScore = z.infer<typeof objectiveScoreSchema>

export const ALL_OBJECTIVE_METRICS: PricingObjectiveMetric[] = pricingObjectiveMetricSchema.options

// --- CRUD contract ----------------------------------------------------------
//
// The advisor's own request shapes live here rather than in `data/validators.ts`, which is the
// frozen quote/simulate contract; objectives are additive and carry no pricing request.

type ScopedObjectiveInput = {
  scope: z.infer<typeof pricingParamScopeSchema>
  scopeRefId?: string | null
  objectives: PricingObjective[]
  validFrom: Date
  validTo?: Date | null
}

function refineObjectiveRule(value: ScopedObjectiveInput, ctx: z.RefinementCtx): void {
  // A scoped rule pointing at nothing would never match any quote: `resolveComponentParam` skips a
  // scope whose ref is falsy, so the row would sit in the list looking effective and do nothing.
  if (value.scope !== 'global' && !value.scopeRefId) {
    ctx.addIssue({
      code: 'custom',
      path: ['scopeRefId'],
      message: 'pricing_engine.params.errors.scopeRefRequired',
    })
  }
  if (value.validTo && value.validTo.getTime() <= value.validFrom.getTime()) {
    ctx.addIssue({
      code: 'custom',
      path: ['validTo'],
      message: 'pricing_engine.params.errors.validToBeforeValidFrom',
    })
  }
  const codes = value.objectives.map((objective) => objective.code)
  if (new Set(codes).size !== codes.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['objectives'],
      message: 'pricing_engine.params.errors.duplicateObjectiveCode',
    })
  }
}

function normalizeObjectiveScopeRef<T extends ScopedObjectiveInput>(
  value: T,
): T & { scopeRefId: string | null } {
  return { ...value, scopeRefId: value.scope === 'global' ? null : (value.scopeRefId ?? null) }
}

const objectiveRuleShape = {
  scope: pricingParamScopeSchema,
  scopeRefId: z.string().trim().min(1).max(200).nullable().optional(),
  objectives: z.array(pricingObjectiveSchema).min(1).max(12),
  changeNote: z.string().trim().min(1).max(2000),
  validFrom: z.coerce.date(),
  validTo: z.coerce.date().nullable().optional(),
}

export const objectiveCreateSchema = z
  .object(objectiveRuleShape)
  .superRefine(refineObjectiveRule)
  .transform(normalizeObjectiveScopeRef)

export const objectiveUpdateSchema = z
  .object({ id: z.string().uuid(), ...objectiveRuleShape })
  .superRefine(refineObjectiveRule)
  .transform(normalizeObjectiveScopeRef)

export type ObjectiveCreateInput = z.infer<typeof objectiveCreateSchema>
export type ObjectiveUpdateInput = z.infer<typeof objectiveUpdateSchema>

/**
 * A malformed payload yields no objectives rather than an exception: this row is read on the hot
 * path of every suggestion, and one bad parameter row must not stop a tenant pricing at all. The
 * screens of `objectiveFormConfig` are what keep a payload well formed in the first place.
 */
export function readObjectives(payload: Record<string, unknown> | null | undefined): PricingObjective[] {
  if (!payload) return []
  const parsed = objectiveWeightsPayloadSchema.safeParse(payload)
  return parsed.success ? parsed.data.objectives : []
}

/** Objectives for one suggestion, resolved through the same scope precedence every parameter uses. */
export function resolveObjectives(params: ParameterLookup, refs: ScopeRefs): PricingObjective[] {
  return readObjectives(params.componentPayload(OBJECTIVE_WEIGHTS_COMPONENT_CODE, refs))
}

export type ObjectiveMetricPair = { before: Decimal; after: Decimal }
export type ObjectiveMeasurement = Record<PricingObjectiveMetric, ObjectiveMetricPair>

export type ObjectiveMetricInput = {
  anchorLine: PricingLineResult
  variantLine: PricingLineResult
  /** Every run on the "before" side — consolidation compares two baskets against one. */
  beforeRuns: PipelineRunResult[]
  afterRuns: PipelineRunResult[]
  basketProfitBefore: Decimal
  basketProfitAfter: Decimal
}

function componentValue(line: PricingLineResult, componentCode: string): Decimal {
  const component = line.breakdown.find((entry) => entry.code === componentCode)
  return component ? toDecimal(component.value) : ZERO
}

function totalNetOf(runs: PipelineRunResult[]): Decimal {
  return runs.reduce((total, run) => add(total, toDecimal(run.totalNet)), ZERO)
}

/** Reads every scoreable metric off the before/after pair a suggestion is already built from. */
export function measureObjectiveMetrics(input: ObjectiveMetricInput): ObjectiveMeasurement {
  const { anchorLine, variantLine } = input
  const perUnitComponent = (componentCode: string): ObjectiveMetricPair => ({
    before: componentValue(anchorLine, componentCode),
    after: componentValue(variantLine, componentCode),
  })

  return {
    marginPercent: {
      before: toDecimal(anchorLine.marginPercent),
      after: toDecimal(variantLine.marginPercent),
    },
    profitNet: { before: input.basketProfitBefore, after: input.basketProfitAfter },
    revenueNet: { before: totalNetOf(input.beforeRuns), after: totalNetOf(input.afterRuns) },
    unitCostNet: {
      before: toDecimal(anchorLine.unitCostNet),
      after: toDecimal(variantLine.unitCostNet),
    },
    productCost: perUnitComponent(PRODUCT_COST_CODE),
    operationalCost: perUnitComponent(OPERATIONAL_COST_BASE_CODE),
    packagingCost: perUnitComponent(PACKAGING_COST_CODE),
    warehouseCost: perUnitComponent(WAREHOUSE_COST_CODE),
    logisticsCost: perUnitComponent(LOGISTICS_COST_CODE),
  }
}

function absolute(value: Decimal): Decimal {
  return value < ZERO ? -value : value
}

/**
 * The directed move, divided by the before-value so a percentage point of margin and a zloty of
 * profit end up on the same scale.
 *
 * A before-value of zero has no ratio at all. Rather than dividing (which would silently yield 0
 * and make the objective invisible) the move away from zero is credited as one whole unit of
 * relative improvement: bounded, so one zero-based metric cannot outvote every other objective.
 */
export function normaliseObjectiveDelta(
  before: Decimal,
  after: Decimal,
  direction: PricingObjectiveDirection,
): Decimal {
  const directedDelta = direction === 'minimise' ? sub(before, after) : sub(after, before)
  if (directedDelta === ZERO) return ZERO
  const base = absolute(before)
  if (base === ZERO) return directedDelta > ZERO ? ONE : -ONE
  return div(directedDelta, base)
}

/**
 * `score = sum(weight x normalised) / sum(weight)`.
 *
 * Returns null when the operator configured nothing, which is what keeps the untouched ranking
 * exactly as it was. A weight of 0 leaves its objective in the breakdown (so the operator can see
 * it is switched off) while contributing to neither the numerator nor the denominator.
 */
export function scoreObjectives(
  objectives: PricingObjective[],
  measurement: ObjectiveMeasurement,
): ObjectiveScore | null {
  if (objectives.length === 0) return null

  let weightTotal = ZERO
  let contributionTotal = ZERO
  const contributions: ObjectiveContribution[] = []

  for (const objective of objectives) {
    const pair = measurement[objective.metric]
    const weight = toDecimal(objective.weight)
    const normalised = normaliseObjectiveDelta(pair.before, pair.after, objective.direction)
    const contribution = mul(weight, normalised)

    weightTotal = add(weightTotal, weight)
    contributionTotal = add(contributionTotal, contribution)

    contributions.push({
      code: objective.code,
      label: objective.label,
      metric: objective.metric,
      weight: money(weight),
      delta: money(sub(pair.after, pair.before)),
      normalised: money(normalised),
      contribution: money(contribution),
    })
  }

  // Every objective disabled is a legitimate configuration, not an error: the rows stay visible
  // and the score stays neutral, so the ranking falls back to the order the generators produced.
  const total = weightTotal === ZERO ? ZERO : div(contributionTotal, weightTotal)
  return { total: money(total), contributions }
}

/**
 * Guardrails outrank weights — but not by way of a filter here, and the distinction matters.
 *
 * Every suggestion is produced by re-running the FULL pipeline through `run.price(...)`, so its
 * price has already passed the `guardrails` component. A price that survives the pipeline is legal
 * by construction, and there is nothing left for a second opinion to veto.
 *
 * A filter would also be actively wrong. `guardrailFloorUnitPrice` on a suggestion is derived from
 * `min_margin_percent` alone, while the guardrail component legitimately prices BELOW that floor
 * whenever the shelf-life ladder is open. Re-deriving the floor here and calling the result a
 * breach would silently delete exactly the suggestions on expiring stock — the ones the operator
 * most needs to see. `advisorObjectives.test.ts` pins this with a priced run rather than a fixture.
 */

/**
 * Global ranking across kinds. `rankByBasketProfitGain` and `rankByCustomerSaving` order within one
 * generator; this orders the merged list by what the operator said matters.
 *
 * With no objectives configured every score is null, every key is zero and the sort is a no-op —
 * the tie-break on the original index makes that guarantee explicit rather than a property of the
 * runtime's sort stability.
 */
export function rankByObjectives(suggestions: Suggestion[]): Suggestion[] {
  const keyed = suggestions.map((suggestion, index) => ({
    suggestion,
    index,
    total: suggestion.objectiveScore ? toDecimal(suggestion.objectiveScore.total) : ZERO,
  }))
  keyed.sort((left, right) => {
    if (left.total !== right.total) return right.total > left.total ? 1 : -1
    return left.index - right.index
  })
  return keyed.map((entry) => entry.suggestion)
}
