export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.read'],
  pageTitle: 'Packaging costs',
  pageTitleKey: 'pricing_engine.params.packagingCosts.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 380,
  icon: 'package',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Packaging costs', labelKey: 'pricing_engine.params.packagingCosts.title' },
  ],
}
