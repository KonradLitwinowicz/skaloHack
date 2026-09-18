import type {
  CatalogProductSnapshot,
  ComponentDeps,
  DeliveryZoneSnapshot,
  GuardrailSnapshot,
  LaborRateSnapshot,
  OrderScenarioSnapshot,
  PackagingCostSnapshot,
  ParameterLookup,
  PricingContext,
  ProcessStepSnapshot,
  SupplierSnapshot,
  VehicleSnapshot,
  WarehouseCostSnapshot,
} from '../lib/types'
import {
  DEMO_LABOR_RATES,
  DEMO_ORDER_SCENARIOS,
  DEMO_OVERHEAD_RATE,
  DEMO_PROCESS_STEPS,
} from '../lib/seedDefaults'

export const PRODUCT_ID = '11111111-1111-4111-8111-111111111111'
export const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222'
export const QUOTE_DATE = new Date('2026-06-15T10:00:00.000Z')

export function buildSupplier(overrides: Partial<SupplierSnapshot> = {}): SupplierSnapshot {
  return {
    id: 'supplier-1',
    slug: 'demo-horeca',
    currencyCode: 'PLN',
    defaultTargetMarkup: '66.0000',
    mode: 'shadow',
    roundingPolicy: { step: '0.01' },
    parameterSetVersion: 1,
    ...overrides,
  }
}

export function buildProduct(overrides: Partial<CatalogProductSnapshot> = {}): CatalogProductSnapshot {
  return {
    productId: PRODUCT_ID,
    variantId: null,
    sku: 'CHEM-014',
    title: 'Degreaser 5 l',
    productGroupCode: 'chemistry',
    weightValue: '5.2000',
    weightUnit: 'kg',
    dimensions: null,
    unitConversions: {},
    purchase: {
      lastDeliveryUnitCost: '20.0000',
      lastDeliveryAt: new Date('2026-06-01T00:00:00.000Z'),
      lastDeliveryQuantity: '120',
      soldQuantityPeriod: '110',
      currentTierCode: 'tier_1',
      currentTierDiscount: '0.0000',
      nextTierVolume: '1500',
      nextTierDiscount: '9.0000',
      annualVolume: '1000',
      productGroupCode: 'chemistry',
    },
    ...overrides,
  }
}

type LookupOverrides = {
  componentPayloads?: Record<string, Record<string, unknown>>
  guardrail?: GuardrailSnapshot | null
  negotiatedPrices?: Record<string, string>
  steps?: ProcessStepSnapshot[]
  scenarios?: OrderScenarioSnapshot[]
  laborRates?: LaborRateSnapshot[]
  packagingCosts?: PackagingCostSnapshot[]
  warehouseCost?: WarehouseCostSnapshot | null
  vehicles?: VehicleSnapshot[]
  deliveryZones?: DeliveryZoneSnapshot[]
  fuelPrices?: Record<string, string>
}

// Assumed Step 2 defaults for a Polish HoReCa wholesaler, matching the shape of
// lib/seedDefaults.ts. Assumptions, not measurements.
export const DEMO_PACKAGING: PackagingCostSnapshot[] = [
  { unitCode: 'pc', materialCost: '0.1200', packMinutes: '0.2000', roleCode: 'warehouse' },
  { unitCode: 'box', materialCost: '1.8500', packMinutes: '1.5000', roleCode: 'warehouse' },
  { unitCode: 'pallet', materialCost: '38.0000', packMinutes: '12.0000', roleCode: 'warehouse' },
]

export const DEMO_WAREHOUSE: WarehouseCostSnapshot = {
  basis: 'pallet_slot',
  costPerMonth: '95.0000',
  capitalCostAnnualRate: '9.0000',
  defaultTurnoverDays: 30,
}

export const DEMO_VEHICLES: VehicleSnapshot[] = [
  {
    code: 'van_35t',
    capacityKg: '1200.0000',
    capacityM3: '14.0000',
    capacityPallets: 6,
    fuelType: 'diesel',
    consumptionLPer100Km: '11.5000',
    fixedCostMonth: '4200.0000',
    driverRoleCode: 'driver',
  },
]

export const DEMO_ZONES: DeliveryZoneSnapshot[] = [
  {
    code: 'warszawa_poludnie',
    avgDistanceKm: '34.0000',
    avgDriveMinutes: '55.0000',
    typicalStops: 3,
    defaultVehicleCode: 'van_35t',
  },
  {
    code: 'mazowieckie_daleko',
    avgDistanceKm: '145.0000',
    avgDriveMinutes: '190.0000',
    typicalStops: 1,
    defaultVehicleCode: 'van_35t',
  },
]

export const DEMO_FUEL: Record<string, string> = { diesel: '6.4900' }

export function buildLookup(overrides: LookupOverrides = {}): ParameterLookup {
  const laborRates =
    overrides.laborRates ??
    DEMO_LABOR_RATES.map((rate) => ({
      roleCode: rate.roleCode,
      hourlyRate: rate.hourlyRate,
      overheadRate: DEMO_OVERHEAD_RATE,
    }))
  const steps =
    overrides.steps ??
    DEMO_PROCESS_STEPS.map((step) => ({
      code: step.code,
      labelKey: step.label,
      roleCode: step.roleCode,
      durationMinutes: step.durationMinutes,
      isPerLine: step.isPerLine,
      isPerOrder: step.isPerOrder,
    }))
  const scenarios =
    overrides.scenarios ??
    DEMO_ORDER_SCENARIOS.map((scenario) => ({
      code: scenario.code,
      labelKey: scenario.label,
      stepMultipliers: { ...scenario.stepMultipliers },
      extraStepCodes: [...scenario.extraStepCodes],
    }))

  return {
    componentPayload(componentCode) {
      return overrides.componentPayloads?.[componentCode] ?? null
    },
    componentParamRef(componentCode) {
      return overrides.componentPayloads?.[componentCode] ? `param-${componentCode}` : null
    },
    laborRate(roleCode) {
      return laborRates.find((rate) => rate.roleCode === roleCode) ?? null
    },
    processSteps() {
      return steps
    },
    orderScenario(code) {
      if (!code) return null
      return scenarios.find((scenario) => scenario.code === code) ?? null
    },
    guardrail() {
      return overrides.guardrail === undefined
        ? {
            code: 'default',
            minMarginPercent: '8.0000',
            maxDiscountPercent: '25.0000',
            floorPrice: null,
            rounding: null,
            negotiatedPricePrecedence: 'negotiated_wins',
          }
        : overrides.guardrail
    },
    negotiatedUnitPrice(productId) {
      return overrides.negotiatedPrices?.[productId] ?? null
    },
    packagingCost(unitCode) {
      const rows = overrides.packagingCosts ?? DEMO_PACKAGING
      return rows.find((row) => row.unitCode === unitCode) ?? null
    },
    warehouseCost() {
      return overrides.warehouseCost === undefined ? DEMO_WAREHOUSE : overrides.warehouseCost
    },
    vehicle(code) {
      if (!code) return null
      const rows = overrides.vehicles ?? DEMO_VEHICLES
      return rows.find((row) => row.code === code) ?? null
    },
    deliveryZone(code) {
      if (!code) return null
      const rows = overrides.deliveryZones ?? DEMO_ZONES
      return rows.find((row) => row.code === code) ?? null
    },
    fuelPrice(fuelType) {
      return (overrides.fuelPrices ?? DEMO_FUEL)[fuelType] ?? null
    },
  }
}

export function buildDeps(
  overrides: {
    supplier?: Partial<SupplierSnapshot>
    product?: Partial<CatalogProductSnapshot>
    lookup?: LookupOverrides
    allocation?: string[]
  } = {},
): ComponentDeps {
  const product = buildProduct(overrides.product)
  return {
    supplier: buildSupplier(overrides.supplier),
    params: buildLookup(overrides.lookup),
    catalog: { byProductId: new Map([[product.productId, product]]) },
    indicators: { byCode: new Map() },
    allocation: { shareByLineIndex: overrides.allocation ?? ['1.0000'] },
  }
}

export function buildContext(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    tenantId: '33333333-3333-4333-8333-333333333333',
    organizationId: '44444444-4444-4444-8444-444444444444',
    currencyCode: 'PLN',
    customerId: CUSTOMER_ID,
    customerGroupCode: null,
    orderScenarioCode: 'ideal_file',
    deliveryZoneCode: null,
    lines: [{ productId: PRODUCT_ID, sku: 'CHEM-014', quantity: '24' }],
    date: QUOTE_DATE,
    mode: 'shadow',
    ...overrides,
  }
}
