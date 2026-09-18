export const metadata = {
  requireAuth: true,
  // The advisor persists nothing, so simulate is the correct gate. Suggestions that would RAISE the
  // customer's price are filtered out server-side for anyone without `pricing.quote`.
  requireFeatures: ['pricing.simulate'],
  pageTitle: 'Margin advisor',
  pageTitleKey: 'pricing_engine.advisor.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 150,
  icon: 'trending-up',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Margin advisor', labelKey: 'pricing_engine.advisor.title' },
  ],
}
