import { OptionalProps } from '@mikro-orm/core'
import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

export type PricingMode = 'shadow' | 'advisory' | 'live'
export type PricingComponentEffect = 'add' | 'mul'
export type PricingComponentLevel = 'line' | 'basket'
export type PricingConfidence = 'measured' | 'estimated' | 'default'
export type PricingParamScope =
  | 'global'
  | 'product_group'
  | 'product'
  | 'customer_group'
  | 'customer'

abstract class PricingScopedEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'is_demo', type: 'boolean', default: false })
  isDemo: boolean = false

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'pricing_supplier_profiles' })
@Unique({ name: 'pricing_supplier_profiles_slug_unique', properties: ['tenantId', 'organizationId', 'slug'] })
export class PricingSupplierProfile extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo' | 'mode' | 'parameterSetVersion'

  @Property({ name: 'slug', type: 'text' })
  slug!: string

  @Property({ name: 'name', type: 'text' })
  name!: string

  @Property({ name: 'currency_code', type: 'text' })
  currencyCode!: string

  @Property({ name: 'default_target_markup', type: 'numeric', precision: 7, scale: 4, default: '0' })
  defaultTargetMarkup: string = '0'

  @Property({ name: 'mode', type: 'text', default: 'shadow' })
  mode: PricingMode = 'shadow'

  @Property({ name: 'rounding_policy', type: 'jsonb', nullable: true })
  roundingPolicy?: Record<string, unknown> | null

  @Property({ name: 'parameter_set_version', type: 'integer', default: 1 })
  parameterSetVersion: number = 1
}

@Entity({ tableName: 'pricing_labor_rates' })
@Index({ name: 'pricing_labor_rates_scope_idx', properties: ['tenantId', 'organizationId', 'roleCode'] })
export class PricingLaborRate extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo' | 'overheadRate'

  @Property({ name: 'role_code', type: 'text' })
  roleCode!: string

  @Property({ name: 'label', type: 'text' })
  label!: string

  @Property({ name: 'hourly_rate', type: 'numeric', precision: 18, scale: 4 })
  hourlyRate!: string

  @Property({ name: 'overhead_rate', type: 'numeric', precision: 7, scale: 4, default: '0' })
  overheadRate: string = '0'

  @Property({ name: 'valid_from', type: Date })
  validFrom!: Date

  @Property({ name: 'valid_to', type: Date, nullable: true })
  validTo?: Date | null
}

@Entity({ tableName: 'pricing_process_steps' })
@Index({ name: 'pricing_process_steps_scope_idx', properties: ['tenantId', 'organizationId', 'code'] })
export class PricingProcessStep extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo' | 'isPerLine' | 'isPerOrder'

  @Property({ name: 'code', type: 'text' })
  code!: string

  @Property({ name: 'label', type: 'text' })
  label!: string

  @Property({ name: 'role_code', type: 'text' })
  roleCode!: string

  @Property({ name: 'duration_minutes', type: 'numeric', precision: 18, scale: 4 })
  durationMinutes!: string

  @Property({ name: 'is_per_line', type: 'boolean', default: false })
  isPerLine: boolean = false

  @Property({ name: 'is_per_order', type: 'boolean', default: true })
  isPerOrder: boolean = true

  @Property({ name: 'valid_from', type: Date })
  validFrom!: Date

  @Property({ name: 'valid_to', type: Date, nullable: true })
  validTo?: Date | null
}

@Entity({ tableName: 'pricing_order_scenarios' })
@Index({ name: 'pricing_order_scenarios_scope_idx', properties: ['tenantId', 'organizationId', 'code'] })
export class PricingOrderScenario extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo'

  @Property({ name: 'code', type: 'text' })
  code!: string

  @Property({ name: 'label', type: 'text' })
  label!: string

  @Property({ name: 'step_multipliers', type: 'jsonb', nullable: true })
  stepMultipliers?: Record<string, string> | null

  @Property({ name: 'extra_step_codes', type: 'jsonb', nullable: true })
  extraStepCodes?: string[] | null

  @Property({ name: 'valid_from', type: Date })
  validFrom!: Date

  @Property({ name: 'valid_to', type: Date, nullable: true })
  validTo?: Date | null
}

@Entity({ tableName: 'pricing_packaging_costs' })
@Index({ name: 'pricing_packaging_costs_scope_idx', properties: ['tenantId', 'organizationId', 'unitCode'] })
export class PricingPackagingCost extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo'

  @Property({ name: 'unit_code', type: 'text' })
  unitCode!: string

  @Property({ name: 'material_cost', type: 'numeric', precision: 18, scale: 4 })
  materialCost!: string

  @Property({ name: 'pack_minutes', type: 'numeric', precision: 18, scale: 4 })
  packMinutes!: string

  @Property({ name: 'role_code', type: 'text' })
  roleCode!: string

  @Property({ name: 'valid_from', type: Date })
  validFrom!: Date

  @Property({ name: 'valid_to', type: Date, nullable: true })
  validTo?: Date | null
}

@Entity({ tableName: 'pricing_warehouse_costs' })
@Index({ name: 'pricing_warehouse_costs_scope_idx', properties: ['tenantId', 'organizationId', 'basis'] })
export class PricingWarehouseCost extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo' | 'defaultTurnoverDays'

  @Property({ name: 'basis', type: 'text' })
  basis!: 'm2' | 'pallet_slot'

  @Property({ name: 'cost_per_month', type: 'numeric', precision: 18, scale: 4 })
  costPerMonth!: string

  @Property({ name: 'capital_cost_annual_rate', type: 'numeric', precision: 7, scale: 4, default: '0' })
  capitalCostAnnualRate: string = '0'

  @Property({ name: 'default_turnover_days', type: 'integer', default: 30 })
  defaultTurnoverDays: number = 30

  @Property({ name: 'valid_from', type: Date })
  validFrom!: Date

  @Property({ name: 'valid_to', type: Date, nullable: true })
  validTo?: Date | null
}

@Entity({ tableName: 'pricing_vehicles' })
@Index({ name: 'pricing_vehicles_scope_idx', properties: ['tenantId', 'organizationId', 'code'] })
export class PricingVehicle extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo' | 'isActive'

  @Property({ name: 'code', type: 'text' })
  code!: string

  @Property({ name: 'label', type: 'text' })
  label!: string

  @Property({ name: 'capacity_kg', type: 'numeric', precision: 18, scale: 4, nullable: true })
  capacityKg?: string | null

  @Property({ name: 'capacity_m3', type: 'numeric', precision: 18, scale: 4, nullable: true })
  capacityM3?: string | null

  @Property({ name: 'capacity_pallets', type: 'integer', nullable: true })
  capacityPallets?: number | null

  @Property({ name: 'fuel_type', type: 'text' })
  fuelType!: string

  @Property({ name: 'consumption_l_per_100km', type: 'numeric', precision: 18, scale: 4 })
  consumptionLPer100Km!: string

  @Property({ name: 'fixed_cost_month', type: 'numeric', precision: 18, scale: 4, default: '0' })
  fixedCostMonth: string = '0'

  @Property({ name: 'driver_role_code', type: 'text' })
  driverRoleCode!: string

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true
}

@Entity({ tableName: 'pricing_fuel_prices' })
@Index({ name: 'pricing_fuel_prices_scope_idx', properties: ['tenantId', 'organizationId', 'fuelType', 'observedOn'] })
export class PricingFuelPrice extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo'

  @Property({ name: 'fuel_type', type: 'text' })
  fuelType!: string

  @Property({ name: 'price_per_litre', type: 'numeric', precision: 18, scale: 4 })
  pricePerLitre!: string

  @Property({ name: 'observed_on', type: Date })
  observedOn!: Date
}

@Entity({ tableName: 'pricing_delivery_zones' })
@Index({ name: 'pricing_delivery_zones_scope_idx', properties: ['tenantId', 'organizationId', 'code'] })
export class PricingDeliveryZone extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo' | 'typicalStops'

  @Property({ name: 'code', type: 'text' })
  code!: string

  @Property({ name: 'label', type: 'text' })
  label!: string

  @Property({ name: 'avg_distance_km', type: 'numeric', precision: 18, scale: 4 })
  avgDistanceKm!: string

  @Property({ name: 'avg_drive_minutes', type: 'numeric', precision: 18, scale: 4 })
  avgDriveMinutes!: string

  @Property({ name: 'typical_stops', type: 'integer', default: 1 })
  typicalStops: number = 1

  @Property({ name: 'default_vehicle_code', type: 'text', nullable: true })
  defaultVehicleCode?: string | null
}

@Entity({ tableName: 'pricing_purchase_positions' })
@Index({
  name: 'pricing_purchase_positions_product_idx',
  properties: ['tenantId', 'organizationId', 'catalogProductId'],
})
export class PricingPurchasePosition extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo' | 'currentTierDiscount'

  @Property({ name: 'catalog_product_id', type: 'uuid' })
  catalogProductId!: string

  @Property({ name: 'catalog_variant_id', type: 'uuid', nullable: true })
  catalogVariantId?: string | null

  @Property({ name: 'sku', type: 'text', nullable: true })
  sku?: string | null

  @Property({ name: 'annual_volume', type: 'numeric', precision: 18, scale: 4, default: '0' })
  annualVolume: string = '0'

  @Property({ name: 'current_tier_code', type: 'text', nullable: true })
  currentTierCode?: string | null

  @Property({ name: 'current_tier_discount', type: 'numeric', precision: 7, scale: 4, default: '0' })
  currentTierDiscount: string = '0'

  @Property({ name: 'next_tier_volume', type: 'numeric', precision: 18, scale: 4, nullable: true })
  nextTierVolume?: string | null

  @Property({ name: 'next_tier_discount', type: 'numeric', precision: 7, scale: 4, nullable: true })
  nextTierDiscount?: string | null

  @Property({ name: 'last_delivery_unit_cost', type: 'numeric', precision: 18, scale: 4, nullable: true })
  lastDeliveryUnitCost?: string | null

  @Property({ name: 'last_delivery_at', type: Date, nullable: true })
  lastDeliveryAt?: Date | null

  @Property({ name: 'last_delivery_quantity', type: 'numeric', precision: 18, scale: 4, nullable: true })
  lastDeliveryQuantity?: string | null

  @Property({ name: 'sold_quantity_period', type: 'numeric', precision: 18, scale: 4, nullable: true })
  soldQuantityPeriod?: string | null

  @Property({ name: 'product_group_code', type: 'text', nullable: true })
  productGroupCode?: string | null
}

@Entity({ tableName: 'pricing_customer_profiles' })
@Unique({
  name: 'pricing_customer_profiles_customer_unique',
  properties: ['tenantId', 'organizationId', 'customerId'],
})
export class PricingCustomerProfile extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo'

  @Property({ name: 'customer_id', type: 'uuid' })
  customerId!: string

  @Property({ name: 'customer_group_code', type: 'text', nullable: true })
  customerGroupCode?: string | null

  @Property({ name: 'delivery_zone_code', type: 'text', nullable: true })
  deliveryZoneCode?: string | null

  @Property({ name: 'default_order_scenario_code', type: 'text', nullable: true })
  defaultOrderScenarioCode?: string | null

  @Property({ name: 'negotiated_prices', type: 'jsonb', nullable: true })
  negotiatedPrices?: Record<string, string> | null

  @Property({ name: 'negotiated_price_expires_at', type: Date, nullable: true })
  negotiatedPriceExpiresAt?: Date | null
}

@Entity({ tableName: 'pricing_customer_indicator_definitions' })
@Unique({
  name: 'pricing_customer_indicator_definitions_code_unique',
  properties: ['tenantId', 'organizationId', 'code'],
})
export class PricingCustomerIndicatorDefinition extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo' | 'isActive' | 'algorithmVersion'

  @Property({ name: 'code', type: 'text' })
  code!: string

  @Property({ name: 'label_key', type: 'text' })
  labelKey!: string

  @Property({ name: 'description_key', type: 'text', nullable: true })
  descriptionKey?: string | null

  @Property({ name: 'direction', type: 'text' })
  direction!: 'increases_price' | 'decreases_price'

  @Property({ name: 'weight', type: 'numeric', precision: 7, scale: 4, default: '0' })
  weight: string = '0'

  @Property({ name: 'algorithm_version', type: 'integer', default: 1 })
  algorithmVersion: number = 1

  @Property({ name: 'source', type: 'text', nullable: true })
  source?: string | null

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true
}

@Entity({ tableName: 'pricing_customer_indicators' })
@Index({
  name: 'pricing_customer_indicators_lookup_idx',
  properties: ['tenantId', 'organizationId', 'customerId', 'code'],
})
export class PricingCustomerIndicator extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo' | 'algorithmVersion' | 'confidence'

  @Property({ name: 'customer_id', type: 'uuid' })
  customerId!: string

  @Property({ name: 'code', type: 'text' })
  code!: string

  @Property({ name: 'value', type: 'numeric', precision: 18, scale: 6, default: '0' })
  value: string = '0'

  @Property({ name: 'normalized_value', type: 'numeric', precision: 7, scale: 4, default: '0' })
  normalizedValue: string = '0'

  @Property({ name: 'window_from', type: Date, nullable: true })
  windowFrom?: Date | null

  @Property({ name: 'window_to', type: Date, nullable: true })
  windowTo?: Date | null

  @Property({ name: 'computed_at', type: Date })
  computedAt: Date = new Date()

  @Property({ name: 'algorithm_version', type: 'integer', default: 1 })
  algorithmVersion: number = 1

  @Property({ name: 'confidence', type: 'text', default: 'estimated' })
  confidence: PricingConfidence = 'estimated'
}

@Entity({ tableName: 'pricing_components' })
@Unique({ name: 'pricing_components_code_unique', properties: ['tenantId', 'organizationId', 'code'] })
export class PricingComponentDefinition extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo' | 'isActive'

  @Property({ name: 'code', type: 'text' })
  code!: string

  @Property({ name: 'label_key', type: 'text' })
  labelKey!: string

  @Property({ name: 'position', type: 'integer' })
  position!: number

  @Property({ name: 'effect', type: 'text' })
  effect!: PricingComponentEffect

  @Property({ name: 'level', type: 'text', default: 'line' })
  level: PricingComponentLevel = 'line'

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true
}

@Entity({ tableName: 'pricing_component_params' })
@Index({
  name: 'pricing_component_params_lookup_idx',
  properties: ['tenantId', 'organizationId', 'componentCode', 'scope'],
})
export class PricingComponentParam extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo'

  @Property({ name: 'component_code', type: 'text' })
  componentCode!: string

  @Property({ name: 'scope', type: 'text', default: 'global' })
  scope: PricingParamScope = 'global'

  @Property({ name: 'scope_ref_id', type: 'text', nullable: true })
  scopeRefId?: string | null

  @Property({ name: 'payload', type: 'jsonb' })
  payload!: Record<string, unknown>

  @Property({ name: 'valid_from', type: Date })
  validFrom!: Date

  @Property({ name: 'valid_to', type: Date, nullable: true })
  validTo?: Date | null

  @Property({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null

  @Property({ name: 'change_note', type: 'text', nullable: true })
  changeNote?: string | null
}

@Entity({ tableName: 'pricing_guardrails' })
@Index({ name: 'pricing_guardrails_lookup_idx', properties: ['tenantId', 'organizationId', 'scope'] })
export class PricingGuardrail extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo' | 'scope'

  @Property({ name: 'code', type: 'text' })
  code!: string

  @Property({ name: 'min_margin_percent', type: 'numeric', precision: 7, scale: 4, nullable: true })
  minMarginPercent?: string | null

  @Property({ name: 'max_discount_percent', type: 'numeric', precision: 7, scale: 4, nullable: true })
  maxDiscountPercent?: string | null

  @Property({ name: 'floor_price', type: 'numeric', precision: 18, scale: 4, nullable: true })
  floorPrice?: string | null

  @Property({ name: 'rounding', type: 'jsonb', nullable: true })
  rounding?: Record<string, unknown> | null

  @Property({ name: 'negotiated_price_precedence', type: 'text', default: 'negotiated_wins' })
  negotiatedPricePrecedence: string = 'negotiated_wins'

  @Property({ name: 'scope', type: 'text', default: 'global' })
  scope: PricingParamScope = 'global'

  @Property({ name: 'scope_ref_id', type: 'text', nullable: true })
  scopeRefId?: string | null

  @Property({ name: 'valid_from', type: Date })
  validFrom!: Date

  @Property({ name: 'valid_to', type: Date, nullable: true })
  validTo?: Date | null
}

// Append-only ledger tables. `packages/core/AGENTS.md` exempts append-only logs from the
// `updated_at` optimistic-lock requirement: nothing edits these rows after they are written.
abstract class PricingLedgerEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

@Entity({ tableName: 'pricing_calculations' })
@Index({
  name: 'pricing_calculations_scope_idx',
  properties: ['tenantId', 'organizationId', 'calculatedAt'],
})
@Index({
  name: 'pricing_calculations_customer_idx',
  properties: ['tenantId', 'organizationId', 'customerId'],
})
export class PricingCalculation extends PricingLedgerEntity {
  [OptionalProps]?: 'createdAt' | 'isDemo'

  @Property({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId?: string | null

  @Property({ name: 'currency_code', type: 'text' })
  currencyCode!: string

  @Property({ name: 'context_snapshot', type: 'jsonb' })
  contextSnapshot!: Record<string, unknown>

  @Property({ name: 'final_unit_price_net', type: 'numeric', precision: 18, scale: 4, default: '0' })
  finalUnitPriceNet: string = '0'

  @Property({ name: 'final_total_net', type: 'numeric', precision: 18, scale: 4, default: '0' })
  finalTotalNet: string = '0'

  @Property({ name: 'total_cost_net', type: 'numeric', precision: 18, scale: 4, default: '0' })
  totalCostNet: string = '0'

  @Property({ name: 'markup_percent', type: 'numeric', precision: 7, scale: 4, default: '0' })
  markupPercent: string = '0'

  @Property({ name: 'margin_percent', type: 'numeric', precision: 7, scale: 4, default: '0' })
  marginPercent: string = '0'

  @Property({ name: 'mode', type: 'text', default: 'shadow' })
  mode: PricingMode = 'shadow'

  @Property({ name: 'parameter_set_version', type: 'integer', default: 1 })
  parameterSetVersion: number = 1

  @Property({ name: 'triggered_by', type: 'text', default: 'api' })
  triggeredBy: 'api' | 'sales_hook' | 'cli' | 'simulate' = 'api'

  @Property({ name: 'triggered_by_user_id', type: 'uuid', nullable: true })
  triggeredByUserId?: string | null

  @Property({ name: 'duration_ms', type: 'integer', default: 0 })
  durationMs: number = 0

  @Property({ name: 'warnings', type: 'jsonb', nullable: true })
  warnings?: string[] | null

  @Property({ name: 'calculated_at', type: Date })
  calculatedAt: Date = new Date()

  @Property({ name: 'is_demo', type: 'boolean', default: false })
  isDemo: boolean = false
}

@Entity({ tableName: 'pricing_calculation_lines' })
@Index({
  name: 'pricing_calculation_lines_calculation_idx',
  properties: ['tenantId', 'calculationId', 'position'],
})
export class PricingCalculationLine extends PricingLedgerEntity {
  [OptionalProps]?: 'createdAt'

  @Property({ name: 'calculation_id', type: 'uuid' })
  calculationId!: string

  @Property({ name: 'basket_line_index', type: 'integer', default: 0 })
  basketLineIndex: number = 0

  @Property({ name: 'component_code', type: 'text' })
  componentCode!: string

  @Property({ name: 'position', type: 'integer' })
  position!: number

  @Property({ name: 'effect', type: 'text' })
  effect!: PricingComponentEffect

  @Property({ name: 'value', type: 'numeric', precision: 18, scale: 6, default: '0' })
  value: string = '0'

  @Property({ name: 'running_total', type: 'numeric', precision: 18, scale: 4, default: '0' })
  runningTotal: string = '0'

  @Property({ name: 'inputs', type: 'jsonb', nullable: true })
  inputs?: Record<string, unknown> | null

  @Property({ name: 'params', type: 'jsonb', nullable: true })
  params?: Record<string, unknown> | null

  // Stored as key + values, never as a rendered sentence, so a historical
  // calculation can be re-rendered in any locale.
  @Property({ name: 'explain_key', type: 'text' })
  explainKey!: string

  @Property({ name: 'explain_values', type: 'jsonb', nullable: true })
  explainValues?: Record<string, unknown> | null

  @Property({ name: 'confidence', type: 'text', default: 'default' })
  confidence: PricingConfidence = 'default'

  @Property({ name: 'warnings', type: 'jsonb', nullable: true })
  warnings?: string[] | null
}

@Entity({ tableName: 'pricing_coverage_entries' })
@Unique({
  name: 'pricing_coverage_entries_component_unique',
  properties: ['tenantId', 'organizationId', 'componentCode'],
})
export class PricingCoverageEntry extends PricingScopedEntity {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'isDemo' | 'confidence'

  @Property({ name: 'component_code', type: 'text' })
  componentCode!: string

  @Property({ name: 'source_kind', type: 'text' })
  sourceKind!: string

  @Property({ name: 'source_ref', type: 'text', nullable: true })
  sourceRef?: string | null

  @Property({ name: 'freshness_days', type: 'integer', nullable: true })
  freshnessDays?: number | null

  @Property({ name: 'confidence', type: 'text', default: 'default' })
  confidence: PricingConfidence = 'default'

  @Property({ name: 'missing_reason_key', type: 'text', nullable: true })
  missingReasonKey?: string | null

  @Property({ name: 'last_checked_at', type: Date, nullable: true })
  lastCheckedAt?: Date | null
}

@Entity({ tableName: 'pricing_shadow_observations' })
@Index({
  name: 'pricing_shadow_observations_scope_idx',
  properties: ['tenantId', 'organizationId', 'observedAt'],
})
export class PricingShadowObservation extends PricingLedgerEntity {
  [OptionalProps]?: 'createdAt'

  @Property({ name: 'calculation_id', type: 'uuid', nullable: true })
  calculationId?: string | null

  @Property({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId?: string | null

  @Property({ name: 'sales_document_kind', type: 'text', nullable: true })
  salesDocumentKind?: string | null

  @Property({ name: 'sales_document_id', type: 'uuid', nullable: true })
  salesDocumentId?: string | null

  @Property({ name: 'sales_line_id', type: 'uuid', nullable: true })
  salesLineId?: string | null

  @Property({ name: 'invoiced_unit_price_net', type: 'numeric', precision: 18, scale: 4, default: '0' })
  invoicedUnitPriceNet: string = '0'

  @Property({ name: 'engine_unit_price_net', type: 'numeric', precision: 18, scale: 4, default: '0' })
  engineUnitPriceNet: string = '0'

  @Property({ name: 'delta_absolute', type: 'numeric', precision: 18, scale: 4, default: '0' })
  deltaAbsolute: string = '0'

  @Property({ name: 'delta_percent', type: 'numeric', precision: 7, scale: 4, default: '0' })
  deltaPercent: string = '0'

  @Property({ name: 'observed_at', type: Date })
  observedAt: Date = new Date()
}
