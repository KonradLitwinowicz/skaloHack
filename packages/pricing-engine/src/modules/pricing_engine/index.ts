import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'pricing_engine',
  title: 'Pricing Engine',
  version: '0.1.0',
  description:
    'Cost-to-serve pricing engine for B2B distribution: ordered price components, versioned parameters, auditable calculations and upsell advice.',
  author: 'Open Mercato Team',
  license: 'MIT',
  ejectable: true,
}

export { features } from './acl'
