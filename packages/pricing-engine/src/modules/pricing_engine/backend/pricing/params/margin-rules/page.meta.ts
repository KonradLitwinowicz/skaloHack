export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.read'],
  pageTitle: 'Margin rules',
  pageTitleKey: 'pricing_engine.params.marginRules.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 300,
  icon: 'percent',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Margin rules', labelKey: 'pricing_engine.params.marginRules.title' },
  ],
}
