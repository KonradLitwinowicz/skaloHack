export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Edit labour rates',
  pageTitleKey: 'pricing_engine.params.laborRates.edit',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Labour rates', labelKey: 'pricing_engine.params.laborRates.title', href: '/backend/pricing/params/labor-rates' },
    { label: 'Edit', labelKey: 'common.edit' },
  ],
}
