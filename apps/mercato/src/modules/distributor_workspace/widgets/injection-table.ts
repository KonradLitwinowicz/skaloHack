import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/**
 * `detail:customers.company:tabs` is a shared spot — other modules already put tabs there
 * (warranty_claims) and more are planned. Each entry stands on its own `widgetId`, so adding a tab
 * here never displaces one declared elsewhere; the host sorts by `priority` and renders them all.
 */
export const injectionTable: ModuleInjectionTable = {
  // The dashboard as the first entry of the distributor's sales group (see the widget for why).
  'menu:sidebar:main': {
    widgetId: 'distributor_workspace.injection.sidebar-dashboard',
    priority: 10,
  },
  'detail:customers.company:tabs': [
    {
      widgetId: 'distributor_workspace.injection.customer-order-forecast',
      kind: 'tab',
      groupLabel: 'distributor_workspace.orderForecast.tabLabel',
      priority: 30,
    },
  ],
}

export default injectionTable
