import { lazyDashboardWidget, type DashboardWidgetModule } from '@open-mercato/shared/modules/dashboard/widgets'

const PricingDeadstockWidget = lazyDashboardWidget(() => import('./widget.client'))

/**
 * Lives in `pricing_engine`, not in the distributor workspace.
 *
 * Dashboard widgets are discovered from any module, so the one that reports a pricing figure
 * belongs with the code that computes it — and keeping it here means it collides with nothing that
 * another module owns.
 */
const widget: DashboardWidgetModule = {
  metadata: {
    id: 'pricing_engine.dashboard.deadstock',
    title: 'Capital asleep',
    description: 'Stock that is not moving, what it costs to keep, and the worst offenders.',
    features: ['dashboards.view', 'pricing.view'],
    defaultSize: 'md',
    defaultEnabled: true,
    // Only affects the seeding of a NEW layout. Anyone who already had a dashboard before this
    // widget existed will not get it automatically, and adding it to their saved layout behind
    // their back is the owner's call, not this module's.
    defaultPriority: 400,
    tags: ['pricing', 'inventory'],
    category: 'pricing_engine',
    icon: 'package-x',
    supportsRefresh: true,
  },
  Widget: PricingDeadstockWidget,
}

export default widget
