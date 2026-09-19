export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.read'],
  pageTitle: 'Objectives and weights',
  pageTitleKey: 'pricing_engine.params.objectives.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 310,
  icon: 'target',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Objectives and weights', labelKey: 'pricing_engine.params.objectives.title' },
  ],
}
