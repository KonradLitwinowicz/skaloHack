"use client"

import * as React from 'react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { DocumentMarginPanel } from '../../components/DocumentMarginPanel'
import { simulateQuote, type SimulateLine } from '../../lib/frontend/quoteClient'
import type { QuoteResponse } from '../../lib/frontend/quoteTypes'

export type SalesDocumentPricingContext = {
  kind: 'order' | 'quote'
  record: {
    id: string
    currencyCode?: string | null
    customerEntityId?: string | null
  }
}

type SalesLineRow = Record<string, unknown>

const LINE_PAGE_SIZE = 100

// The sales document detail page is `// @ts-nocheck`, so the context it hands over carries no
// compile-time guarantee. Everything this widget reads is narrowed at runtime instead.
export function isDocumentPricingContext(candidate: unknown): candidate is SalesDocumentPricingContext {
  if (!candidate || typeof candidate !== 'object') return false
  const context = candidate as { kind?: unknown; record?: unknown }
  if (context.kind !== 'order' && context.kind !== 'quote') return false
  if (!context.record || typeof context.record !== 'object') return false
  const record = context.record as { id?: unknown }
  return typeof record.id === 'string' && record.id.trim().length > 0
}

function readString(row: SalesLineRow, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

function readQuantity(row: SalesLineRow): string | null {
  const value = row.quantity ?? row.normalized_quantity ?? row.normalizedQuantity
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return String(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return value
  }
  return null
}

/** Lines with no product id are dropped: `/api/pricing/simulate` rejects the whole basket over one. */
export function toSimulateLines(rows: SalesLineRow[]): SimulateLine[] {
  return rows.flatMap<SimulateLine>((row) => {
    const productId = readString(row, 'product_id', 'productId')
    const quantity = readQuantity(row)
    if (!productId || !quantity) return []
    return [{ productId, quantity }]
  })
}

export function DocumentMarginTabWidget({ context }: InjectionWidgetComponentProps<unknown, unknown>) {
  const t = useT()
  const [quote, setQuote] = React.useState<QuoteResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)

  const valid = isDocumentPricingContext(context) ? context : null
  const documentId = valid?.record.id ?? null
  const documentKind = valid?.kind ?? null
  const currencyCode = valid?.record.currencyCode ?? null
  const customerEntityId = valid?.record.customerEntityId ?? null

  React.useEffect(() => {
    if (!documentId || !documentKind) return
    let cancelled = false
    const resourcePath = documentKind === 'order' ? 'sales/order-lines' : 'sales/quote-lines'
    const documentKey = documentKind === 'order' ? 'orderId' : 'quoteId'

    async function run() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({
          page: '1',
          pageSize: String(LINE_PAGE_SIZE),
          [documentKey]: documentId as string,
        })
        const linesCall = await apiCall<{ items?: SalesLineRow[] }>(
          `/api/${resourcePath}?${params.toString()}`,
          undefined,
          { fallback: { items: [] } },
        )
        if (cancelled) return
        if (!linesCall.ok) {
          setQuote(null)
          setError(t('pricing_engine.widgets.documentMargin.error', 'Could not price this document.'))
          return
        }
        const rows = Array.isArray(linesCall.result?.items) ? linesCall.result.items : []
        const simulateLines = toSimulateLines(rows)
        if (simulateLines.length === 0) {
          setQuote(null)
          return
        }
        const outcome = await simulateQuote({
          customerId: customerEntityId,
          currencyCode: currencyCode ?? undefined,
          lines: simulateLines,
        })
        if (cancelled) return
        if (!outcome.ok) {
          setQuote(null)
          setError(t(outcome.errorKey, 'Pricing failed.'))
          return
        }
        setQuote(outcome.quote)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [currencyCode, customerEntityId, documentId, documentKind, reloadToken, t])

  if (!valid) return null

  return (
    <DocumentMarginPanel
      quote={quote}
      currencyCode={quote?.currencyCode ?? currencyCode ?? ''}
      loading={loading}
      error={error}
      emptyTitle={t('pricing_engine.widgets.documentMargin.empty.title', 'Nothing to price yet')}
      emptyDescription={t(
        'pricing_engine.widgets.documentMargin.empty.description',
        'Add a line that points at a catalog product and the margin for this document appears here.',
      )}
      onRetry={() => setReloadToken((token) => token + 1)}
    />
  )
}

export default DocumentMarginTabWidget
