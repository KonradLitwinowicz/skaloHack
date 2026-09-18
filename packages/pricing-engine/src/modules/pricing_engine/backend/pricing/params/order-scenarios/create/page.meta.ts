export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Add to order scenarios',
  pageTitleKey: 'pricing_engine.params.orderScenarios.create',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Order scenarios', labelKey: 'pricing_engine.params.orderScenarios.title', href: '/backend/pricing/params/order-scenarios' },
    { label: 'Add', labelKey: 'pricing_engine.params.action.create' },
  ],
}
