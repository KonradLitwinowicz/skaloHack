export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Add to labour rates',
  pageTitleKey: 'pricing_engine.params.laborRates.create',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Labour rates', labelKey: 'pricing_engine.params.laborRates.title', href: '/backend/pricing/params/labor-rates' },
    { label: 'Add', labelKey: 'pricing_engine.params.action.create' },
  ],
}
