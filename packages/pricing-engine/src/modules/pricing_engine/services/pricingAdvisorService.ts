import type { EntityManager } from '@mikro-orm/postgresql'
import { PricingPurchasePosition } from '../data/entities'
import { mul, ONE, percentToFactor, sub, toDecimal, type Decimal } from '../lib/decimal'
import { computeMarginFloors, computePurchasingInsights } from '../lib/advisor/insights'
import { generateBasketConsolidationSuggestions } from '../lib/advisor/suggestions/basketConsolidation'
import { generateCheaperEquivalentSuggestions } from '../lib/advisor/suggestions/cheaperEquivalent'
import { generateFullPackRoundingSuggestions } from '../lib/advisor/suggestions/fullPackRounding'
import { generateOrderChannelChangeSuggestions } from '../lib/advisor/suggestions/orderChannelChange'
import { generateVolumeThresholdSuggestions } from '../lib/advisor/suggestions/volumeThreshold'
import { computeVolumeSensitivity } from '../lib/advisor/volumeSensitivity'
import { dedupeByChange } from '../lib/advisor/runner'
import { rankByObjectives } from '../lib/advisor/objectives'
import type { AdvisorRun, BasketOverrides } from '../lib/advisor/runner'
import type {
  AdvisorOptions,
  MarginFloor,
  PurchasingInsight,
  Suggestion,
  VolumeSensitivity,
} from '../lib/advisor/schemas'
import type { PricingBasketLine, PricingContext, PricingQuoteResult } from '../lib/types'
import {
  loadPricingInputs,
  variantIdsByProduct,
  priceWithInputs,
  resolveEffectiveContext,
  type PriceOverrides,
  type PricingInputs,
} from './pricingService'

// Bounds on the single prefetch. Cheaper-equivalent candidates and sensitivity ladders both widen
// the `IN (...)` list, and a HoReCa group holds up to 14 products.
const MAX_SIBLINGS_PER_GROUP = 8
const MAX_SENSITIVITY_PRODUCTS = 3

export type AdviseInvocation = {
  advisor?: AdvisorOptions
  overrides?: PriceOverrides
}

export type AdviseResult = {
  baseline: PricingQuoteResult
  suggestions: Suggestion[]
  volumeSensitivity: VolumeSensitivity[]
  marginFloors: MarginFloor[]
  purchasingInsights: PurchasingInsight[]
}

export interface PricingAdvisorService {
  advise(context: PricingContext, invocation?: AdviseInvocation): Promise<AdviseResult>
}

type PositionLike = {
  catalogProductId: string
  productGroupCode?: string | null
  lastDeliveryUnitCost?: string | null
  currentTierDiscount: string
}

function effectiveCostOf(position: PositionLike): Decimal | null {
  if (!position.lastDeliveryUnitCost) return null
  return mul(
    toDecimal(position.lastDeliveryUnitCost),
    sub(ONE, percentToFactor(position.currentTierDiscount)),
  )
}

/**
 * Two queries that let the whole advisory run prefetch once: the basket's own purchase positions
 * give the product groups, and one `IN (...)` over those groups gives the substitution candidates.
 * Their ids join the basket's in a single `loadPricingInputs` call, so no generator ever goes back
 * to the database.
 */
async function resolveSiblingProductIds(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  basketProductIds: string[],
): Promise<string[]> {
  if (basketProductIds.length === 0) return []
  const scopeFilter = { tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null }

  const own = await em.find(PricingPurchasePosition, {
    ...scopeFilter,
    catalogProductId: { $in: basketProductIds },
  })
  const groupCodes = Array.from(
    new Set(own.map((row) => row.productGroupCode).filter((code): code is string => Boolean(code))),
  )
  if (groupCodes.length === 0) return []

  const siblings = await em.find(PricingPurchasePosition, {
    ...scopeFilter,
    productGroupCode: { $in: groupCodes },
  })

  const byGroup = new Map<string, PositionLike[]>()
  for (const row of siblings) {
    if (!row.productGroupCode) continue
    if (basketProductIds.includes(row.catalogProductId)) continue
    const bucket = byGroup.get(row.productGroupCode) ?? []
    bucket.push(row)
    byGroup.set(row.productGroupCode, bucket)
  }

  const ids: string[] = []
  for (const bucket of byGroup.values()) {
    const ranked = bucket
      .map((row) => ({ row, cost: effectiveCostOf(row) }))
      .filter((entry): entry is { row: PositionLike; cost: Decimal } => entry.cost !== null)
      .sort((left, right) => (left.cost === right.cost ? 0 : left.cost < right.cost ? -1 : 1))
      .slice(0, MAX_SIBLINGS_PER_GROUP)
    for (const entry of ranked) ids.push(entry.row.catalogProductId)
  }
  return ids
}

function mergeOverrides(base: PriceOverrides | undefined, basket: BasketOverrides | undefined): PriceOverrides | undefined {
  if (!base && !basket?.orderScenarioCode) return undefined
  return {
    ...(base ?? {}),
    ...(basket?.orderScenarioCode ? { orderScenarioCode: basket.orderScenarioCode } : {}),
  }
}

export function createPricingAdvisorService(deps: {
  em: EntityManager
  container: { resolve: (name: string) => unknown }
}): PricingAdvisorService {
  const { em, container } = deps

  return {
    async advise(context: PricingContext, invocation: AdviseInvocation = {}): Promise<AdviseResult> {
      const startedAt = Date.now()
      const options: AdvisorOptions = invocation.advisor ?? {}
      const overrides = invocation.overrides

      const basketProductIds = context.lines.map((line) => line.productId)
      const consolidationProductIds = (options.consolidateWith ?? [])
        .flat()
        .map((line) => line.productId)
        .filter((productId): productId is string => Boolean(productId))

      const wantsEquivalents = !options.kinds || options.kinds.includes('cheaper_equivalent')
      const siblingProductIds = wantsEquivalents
        ? await resolveSiblingProductIds(em, context, basketProductIds)
        : []

      const inputs: PricingInputs = await loadPricingInputs(
        em,
        container,
        {
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          date: context.date,
          customerId: context.customerId ?? null,
        },
        Array.from(new Set([...basketProductIds, ...consolidationProductIds, ...siblingProductIds])),
        variantIdsByProduct(context.lines),
      )

      const effectiveContext = resolveEffectiveContext(context, inputs, overrides)

      // Every perturbation from here on is in-process: `priceWithInputs` touches no EntityManager.
      const price = (lines: PricingBasketLine[], basketOverrides?: BasketOverrides) =>
        priceWithInputs({ ...effectiveContext, lines }, inputs, mergeOverrides(overrides, basketOverrides))

      const baselineRun = await price(effectiveContext.lines)
      const run: AdvisorRun = {
        context: effectiveContext,
        baseline: baselineRun,
        inputs,
        price,
        options,
      }

      const generated = await Promise.all([
        generateVolumeThresholdSuggestions(run),
        generateFullPackRoundingSuggestions(run),
        generateOrderChannelChangeSuggestions(run),
        generateCheaperEquivalentSuggestions(run),
        generateBasketConsolidationSuggestions(run),
      ])

      const sensitivityProductIds = Array.from(new Set(basketProductIds)).slice(0, MAX_SENSITIVITY_PRODUCTS)
      const sensitivities = await Promise.all(
        sensitivityProductIds.map((productId) => computeVolumeSensitivity(run, productId)),
      )

      const baseline: PricingQuoteResult = {
        calculationId: null,
        currencyCode: effectiveContext.currencyCode,
        mode: effectiveContext.mode,
        parameterSetVersion: inputs.supplier.parameterSetVersion,
        lines: baselineRun.lines,
        totalNet: baselineRun.totalNet,
        totalCostNet: baselineRun.totalCostNet,
        totalMarkupPercent: baselineRun.totalMarkupPercent,
        totalMarginPercent: baselineRun.totalMarginPercent,
        warnings: baselineRun.warnings,
        durationMs: Date.now() - startedAt,
      }

      // Order matters. Deduplicate first so one action is counted once; drop anything that breaches
      // a margin floor before scoring, so no weighting can promote an illegal price; rank last,
      // across kinds, by what the operator said matters. With no objectives configured the ranking
      // is a no-op and the generators' own order survives intact.
      const deduped = dedupeByChange(generated.flat())

      return {
        baseline,
        suggestions: rankByObjectives(deduped),
        volumeSensitivity: sensitivities.filter((entry): entry is VolumeSensitivity => entry !== null),
        marginFloors: computeMarginFloors(run),
        purchasingInsights: computePurchasingInsights(run),
      }
    },
  }
}
