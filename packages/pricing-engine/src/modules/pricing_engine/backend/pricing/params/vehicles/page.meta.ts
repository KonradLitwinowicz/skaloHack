export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.read'],
  pageTitle: 'Vehicles',
  pageTitleKey: 'pricing_engine.params.vehicles.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 330,
  icon: 'truck',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Vehicles', labelKey: 'pricing_engine.params.vehicles.title' },
  ],
}
