// Assumed starting values for a Polish HoReCa wholesaler (owner decision Q7).
//
// Every number here is an ASSUMPTION, not a measurement. Rows created from it carry
// `is_demo = true` and the coverage register reports the components they feed as `default`.
// A real distributor replaces them through the params screen or a supplier package.

export const DEMO_SUPPLIER_SLUG = 'demo-horeca'

export const DEMO_OVERHEAD_RATE = '22.0000'

export const DEMO_LABOR_RATES = [
  { roleCode: 'sales_rep', label: 'pricing_engine.roles.salesRep', hourlyRate: '85.0000' },
  { roleCode: 'warehouse', label: 'pricing_engine.roles.warehouse', hourlyRate: '48.0000' },
  { roleCode: 'driver', label: 'pricing_engine.roles.driver', hourlyRate: '55.0000' },
  { roleCode: 'accounting', label: 'pricing_engine.roles.accounting', hourlyRate: '75.0000' },
  { roleCode: 'collections', label: 'pricing_engine.roles.collections', hourlyRate: '90.0000' },
] as const

export const DEMO_PROCESS_STEPS = [
  {
    code: 'order_intake',
    label: 'pricing_engine.steps.orderIntake',
    roleCode: 'sales_rep',
    durationMinutes: '6.0000',
    isPerLine: false,
    isPerOrder: true,
  },
  {
    code: 'picking',
    label: 'pricing_engine.steps.picking',
    roleCode: 'warehouse',
    durationMinutes: '2.5000',
    isPerLine: true,
    isPerOrder: false,
  },
  {
    code: 'packing',
    label: 'pricing_engine.steps.packing',
    roleCode: 'warehouse',
    durationMinutes: '1.5000',
    isPerLine: true,
    isPerOrder: false,
  },
  {
    code: 'dispatch',
    label: 'pricing_engine.steps.dispatch',
    roleCode: 'warehouse',
    durationMinutes: '4.0000',
    isPerLine: false,
    isPerOrder: true,
  },
  {
    code: 'invoicing',
    label: 'pricing_engine.steps.invoicing',
    roleCode: 'accounting',
    durationMinutes: '3.0000',
    isPerLine: false,
    isPerOrder: true,
  },
  {
    code: 'dunning',
    label: 'pricing_engine.steps.dunning',
    roleCode: 'collections',
    durationMinutes: '12.0000',
    isPerLine: false,
    // Only reached through a scenario's `extraStepCodes`, never on a healthy order.
    isPerOrder: false,
  },
] as const

// Multipliers on `order_intake` are calibrated so the channel handling cost spans roughly
// 3.60 PLN (structured file) to 25.60 PLN (phone), matching the distributor's own measurement.
// Base: 6 min x 85 PLN/h x 1.22 overhead = 10.37 PLN at multiplier 1.
export const DEMO_ORDER_SCENARIOS = [
  {
    code: 'ideal_file',
    label: 'pricing_engine.scenarios.idealFile',
    stepMultipliers: { order_intake: '0.35' },
    extraStepCodes: [],
  },
  {
    code: 'nonstandard_file',
    label: 'pricing_engine.scenarios.nonstandardFile',
    stepMultipliers: { order_intake: '0.90' },
    extraStepCodes: [],
  },
  {
    code: 'email',
    label: 'pricing_engine.scenarios.email',
    stepMultipliers: { order_intake: '1.30' },
    extraStepCodes: [],
  },
  {
    code: 'sms',
    label: 'pricing_engine.scenarios.sms',
    stepMultipliers: { order_intake: '2.30' },
    extraStepCodes: [],
  },
  {
    code: 'phone',
    label: 'pricing_engine.scenarios.phone',
    stepMultipliers: { order_intake: '2.47' },
    extraStepCodes: [],
  },
  {
    code: 'rep_visit',
    label: 'pricing_engine.scenarios.repVisit',
    stepMultipliers: { order_intake: '4.00' },
    extraStepCodes: [],
  },
] as const

// Median markup across the distributor's book is 66%.
export const DEMO_DEFAULT_TARGET_MARKUP = '66.0000'

export const DEMO_GUARDRAIL = {
  code: 'default',
  minMarginPercent: '8.0000',
  maxDiscountPercent: '25.0000',
  floorPrice: null,
  negotiatedPricePrecedence: 'negotiated_wins',
} as const

export const DEMO_ROUNDING_POLICY = { step: '0.01' }

// Assumed Step 2 rates. Same status as everything else in this file: assumptions a real
// distributor replaces, never measurements.
export const DEMO_PACKAGING_COSTS = [
  { unitCode: 'pc', materialCost: '0.1200', packMinutes: '0.2000', roleCode: 'warehouse' },
  { unitCode: 'box', materialCost: '1.8500', packMinutes: '1.5000', roleCode: 'warehouse' },
  { unitCode: 'pallet', materialCost: '38.0000', packMinutes: '12.0000', roleCode: 'warehouse' },
] as const

export const DEMO_WAREHOUSE_COST = {
  basis: 'pallet_slot' as const,
  costPerMonth: '95.0000',
  capitalCostAnnualRate: '9.0000',
  defaultTurnoverDays: 30,
}

export const DEMO_VEHICLES = [
  {
    code: 'van_35t',
    label: 'pricing_engine.vehicles.van35t',
    capacityKg: '1200.0000',
    capacityM3: '14.0000',
    capacityPallets: 6,
    fuelType: 'diesel',
    consumptionLPer100Km: '11.5000',
    fixedCostMonth: '4200.0000',
    driverRoleCode: 'driver',
  },
] as const

export const DEMO_DELIVERY_ZONES = [
  {
    code: 'warszawa_poludnie',
    label: 'pricing_engine.zones.warszawaPoludnie',
    avgDistanceKm: '34.0000',
    avgDriveMinutes: '55.0000',
    typicalStops: 3,
    defaultVehicleCode: 'van_35t',
  },
  {
    code: 'mazowieckie_daleko',
    label: 'pricing_engine.zones.mazowieckieDaleko',
    avgDistanceKm: '145.0000',
    avgDriveMinutes: '190.0000',
    typicalStops: 1,
    defaultVehicleCode: 'van_35t',
  },
] as const

// A single observation, not a series — a real distributor feeds this from its fuel-card export.
export const DEMO_FUEL_PRICES = [{ fuelType: 'diesel', pricePerLitre: '6.4900' }] as const

export const COVERAGE_SEED = [
  {
    componentCode: 'product_cost',
    sourceKind: 'pricing_purchase_positions',
    sourceRef: 'last_delivery_unit_cost',
    confidence: 'measured' as const,
    missingReasonKey: null,
  },
  {
    componentCode: 'operational_cost_base',
    sourceKind: 'pricing_process_steps',
    sourceRef: 'pricing_labor_rates x pricing_order_scenarios',
    confidence: 'default' as const,
    missingReasonKey: 'pricing_engine.coverage.reason.assumedRates',
  },
  {
    componentCode: 'packaging_cost',
    sourceKind: 'pricing_packaging_costs',
    sourceRef: 'catalog_product_unit_conversions (not wired yet)',
    confidence: 'default' as const,
    missingReasonKey: 'pricing_engine.coverage.reason.packagingConversionsMissing',
  },
  {
    componentCode: 'warehouse_cost',
    sourceKind: 'pricing_warehouse_costs',
    sourceRef: 'catalog dimensions/weight + assumed pallet geometry',
    confidence: 'estimated' as const,
    missingReasonKey: 'pricing_engine.coverage.reason.warehouseTurnoverAssumed',
  },
  {
    componentCode: 'logistics_cost',
    sourceKind: 'pricing_delivery_zones',
    sourceRef: 'pricing_vehicles x pricing_fuel_prices',
    confidence: 'default' as const,
    missingReasonKey: 'pricing_engine.coverage.reason.assumedRates',
  },
  {
    componentCode: 'product_aspects',
    sourceKind: 'catalog_products',
    sourceRef: 'weight_value / dimensions',
    confidence: 'default' as const,
    missingReasonKey: 'pricing_engine.coverage.reason.assumedRates',
  },
  {
    componentCode: 'target_margin',
    sourceKind: 'pricing_component_params',
    sourceRef: 'target_markup_percent',
    confidence: 'default' as const,
    missingReasonKey: 'pricing_engine.coverage.reason.assumedRates',
  },
  {
    componentCode: 'guardrails',
    sourceKind: 'pricing_guardrails',
    sourceRef: 'default',
    confidence: 'measured' as const,
    missingReasonKey: null,
  },
  {
    componentCode: 'rounding',
    sourceKind: 'pricing_supplier_profiles',
    sourceRef: 'rounding_policy',
    confidence: 'measured' as const,
    missingReasonKey: null,
  },
] as const
