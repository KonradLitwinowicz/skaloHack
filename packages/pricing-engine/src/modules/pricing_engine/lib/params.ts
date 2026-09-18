import type { EntityManager } from '@mikro-orm/postgresql'
import {
  PricingComponentParam,
  PricingCustomerProfile,
  PricingDeliveryZone,
  PricingFuelPrice,
  PricingGuardrail,
  PricingLaborRate,
  PricingOrderScenario,
  PricingPackagingCost,
  PricingProcessStep,
  PricingVehicle,
  PricingWarehouseCost,
  type PricingParamScope,
} from '../data/entities'
import type {
  DeliveryZoneSnapshot,
  GuardrailSnapshot,
  LaborRateSnapshot,
  OrderScenarioSnapshot,
  ParameterLookup,
  PackagingCostSnapshot,
  ProcessStepSnapshot,
  ScopeRefs,
  VehicleSnapshot,
  WarehouseCostSnapshot,
} from './types'

export type ParameterScope = {
  tenantId: string
  organizationId: string
  date: Date
}

// Most specific wins. Same order for component params and guardrails so an operator only has to
// learn one precedence rule.
const SCOPE_PRECEDENCE: PricingParamScope[] = [
  'customer',
  'customer_group',
  'product',
  'product_group',
  'global',
]

function scopeRefValue(scope: PricingParamScope, refs: ScopeRefs): string | null {
  switch (scope) {
    case 'customer':
      return refs.customerId ?? null
    case 'customer_group':
      return refs.customerGroupCode ?? null
    case 'product':
      return refs.productId ?? null
    case 'product_group':
      return refs.productGroupCode ?? null
    case 'global':
      return null
  }
}

function validAt<T extends { validFrom: Date; validTo?: Date | null }>(rows: T[], date: Date): T[] {
  return rows.filter((row) => {
    if (row.validFrom.getTime() > date.getTime()) return false
    if (row.validTo && row.validTo.getTime() <= date.getTime()) return false
    return true
  })
}

// Newest `valid_from` wins within one scope, so a correction supersedes the row it corrects
// without anyone having to close the old one first.
function newestFirst<T extends { validFrom: Date }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => right.validFrom.getTime() - left.validFrom.getTime())
}

export type LoadedParameters = {
  lookup: ParameterLookup
  customerProfile: PricingCustomerProfile | null
}

export async function loadParameters(
  em: EntityManager,
  scope: ParameterScope,
  refs: { customerId?: string | null },
): Promise<LoadedParameters> {
  const baseFilter = { tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null }

  const [
    laborRates,
    processSteps,
    orderScenarios,
    componentParams,
    guardrails,
    customerProfile,
    packagingCosts,
    warehouseCosts,
    vehicles,
    deliveryZones,
    fuelPrices,
  ] = await Promise.all([
    em.find(PricingLaborRate, baseFilter),
    em.find(PricingProcessStep, baseFilter),
    em.find(PricingOrderScenario, baseFilter),
    em.find(PricingComponentParam, baseFilter),
    em.find(PricingGuardrail, baseFilter),
    refs.customerId
      ? em.findOne(PricingCustomerProfile, { ...baseFilter, customerId: refs.customerId })
      : Promise.resolve(null),
    em.find(PricingPackagingCost, baseFilter),
    em.find(PricingWarehouseCost, baseFilter),
    em.find(PricingVehicle, { ...baseFilter, isActive: true }),
    em.find(PricingDeliveryZone, baseFilter),
    em.find(PricingFuelPrice, { ...baseFilter, observedOn: { $lte: scope.date } }),
  ])

  const activeLaborRates = newestFirst(validAt(laborRates, scope.date))
  const activeProcessSteps = newestFirst(validAt(processSteps, scope.date))
  const activeScenarios = newestFirst(validAt(orderScenarios, scope.date))
  const activeComponentParams = newestFirst(validAt(componentParams, scope.date))
  const activeGuardrails = newestFirst(validAt(guardrails, scope.date))

  const laborByRole = new Map<string, LaborRateSnapshot>()
  for (const row of activeLaborRates) {
    if (laborByRole.has(row.roleCode)) continue
    laborByRole.set(row.roleCode, {
      roleCode: row.roleCode,
      hourlyRate: row.hourlyRate,
      overheadRate: row.overheadRate,
    })
  }

  const stepsByCode = new Map<string, ProcessStepSnapshot>()
  for (const row of activeProcessSteps) {
    if (stepsByCode.has(row.code)) continue
    stepsByCode.set(row.code, {
      code: row.code,
      labelKey: row.label,
      roleCode: row.roleCode,
      durationMinutes: row.durationMinutes,
      isPerLine: row.isPerLine,
      isPerOrder: row.isPerOrder,
    })
  }
  const steps = Array.from(stepsByCode.values())

  const scenariosByCode = new Map<string, OrderScenarioSnapshot>()
  for (const row of activeScenarios) {
    if (scenariosByCode.has(row.code)) continue
    scenariosByCode.set(row.code, {
      code: row.code,
      labelKey: row.label,
      stepMultipliers: row.stepMultipliers ?? {},
      extraStepCodes: row.extraStepCodes ?? [],
    })
  }

  function resolveComponentParam(
    componentCode: string,
    refsForScope: ScopeRefs,
  ): PricingComponentParam | null {
    for (const scopeKind of SCOPE_PRECEDENCE) {
      const wanted = scopeRefValue(scopeKind, refsForScope)
      if (scopeKind !== 'global' && !wanted) continue
      const match = activeComponentParams.find(
        (row) =>
          row.componentCode === componentCode &&
          row.scope === scopeKind &&
          (scopeKind === 'global' ? true : row.scopeRefId === wanted),
      )
      if (match) return match
    }
    return null
  }

  const packagingByUnit = new Map<string, PackagingCostSnapshot>()
  for (const row of newestFirst(validAt(packagingCosts, scope.date))) {
    if (packagingByUnit.has(row.unitCode)) continue
    packagingByUnit.set(row.unitCode, {
      unitCode: row.unitCode,
      materialCost: row.materialCost,
      packMinutes: row.packMinutes,
      roleCode: row.roleCode,
    })
  }

  const activeWarehouseCost = newestFirst(validAt(warehouseCosts, scope.date))[0] ?? null

  const vehiclesByCode = new Map<string, VehicleSnapshot>()
  for (const row of vehicles) {
    if (vehiclesByCode.has(row.code)) continue
    vehiclesByCode.set(row.code, {
      code: row.code,
      capacityKg: row.capacityKg ?? null,
      capacityM3: row.capacityM3 ?? null,
      capacityPallets: row.capacityPallets ?? null,
      fuelType: row.fuelType,
      consumptionLPer100Km: row.consumptionLPer100Km,
      fixedCostMonth: row.fixedCostMonth,
      driverRoleCode: row.driverRoleCode,
    })
  }

  const zonesByCode = new Map<string, DeliveryZoneSnapshot>()
  for (const row of deliveryZones) {
    if (zonesByCode.has(row.code)) continue
    zonesByCode.set(row.code, {
      code: row.code,
      avgDistanceKm: row.avgDistanceKm,
      avgDriveMinutes: row.avgDriveMinutes,
      typicalStops: row.typicalStops,
      defaultVehicleCode: row.defaultVehicleCode ?? null,
    })
  }

  // Nearest observation at or before the quote date wins, so a historical quote
  // reprices with the fuel price that was actually in force.
  const fuelByType = new Map<string, string>()
  for (const row of [...fuelPrices].sort(
    (left, right) => right.observedOn.getTime() - left.observedOn.getTime(),
  )) {
    if (fuelByType.has(row.fuelType)) continue
    fuelByType.set(row.fuelType, row.pricePerLitre)
  }

  const negotiatedExpired =
    customerProfile?.negotiatedPriceExpiresAt != null &&
    customerProfile.negotiatedPriceExpiresAt.getTime() <= scope.date.getTime()

  const lookup: ParameterLookup = {
    componentPayload(componentCode, refsForScope) {
      return resolveComponentParam(componentCode, refsForScope)?.payload ?? null
    },
    componentParamRef(componentCode, refsForScope) {
      return resolveComponentParam(componentCode, refsForScope)?.id ?? null
    },
    laborRate(roleCode) {
      return laborByRole.get(roleCode) ?? null
    },
    processSteps() {
      return steps
    },
    orderScenario(code) {
      if (!code) return null
      return scenariosByCode.get(code) ?? null
    },
    guardrail(refsForScope): GuardrailSnapshot | null {
      for (const scopeKind of SCOPE_PRECEDENCE) {
        const wanted = scopeRefValue(scopeKind, refsForScope)
        if (scopeKind !== 'global' && !wanted) continue
        const match = activeGuardrails.find(
          (row) => row.scope === scopeKind && (scopeKind === 'global' ? true : row.scopeRefId === wanted),
        )
        if (!match) continue
        return {
          code: match.code,
          minMarginPercent: match.minMarginPercent ?? null,
          maxDiscountPercent: match.maxDiscountPercent ?? null,
          floorPrice: match.floorPrice ?? null,
          rounding: match.rounding ?? null,
          negotiatedPricePrecedence: match.negotiatedPricePrecedence,
        }
      }
      return null
    },
    negotiatedUnitPrice(productId) {
      if (!customerProfile || negotiatedExpired) return null
      const prices = customerProfile.negotiatedPrices ?? {}
      return prices[productId] ?? null
    },
    packagingCost(unitCode) {
      return packagingByUnit.get(unitCode) ?? null
    },
    warehouseCost(): WarehouseCostSnapshot | null {
      if (!activeWarehouseCost) return null
      return {
        basis: activeWarehouseCost.basis,
        costPerMonth: activeWarehouseCost.costPerMonth,
        capitalCostAnnualRate: activeWarehouseCost.capitalCostAnnualRate,
        defaultTurnoverDays: activeWarehouseCost.defaultTurnoverDays,
      }
    },
    vehicle(code) {
      if (!code) return null
      return vehiclesByCode.get(code) ?? null
    },
    deliveryZone(code) {
      if (!code) return null
      return zonesByCode.get(code) ?? null
    },
    fuelPrice(fuelType) {
      return fuelByType.get(fuelType) ?? null
    },
  }

  return { lookup, customerProfile: customerProfile ?? null }
}
