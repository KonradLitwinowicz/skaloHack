import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

const DOCUMENT_MARGIN_TAB = {
  widgetId: 'pricing_engine.injection.document-margin-tab',
  kind: 'tab' as const,
  groupLabel: 'pricing_engine.widgets.documentMargin.tabLabel',
  priority: 50,
}

// Registered on both kinds: a quote is where the margin is still negotiable, an order is where it
// has to be auditable. The spot ids are the concrete resolutions of the sales pattern
// 'sales.document.detail.{kind}:{surface}'.
export const injectionTable: ModuleInjectionTable = {
  'sales.document.detail.order:tabs': [DOCUMENT_MARGIN_TAB],
  'sales.document.detail.quote:tabs': [DOCUMENT_MARGIN_TAB],
}

export default injectionTable
