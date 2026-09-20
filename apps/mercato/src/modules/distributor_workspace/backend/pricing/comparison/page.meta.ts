export const metadata = {
  requireAuth: true,
  requireFeatures: ['sales.orders.view', 'pricing.simulate', 'distributor_workspace.pricing.compare'],
  pageTitle: 'Price comparison',
  pageTitleKey: 'distributor_workspace.priceComparison.page.title',
  // Same group key as the pricing engine's own pages, so this sits next to "Rotation and
  // deadstock" rather than opening a group of its own between unrelated sections.
  pageGroup: 'Pricing',
  pageGroupKey: 'pricing_engine.nav.group',
  pagePriority: 55,
  pageOrder: 205,
  icon: 'scale',
  breadcrumb: [
    { label: 'Pricing', labelKey: 'pricing_engine.nav.group' },
    { label: 'Price comparison', labelKey: 'distributor_workspace.priceComparison.page.title' },
  ],
} as const
