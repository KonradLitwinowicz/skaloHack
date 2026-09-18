export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Edit process steps',
  pageTitleKey: 'pricing_engine.params.processSteps.edit',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Process steps', labelKey: 'pricing_engine.params.processSteps.title', href: '/backend/pricing/params/process-steps' },
    { label: 'Edit', labelKey: 'common.edit' },
  ],
}
