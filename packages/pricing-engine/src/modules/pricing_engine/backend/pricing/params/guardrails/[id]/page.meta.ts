export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.write'],
  pageTitle: 'Edit guardrails',
  pageTitleKey: 'pricing_engine.params.guardrails.edit',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Guardrails', labelKey: 'pricing_engine.params.guardrails.title', href: '/backend/pricing/params/guardrails' },
    { label: 'Edit', labelKey: 'common.edit' },
  ],
}
