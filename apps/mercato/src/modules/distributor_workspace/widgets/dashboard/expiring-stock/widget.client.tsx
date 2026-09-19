"use client"

import * as React from 'react'
import Link from 'next/link'
import { z } from 'zod'
import type { DashboardWidgetComponentProps } from '@open-mercato/shared/modules/dashboard/widgets'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { WidgetError, WidgetSkeleton } from '@open-mercato/ui/backend/dashboard/WidgetList'
import { useOptionalLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { cn } from '@open-mercato/shared/lib/utils'

const MS_PER_DAY = 86_400_000
const LOTS_LIST_PATH = '/backend/wms/lots'
const LOT_DETAIL_PATH = '/backend/wms/lot'

/**
 * `buildExpiryLotRows` in the WMS operational dashboard caps each of its two expiry
 * categories at `EXPIRY_CARD_LIMIT` (5), so a payload can never carry more than ten
 * rows. Rendering exactly that ceiling means the widget never hides a row the API did
 * send, which is what keeps the "remaining lots" line below the list honest: every lot
 * it counts is genuinely absent from the payload and only reachable through the full
 * lot list. The previous value of 6 sat between the per-category limit and that
 * ceiling, so it could hide received rows while never triggering the message.
 */
const VISIBLE_LOT_ROWS = 10

const expiringStockPayloadSchema = z.object({
  lastUpdatedAt: z.string(),
  kpis: z.array(z.object({ id: z.string(), count: z.number() })),
  expiryLots: z.array(
    z.object({
      id: z.string(),
      lotNumber: z.string(),
      sku: z.string(),
      productTitle: z.string().nullable().optional(),
      expiresAt: z.string(),
      availableQuantity: z.number(),
      category: z.enum(['expiringSoon', 'pastDue']),
    }),
  ),
})

export type ExpiringStockPayload = z.infer<typeof expiringStockPayloadSchema>
export type ExpiringStockLot = ExpiringStockPayload['expiryLots'][number]

export type ExpiringStockSettings = Record<string, never>

/**
 * The reference instant comes from the payload rather than the browser clock so the
 * row ordering and the day counts describe the same moment the counts were computed,
 * and so the behaviour stays reproducible in tests.
 */
export function daysUntilExpiry(expiresAt: string, referenceIso: string): number | null {
  const expiresMs = Date.parse(expiresAt)
  const referenceMs = Date.parse(referenceIso)
  if (!Number.isFinite(expiresMs) || !Number.isFinite(referenceMs)) return null
  return Math.floor(expiresMs / MS_PER_DAY) - Math.floor(referenceMs / MS_PER_DAY)
}

export function sortLotsByUrgency(lots: readonly ExpiringStockLot[]): ExpiringStockLot[] {
  return [...lots].sort((left, right) => {
    const leftMs = Date.parse(left.expiresAt)
    const rightMs = Date.parse(right.expiresAt)
    const leftSortable = Number.isFinite(leftMs)
    const rightSortable = Number.isFinite(rightMs)
    if (!leftSortable && !rightSortable) return left.lotNumber.localeCompare(right.lotNumber)
    if (!leftSortable) return 1
    if (!rightSortable) return -1
    if (leftMs !== rightMs) return leftMs - rightMs
    return left.lotNumber.localeCompare(right.lotNumber)
  })
}

export function readKpiCount(kpis: readonly { id: string; count: number }[], id: string): number {
  return kpis.find((kpi) => kpi.id === id)?.count ?? 0
}

/**
 * The two tiles count every lot with stock left in their expiry window, while the
 * payload carries only the most urgent handful, so the remainder the operator cannot
 * see is the tile total minus the rows actually rendered. Both counts are lot counts,
 * which is what makes the subtraction meaningful; a payload that runs ahead of the
 * KPIs clamps to zero rather than reporting a negative remainder.
 */
export function countRemainingLots(kpiTotal: number, renderedRows: number): number {
  return Math.max(kpiTotal - renderedRows, 0)
}

/**
 * Falls back to the SKU as the headline when the payload carries no product title,
 * either because the field has not shipped yet or because the lot has no catalog
 * match. The SKU then stops repeating on the secondary line.
 */
export function resolveLotPrimaryLabel(lot: ExpiringStockLot): { primary: string; showSku: boolean } {
  const productTitle = lot.productTitle?.trim() ?? ''
  if (productTitle.length === 0) return { primary: lot.sku, showSku: false }
  return { primary: productTitle, showSku: true }
}

async function loadExpiringStock(): Promise<ExpiringStockPayload> {
  const call = await apiCall<unknown>('/api/wms/dashboard/operational')
  if (!call.ok) {
    throw new Error(`[internal] Operational dashboard request failed with status ${call.status}`)
  }
  const parsed = expiringStockPayloadSchema.safeParse(call.result)
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

function buildLotsHref(window: 'expiringSoon' | 'pastDue'): string {
  return `${LOTS_LIST_PATH}?expiryWindow=${window}`
}

type CountTileProps = {
  href: string
  label: string
  count: number
  unitLabel: string
  accessibleValue: string
  tone: 'warning' | 'error'
  locale: string | undefined
}

/**
 * The visible number and its unit are split for typographic weight, so the pair is
 * hidden from assistive technology and replaced by one phrase that reads the count
 * and the unit together instead of announcing a bare number.
 */
function CountTile({ href, label, count, unitLabel, accessibleValue, tone, locale }: CountTileProps) {
  const toneClass = tone === 'error' ? 'text-status-error-text' : 'text-status-warning-text'
  return (
    <Link href={href} className="flex flex-col px-3 py-3 transition-colors hover:bg-accent">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="mt-1 flex items-baseline gap-1">
        <span className="sr-only">{accessibleValue}</span>
        <span
          aria-hidden="true"
          className={cn('text-xl font-bold tabular-nums', count > 0 ? toneClass : 'text-foreground')}
        >
          {formatNumber(count, locale)}
        </span>
        <span aria-hidden="true" className="text-xs font-medium text-muted-foreground">
          {unitLabel}
        </span>
      </span>
    </Link>
  )
}

const ExpiringStockWidget: React.FC<DashboardWidgetComponentProps<ExpiringStockSettings>> = ({
  mode,
  refreshToken,
  onRefreshStateChange,
}) => {
  const t = useT()
  const locale = useOptionalLocale()
  const [payload, setPayload] = React.useState<ExpiringStockPayload | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    onRefreshStateChange?.(true)
    setLoading(true)
    setError(null)
    try {
      setPayload(await loadExpiringStock())
    } catch {
      setError(t('distributor_workspace.widgets.expiringStock.error', 'Could not load the expiry watch list'))
    } finally {
      setLoading(false)
      onRefreshStateChange?.(false)
    }
  }, [onRefreshStateChange, t])

  React.useEffect(() => {
    refresh().catch(() => {})
  }, [refresh, refreshToken])

  const describeDeadline = React.useCallback((days: number | null): string => {
    if (days === null) return t('distributor_workspace.widgets.expiringStock.deadline.unknown', 'No expiry date')
    if (days < 0) {
      return t('distributor_workspace.widgets.expiringStock.deadline.overdue', '{days} days past date', {
        days: Math.abs(days),
      })
    }
    if (days === 0) return t('distributor_workspace.widgets.expiringStock.deadline.today', 'Expires today')
    if (days === 1) return t('distributor_workspace.widgets.expiringStock.deadline.tomorrow', 'Expires tomorrow')
    return t('distributor_workspace.widgets.expiringStock.deadline.inDays', 'In {days} days', { days })
  }, [t])

  if (mode === 'settings') {
    return (
      <p className="text-sm text-muted-foreground">
        {t(
          'distributor_workspace.widgets.expiringStock.settings.none',
          'This widget has no options. Expiry windows are configured per warehouse.',
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

  if (!payload) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('distributor_workspace.widgets.expiringStock.empty', 'Nothing is close to its expiry date.')}
      </p>
    )
  }

  const expiringSoon = readKpiCount(payload.kpis, 'expiringSoon')
  const pastDue = readKpiCount(payload.kpis, 'pastDue')
  const rows = sortLotsByUrgency(payload.expiryLots)

  if (expiringSoon === 0 && pastDue === 0 && rows.length === 0) {
    return (
      <div className="rounded-md border border-status-success-border bg-status-success-bg px-3 py-6 text-center">
        <p className="text-sm text-status-success-text">
          {t('distributor_workspace.widgets.expiringStock.empty', 'Nothing is close to its expiry date.')}
        </p>
      </div>
    )
  }

  const visibleRows = rows.slice(0, VISIBLE_LOT_ROWS)
  const remainingLots = countRemainingLots(expiringSoon + pastDue, visibleRows.length)
  const lotsUnitLabel = t('distributor_workspace.widgets.expiringStock.kpi.lotsUnit', 'lots')

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 divide-x divide-border border-y border-border">
        <CountTile
          href={buildLotsHref('expiringSoon')}
          label={t('distributor_workspace.widgets.expiringStock.kpi.expiringSoon', 'Losing date')}
          count={expiringSoon}
          unitLabel={lotsUnitLabel}
          accessibleValue={t('distributor_workspace.widgets.expiringStock.kpi.lotsValue', '{count} lots', {
            count: formatNumber(expiringSoon, locale),
          })}
          tone="warning"
          locale={locale}
        />
        <CountTile
          href={buildLotsHref('pastDue')}
          label={t('distributor_workspace.widgets.expiringStock.kpi.pastDue', 'Past date')}
          count={pastDue}
          unitLabel={lotsUnitLabel}
          accessibleValue={t('distributor_workspace.widgets.expiringStock.kpi.lotsValue', '{count} lots', {
            count: formatNumber(pastDue, locale),
          })}
          tone="error"
          locale={locale}
        />
      </div>
      {visibleRows.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">
          {t(
            'distributor_workspace.widgets.expiringStock.noLotDetail',
            'No lot rows to show for the current expiry window.',
          )}
        </p>
      ) : (
        <ul>
          {visibleRows.map((lot) => {
            const days = daysUntilExpiry(lot.expiresAt, payload.lastUpdatedAt)
            const overdue = days !== null && days < 0
            const { primary, showSku } = resolveLotPrimaryLabel(lot)
            return (
              <li key={lot.id}>
                <Link
                  href={`${LOT_DETAIL_PATH}/${encodeURIComponent(lot.id)}`}
                  className="flex items-center justify-between gap-3 py-1.5 transition-colors hover:bg-accent"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{primary}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {showSku ? (
                        <>
                          <span>{lot.sku}</span>
                          <span aria-hidden="true"> · </span>
                          <span>{lot.lotNumber}</span>
                        </>
                      ) : (
                        lot.lotNumber
                      )}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span
                      className={cn(
                        'block text-xs font-medium',
                        overdue ? 'text-status-error-text' : 'text-status-warning-text',
                      )}
                    >
                      {describeDeadline(days)}
                    </span>
                    <span className="block text-xs tabular-nums text-muted-foreground">
                      {t('distributor_workspace.widgets.expiringStock.units', '{count} pcs', {
                        count: formatNumber(lot.availableQuantity, locale),
                      })}
                    </span>
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      {remainingLots > 0 ? (
        <Link href={LOTS_LIST_PATH} className="block px-1 text-xs text-muted-foreground hover:text-foreground">
          {t(
            'distributor_workspace.widgets.expiringStock.more',
            'See {count} more lots in the full lot list',
            { count: formatNumber(remainingLots, locale) },
          )}
        </Link>
      ) : null}
    </div>
  )
}

export default ExpiringStockWidget
