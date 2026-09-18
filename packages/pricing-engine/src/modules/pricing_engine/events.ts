import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  {
    id: 'pricing_engine.calculation.created',
    label: 'Price calculation created',
    entity: 'calculation',
    category: 'crud',
  },
  {
    id: 'pricing_engine.parameters.changed',
    label: 'Pricing parameters changed',
    entity: 'component_param',
    category: 'crud',
  },
  {
    id: 'pricing_engine.mode.changed',
    label: 'Pricing mode changed',
    entity: 'supplier_profile',
    category: 'lifecycle',
  },
  {
    id: 'pricing_engine.supplier.imported',
    label: 'Supplier package imported',
    entity: 'supplier_profile',
    category: 'system',
  },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'pricing_engine', events })
export const emitPricingEngineEvent = eventsConfig.emit
export type PricingEngineEventId = (typeof events)[number]['id']

export default eventsConfig
