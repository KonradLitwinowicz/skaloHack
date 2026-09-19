import { add, money, roundToStep, sub, toDecimal, ZERO } from '../decimal'
import type { Decimal } from '../decimal'
import type { ComponentComputeArgs, ComponentResult, PriceComponent } from '../types'
import { GUARDRAILS_CODE } from './guardrails'

export const ROUNDING_CODE = 'rounding'

type RoundingPolicy = { step?: string | number; endingCharm?: string | number }

const DEFAULT_STEP = '0.01'
const WHOLE = toDecimal('1')

function roundWithPolicy(value: Decimal, step: Decimal, charm: Decimal | null): Decimal {
  if (charm !== null && charm > ZERO) return roundToStep(sub(value, charm), WHOLE) + charm
  return roundToStep(value, step)
}

// The smallest price on the policy's grid that is not below `floor`.
function ceilWithPolicy(floor: Decimal, step: Decimal, charm: Decimal | null): Decimal {
  const increment = charm !== null && charm > ZERO ? WHOLE : step
  let candidate = roundWithPolicy(floor, step, charm)
  if (increment <= ZERO) return candidate > floor ? candidate : floor
  while (candidate < floor) candidate = add(candidate, increment)
  return candidate
}

function readRoundingFloor(args: ComponentComputeArgs): Decimal | null {
  const guardrail = args.priorResults?.find((result) => result.code === GUARDRAILS_CODE)
  const floor = guardrail?.params?.roundingFloorUnitPrice
  return typeof floor === 'string' ? toDecimal(floor) : null
}

// Reported as the signed delta rather than a factor: a sales rep reads "rounded up by 3 gr",
// not "multiplied by 1.0016".
async function compute(args: ComponentComputeArgs): Promise<ComponentResult> {
  const { context, deps, runningUnitValue } = args
  const policy = (deps.supplier.roundingPolicy ?? {}) as RoundingPolicy
  const step = toDecimal(policy.step ?? DEFAULT_STEP, DEFAULT_STEP)
  const charm = policy.endingCharm === undefined ? null : toDecimal(policy.endingCharm)

  let rounded = roundWithPolicy(runningUnitValue, step, charm)

  // Rounding runs after the guardrails, so an ordinary round-half-up (or a charm ending) could land
  // a clamped price a fraction under the minimum margin, the floor price or the discount cap. The
  // floor the guardrail reports wins: the price is rounded UP onto the grid instead.
  const floor = readRoundingFloor(args)
  const keptAboveFloor = floor !== null && floor > ZERO && rounded < floor
  if (keptAboveFloor) rounded = ceilWithPolicy(floor, step, charm)

  const delta = sub(rounded, runningUnitValue)

  return {
    code: ROUNDING_CODE,
    labelKey: 'pricing_engine.components.rounding.label',
    effect: 'add',
    value: money(delta),
    inputs: {
      priceBefore: money(runningUnitValue),
      priceAfter: money(rounded),
      ...(floor !== null ? { floorUnitPrice: money(floor) } : {}),
    },
    params: { step: money(step), endingCharm: charm === null ? null : money(charm) },
    explainKey: keptAboveFloor
      ? 'pricing_engine.components.rounding.explainKeptAboveFloor'
      : 'pricing_engine.components.rounding.explain',
    explainValues: {
      step: money(step),
      delta: money(delta),
      priceAfter: money(rounded),
      currency: context.currencyCode,
      ...(keptAboveFloor ? { floorUnitPrice: money(floor) } : {}),
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
