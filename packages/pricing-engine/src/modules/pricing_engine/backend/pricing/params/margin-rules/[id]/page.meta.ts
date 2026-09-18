export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Edit margin rules',
  pageTitleKey: 'pricing_engine.params.marginRules.edit',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Margin rules', labelKey: 'pricing_engine.params.marginRules.title', href: '/backend/pricing/params/margin-rules' },
    { label: 'Edit', labelKey: 'common.edit' },
  ],
}
