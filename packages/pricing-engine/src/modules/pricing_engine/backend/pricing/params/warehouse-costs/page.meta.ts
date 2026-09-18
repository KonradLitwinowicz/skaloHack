export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.read'],
  pageTitle: 'Warehouse costs',
  pageTitleKey: 'pricing_engine.params.warehouseCosts.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 390,
  icon: 'warehouse',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Warehouse costs', labelKey: 'pricing_engine.params.warehouseCosts.title' },
  ],
}
