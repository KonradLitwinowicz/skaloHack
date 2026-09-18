export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Edit packaging costs',
  pageTitleKey: 'pricing_engine.params.packagingCosts.edit',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Packaging costs', labelKey: 'pricing_engine.params.packagingCosts.title', href: '/backend/pricing/params/packaging-costs' },
    { label: 'Edit', labelKey: 'common.edit' },
  ],
}
