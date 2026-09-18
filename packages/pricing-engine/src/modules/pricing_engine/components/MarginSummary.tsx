'use client'

import * as React from 'react'
import { KpiCard, type KpiTrend } from '@open-mercato/ui/backend/charts'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { formatMoney } from '../lib/frontend/marginMath'

export type MarginFigures = {
  revenueNet: string
  costNet: string
  profitNet: string
  marginPercent: string
  markupPercent: string
}

export type MarginSummaryProps = MarginFigures & {
  currencyCode: string
  /** Optional 'before' figures; every tile then carries a delta badge against them. */
  compareTo?: MarginFigures
  comparisonLabel?: string
  /** Below this the margin tile reads as a warning; below the floor it reads as an error. */
  targetMarginPercent?: string | null
  floorMarginPercent?: string | null
  loading?: boolean
  error?: string | null
  className?: string
}

type MarginState = 'ok' | 'belowTarget' | 'belowFloor'

function toNumber(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0
  const parsed = Number(String(value).trim())
  return Number.isFinite(parsed) ? parsed : 0
}

function formatPercent(value: number): string {
  return value.toFixed(2)
}

// A money tile compares as a relative change; a percent tile compares in percentage points. Both
// land in the same badge, so the comparison label has to say which reading it is.
function relativeTrend(current: string, previous: string | undefined): KpiTrend | undefined {
  if (previous === undefined) return undefined
  const before = toNumber(previous)
  const now = toNumber(current)
  if (before === 0) return now === 0 ? { value: 0, direction: 'unchanged' } : undefined
  const change = ((now - before) / Math.abs(before)) * 100
  return { value: Number(change.toFixed(1)), direction: change > 0 ? 'up' : change < 0 ? 'down' : 'unchanged' }
}

function pointTrend(current: string, previous: string | undefined): KpiTrend | undefined {
  if (previous === undefined) return undefined
  const change = toNumber(current) - toNumber(previous)
  return { value: Number(change.toFixed(1)), direction: change > 0 ? 'up' : change < 0 ? 'down' : 'unchanged' }
}

function resolveMarginState(
  marginPercent: string,
  targetMarginPercent: string | null | undefined,
  floorMarginPercent: string | null | undefined,
): MarginState {
  const margin = toNumber(marginPercent)
  if (floorMarginPercent !== null && floorMarginPercent !== undefined && margin < toNumber(floorMarginPercent)) {
    return 'belowFloor'
  }
  if (targetMarginPercent !== null && targetMarginPercent !== undefined && margin < toNumber(targetMarginPercent)) {
    return 'belowTarget'
  }
  return 'ok'
}

export function MarginSummary({
  currencyCode,
  revenueNet,
  costNet,
  profitNet,
  marginPercent,
  markupPercent,
  compareTo,
  comparisonLabel,
  targetMarginPercent,
  floorMarginPercent,
  loading,
  error,
  className,
}: MarginSummaryProps) {
  const t = useT()
  const money = React.useCallback(
    (value: number) => formatMoney(String(value), currencyCode),
    [currencyCode],
  )

  const marginState = resolveMarginState(marginPercent, targetMarginPercent, floorMarginPercent)
  const profitIsNegative = toNumber(profitNet) < 0
  const resolvedComparisonLabel = comparisonLabel ?? t(
    'pricing_engine.margin.kpi.comparison',
    'Change against the figures this document carries today',
  )

  const marginFooter =
    marginState === 'belowFloor' ? (
      <Badge variant="error" size="sm">
        {t('pricing_engine.margin.kpi.belowFloor', 'Below the minimum margin')}
      </Badge>
    ) : marginState === 'belowTarget' ? (
      <Badge variant="warning" size="sm">
        {t('pricing_engine.margin.kpi.belowTarget', 'Below the target margin')}
      </Badge>
    ) : undefined

  return (
    <div className={className}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard
          title={t('pricing_engine.margin.kpi.revenue', 'Revenue (net)')}
          value={toNumber(revenueNet)}
          formatValue={money}
          loading={loading}
          error={error ?? undefined}
          trend={relativeTrend(revenueNet, compareTo?.revenueNet)}
          comparisonLabel={resolvedComparisonLabel}
        />
        <KpiCard
          title={t('pricing_engine.margin.kpi.cost', 'Total cost (net)')}
          value={toNumber(costNet)}
          formatValue={money}
          loading={loading}
          error={error ?? undefined}
          trend={relativeTrend(costNet, compareTo?.costNet)}
          comparisonLabel={resolvedComparisonLabel}
        />
        <KpiCard
          title={t('pricing_engine.margin.kpi.profit', 'Profit (net)')}
          value={toNumber(profitNet)}
          formatValue={money}
          loading={loading}
          error={error ?? undefined}
          trend={relativeTrend(profitNet, compareTo?.profitNet)}
          comparisonLabel={resolvedComparisonLabel}
          footer={
            profitIsNegative ? (
              <Badge variant="error" size="sm">
                {t('pricing_engine.margin.kpi.lossMaking', 'This document sells below cost')}
              </Badge>
            ) : undefined
          }
        />
        <KpiCard
          title={t('pricing_engine.margin.kpi.margin', 'Margin on price')}
          value={toNumber(marginPercent)}
          formatValue={formatPercent}
          suffix="%"
          loading={loading}
          error={error ?? undefined}
          trend={pointTrend(marginPercent, compareTo?.marginPercent)}
          comparisonLabel={resolvedComparisonLabel}
          footer={marginFooter}
        />
        <KpiCard
          title={t('pricing_engine.margin.kpi.markup', 'Markup on cost')}
          value={toNumber(markupPercent)}
          formatValue={formatPercent}
          suffix="%"
          loading={loading}
          error={error ?? undefined}
          trend={pointTrend(markupPercent, compareTo?.markupPercent)}
          comparisonLabel={resolvedComparisonLabel}
        />
      </div>
    </div>
  )
}

export default MarginSummary
