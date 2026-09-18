import type { Decimal } from './decimal'
import type {
  PricingComponentEffect,
  PricingComponentLevel,
  PricingConfidence,
  PricingMode,
} from '../data/entities'

export type { PricingComponentEffect, PricingComponentLevel, PricingConfidence, PricingMode }

export type PricingBasketLine = {
  productId: string
  variantId?: string | null
  sku?: string | null
  quantity: string
  enteredQuantity?: string | null
  enteredUnitCode?: string | null
}

export type PricingContext = {
  tenantId: string
  organizationId: string
  currencyCode: string
  customerId?: string | null
  customerGroupCode?: string | null
  orderScenarioCode?: string | null
  deliveryZoneCode?: string | null
  lines: PricingBasketLine[]
  date: Date
  mode: PricingMode
}

export type ComponentResult = {
  code: string
  labelKey: string
  effect: PricingComponentEffect
  // Currency amount for `add`, a multiplier for `mul`. Decimal string.
  value: string
  inputs: Record<string, unknown>
  params: Record<string, unknown>
  explainKey: string
  explainValues: Record<string, unknown>
  confidence: PricingConfidence
  warnings?: string[]
}

export type PricingLineResult = {
  line: PricingBasketLine
  unitPriceNet: string
  totalPriceNet: string
  unitCostNet: string
  markupPercent: string
  marginPercent: string
  breakdown: ComponentResult[]
  warnings: string[]
}

export type PricingQuoteResult = {
  calculationId: string | null
  currencyCode: string
  mode: PricingMode
  parameterSetVersion: number
  lines: PricingLineResult[]
  totalNet: string
  totalCostNet: string
  totalMarkupPercent: string
  totalMarginPercent: string
  warnings: string[]
  durationMs: number
}

// Everything a component may read is prefetched before the loop: components receive data,
// never an EntityManager. A 50-line basket therefore costs O(1) queries, not O(50 x 11).
export type ComponentDeps = {
  supplier: SupplierSnapshot
  params: ParameterLookup
  catalog: CatalogSnapshot
  indicators: IndicatorSnapshot
  allocation: BasketAllocation
}

export type SupplierSnapshot = {
  id: string
  slug: string
  currencyCode: string
  defaultTargetMarkup: string
  mode: PricingMode
  roundingPolicy: Record<string, unknown> | null
  parameterSetVersion: number
}

export type CatalogProductSnapshot = {
  productId: string
  variantId: string | null
  sku: string | null
  title: string | null
  productGroupCode: string | null
  weightValue: string | null
  weightUnit: string | null
  dimensions: Record<string, unknown> | null
  unitConversions: Record<string, string>
  purchase: PurchasePositionSnapshot | null
}

export type PurchasePositionSnapshot = {
  lastDeliveryUnitCost: string | null
  lastDeliveryAt: Date | null
  lastDeliveryQuantity: string | null
  soldQuantityPeriod: string | null
  currentTierCode: string | null
  currentTierDiscount: string
  nextTierVolume: string | null
  nextTierDiscount: string | null
  annualVolume: string
  productGroupCode: string | null
}

export type CatalogSnapshot = {
  byProductId: Map<string, CatalogProductSnapshot>
}

export type IndicatorSnapshot = {
  byCode: Map<string, { value: string; normalizedValue: string; confidence: PricingConfidence }>
}

// Per-order costs and logistics are attributed to lines proportionally to line net value
// (owner decision Q5). The share is computed once against the pre-allocation running totals.
export type BasketAllocation = {
  shareByLineIndex: string[]
}

export type ProcessStepSnapshot = {
  code: string
  labelKey: string
  roleCode: string
  durationMinutes: string
  isPerLine: boolean
  isPerOrder: boolean
}

export type LaborRateSnapshot = {
  roleCode: string
  hourlyRate: string
  overheadRate: string
}

export type OrderScenarioSnapshot = {
  code: string
  labelKey: string
  stepMultipliers: Record<string, string>
  extraStepCodes: string[]
}

export type PackagingCostSnapshot = {
  unitCode: string
  materialCost: string
  packMinutes: string
  roleCode: string
}

export type WarehouseCostSnapshot = {
  basis: 'm2' | 'pallet_slot'
  costPerMonth: string
  capitalCostAnnualRate: string
  defaultTurnoverDays: number
}

export type VehicleSnapshot = {
  code: string
  capacityKg: string | null
  capacityM3: string | null
  capacityPallets: number | null
  fuelType: string
  consumptionLPer100Km: string
  fixedCostMonth: string
  driverRoleCode: string
}

export type DeliveryZoneSnapshot = {
  code: string
  avgDistanceKm: string
  avgDriveMinutes: string
  typicalStops: number
  defaultVehicleCode: string | null
}

export type ParameterLookup = {
  componentPayload(componentCode: string, scopeRefs: ScopeRefs): Record<string, unknown> | null
  componentParamRef(componentCode: string, scopeRefs: ScopeRefs): string | null
  laborRate(roleCode: string): LaborRateSnapshot | null
  processSteps(): ProcessStepSnapshot[]
  orderScenario(code: string | null | undefined): OrderScenarioSnapshot | null
  guardrail(scopeRefs: ScopeRefs): GuardrailSnapshot | null
  negotiatedUnitPrice(productId: string): string | null
  packagingCost(unitCode: string): PackagingCostSnapshot | null
  warehouseCost(): WarehouseCostSnapshot | null
  vehicle(code: string | null | undefined): VehicleSnapshot | null
  deliveryZone(code: string | null | undefined): DeliveryZoneSnapshot | null
  // Nearest observation at or before the quote date — a fuel price is a time series,
  // and a historical quote must reprice with the fuel price that was in force.
  fuelPrice(fuelType: string): string | null
}

export type ScopeRefs = {
  productId?: string | null
  productGroupCode?: string | null
  customerId?: string | null
  customerGroupCode?: string | null
}

export type GuardrailSnapshot = {
  code: string
  minMarginPercent: string | null
  maxDiscountPercent: string | null
  floorPrice: string | null
  rounding: Record<string, unknown> | null
  negotiatedPricePrecedence: string
}

export type ComponentComputeArgs = {
  context: PricingContext
  lineIndex: number
  line: PricingBasketLine
  quantity: Decimal
  runningUnitValue: Decimal
  unitCostNet: Decimal
  deps: ComponentDeps
}

export type PriceComponent = {
  code: string
  position: number
  level: PricingComponentLevel
  effect: PricingComponentEffect
  labelKey: string
  // Cost components feed the margin/markup denominator; price components (target markup,
  // guardrails, rounding) do not. Declaring it per component keeps the split out of the runner.
  contributesToCost: boolean
  compute(args: ComponentComputeArgs): Promise<ComponentResult>
}
