import { InjectionPosition } from '@open-mercato/shared/modules/widgets/injection-position'
import type { InjectionMenuItemWidget } from '@open-mercato/shared/modules/widgets/injection'

/**
 * Puts the dashboard ("what to do today") at the top of the sales group, where the distributor's
 * day starts. `/backend` is an app page rather than a module route, so a page override in
 * `apps/mercato/src/modules.ts` cannot re-home it; menu injection into the existing group can.
 * `groupId` must equal that group's id there (`app.nav.groups.sales`).
 */
const widget: InjectionMenuItemWidget = {
  metadata: {
    id: 'distributor_workspace.injection.sidebar-dashboard',
  },
  menuItems: [
    {
      id: 'distributor-dashboard',
      labelKey: 'distributor_workspace.nav.dashboard',
      label: 'Dashboard',
      icon: 'LayoutDashboard',
      href: '/backend',
      features: ['dashboards.view'],
      groupId: 'app.nav.groups.sales',
      groupLabelKey: 'app.nav.groups.sales',
      placement: { position: InjectionPosition.First },
    },
  ],
}

export default widget
