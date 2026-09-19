import { lazyDashboardWidget, type DashboardWidgetModule } from '@open-mercato/shared/modules/dashboard/widgets'
import type { ExpiringStockSettings } from './widget.client'

const ExpiringStockWidget = lazyDashboardWidget<ExpiringStockSettings>(() => import('./widget.client'))

const widget: DashboardWidgetModule<ExpiringStockSettings> = {
  metadata: {
    id: 'distributor_workspace.dashboard.expiringStock',
    title: 'Stock losing its date',
    description: 'Lots approaching or past their expiry date, most urgent first, each linking to the lot.',
    features: ['dashboards.view', 'wms.view'],
    defaultSize: 'md',
    defaultEnabled: true,
    // Second: date-driven losses come before restocking decisions.
    defaultPriority: 200,
    tags: ['wms', 'expiry', 'distributor'],
    category: 'distributor_workspace',
    icon: 'calendar-clock',
    supportsRefresh: true,
  },
  Widget: ExpiringStockWidget,
}

export default widget
