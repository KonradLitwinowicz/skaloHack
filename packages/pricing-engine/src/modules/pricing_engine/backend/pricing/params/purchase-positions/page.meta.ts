export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.read'],
  pageTitle: 'Purchase positions',
  pageTitleKey: 'pricing_engine.params.purchasePositions.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 400,
  icon: 'shopping-cart',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Purchase positions', labelKey: 'pricing_engine.params.purchasePositions.title' },
  ],
}
