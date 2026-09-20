import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import CustomerOrderForecastWidget from './widget.client'

/**
 * The forecast tab on a customer card, for the distributor side only.
 *
 * Gated on the two features the route already enforces — reading a customer and reading their
 * orders — plus the module's own `distributor_workspace.forecast.view` (see `../../../acl.ts`).
 * The data-owning ids keep the data boundary; the own id only says the forecast screens may be
 * used at all.
 *
 * Priority 30 leaves room above for the tabs a customer card already carries; the spot is shared,
 * so this widget keeps its own id and its own injection-table entry and never assumes it is alone.
 */
const widget: InjectionWidgetModule<unknown, unknown> = {
  metadata: {
    id: 'distributor_workspace.injection.customer-order-forecast',
    title: 'distributor_workspace.orderForecast.tabLabel',
    description:
      'Products this customer buys on a repeating rhythm, the quantity and date each is next expected, and the evidence behind every figure.',
    features: ['customers.companies.view', 'sales.orders.view', 'distributor_workspace.forecast.view'],
    priority: 30,
    enabled: true,
  },
  Widget: CustomerOrderForecastWidget,
}

export default widget
