export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.simulate'],
  pageTitle: 'Margin calculator',
  pageTitleKey: 'pricing_engine.calculator.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 50,
  icon: 'calculator',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Margin calculator', labelKey: 'pricing_engine.calculator.title' },
  ],
}
