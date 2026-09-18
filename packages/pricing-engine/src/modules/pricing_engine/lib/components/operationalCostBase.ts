import { add, div, money, mul, ONE, percentToFactor, toDecimal, ZERO } from '../decimal'
import type { ComponentComputeArgs, ComponentResult, PriceComponent } from '../types'

export const OPERATIONAL_COST_BASE_CODE = 'operational_cost_base'

const MINUTES_PER_HOUR = toDecimal('60')

async function compute(args: ComponentComputeArgs): Promise<ComponentResult> {
  const { context, deps, quantity, lineIndex } = args
  const scenarioCode = context.orderScenarioCode ?? null
  const scenario = deps.params.orderScenario(scenarioCode)
  const steps = deps.params.processSteps()
  const warnings: string[] = []

  if (!scenario) warnings.push('pricing_engine.warnings.orderScenarioMissing')
  if (steps.length === 0) warnings.push('pricing_engine.warnings.processStepsMissing')

  const multipliers = scenario?.stepMultipliers ?? {}
  const extraSteps = new Set(scenario?.extraStepCodes ?? [])
  const lineShare = toDecimal(deps.allocation.shareByLineIndex[lineIndex] ?? '0')

  let perOrderCost = ZERO
  let perLineCost = ZERO
  let missingRate = false
  const stepDetails: Array<Record<string, unknown>> = []

  for (const step of steps) {
    const applies = step.isPerLine || step.isPerOrder || extraSteps.has(step.code)
    if (!applies) continue

    const rate = deps.params.laborRate(step.roleCode)
    if (!rate) {
      missingRate = true
      continue
    }

    const multiplier = toDecimal(multipliers[step.code] ?? '1', '1')
    const hours = div(mul(toDecimal(step.durationMinutes), multiplier), MINUTES_PER_HOUR)
    const loadedRate = mul(toDecimal(rate.hourlyRate), add(ONE, percentToFactor(rate.overheadRate)))
    const stepCost = mul(hours, loadedRate)

    if (step.isPerLine) perLineCost = add(perLineCost, stepCost)
    else perOrderCost = add(perOrderCost, stepCost)

    stepDetails.push({
      code: step.code,
      roleCode: step.roleCode,
      durationMinutes: step.durationMinutes,
      multiplier: money(multiplier),
      cost: money(stepCost),
      scope: step.isPerLine ? 'line' : 'order',
    })
  }

  if (missingRate) warnings.push('pricing_engine.warnings.laborRateMissing')

  // Per-order steps are attributed to this line by its share of basket net value (owner
  // decision Q5); per-line steps belong to the line outright. Both are then spread across the
  // line's units so the component reports a per-unit amount like every other component.
  const allocatedOrderCost = mul(perOrderCost, lineShare)
  const lineCost = add(allocatedOrderCost, perLineCost)
  const perUnit = quantity > 0n ? div(lineCost, quantity) : ZERO

  return {
    code: OPERATIONAL_COST_BASE_CODE,
    labelKey: 'pricing_engine.components.operationalCostBase.label',
    effect: 'add',
    value: money(perUnit),
    inputs: {
      orderScenarioCode: scenarioCode,
      quantity: money(quantity),
      lineShare: money(lineShare),
      steps: stepDetails,
    },
    params: {
      scenarioLabelKey: scenario?.labelKey ?? null,
      stepCount: stepDetails.length,
    },
    explainKey: scenario
      ? 'pricing_engine.components.operationalCostBase.explain.withScenario'
      : 'pricing_engine.components.operationalCostBase.explain.noScenario',
    explainValues: {
      scenario: scenario?.code ?? '',
      stepCount: stepDetails.length,
      lineCost: money(lineCost),
      perUnit: money(perUnit),
      currency: context.currencyCode,
    },
    confidence: scenario && steps.length > 0 && !missingRate ? 'measured' : 'default',
    warnings,
  }
}

export const operationalCostBaseComponent: PriceComponent = {
  code: OPERATIONAL_COST_BASE_CODE,
  position: 2,
  level: 'basket',
  effect: 'add',
  labelKey: 'pricing_engine.components.operationalCostBase.label',
  contributesToCost: true,
  compute,
}
