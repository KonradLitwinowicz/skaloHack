import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  PricingCoverageEntry,
  PricingDeliveryZone,
  PricingFuelPrice,
  PricingGuardrail,
  PricingLaborRate,
  PricingOrderScenario,
  PricingPackagingCost,
  PricingProcessStep,
  PricingPurchasePosition,
  PricingSupplierProfile,
  PricingVehicle,
  PricingWarehouseCost,
} from './data/entities'
import { tryResolve } from './lib/catalog'
import {
  COVERAGE_SEED,
  DEMO_DELIVERY_ZONES,
  DEMO_FUEL_PRICES,
  DEMO_PACKAGING_COSTS,
  DEMO_VEHICLES,
  DEMO_WAREHOUSE_COST,
  DEMO_DEFAULT_TARGET_MARKUP,
  DEMO_GUARDRAIL,
  DEMO_LABOR_RATES,
  DEMO_ORDER_SCENARIOS,
  DEMO_OVERHEAD_RATE,
  DEMO_PROCESS_STEPS,
  DEMO_ROUNDING_POLICY,
  DEMO_SUPPLIER_SLUG,
} from './lib/seedDefaults'

const logger = createLogger('pricing_engine')

// Everything the engine seeds is dated from here so a historical replay resolves the same
// parameter rows the first quote used.
const EPOCH = new Date('2000-01-01T00:00:00.000Z')

const DEMO_PRODUCT_LIMIT = 50

type Scope = { tenantId: string; organizationId: string }

async function ensureSupplierProfile(em: EntityManager, scope: Scope): Promise<PricingSupplierProfile> {
  const existing = await em.findOne(PricingSupplierProfile, { ...scope, deletedAt: null })
  if (existing) return existing
  const profile = em.create(PricingSupplierProfile, {
    ...scope,
    slug: DEMO_SUPPLIER_SLUG,
    name: 'Demo HoReCa distributor',
    currencyCode: 'PLN',
    defaultTargetMarkup: DEMO_DEFAULT_TARGET_MARKUP,
    mode: 'shadow',
    roundingPolicy: DEMO_ROUNDING_POLICY,
    parameterSetVersion: 1,
    isDemo: true,
  })
  em.persist(profile)
  return profile
}

async function seedParameterRows(em: EntityManager, scope: Scope): Promise<void> {
  const existingRates = await em.count(PricingLaborRate, { ...scope, deletedAt: null })
  if (existingRates === 0) {
    for (const rate of DEMO_LABOR_RATES) {
      em.persist(
        em.create(PricingLaborRate, {
          ...scope,
          roleCode: rate.roleCode,
          label: rate.label,
          hourlyRate: rate.hourlyRate,
          overheadRate: DEMO_OVERHEAD_RATE,
          validFrom: EPOCH,
          isDemo: true,
        }),
      )
    }
  }

  const existingSteps = await em.count(PricingProcessStep, { ...scope, deletedAt: null })
  if (existingSteps === 0) {
    for (const step of DEMO_PROCESS_STEPS) {
      em.persist(
        em.create(PricingProcessStep, {
          ...scope,
          code: step.code,
          label: step.label,
          roleCode: step.roleCode,
          durationMinutes: step.durationMinutes,
          isPerLine: step.isPerLine,
          isPerOrder: step.isPerOrder,
          validFrom: EPOCH,
          isDemo: true,
        }),
      )
    }
  }

  // Probed per code, not on an empty table: a tenant seeded before a scenario existed has to pick
  // the new one up on its next run, which a `count === 0` gate can never do.
  //
  // The probe deliberately does NOT filter `deletedAt: null`. A soft-deleted scenario is an
  // operator's decision that this way of ordering is not offered here, and a probe over live rows
  // only would resurrect it on every seed run. Seeding is additive; it never undoes a deletion.
  const seededScenarioRows = await em.find(PricingOrderScenario, {
    ...scope,
    code: { $in: DEMO_ORDER_SCENARIOS.map((scenario) => scenario.code) },
  })
  const knownScenarioCodes = new Set<string>(seededScenarioRows.map((row) => row.code))
  for (const scenario of DEMO_ORDER_SCENARIOS) {
    if (knownScenarioCodes.has(scenario.code)) continue
    em.persist(
      em.create(PricingOrderScenario, {
        ...scope,
        code: scenario.code,
        label: scenario.label,
        stepMultipliers: { ...scenario.stepMultipliers },
        extraStepCodes: [...scenario.extraStepCodes],
        validFrom: EPOCH,
        isDemo: true,
      }),
    )
  }

  const existingGuardrails = await em.count(PricingGuardrail, { ...scope, deletedAt: null })
  if (existingGuardrails === 0) {
    em.persist(
      em.create(PricingGuardrail, {
        ...scope,
        code: DEMO_GUARDRAIL.code,
        minMarginPercent: DEMO_GUARDRAIL.minMarginPercent,
        maxDiscountPercent: DEMO_GUARDRAIL.maxDiscountPercent,
        floorPrice: DEMO_GUARDRAIL.floorPrice,
        negotiatedPricePrecedence: DEMO_GUARDRAIL.negotiatedPricePrecedence,
        scope: 'global',
        validFrom: EPOCH,
        isDemo: true,
      }),
    )
  }
}

async function seedLogisticsRows(em: EntityManager, scope: Scope): Promise<void> {
  if ((await em.count(PricingPackagingCost, { ...scope, deletedAt: null })) === 0) {
    for (const row of DEMO_PACKAGING_COSTS) {
      em.persist(em.create(PricingPackagingCost, { ...scope, ...row, validFrom: EPOCH, isDemo: true }))
    }
  }

  if ((await em.count(PricingWarehouseCost, { ...scope, deletedAt: null })) === 0) {
    em.persist(
      em.create(PricingWarehouseCost, {
        ...scope,
        ...DEMO_WAREHOUSE_COST,
        validFrom: EPOCH,
        isDemo: true,
      }),
    )
  }

  if ((await em.count(PricingVehicle, { ...scope, deletedAt: null })) === 0) {
    for (const row of DEMO_VEHICLES) {
      em.persist(em.create(PricingVehicle, { ...scope, ...row, isActive: true, isDemo: true }))
    }
  }

  if ((await em.count(PricingDeliveryZone, { ...scope, deletedAt: null })) === 0) {
    for (const row of DEMO_DELIVERY_ZONES) {
      em.persist(em.create(PricingDeliveryZone, { ...scope, ...row, isDemo: true }))
    }
  }

  if ((await em.count(PricingFuelPrice, { ...scope, deletedAt: null })) === 0) {
    for (const row of DEMO_FUEL_PRICES) {
      em.persist(
        em.create(PricingFuelPrice, { ...scope, ...row, observedOn: EPOCH, isDemo: true }),
      )
    }
  }
}

async function seedCoverage(em: EntityManager, scope: Scope): Promise<void> {
  for (const entry of COVERAGE_SEED) {
    const existing = await em.findOne(PricingCoverageEntry, {
      ...scope,
      componentCode: entry.componentCode,
      deletedAt: null,
    })
    if (existing) continue
    em.persist(
      em.create(PricingCoverageEntry, {
        ...scope,
        componentCode: entry.componentCode,
        sourceKind: entry.sourceKind,
        sourceRef: entry.sourceRef,
        confidence: entry.confidence,
        missingReasonKey: entry.missingReasonKey,
        lastCheckedAt: new Date(),
        isDemo: false,
      }),
    )
  }
}

// Demo purchase costs are derived from real catalog products so nothing references an invented
// product id. Catalog is optional: without it the engine still boots, just with no cost data.
async function seedDemoPurchasePositions(
  em: EntityManager,
  container: { resolve: (name: string) => unknown },
  scope: Scope,
): Promise<number> {
  const catalogProductClass = tryResolve<new (...args: never[]) => { id: string; sku?: string | null }>(
    container,
    'CatalogProduct',
  )
  if (!catalogProductClass) return 0

  const products = await em.find(
    catalogProductClass,
    { ...scope, deletedAt: null },
    { limit: DEMO_PRODUCT_LIMIT, orderBy: { id: 'asc' } },
  )
  if (products.length === 0) return 0

  let created = 0
  const now = new Date()
  for (let index = 0; index < products.length; index += 1) {
    const product = products[index] as { id: string; sku?: string | null }

    // The probe asks "was this product already considered here?", not "does it have a live
    // position?", so it deliberately does NOT filter `deletedAt: null` — the same rule the order
    // scenario probe above follows. A soft-deleted position is a decision (an operator's delete, or
    // the HoReCa seeder retiring a demo cost that landed on a sneaker); a probe over live rows only
    // would undo that decision on every seed run. Seeding is additive; it never resurrects.
    // `purge-demo` hard-deletes through `nativeDelete`, so it remains the way to get demo rows back.
    const existing = await em.findOne(PricingPurchasePosition, {
      ...scope,
      catalogProductId: product.id,
    })
    if (existing) continue

    // A spread of costs and rebate tiers so the waterfall and the markup distribution are not flat.
    const baseCost = 4 + ((index * 7) % 60)
    const tierDiscount = index % 4 === 0 ? '6.0000' : index % 3 === 0 ? '3.5000' : '0.0000'
    const ageDays = index % 5 === 0 ? 95 : 12 + (index % 30)

    em.persist(
      em.create(PricingPurchasePosition, {
        ...scope,
        catalogProductId: product.id,
        sku: product.sku ?? null,
        annualVolume: String((index + 1) * 250),
        currentTierCode: tierDiscount === '0.0000' ? null : `tier_${index % 4}`,
        currentTierDiscount: tierDiscount,
        nextTierVolume: String((index + 1) * 250 + 500),
        nextTierDiscount: '9.0000',
        lastDeliveryUnitCost: `${baseCost}.5000`,
        lastDeliveryAt: new Date(now.getTime() - ageDays * 86_400_000),
        lastDeliveryQuantity: String(120 + index),
        soldQuantityPeriod: String(index % 7 === 0 ? 20 : 110 + index),
        productGroupCode: ['chemistry', 'packaging', 'paper'][index % 3],
        isDemo: true,
      }),
    )
    created += 1
  }
  return created
}

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['pricing.*'],
    employee: ['pricing.view', 'pricing.quote', 'pricing.audit.read'],
  },

  async seedDefaults({ em, tenantId, organizationId }) {
    const scope = { tenantId, organizationId }
    await ensureSupplierProfile(em, scope)
    await seedParameterRows(em, scope)
    await seedLogisticsRows(em, scope)
    await seedCoverage(em, scope)
    await em.flush()
  },

  async seedExamples({ em, container, tenantId, organizationId }) {
    const scope = { tenantId, organizationId }
    await ensureSupplierProfile(em, scope)
    const created = await seedDemoPurchasePositions(
      em,
      container as unknown as { resolve: (name: string) => unknown },
      scope,
    )
    await em.flush()
    if (created === 0) {
      logger.warn(
        '[pricing_engine] No catalog products found; demo purchase positions were not seeded',
        { tenantId, organizationId },
      )
    }
  },
}

export default setup
