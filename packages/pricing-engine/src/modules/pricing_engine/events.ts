import { createModuleEvents } from '@open-mercato/shared/modules/events'

// Only events with a real emit site are declared here. `mode.changed` and `supplier.imported`
// were dropped: shadow mode is an env flag (`OM_PRICING_SHADOW_OBSERVE`), not a runtime switch,
// and no supplier import surface exists — a declared event nobody emits is a contract no
// subscriber can rely on.
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
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'pricing_engine', events })
export const emitPricingEngineEvent = eventsConfig.emit
export type PricingEngineEventId = (typeof events)[number]['id']

export default eventsConfig
