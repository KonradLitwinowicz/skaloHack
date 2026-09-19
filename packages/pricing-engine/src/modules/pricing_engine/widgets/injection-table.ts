import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

const DOCUMENT_MARGIN_TAB = {
  widgetId: 'pricing_engine.injection.document-margin-tab',
  kind: 'tab' as const,
  groupLabel: 'pricing_engine.widgets.documentMargin.tabLabel',
  priority: 50,
}

// The six fields of `pricing_customer_profiles` had no screen at all — a rep who negotiated a price
// had nowhere to put it. The tab sits on the company record because
// `pricing_customer_profiles.customer_id` stores a `customer_entities` id, which is exactly what the
// company detail page publishes as `injectionContext.companyId`.
const CUSTOMER_PRICING_TAB = {
  widgetId: 'pricing_engine.injection.customer-pricing-tab',
  kind: 'tab' as const,
  groupLabel: 'pricing_engine.widgets.customerPricing.tabLabel',
  priority: 30,
}

// Registered on both kinds: a quote is where the margin is still negotiable, an order is where it
// has to be auditable. The spot ids are the concrete resolutions of the sales pattern
// 'sales.document.detail.{kind}:{surface}'.
export const injectionTable: ModuleInjectionTable = {
  'sales.document.detail.order:tabs': [DOCUMENT_MARGIN_TAB],
  'sales.document.detail.quote:tabs': [DOCUMENT_MARGIN_TAB],
  'detail:customers.company:tabs': [CUSTOMER_PRICING_TAB],
}

export default injectionTable
