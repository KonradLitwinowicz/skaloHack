import { add, div, factorToPercent, money, mul, ONE, percentToFactor, rate as formatRate, sub, ZERO } from '../decimal'
import type { ComponentComputeArgs, ComponentResult, PriceComponent } from '../types'

export const TARGET_MARGIN_CODE = 'target_margin'

type TargetMarkupPayload = { targetMarkupPercent?: string | number }

// The distributor's own numbers are expressed as markup on cost ("mediana narzutu 66%"), so that
// is what gets configured: price = cost x (1 + markup). Margin — (price - cost) / price — is
// derived and reported, never configured. Conflating the two is exactly the silent error this
// engine exists to remove.
async function compute(args: ComponentComputeArgs): Promise<ComponentResult> {
  const { context, deps, line, runningUnitValue } = args
  const product = deps.catalog.byProductId.get(line.productId) ?? null
  const scopeRefs = {
    productId: line.productId,
    productGroupCode: product?.productGroupCode ?? null,
    customerId: context.customerId ?? null,
    customerGroupCode: context.customerGroupCode ?? null,
  }

  const payload = deps.params.componentPayload(TARGET_MARGIN_CODE, scopeRefs) as TargetMarkupPayload | null
  const paramRef = deps.params.componentParamRef(TARGET_MARGIN_CODE, scopeRefs)
  const configured = payload?.targetMarkupPercent
  const markupPercent = configured ?? deps.supplier.defaultTargetMarkup
  const factor = add(ONE, percentToFactor(markupPercent))

  const cost = runningUnitValue
  const projectedPrice = mul(cost, factor)
  const derivedMarginPercent =
    projectedPrice > ZERO ? factorToPercent(div(sub(projectedPrice, cost), projectedPrice)) : ZERO

  return {
    code: TARGET_MARGIN_CODE,
    labelKey: 'pricing_engine.components.targetMargin.label',
    effect: 'mul',
    value: money(factor),
    inputs: {
      costBeforeMarkup: money(cost),
      productGroupCode: product?.productGroupCode ?? null,
    },
    params: {
      targetMarkupPercent: String(markupPercent),
      source: configured === undefined ? 'supplier_default' : 'component_param',
      paramRef,
    },
    explainKey: 'pricing_engine.components.targetMargin.explain',
    explainValues: {
      markupPercent: String(markupPercent),
      marginPercent: formatRate(derivedMarginPercent),
      cost: money(cost),
      currency: context.currencyCode,
    },
    confidence: configured === undefined ? 'default' : 'measured',
  }
}

export const targetMarginComponent: PriceComponent = {
  code: TARGET_MARGIN_CODE,
  position: 9,
  level: 'line',
  effect: 'mul',
  labelKey: 'pricing_engine.components.targetMargin.label',
  contributesToCost: false,
  compute,
}
