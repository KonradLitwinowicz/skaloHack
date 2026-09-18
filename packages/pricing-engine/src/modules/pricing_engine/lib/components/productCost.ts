import { div, format, money, mul, ONE, percentToFactor, sub, toDecimal } from '../decimal'
import type { ComponentComputeArgs, ComponentResult, PriceComponent } from '../types'

export const PRODUCT_COST_CODE = 'product_cost'

// A purchase cost older than this is still used, but reported as `estimated` with a warning:
// pricing a line off a stale delivery is the single most common way this engine lies.
export const STALE_PURCHASE_COST_DAYS = 60

// Bought vs. sold quantities that diverge by more than this on a slow-moving position are the
// classic source of fake losses when markup is computed from period averages. The engine never
// uses an average, but the divergence is still worth surfacing.
export const QUANTITY_DIVERGENCE_WARNING_RATIO = 0.3

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000)
}

async function compute(args: ComponentComputeArgs): Promise<ComponentResult> {
  const { line, deps, context } = args
  const product = deps.catalog.byProductId.get(line.productId) ?? null
  const purchase = product?.purchase ?? null
  const warnings: string[] = []

  if (!purchase || purchase.lastDeliveryUnitCost === null) {
    // TODO(data-source): no purchase position for this product. No module in Open Mercato stores
    // a purchase cost, so there is nothing to fall back to — the engine must say so rather than
    // invent a number.
    warnings.push('pricing_engine.warnings.purchaseCostMissing')
    return {
      code: PRODUCT_COST_CODE,
      labelKey: 'pricing_engine.components.productCost.label',
      effect: 'add',
      value: '0.0000',
      inputs: { productId: line.productId, sku: line.sku ?? product?.sku ?? null },
      params: {},
      explainKey: 'pricing_engine.components.productCost.explain.missing',
      explainValues: { sku: line.sku ?? product?.sku ?? line.productId },
      confidence: 'default',
      warnings,
    }
  }

  const listCost = toDecimal(purchase.lastDeliveryUnitCost)
  const tierDiscountFactor = percentToFactor(purchase.currentTierDiscount)
  const effectiveCost = mul(listCost, sub(ONE, tierDiscountFactor))

  const ageDays = purchase.lastDeliveryAt ? daysBetween(purchase.lastDeliveryAt, context.date) : null
  const stale = ageDays === null || ageDays > STALE_PURCHASE_COST_DAYS
  if (stale) warnings.push('pricing_engine.warnings.purchaseCostStale')

  if (purchase.lastDeliveryQuantity && purchase.soldQuantityPeriod) {
    const bought = toDecimal(purchase.lastDeliveryQuantity)
    const sold = toDecimal(purchase.soldQuantityPeriod)
    if (bought > 0n) {
      const ratio = Number(format(div(sub(bought, sold) < 0n ? sold - bought : bought - sold, bought), 6))
      if (ratio > QUANTITY_DIVERGENCE_WARNING_RATIO) {
        warnings.push('pricing_engine.warnings.purchaseQuantityDivergence')
      }
    }
  }

  return {
    code: PRODUCT_COST_CODE,
    labelKey: 'pricing_engine.components.productCost.label',
    effect: 'add',
    value: money(effectiveCost),
    inputs: {
      productId: line.productId,
      sku: line.sku ?? product?.sku ?? null,
      lastDeliveryUnitCost: purchase.lastDeliveryUnitCost,
      lastDeliveryAt: purchase.lastDeliveryAt ? purchase.lastDeliveryAt.toISOString() : null,
      ageDays,
    },
    params: {
      currentTierCode: purchase.currentTierCode,
      currentTierDiscount: purchase.currentTierDiscount,
      annualVolume: purchase.annualVolume,
    },
    explainKey: stale
      ? 'pricing_engine.components.productCost.explain.stale'
      : 'pricing_engine.components.productCost.explain.fresh',
    explainValues: {
      cost: money(effectiveCost),
      listCost: purchase.lastDeliveryUnitCost,
      discount: purchase.currentTierDiscount,
      ageDays: ageDays ?? 0,
      currency: context.currencyCode,
    },
    confidence: stale ? 'estimated' : 'measured',
    warnings,
  }
}

export const productCostComponent: PriceComponent = {
  code: PRODUCT_COST_CODE,
  position: 1,
  level: 'line',
  effect: 'add',
  labelKey: 'pricing_engine.components.productCost.label',
  contributesToCost: true,
  compute,
}
