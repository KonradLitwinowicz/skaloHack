export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Edit vehicles',
  pageTitleKey: 'pricing_engine.params.vehicles.edit',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Vehicles', labelKey: 'pricing_engine.params.vehicles.title', href: '/backend/pricing/params/vehicles' },
    { label: 'Edit', labelKey: 'common.edit' },
  ],
}
