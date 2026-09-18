export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.audit.read'],
  pageTitle: 'Data coverage',
  pageTitleKey: 'pricing_engine.coverage.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 200,
  icon: 'list-checks',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Data coverage', labelKey: 'pricing_engine.coverage.title' },
  ],
}
