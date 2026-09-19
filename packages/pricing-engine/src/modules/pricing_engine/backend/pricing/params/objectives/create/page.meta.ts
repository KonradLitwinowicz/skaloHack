export const metadata = {
  requireAuth: true,
  // A create page is reached from its list's "Add" button, never from the sidebar. Left
  // visible, the twelve of them collect into an untranslated `Pricing_engine` group that
  // doubles the module's apparent menu weight. The URL keeps working.
  navHidden: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Add objectives and weights',
  pageTitleKey: 'pricing_engine.params.objectives.create',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Objectives and weights', labelKey: 'pricing_engine.params.objectives.title', href: '/backend/pricing/params/objectives' },
    { label: 'Add', labelKey: 'pricing_engine.params.action.create' },
  ],
}
