export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Edit purchase positions',
  pageTitleKey: 'pricing_engine.params.purchasePositions.edit',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Purchase positions', labelKey: 'pricing_engine.params.purchasePositions.title', href: '/backend/pricing/params/purchase-positions' },
    { label: 'Edit', labelKey: 'common.edit' },
  ],
}
