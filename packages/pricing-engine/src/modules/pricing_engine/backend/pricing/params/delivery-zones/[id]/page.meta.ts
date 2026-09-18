export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Edit delivery zones',
  pageTitleKey: 'pricing_engine.params.deliveryZones.edit',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Delivery zones', labelKey: 'pricing_engine.params.deliveryZones.title', href: '/backend/pricing/params/delivery-zones' },
    { label: 'Edit', labelKey: 'common.edit' },
  ],
}
