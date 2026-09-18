export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Add to vehicles',
  pageTitleKey: 'pricing_engine.params.vehicles.create',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Vehicles', labelKey: 'pricing_engine.params.vehicles.title', href: '/backend/pricing/params/vehicles' },
    { label: 'Add', labelKey: 'pricing_engine.params.action.create' },
  ],
}
