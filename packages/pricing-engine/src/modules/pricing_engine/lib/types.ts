import type { Decimal } from './decimal'
import type {
  PricingComponentEffect,
  PricingComponentLevel,
  PricingConfidence,
  PricingMode,
} from '../data/entities'
import type { AuthorisedDeadstockFloors } from './deadstock/authorisedFloor'

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
  // Optional because ComponentDeps is a contract surface and WMS is an optional peer: a caller
  // assembling deps without it must keep compiling, and a component without it must keep pricing.
  inventory?: InventorySnapshot
  // Floors a person authorised on the deadstock screen. Optional for the same reason, and empty
  // whenever nobody has confirmed anything — which is the normal state.
  deadstock?: AuthorisedDeadstockFloors
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

export type ProductLotSnapshot = {
  lotId: string
  lotNumber: string
  status: 'available' | 'hold' | 'quarantine' | 'expired'
  manufacturedAt: Date | null
  bestBeforeAt: Date | null
  expiresAt: Date | null
  quantityAvailable: string
}

/**
 * Why a turnover figure is or is not measured. Only `movements` may be presented as a measurement;
 * every other value means the component fell back to its configured default and must say so.
 */
export type InventoryRotationSource =
  | 'movements'
  | 'no_movements'
  | 'no_issues'
  | 'no_stock'
  | 'short_history'
  | 'unavailable'

export type ProductRotation = {
  productId: string
  variantIds: string[]
  onHandQuantity: string
  issuedQuantity: string
  observedDays: number
  dailyIssueRate: string
  coverDays: string | null
  source: InventoryRotationSource
}

export type ProductInventorySnapshot = {
  productId: string
  variantIds: string[]
  trackExpiration: boolean
  defaultStrategy: 'fifo' | 'lifo' | 'fefo' | null
  /** Lots with pickable stock, already in FEFO order. */
  lots: ProductLotSnapshot[]
  rotation: ProductRotation
}

// Stock is prefetched next to the catalog rather than read inside a component, for the same reason
// every other dependency is: a 50-line basket must cost a fixed number of queries.
export type InventorySnapshot = {
  byProductId: Map<string, ProductInventorySnapshot>
  rotationWindowDays: number
  /** False when the WMS module is absent, which is a supported configuration. */
  available: boolean
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
  // Each already-executed component's own contribution, keyed by code. `unitCostNet` is the
  // running total of all of them, which is the wrong base for anything that needs one specific
  // earlier figure — frozen capital finances the goods, not the labour not yet spent on them.
  componentValues: Readonly<Record<string, string>>
  // Full results of the components already run on this line, in order. Optional so callers that
  // compute a single component in isolation keep working; `rounding` reads the guardrail's floor
  // from here so it can never round a clamped price back under it.
  priorResults?: ReadonlyArray<ComponentResult>
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
