import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import CustomerPricingTabWidget from './widget.client'

// `metadata.id` must stay byte-identical to the `widgetId` in widgets/injection-table.ts. A mismatch
// is only a build-time warning, and the tab then silently never renders.
//
// The gate here is READ. The write gate lives inside the widget, which checks
// `pricing.params.write` before it renders the form at all — a sales rep with read-only access must
// still see the terms they are quoting against.
const widget: InjectionWidgetModule<unknown, unknown> = {
  metadata: {
    id: 'pricing_engine.injection.customer-pricing-tab',
    title: 'Pricing terms',
    description:
      'Customer group, delivery zone, order scenario and negotiated prices, each shown next to what the engine will actually charge',
    features: ['pricing.params.read'],
    priority: 30,
    enabled: true,
  },
  Widget: CustomerPricingTabWidget,
}

export default widget
