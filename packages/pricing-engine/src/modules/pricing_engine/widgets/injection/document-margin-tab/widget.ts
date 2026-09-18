import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import DocumentMarginTabWidget, { type SalesDocumentPricingContext } from '../document-margin-tab'

// `metadata.id` must stay byte-identical to the `widgetId` in widgets/injection-table.ts. A mismatch
// is only a build-time warning, and the tab then silently never renders.
const widget: InjectionWidgetModule<SalesDocumentPricingContext, unknown> = {
  metadata: {
    id: 'pricing_engine.injection.document-margin-tab',
    title: 'Margin',
    description: 'Cost, profit and margin for this document, with the assumptions behind every number',
    features: ['pricing.simulate'],
    priority: 50,
    enabled: true,
  },
  Widget: DocumentMarginTabWidget,
}

export default widget
