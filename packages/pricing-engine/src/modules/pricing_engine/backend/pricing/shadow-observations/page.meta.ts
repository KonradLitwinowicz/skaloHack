export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.audit.read'],
  pageTitle: 'Shadow observations',
  pageTitleKey: 'pricing_engine.shadowObservations.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 210,
  icon: 'scale',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Shadow observations', labelKey: 'pricing_engine.shadowObservations.title' },
  ],
}
