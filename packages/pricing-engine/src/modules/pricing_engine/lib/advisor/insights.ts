import { money, mul, percentToFactor, rate as formatRate, sub, toDecimal, ZERO } from '../decimal'
import { discountHeadroomPercent, minPriceForMargin } from './margin'
import { resolveMinMarginPercent, type AdvisorRun } from './runner'
import type { MarginFloor, PurchasingInsight } from './schemas'

/**
 * The lowest price each line can carry while still holding the minimum margin — the direct answer to
 * "what is the best price I can give this customer". It uses the exported `minPriceForMargin`, the
 * same function `guardrails` clamps with, so the floor shown is a floor the engine will honour.
 */
export function computeMarginFloors(run: AdvisorRun): MarginFloor[] {
  const floors: MarginFloor[] = []

  for (const line of run.baseline.lines) {
    const resolved = resolveMinMarginPercent(run, line.line)
    if (!resolved) continue

    const unitCost = toDecimal(line.unitCostNet)
    const unitPrice = toDecimal(line.unitPriceNet)
    const floor = minPriceForMargin(unitCost, resolved.value)
    const headroom = discountHeadroomPercent(unitPrice, unitCost, resolved.value)
    const product = run.inputs.catalog.byProductId.get(line.line.productId) ?? null

    floors.push({
      productId: line.line.productId,
      sku: line.line.sku ?? product?.sku ?? null,
      minMarginPercent: resolved.value,
      unitCostNet: line.unitCostNet,
      currentUnitPriceNet: line.unitPriceNet,
      lowestUnitPriceNet: floor === null ? null : money(floor),
      discountHeadroomPercent: headroom === null ? null : formatRate(headroom),
      source: resolved.source,
    })
  }

  return floors
}

/**
 * Distributor-only. `next_tier_volume` / `next_tier_discount` are ANNUAL purchase thresholds against
 * the distributor's own supplier, so this never reaches a customer-facing surface and never claims
 * that a single order earns the discount: it says how far the year's purchasing is from the tier and
 * what closing that gap would take off every future unit's cost.
 */
export function computePurchasingInsights(run: AdvisorRun): PurchasingInsight[] {
  const insights: PurchasingInsight[] = []
  const seen = new Set<string>()

  for (const line of run.context.lines) {
    if (seen.has(line.productId)) continue
    seen.add(line.productId)

    const product = run.inputs.catalog.byProductId.get(line.productId) ?? null
    const purchase = product?.purchase ?? null
    if (!purchase?.nextTierVolume || !purchase.nextTierDiscount || !purchase.lastDeliveryUnitCost) continue

    const annualVolume = toDecimal(purchase.annualVolume)
    const nextTierVolume = toDecimal(purchase.nextTierVolume)
    const gap = sub(nextTierVolume, annualVolume)
    if (gap <= ZERO) continue

    const listCost = toDecimal(purchase.lastDeliveryUnitCost)
    const discountDelta = sub(
      percentToFactor(purchase.nextTierDiscount),
      percentToFactor(purchase.currentTierDiscount),
    )
    const unitCostSaving = mul(listCost, discountDelta)

    insights.push({
      productId: line.productId,
      sku: product?.sku ?? null,
      annualVolume: purchase.annualVolume,
      nextTierVolume: purchase.nextTierVolume,
      unitsToNextTier: money(gap),
      currentTierDiscount: purchase.currentTierDiscount,
      nextTierDiscount: purchase.nextTierDiscount,
      unitCostSaving: money(unitCostSaving),
      annualSavingAtNextTier: money(mul(unitCostSaving, nextTierVolume)),
    })
  }

  return insights
}
