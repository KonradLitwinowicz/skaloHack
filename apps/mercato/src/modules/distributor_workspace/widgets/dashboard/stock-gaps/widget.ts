import { lazyDashboardWidget, type DashboardWidgetModule } from '@open-mercato/shared/modules/dashboard/widgets'
import type { StockGapsSettings } from './widget.client'

const StockGapsWidget = lazyDashboardWidget<StockGapsSettings>(() => import('./widget.client'))

const widget: DashboardWidgetModule<StockGapsSettings> = {
  metadata: {
    id: 'distributor_workspace.dashboard.stockGaps',
    title: 'Stock gaps',
    // One set, not two: the safety-stock positions are counted inside the reorder-point
    // total, the unit is a variant-in-warehouse position rather than a product, and the
    // widget no longer claims a trend (see the removal note in widget.client.tsx).
    description:
      'How many stock positions are at or below their reorder point, and how many of those are already below safety stock.',
    features: ['dashboards.view', 'wms.view'],
    defaultSize: 'md',
    defaultEnabled: true,
    // Third: restocking follows the two time-critical lists above.
    defaultPriority: 300,
    tags: ['wms', 'inventory', 'distributor'],
    category: 'distributor_workspace',
    icon: 'package-minus',
    supportsRefresh: true,
  },
  Widget: StockGapsWidget,
}

export default widget
