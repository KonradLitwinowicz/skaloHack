export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Add to fuel prices',
  pageTitleKey: 'pricing_engine.params.fuelPrices.create',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Fuel prices', labelKey: 'pricing_engine.params.fuelPrices.title', href: '/backend/pricing/params/fuel-prices' },
    { label: 'Add', labelKey: 'pricing_engine.params.action.create' },
  ],
}
