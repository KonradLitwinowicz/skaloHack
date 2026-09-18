export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Edit warehouse costs',
  pageTitleKey: 'pricing_engine.params.warehouseCosts.edit',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Warehouse costs', labelKey: 'pricing_engine.params.warehouseCosts.title', href: '/backend/pricing/params/warehouse-costs' },
    { label: 'Edit', labelKey: 'common.edit' },
  ],
}
