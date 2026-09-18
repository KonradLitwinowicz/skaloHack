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
    id: 'pricing.mode.change',
    title: 'Change pricing mode',
    module: 'pricing_engine',
    dependsOn: ['pricing.params.write'],
  },
]

export default features
