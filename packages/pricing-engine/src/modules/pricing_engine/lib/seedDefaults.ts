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

/**
 * A customer whose order is the same order every week is CHEAPER TO SERVE, not entitled to a
 * discount: nothing is negotiated at intake and the picker works from a standing list. The saving
 * therefore belongs on the cost side, where the percentage margin survives it untouched and the
 * lower price can be defended line by line in front of the customer.
 */
export const REPEAT_ORDER_SCENARIO_CODE = 'repeat_order'

/**
 * The band the seeded `repeat_order` multipliers must stay inside, and the reason they may not
 * leave it.
 *
 * Loaded rates, from the rows above: sales rep 85.00 x 1.22 = 103.70 PLN/h, warehouse
 * 48.00 x 1.22 = 58.56 PLN/h. At multiplier 1.00 the two affected steps cost
 * `order_intake` 6 min -> 10.3700 PLN per order and `picking` 2.5 min -> 2.4400 PLN per line.
 *
 * `order_intake` 0.25 (min of the band). Against the ONLY baseline the rule is allowed to replace,
 * `ideal_file` at 0.35, that removes (0.35 - 0.25) x 10.3700 = 1.0370 PLN per order — 28.6% of
 * that channel's own 3.6295 PLN intake cost. The upper edge 0.35 is the no-op case, so the band is
 * bounded on both sides by numbers the distributor measured.
 *
 * Why the band stops at 0.25 rather than going lower, and why eligibility is restricted: a scenario
 * REPLACES the channel scenario, so the saving it fabricates is `(baseline - repeat) x 10.3700`.
 * Applied to `email` (1.30) a 0.25 multiplier would remove 10.8885 PLN of intake labour — three
 * times the entire 3.6295 PLN intake cost of the cheapest channel the distributor actually
 * measured. A saving larger than the whole cheapest measurement of the activity it claims to
 * shorten cannot be defended, so the guard is: the multiplier delta may not exceed 0.35, the whole
 * of `ideal_file`. `nonstandard_file` (0.90) fails that guard by 0.65 -> 6.7405 PLN and is
 * therefore NOT eligible either; see `horecaCustomerData.isRepeatOrderCustomer`.
 *
 * `picking` 0.90. A repeat basket is picked against a standing list rather than read line by line,
 * worth 0.2440 PLN per line — 10% of the step. No channel in this file moves `picking` at all, so
 * unlike the intake figure this one has no measured sibling to calibrate against: it is the
 * smallest visible step down, deliberately, because it is the weakest-evidenced number here.
 */
/**
 * Scenario codes that are a BEHAVIOUR, not an ordering channel.
 *
 * `pricing_order_scenarios` holds both, because both scale the same process steps. The advisor's
 * channel-change generator must not offer these: "move this customer to repeat ordering" is not a
 * channel a rep can switch them to, it is a description of how that customer already buys. Offering
 * it would produce a saving nobody can act on, attached to a decision nobody can make.
 */
export const NON_CHANNEL_SCENARIO_CODES: readonly string[] = [REPEAT_ORDER_SCENARIO_CODE]

export const REPEAT_ORDER_MULTIPLIER_BAND = {
  order_intake: { min: '0.25', max: '0.35' },
  picking: { min: '0.90', max: '1.00' },
} as const

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
  {
    code: REPEAT_ORDER_SCENARIO_CODE,
    label: 'pricing_engine.scenarios.repeatOrder',
    stepMultipliers: { order_intake: '0.25', picking: '0.90' },
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
