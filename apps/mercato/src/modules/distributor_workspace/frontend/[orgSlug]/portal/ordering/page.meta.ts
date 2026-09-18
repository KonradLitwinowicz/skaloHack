import type { PageMetadata } from '@open-mercato/shared/modules/registry'

export const metadata: PageMetadata = {
  requireCustomerAuth: true,
  requireCustomerFeatures: ['portal.catalog.view'],
  titleKey: 'distributor_workspace.portal.ordering.title',
  title: 'Order',
  nav: {
    label: 'Order',
    labelKey: 'distributor_workspace.portal.nav.ordering',
    group: 'main',
    order: 20,
  },
}

export default metadata
