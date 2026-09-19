export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Edit objectives and weights',
  pageTitleKey: 'pricing_engine.params.objectives.edit',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Objectives and weights', labelKey: 'pricing_engine.params.objectives.title', href: '/backend/pricing/params/objectives' },
    { label: 'Edit', labelKey: 'common.edit' },
  ],
}
