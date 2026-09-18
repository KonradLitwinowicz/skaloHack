import { money, roundToStep, sub, toDecimal, ZERO } from '../decimal'
import type { ComponentComputeArgs, ComponentResult, PriceComponent } from '../types'

export const ROUNDING_CODE = 'rounding'

type RoundingPolicy = { step?: string | number; endingCharm?: string | number }

const DEFAULT_STEP = '0.01'

// Reported as the signed delta rather than a factor: a sales rep reads "rounded up by 3 gr",
// not "multiplied by 1.0016".
async function compute(args: ComponentComputeArgs): Promise<ComponentResult> {
  const { context, deps, runningUnitValue } = args
  const policy = (deps.supplier.roundingPolicy ?? {}) as RoundingPolicy
  const step = toDecimal(policy.step ?? DEFAULT_STEP, DEFAULT_STEP)
  const charm = policy.endingCharm === undefined ? null : toDecimal(policy.endingCharm)

  let rounded = roundToStep(runningUnitValue, step)
  if (charm !== null && charm > ZERO) {
    const base = roundToStep(sub(runningUnitValue, charm), toDecimal('1'))
    rounded = base + charm
  }

  const delta = sub(rounded, runningUnitValue)

  return {
    code: ROUNDING_CODE,
    labelKey: 'pricing_engine.components.rounding.label',
    effect: 'add',
    value: money(delta),
    inputs: { priceBefore: money(runningUnitValue), priceAfter: money(rounded) },
    params: { step: money(step), endingCharm: charm === null ? null : money(charm) },
    explainKey: 'pricing_engine.components.rounding.explain',
    explainValues: {
      step: money(step),
      delta: money(delta),
      priceAfter: money(rounded),
      currency: context.currencyCode,
    },
    confidence: deps.supplier.roundingPolicy ? 'measured' : 'default',
  }
}

export const roundingComponent: PriceComponent = {
  code: ROUNDING_CODE,
  position: 11,
  level: 'line',
  effect: 'add',
  labelKey: 'pricing_engine.components.rounding.label',
  contributesToCost: false,
  compute,
}
