export const features = [
  { id: 'pricing.view', title: 'View pricing engine', module: 'pricing_engine' },
  {
    id: 'pricing.quote',
    title: 'Create price quotes',
    module: 'pricing_engine',
    dependsOn: ['pricing.view'],
  },
  {
    id: 'pricing.simulate',
    title: 'Run pricing simulations',
    module: 'pricing_engine',
    dependsOn: ['pricing.view'],
  },
  {
    id: 'pricing.params.read',
    title: 'View pricing parameters',
    module: 'pricing_engine',
    dependsOn: ['pricing.view'],
  },
  {
    id: 'pricing.params.write',
    title: 'Edit pricing parameters',
    module: 'pricing_engine',
    dependsOn: ['pricing.params.read'],
  },
  {
    id: 'pricing.audit.read',
    title: 'View pricing audit trail',
    module: 'pricing_engine',
    dependsOn: ['pricing.view'],
  },
  {
    id: 'pricing.supplier.import',
    title: 'Import supplier package',
    module: 'pricing_engine',
    dependsOn: ['pricing.params.write'],
  },
  {
    // Deliberately NOT `dependsOn: ['pricing.view']`.
    //
    // The whole point of this feature is to be grantable on its own, to a warehouse role that must
    // see the SCALE of dormant stock without seeing purchase prices, margins or the pricing module
    // at all. Chaining it to `pricing.view` would make the narrow grant impossible and force the
    // broad one — which is the decision this feature exists to avoid.
    id: 'pricing.deadstock.summary',
    title: 'View deadstock totals only',
    module: 'pricing_engine',
  },
  {
    // Recording a judgement about dormant stock is a commercial decision, not a parameter change:
    // it removes a product from everyone else's worklist. Separate from `pricing.params.write` so
    // it can be granted to the people who actually sell the goods.
    id: 'pricing.deadstock.decide',
    title: 'Decide on deadstock positions',
    module: 'pricing_engine',
    dependsOn: ['pricing.view'],
  },
  {
    id: 'pricing.mode.change',
    title: 'Change pricing mode',
    module: 'pricing_engine',
    dependsOn: ['pricing.params.write'],
  },
]

export default features
