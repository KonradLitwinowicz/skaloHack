export const metadata = {
  requireAuth: true,
  requireFeatures: ['pricing.params.read'],
  pageTitle: 'Guardrails',
  pageTitleKey: 'pricing_engine.params.guardrails.title',
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 310,
  icon: 'shield',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Guardrails', labelKey: 'pricing_engine.params.guardrails.title' },
  ],
}
