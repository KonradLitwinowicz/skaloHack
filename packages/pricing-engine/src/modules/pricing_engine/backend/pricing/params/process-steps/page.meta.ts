export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.read'],
  pageTitle: 'Process steps',
  pageTitleKey: 'pricing_engine.params.processSteps.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 360,
  icon: 'workflow',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Process steps', labelKey: 'pricing_engine.params.processSteps.title' },
  ],
}
