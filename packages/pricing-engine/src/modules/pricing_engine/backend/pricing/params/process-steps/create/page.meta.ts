export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Add to process steps',
  pageTitleKey: 'pricing_engine.params.processSteps.create',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Process steps', labelKey: 'pricing_engine.params.processSteps.title', href: '/backend/pricing/params/process-steps' },
    { label: 'Add', labelKey: 'pricing_engine.params.action.create' },
  ],
}
