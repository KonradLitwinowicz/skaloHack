export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Add to margin rules',
  pageTitleKey: 'pricing_engine.params.marginRules.create',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Margin rules', labelKey: 'pricing_engine.params.marginRules.title', href: '/backend/pricing/params/margin-rules' },
    { label: 'Add', labelKey: 'pricing_engine.params.action.create' },
  ],
}
