import type { PriceComponent } from '../types'
import { productCostComponent } from './productCost'
import { operationalCostBaseComponent } from './operationalCostBase'
import { targetMarginComponent } from './targetMargin'
import { guardrailsComponent } from './guardrails'
import { roundingComponent } from './rounding'

export { PRODUCT_COST_CODE } from './productCost'
export { OPERATIONAL_COST_BASE_CODE } from './operationalCostBase'
export { TARGET_MARGIN_CODE } from './targetMargin'
export { GUARDRAILS_CODE } from './guardrails'
export { ROUNDING_CODE } from './rounding'

// Components implemented and running today.
export const implementedComponents: PriceComponent[] = [
  productCostComponent,
  operationalCostBaseComponent,
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
