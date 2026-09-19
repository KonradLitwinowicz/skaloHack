import type { PriceComponent } from '../types'
import { productCostComponent } from './productCost'
import { operationalCostBaseComponent } from './operationalCostBase'
import { packagingCostComponent } from './packagingCost'
import { warehouseCostComponent } from './warehouseCost'
import { logisticsCostComponent } from './logisticsCost'
import { productAspectsComponent } from './productAspects'
import { targetMarginComponent } from './targetMargin'
import { guardrailsComponent } from './guardrails'
import { roundingComponent } from './rounding'

export { PRODUCT_COST_CODE } from './productCost'
export { OPERATIONAL_COST_BASE_CODE } from './operationalCostBase'
export { PACKAGING_COST_CODE } from './packagingCost'
export { WAREHOUSE_COST_CODE } from './warehouseCost'
export { LOGISTICS_COST_CODE } from './logisticsCost'
export { PRODUCT_ASPECTS_CODE } from './productAspects'
export { TARGET_MARGIN_CODE } from './targetMargin'
export { GUARDRAILS_CODE } from './guardrails'
export { ROUNDING_CODE } from './rounding'

// Components implemented and running today.
export const implementedComponents: PriceComponent[] = [
  productCostComponent,
  operationalCostBaseComponent,
  packagingCostComponent,
  warehouseCostComponent,
  logisticsCostComponent,
  productAspectsComponent,
  targetMarginComponent,
  guardrailsComponent,
  roundingComponent,
]

// The full eleven-component pipeline. Codes not present in `implementedComponents` are declared
// here so the coverage screen lists them as pending instead of silently omitting them — a missing
// component must be visible, not invisible.
export const PIPELINE_COMPONENT_CODES = [
  'product_cost',
  'operational_cost_base',
  'packaging_cost',
  'warehouse_cost',
  'logistics_cost',
  'product_aspects',
  'customer_profile',
  'volume_effect',
  'target_margin',
  'guardrails',
  'rounding',
] as const

export type PipelineComponentCode = (typeof PIPELINE_COMPONENT_CODES)[number]

export const PENDING_COMPONENT_CODES: PipelineComponentCode[] = PIPELINE_COMPONENT_CODES.filter(
  (code) => !implementedComponents.some((component) => component.code === code),
)

/**
 * Why a declared component has no implementation. "Not implemented" on its own reads as a backlog
 * item somebody forgot, which is wrong for both of these and hides the actual reason.
 *
 * - `awaiting_data`: the formula is understood but has nothing to read. `customer_profile` is a
 *   product over the customer's ACTIVE indicators, and the tenant has none — implementing it today
 *   would return a multiplier of exactly 1.0000 for every customer, which is worse than absent
 *   because it would look like a working component.
 * - `superseded`: the effect already reaches the price by a different and more honest route.
 *   `volume_effect` was specified as a tiered multiplier ON THE PRICE, but fixed per-order costs
 *   already amortise as 1/q, so the unit price falls with quantity on its own — measured on the
 *   seeded tenant, 1 unit prices at 107.61 and 50 units at 68.04 with no multiplier involved.
 *   Adding one would discount the same volume twice.
 */
export type PendingComponentReason = 'awaiting_data' | 'superseded'

export const PENDING_COMPONENT_REASONS: Partial<Record<PipelineComponentCode, PendingComponentReason>> = {
  customer_profile: 'awaiting_data',
  volume_effect: 'superseded',
}
