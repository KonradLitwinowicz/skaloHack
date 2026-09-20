export const metadata = {
  requireAuth: true,
  requireFeatures: ['customers.companies.view', 'sales.orders.view', 'distributor_workspace.forecast.view'],
  pageTitle: 'Predicted orders',
  pageTitleKey: 'distributor_workspace.orderForecast.page.title',
  pageGroup: 'Daily work',
  pageGroupKey: 'app.nav.groups.daily',
  pagePriority: 15,
  pageOrder: 15,
  icon: 'calendar-clock',
  breadcrumb: [
    { label: 'Predicted orders', labelKey: 'distributor_workspace.orderForecast.page.title' },
  ],
} as const
