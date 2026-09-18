export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Add to purchase positions',
  pageTitleKey: 'pricing_engine.params.purchasePositions.create',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Purchase positions', labelKey: 'pricing_engine.params.purchasePositions.title', href: '/backend/pricing/params/purchase-positions' },
    { label: 'Add', labelKey: 'pricing_engine.params.action.create' },
  ],
}
