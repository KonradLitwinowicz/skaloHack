export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.quote'],
  pageTitle: 'Price playground',
  pageTitleKey: 'pricing_engine.playground.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 100,
  icon: 'calculator',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Price playground', labelKey: 'pricing_engine.playground.title' },
  ],
}
