export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Edit order scenarios',
  pageTitleKey: 'pricing_engine.params.orderScenarios.edit',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Order scenarios', labelKey: 'pricing_engine.params.orderScenarios.title', href: '/backend/pricing/params/order-scenarios' },
    { label: 'Edit', labelKey: 'common.edit' },
  ],
}
