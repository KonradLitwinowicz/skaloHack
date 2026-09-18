export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Add to delivery zones',
  pageTitleKey: 'pricing_engine.params.deliveryZones.create',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Delivery zones', labelKey: 'pricing_engine.params.deliveryZones.title', href: '/backend/pricing/params/delivery-zones' },
    { label: 'Add', labelKey: 'pricing_engine.params.action.create' },
  ],
}
