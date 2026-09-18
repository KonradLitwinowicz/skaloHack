export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Add to warehouse costs',
  pageTitleKey: 'pricing_engine.params.warehouseCosts.create',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Warehouse costs', labelKey: 'pricing_engine.params.warehouseCosts.title', href: '/backend/pricing/params/warehouse-costs' },
    { label: 'Add', labelKey: 'pricing_engine.params.action.create' },
  ],
}
