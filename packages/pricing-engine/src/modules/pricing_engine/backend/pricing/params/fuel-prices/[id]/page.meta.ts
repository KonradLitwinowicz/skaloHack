export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Edit fuel prices',
  pageTitleKey: 'pricing_engine.params.fuelPrices.edit',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Fuel prices', labelKey: 'pricing_engine.params.fuelPrices.title', href: '/backend/pricing/params/fuel-prices' },
    { label: 'Edit', labelKey: 'common.edit' },
  ],
}
