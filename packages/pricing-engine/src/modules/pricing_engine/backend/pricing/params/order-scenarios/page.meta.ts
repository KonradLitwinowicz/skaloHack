export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.read'],
  pageTitle: 'Order scenarios',
  pageTitleKey: 'pricing_engine.params.orderScenarios.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 370,
  icon: 'git-branch',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Order scenarios', labelKey: 'pricing_engine.params.orderScenarios.title' },
  ],
}
