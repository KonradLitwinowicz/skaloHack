export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.read'],
  pageTitle: 'Labour rates',
  pageTitleKey: 'pricing_engine.params.laborRates.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 350,
  icon: 'users',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Labour rates', labelKey: 'pricing_engine.params.laborRates.title' },
  ],
}
