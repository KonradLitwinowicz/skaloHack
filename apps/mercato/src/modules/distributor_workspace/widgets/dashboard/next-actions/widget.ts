import { lazyDashboardWidget, type DashboardWidgetModule } from '@open-mercato/shared/modules/dashboard/widgets'

const NextActionsWidget = lazyDashboardWidget(() => import('./widget.client'))

const widget: DashboardWidgetModule = {
  metadata: {
    id: 'distributor_workspace.dashboard.nextActions',
    title: 'What to do today',
    // One entry per member of NEXT_ACTION_KINDS, in the order their irreversibility weights rank
    // them. This text is the widget's header tooltip and its edit-mode subtitle, and its copy
    // lives in distributor_workspace.dashboard.nextActions.description — a kind listed in one and
    // not the other tells the operator the list is shorter than it is.
    description:
      'Ranked shortlist of the work that cannot wait: stock about to expire, quote requests with no answer yet, quotes with no customer reply, orders still waiting to be picked, and stock below the safety level.',
    features: ['dashboards.view', 'wms.view', 'sales.quotes.view', 'sales.orders.view', 'distributor_workspace.widgets.next-actions'],
    defaultSize: 'md',
    defaultEnabled: true,
    // Placed first: the operator's shortlist of work that cannot wait is the reason
    // the dashboard is opened. Gaps of 100 leave room to slot a widget in between.
    defaultPriority: 100,
    tags: ['distributor', 'operations'],
    category: 'distributor_workspace',
    icon: 'list-checks',
    supportsRefresh: true,
  },
  Widget: NextActionsWidget,
}

export default widget
