import {
  div,
  factorToPercent,
  money,
  ONE,
  percentToFactor,
  rate as formatRate,
  sub,
  toDecimal,
  ZERO,
} from '../decimal'
import type { Decimal } from '../decimal'
import type { ComponentComputeArgs, ComponentResult, PriceComponent } from '../types'

export const GUARDRAILS_CODE = 'guardrails'

/**
 * margin = (price - cost) / price  =>  price_min = cost / (1 - margin/100).
 * Returns null at margin >= 100, where the equation has no finite solution.
 *
 * Exported so the advisor answers "lowest price still holding margin X" with the SAME formula the
 * pipeline clamps with — a floor the engine would not honour is worse than no floor at all.
 */
export function minPriceForMargin(unitCostNet: Decimal, minMarginPercent: string): Decimal | null {
  const denominator = sub(ONE, percentToFactor(minMarginPercent))
  if (denominator <= ZERO) return null
  return div(unitCostNet, denominator)
}

// Guardrails clamp rather than add or scale. They are reported as a multiplier so the waterfall
// stays one consistent shape: 1.0000 means nothing was clamped, and any other value shows exactly
// how much the clamp moved the price.
async function compute(args: ComponentComputeArgs): Promise<ComponentResult> {
  const { context, deps, line, runningUnitValue, unitCostNet } = args
  const product = deps.catalog.byProductId.get(line.productId) ?? null
  const scopeRefs = {
    productId: line.productId,
    productGroupCode: product?.productGroupCode ?? null,
    customerId: context.customerId ?? null,
    customerGroupCode: context.customerGroupCode ?? null,
  }

  const guardrail = deps.params.guardrail(scopeRefs)
  const negotiated = deps.params.negotiatedUnitPrice(line.productId)
  const warnings: string[] = []

  let target = runningUnitValue
  let applied: string | null = null

  const negotiatedWins = (guardrail?.negotiatedPricePrecedence ?? 'negotiated_wins') === 'negotiated_wins'
  if (negotiated !== null && negotiatedWins) {
    target = toDecimal(negotiated)
    applied = 'negotiated_price'
  }

  if (guardrail) {
    if (guardrail.floorPrice !== null) {
      const floor = toDecimal(guardrail.floorPrice)
      if (target < floor) {
        target = floor
        applied = 'floor_price'
      }
    }

    if (guardrail.minMarginPercent !== null && unitCostNet > ZERO) {
      const minPrice = minPriceForMargin(unitCostNet, guardrail.minMarginPercent)
      if (minPrice !== null && target < minPrice) {
        target = minPrice
        applied = 'min_margin'
        warnings.push('pricing_engine.warnings.minMarginEnforced')
      }
    }
  }

  const factor = runningUnitValue > ZERO ? div(target, runningUnitValue) : ONE
  const resultingMargin =
    target > ZERO ? factorToPercent(div(sub(target, unitCostNet), target)) : ZERO

  return {
    code: GUARDRAILS_CODE,
    labelKey: 'pricing_engine.components.guardrails.label',
    effect: 'mul',
    value: money(factor),
    inputs: {
      priceBefore: money(runningUnitValue),
      priceAfter: money(target),
      unitCostNet: money(unitCostNet),
      negotiatedUnitPrice: negotiated,
    },
    params: {
      guardrailCode: guardrail?.code ?? null,
      minMarginPercent: guardrail?.minMarginPercent ?? null,
      maxDiscountPercent: guardrail?.maxDiscountPercent ?? null,
      floorPrice: guardrail?.floorPrice ?? null,
      negotiatedPricePrecedence: guardrail?.negotiatedPricePrecedence ?? null,
    },
    explainKey: applied
      ? `pricing_engine.components.guardrails.explain.${applied}`
      : 'pricing_engine.components.guardrails.explain.none',
    explainValues: {
      priceBefore: money(runningUnitValue),
      priceAfter: money(target),
      marginPercent: formatRate(resultingMargin),
      currency: context.currencyCode,
    },
    confidence: guardrail ? 'measured' : 'default',
    warnings,
  }
}

export const guardrailsComponent: PriceComponent = {
  code: GUARDRAILS_CODE,
  position: 10,
  level: 'line',
  effect: 'mul',
  labelKey: 'pricing_engine.components.guardrails.label',
  contributesToCost: false,
  compute,
}
