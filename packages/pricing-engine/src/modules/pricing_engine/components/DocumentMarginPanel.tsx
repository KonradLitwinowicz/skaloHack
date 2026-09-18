'use client'

import * as React from 'react'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { ErrorMessage, LoadingMessage, TabEmptyState } from '@open-mercato/ui/backend/detail'
import { SectionHeader, CollapsibleSection } from '@open-mercato/ui/backend/SectionHeader'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { QuoteLine, QuoteResponse } from '../lib/frontend/quoteTypes'
import { basketMargin, formatMoney } from '../lib/frontend/marginMath'
import { PriceWaterfall } from './PriceWaterfall'
import { MarginAssumptions } from './MarginAssumptions'
import { MarginSummary } from './MarginSummary'

export type DocumentMarginPanelProps = {
  /** Breakdowns must already be piped through `withRunningTotals` — `simulateQuote` does that. */
  quote: QuoteResponse | null
  currencyCode: string
  loading: boolean
  error: string | null
  emptyTitle: string
  emptyDescription?: string
  onRetry?: () => void
  targetMarginPercent?: string | null
  floorMarginPercent?: string | null
  className?: string
}

function lineLabel(line: QuoteLine, index: number): string {
  return line.sku ?? `#${index + 1}`
}

export function DocumentMarginPanel({
  quote,
  currencyCode,
  loading,
  error,
  emptyTitle,
  emptyDescription,
  onRetry,
  targetMarginPercent,
  floorMarginPercent,
  className,
}: DocumentMarginPanelProps) {
  const t = useT()
  const [selectedProductId, setSelectedProductId] = React.useState<string | null>(null)

  const lines = quote?.lines ?? []
  const selectedLine =
    lines.find((line) => line.productId === selectedProductId) ?? lines[0] ?? null

  // An error must win over the empty state: a failed simulation also produces zero lines, and
  // reporting that as "nothing to price" would hide the failure from the operator.
  if (loading) {
    return <LoadingMessage label={t('pricing_engine.margin.loading', 'Pricing this document…')} />
  }

  if (error) {
    return (
      <ErrorMessage
        label={error}
        action={
          onRetry ? (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {t('pricing_engine.margin.retry', 'Try again')}
            </Button>
          ) : undefined
        }
      />
    )
  }

  if (!quote || lines.length === 0) {
    return <TabEmptyState title={emptyTitle} description={emptyDescription} />
  }

  const totals = basketMargin([
    { unitPriceNet: quote.totalNet, unitCostNet: quote.totalCostNet, quantity: '1' },
  ])
  const quoteWarnings = quote.warnings ?? []

  return (
    <div className={className ? `space-y-6 ${className}` : 'space-y-6'}>
      <MarginSummary
        currencyCode={currencyCode}
        revenueNet={totals.revenueNet}
        costNet={totals.costNet}
        profitNet={totals.profitNet}
        marginPercent={totals.marginPercent}
        markupPercent={totals.markupPercent}
        targetMarginPercent={targetMarginPercent}
        floorMarginPercent={floorMarginPercent}
      />

      {quoteWarnings.length > 0 ? (
        <Alert status="warning" style="lighter" size="sm">
          <AlertTitle>{t('pricing_engine.margin.warnings.title', 'What this price could not account for')}</AlertTitle>
          <AlertDescription>
            <ul className="space-y-1">
              {quoteWarnings.map((warning) => (
                <li key={warning}>{t(warning, warning)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {lines.length > 1 ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {t('pricing_engine.margin.line.selector', 'Line')}
          </span>
          <Select
            value={selectedLine?.productId ?? ''}
            onValueChange={(value) => setSelectedProductId(value)}
          >
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {lines.map((line, index) => (
                <SelectItem key={line.productId} value={line.productId}>
                  {lineLabel(line, index)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-sm tabular-nums text-muted-foreground">
            {t('pricing_engine.margin.line.total', 'Line total')}
            {': '}
            {formatMoney(selectedLine?.totalPriceNet ?? '0', currencyCode)}
          </span>
        </div>
      ) : null}

      {selectedLine ? (
        <>
          <div className="space-y-3">
            <SectionHeader title={t('pricing_engine.playground.waterfall.title', 'How the price was built')} />
            <PriceWaterfall breakdown={selectedLine.breakdown} currencyCode={currencyCode} />
          </div>

          <CollapsibleSection
            title={t('pricing_engine.margin.assumptions.title', 'What this price assumes')}
            count={selectedLine.breakdown.length}
          >
            <p className="text-sm text-muted-foreground">
              {t(
                'pricing_engine.margin.assumptions.description',
                'Every number above rests on these values. Anything marked as assumed came from a default, not from your data.',
              )}
            </p>
            <MarginAssumptions breakdown={selectedLine.breakdown} currencyCode={currencyCode} />
          </CollapsibleSection>
        </>
      ) : null}
    </div>
  )
}

export default DocumentMarginPanel
