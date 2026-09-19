"use client"

import * as React from 'react'
import Link from 'next/link'
import { z } from 'zod'
import type { DashboardWidgetComponentProps } from '@open-mercato/shared/modules/dashboard/widgets'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { WidgetError, WidgetSkeleton } from '@open-mercato/ui/backend/dashboard/WidgetList'
import { useOptionalLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { cn } from '@open-mercato/shared/lib/utils'

const INVENTORY_PATH = '/backend/wms/inventory'

/**
 * `deltaSinceYesterday` and `sparkline` stay in the schema because the operational
 * dashboard payload carries them and validating the full KPI shape keeps the contract
 * check honest. This widget renders NEITHER of them — see the removal note below.
 */
const stockGapsPayloadSchema = z.object({
  kpis: z.array(
    z.object({
      id: z.string(),
      count: z.number(),
      deltaSinceYesterday: z.number().nullable(),
      sparkline: z.array(z.number()),
    }),
  ),
})

export type StockGapsPayload = z.infer<typeof stockGapsPayloadSchema>
export type StockGapKpi = StockGapsPayload['kpis'][number]

export type StockGapsSettings = Record<string, never>

export function readGapKpi(kpis: readonly StockGapKpi[], id: string): StockGapKpi {
  return kpis.find((kpi) => kpi.id === id) ?? { id, count: 0, deltaSinceYesterday: null, sparkline: [] }
}

export type StockGapBreakdown = {
  total: number
  critical: number
  reportedCritical: number
  onlyBelowReorder: number
  allCritical: boolean
  noneCritical: boolean
  notNested: boolean
  criticalShare: number
}

/**
 * `lowStock` and `reorderCritical` are the two threshold checks the backend
 * runs per position, and each one mirrors exactly one list the operator can
 * open: `lowStock` is `available <= reorder_point`, `reorderCritical` is
 * `available <= safety_stock` (packages/core/src/modules/wms/lib/lowStockBalanceFilter.ts
 * and computeLowStockCounts in lib/loadOperationalDashboard.ts, which now
 * evaluates both thresholds independently so a position below safety stock but
 * above the reorder point stops falling out of both counters).
 *
 * Nesting is therefore a property of the DATA, not of the code: the critical
 * set sits inside the low-stock set exactly while every profile keeps
 * `safety_stock <= reorder_point`. Nothing enforces that — `data/validators.ts`
 * accepts either ordering — so the widget checks it per payload instead of
 * assuming it. When it holds (every profile in this tenant today), the nested
 * layout below is the readable shape the two equal tiles failed to be. When it
 * does not, the two numbers are simply two different lists and are shown as
 * that: `notNested` is not an error state and must never be worded as one.
 */
export function resolveGapBreakdown(total: number, critical: number): StockGapBreakdown {
  const safeTotal = Math.max(0, total)
  const reportedCritical = Math.max(0, critical)
  const safeCritical = Math.min(reportedCritical, safeTotal)
  return {
    total: safeTotal,
    critical: safeCritical,
    reportedCritical,
    onlyBelowReorder: safeTotal - safeCritical,
    allCritical: safeTotal > 0 && safeCritical === safeTotal,
    noneCritical: safeTotal > 0 && safeCritical === 0,
    notNested: reportedCritical > safeTotal,
    criticalShare: safeTotal === 0 ? 0 : (safeCritical / safeTotal) * 100,
  }
}

async function loadStockGaps(): Promise<StockGapsPayload> {
  const call = await apiCall<unknown>('/api/wms/dashboard/operational')
  if (!call.ok) {
    throw new Error(`[internal] Operational dashboard request failed with status ${call.status}`)
  }
  const parsed = stockGapsPayloadSchema.safeParse(call.result)
  if (!parsed.success) {
    throw new Error('[internal] Malformed operational dashboard payload')
  }
  return parsed.data
}

// Locale comes from the i18n context, never from `navigator.language` or an omitted argument:
// the operator picked the interface language and the separators have to obey that choice.
// See .ai/lessons/user-facing-numbers-and-dates-must-use-the-app-locale.md.
function formatNumber(value: number, locale: string | undefined): string {
  return new Intl.NumberFormat(locale).format(value)
}

/**
 * REMOVED ON PURPOSE — do not bring either of these back without fixing the source first:
 *
 * 1. Both sparklines ("Below reorder point over the last 7 days" and "Below safety stock
 *    over the last 7 days"). In packages/core/src/modules/wms/lib/loadOperationalDashboard.ts
 *    the `Promise.all` that fills `lowStockSparklineRows` and `reorderCriticalSparklineRows`
 *    (lines 684 and 685 at the time of writing) holds two character-identical calls to
 *    `loadMovementDailyCounts(em, scope, trendStart, { types: ['adjust'], quantitySign: 'negative' })`,
 *    so the two differently labelled trends were one and the same series: the daily
 *    number of negative stock adjustments. That is neither a count of low-stock
 *    positions nor a history of the reorder or safety thresholds, so neither caption was
 *    true and the chart could not be reconciled with the number printed next to it.
 * 2. The "since yesterday" delta. The same loader hard-codes `deltaSinceYesterday: null`
 *    on the `lowStock` and `reorderCritical` KPI entries, so the row could only ever
 *    appear in tests, never for an operator.
 *
 * WMS persists neither historical stock levels nor historical thresholds, so a truthful
 * seven-day low-stock trend cannot be reconstructed from this payload at all. Restoring
 * either element needs a new series in core first, not a change in this file.
 */
const StockGapsWidget: React.FC<DashboardWidgetComponentProps<StockGapsSettings>> = ({
  mode,
  refreshToken,
  onRefreshStateChange,
}) => {
  const t = useT()
  const locale = useOptionalLocale()
  const [payload, setPayload] = React.useState<StockGapsPayload | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    onRefreshStateChange?.(true)
    setLoading(true)
    setError(null)
    try {
      setPayload(await loadStockGaps())
    } catch {
      setError(t('distributor_workspace.widgets.stockGaps.error', 'Could not load stock levels'))
    } finally {
      setLoading(false)
      onRefreshStateChange?.(false)
    }
  }, [onRefreshStateChange, t])

  React.useEffect(() => {
    refresh().catch(() => {})
  }, [refresh, refreshToken])

  if (mode === 'settings') {
    return (
      <p className="text-sm text-muted-foreground">
        {t(
          'distributor_workspace.widgets.stockGaps.settings.none',
          'This widget has no options. Reorder points and safety stock are set per product variant.',
        )}
      </p>
    )
  }

  if (error) {
    return <WidgetError message={error} />
  }

  if (loading && !payload) {
    return <WidgetSkeleton rows={3} />
  }

  const emptyMessage = t(
    'distributor_workspace.widgets.stockGaps.empty',
    'Every stock position is above its reorder point.',
  )

  if (!payload) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>
  }

  const lowStock = readGapKpi(payload.kpis, 'lowStock')
  const belowSafety = readGapKpi(payload.kpis, 'reorderCritical')
  const breakdown = resolveGapBreakdown(lowStock.count, belowSafety.count)

  const unitLabel = t(
    'distributor_workspace.widgets.stockGaps.unit',
    'low stock positions (variant × warehouse)',
  )

  if (breakdown.notNested) {
    // Some profile carries a safety stock above its reorder point, so neither set
    // contains the other and the nested layout below would misstate them. Both
    // numbers are real and each still opens its own list.
    return (
      <div className="flex flex-col gap-3 border-y border-border py-3">
        <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <Link
            href={`${INVENTORY_PATH}?lowStock=belowReorder`}
            className="flex flex-col gap-1 px-3 transition-colors hover:bg-accent"
          >
            <span className="text-xs text-muted-foreground">
              {t('distributor_workspace.widgets.stockGaps.total.label', 'At or below reorder point')}
            </span>
            <span className="flex items-baseline gap-1.5">
              <span
                className={cn(
                  'text-2xl font-bold tabular-nums',
                  breakdown.total > 0 ? 'text-status-warning-text' : 'text-foreground',
                )}
              >
                {formatNumber(breakdown.total, locale)}
              </span>
              <span className="text-xs text-muted-foreground">{unitLabel}</span>
            </span>
          </Link>
          <Link
            href={`${INVENTORY_PATH}?lowStock=belowSafety`}
            className="flex flex-col gap-1 px-3 transition-colors hover:bg-accent"
          >
            <span className="text-xs text-muted-foreground">
              {t(
                'distributor_workspace.widgets.stockGaps.belowSafety.standaloneLabel',
                'At or below safety stock',
              )}
            </span>
            <span className="flex items-baseline gap-1.5">
              <span
                className={cn(
                  'text-2xl font-bold tabular-nums',
                  breakdown.reportedCritical > 0 ? 'text-status-error-text' : 'text-foreground',
                )}
              >
                {formatNumber(breakdown.reportedCritical, locale)}
              </span>
              <span className="text-xs text-muted-foreground">{unitLabel}</span>
            </span>
          </Link>
        </div>
        <p className="px-3 text-xs text-muted-foreground">
          {t(
            'distributor_workspace.widgets.stockGaps.independentCounts',
            'These are two separate checks here, not one inside the other: some products keep a safety stock above their reorder point. Do not add the numbers up.',
          )}
        </p>
      </div>
    )
  }

  if (breakdown.total === 0) {
    return (
      <div className="rounded-md border border-status-success-border bg-status-success-bg px-3 py-6 text-center">
        <p className="text-sm text-status-success-text">{emptyMessage}</p>
      </div>
    )
  }

  /**
   * One primary number carries the whole low-stock set, and the critical subset
   * is nested inside it behind a segmented bar plus an indented rail. That
   * shape is what makes the containment readable at a glance: two equal tiles
   * invited the reader to add 42 and 16 into 58 problems that do not exist.
   * The primary number keeps the `belowReorder` link because that filter
   * returns the whole set (available <= reorder point, see
   * packages/core/src/modules/wms/lib/lowStockBalanceFilter.ts) — so its label
   * promises the whole set too. The derived reorder-only remainder has no
   * filter that returns exactly it, so it stays plain text.
   *
   * The remainder region has one branch per relation between the subset and the
   * whole, and none of them prints the primary number a second time: when
   * nothing is critical the remainder EQUALS the total, so it is stated in
   * words instead of repeated as a second big figure the operator could add to
   * the first one.
   */
  return (
    <div className="flex flex-col gap-3 border-y border-border py-3">
      <Link
        href={`${INVENTORY_PATH}?lowStock=belowReorder`}
        className="flex flex-col gap-1 px-3 transition-colors hover:bg-accent"
      >
        <span className="text-xs text-muted-foreground">
          {t('distributor_workspace.widgets.stockGaps.total.label', 'At or below reorder point')}
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-3xl font-bold tabular-nums text-status-warning-text">
            {formatNumber(breakdown.total, locale)}
          </span>
          <span className="text-xs text-muted-foreground">{unitLabel}</span>
        </span>
        {breakdown.noneCritical ? null : (
          <span className="text-xs text-muted-foreground">
            {t(
              'distributor_workspace.widgets.stockGaps.total.hint',
              'Everything here needs ordering — the critical part is inside it',
            )}
          </span>
        )}
      </Link>

      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={breakdown.total}
        aria-valuenow={breakdown.critical}
        aria-label={t(
          'distributor_workspace.widgets.stockGaps.meter',
          '{critical} of {total} low stock positions are below safety stock',
          { critical: formatNumber(breakdown.critical, locale), total: formatNumber(breakdown.total, locale) },
        )}
        className="mx-3 flex h-2 overflow-hidden rounded-full bg-muted"
      >
        <span className="bg-status-error-icon" style={{ width: `${breakdown.criticalShare}%` }} />
        <span className="bg-status-warning-icon" style={{ width: `${100 - breakdown.criticalShare}%` }} />
      </div>

      <div className="mx-3 flex flex-col gap-2 border-l-2 border-border pl-3">
        <Link
          href={`${INVENTORY_PATH}?lowStock=belowSafety`}
          className="flex flex-col gap-1 transition-colors hover:bg-accent"
        >
          <span className="flex items-baseline gap-1.5">
            <span
              className={cn(
                'text-xl font-bold tabular-nums',
                breakdown.critical > 0 ? 'text-status-error-text' : 'text-foreground',
              )}
            >
              {formatNumber(breakdown.critical, locale)}
            </span>
            <span className="text-xs text-muted-foreground">
              {t(
                'distributor_workspace.widgets.stockGaps.belowSafety.subsetLabel',
                'of which below safety stock',
              )}
            </span>
          </span>
          {breakdown.critical > 0 ? (
            <span className="text-xs text-muted-foreground">
              {t(
                'distributor_workspace.widgets.stockGaps.belowSafety.hint',
                'The next order may go unfilled',
              )}
            </span>
          ) : null}
        </Link>

        {breakdown.noneCritical ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">
              {t(
                'distributor_workspace.widgets.stockGaps.noneCritical',
                'All of them are only below their reorder point',
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              {t(
                'distributor_workspace.widgets.stockGaps.onlyBelowReorder.hint',
                'Still sellable — order before the buffer is gone',
              )}
            </span>
          </div>
        ) : breakdown.allCritical ? (
          <p className="text-xs text-status-error-text">
            {t(
              'distributor_workspace.widgets.stockGaps.allCritical',
              'Every one of them is below safety stock',
            )}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            <span className="flex items-baseline gap-1.5">
              <span className="text-xl font-bold tabular-nums text-status-warning-text">
                {formatNumber(breakdown.onlyBelowReorder, locale)}
              </span>
              <span className="text-xs text-muted-foreground">
                {t(
                  'distributor_workspace.widgets.stockGaps.onlyBelowReorder.label',
                  'and only below reorder point',
                )}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              {t(
                'distributor_workspace.widgets.stockGaps.onlyBelowReorder.hint',
                'Still sellable — order before the buffer is gone',
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

export default StockGapsWidget
