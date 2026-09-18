export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.read'],
  pageTitle: 'Delivery zones',
  pageTitleKey: 'pricing_engine.params.deliveryZones.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 320,
  icon: 'map',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Delivery zones', labelKey: 'pricing_engine.params.deliveryZones.title' },
  ],
}
