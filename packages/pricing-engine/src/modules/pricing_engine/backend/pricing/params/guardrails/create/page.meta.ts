export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Add to guardrails',
  pageTitleKey: 'pricing_engine.params.guardrails.create',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Guardrails', labelKey: 'pricing_engine.params.guardrails.title', href: '/backend/pricing/params/guardrails' },
    { label: 'Add', labelKey: 'pricing_engine.params.action.create' },
  ],
}
