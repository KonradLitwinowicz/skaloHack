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
