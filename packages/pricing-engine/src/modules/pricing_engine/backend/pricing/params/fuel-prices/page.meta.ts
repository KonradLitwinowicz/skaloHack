export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.read'],
  pageTitle: 'Fuel prices',
  pageTitleKey: 'pricing_engine.params.fuelPrices.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 340,
  icon: 'fuel',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Fuel prices', labelKey: 'pricing_engine.params.fuelPrices.title' },
  ],
}
