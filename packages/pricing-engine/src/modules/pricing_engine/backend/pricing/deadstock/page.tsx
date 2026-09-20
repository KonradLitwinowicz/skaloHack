'use client'

import * as React from 'react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { ListEmptyState } from '@open-mercato/ui/backend/filters/ListEmptyState'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@open-mercato/ui/primitives/table'
import { ConfidenceBadge } from '../../../components/ConfidenceBadge'
import type { DeadstockListResponse, DeadstockRowView, DeadstockSortKey } from '../../../lib/frontend/deadstockTypes'
import {
  CLASS_LABEL_KEYS,
  CLASS_TONE,
  SUPPRESSION_LABEL_KEYS,
  formatAmount,
  formatQuantity,
  resolveExpiryFlag,
} from '../../../lib/frontend/deadstockTypes'

const PAGE_SIZE = 50

type SortState = { key: DeadstockSortKey; dir: 'asc' | 'desc' }

export default function PricingDeadstockPage() {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = React.useState<DeadstockListResponse | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [sort, setSort] = React.useState<SortState>({ key: 'tiedCapital', dir: 'desc' })
  const [search, setSearch] = React.useState('')
  const [atRiskOnly, setAtRiskOnly] = React.useState(true)
  const [includeSuppressed, setIncludeSuppressed] = React.useState(false)
  const [page, setPage] = React.useState(1)
  const [reloadToken, setReloadToken] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      const params = new URLSearchParams({
        sort: sort.key,
        dir: sort.dir,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      })
      if (atRiskOnly) params.set('atRiskOnly', 'true')
      if (includeSuppressed) params.set('includeSuppressed', 'true')
      if (search.trim()) params.set('search', search.trim())

      try {
        const call = await apiCall<DeadstockListResponse & { error?: string }>(
          `/api/pricing/deadstock?${params.toString()}`,
        )
        if (cancelled) return
        if (!call.ok || !call.result) {
          setError(t(call.result?.error ?? 'pricing_engine.errors.deadstockFailed', 'Could not load the deadstock list.'))
          return
        }
        setError(null)
        setData(call.result)
      } catch {
        if (!cancelled) setError(t('pricing_engine.errors.deadstockFailed', 'Could not load the deadstock list.'))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [t, sort, page, search, atRiskOnly, includeSuppressed, reloadToken])

  const toggleSort = React.useCallback((key: DeadstockSortKey) => {
    setPage(1)
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === 'desc' ? 'asc' : 'desc' }
        : { key, dir: key === 'title' || key === 'sku' ? 'asc' : 'desc' },
    )
  }, [])

  const decide = React.useCallback(
    async (row: DeadstockRowView, verdict: 'confirmed' | 'dismissed') => {
      const call = await apiCall<{ error?: string }>('/api/pricing/deadstock/decisions', {
        method: 'POST',
        body: JSON.stringify({
          productId: row.productId,
          variantId: row.variantId,
          verdict,
          // A dismissal that never lapses would quietly empty the list, so the screen always sets
          // a review date and the operator can extend it by dismissing again.
          ...(verdict === 'dismissed' ? { reviewInDays: 90 } : {}),
        }),
      })
      if (!call.ok) {
        // The server's key, when it has one: "run the migration" is actionable, "could not record
        // the decision" is not, and the operator cannot tell those two situations apart otherwise.
        flash(
          t(call.result?.error ?? 'pricing_engine.deadstock.decision.failed', 'Could not record the decision.'),
          'error',
        )
        return
      }
      flash(
        verdict === 'dismissed'
          ? t('pricing_engine.deadstock.decision.dismissed', 'Hidden for 90 days.')
          : t('pricing_engine.deadstock.decision.confirmed', 'Marked as deadstock.'),
        'success',
      )
      setReloadToken((token) => token + 1)
    },
    [t],
  )

  if (error) return <ErrorMessage label={error} />
  if (!data) return <LoadingMessage label={t('pricing_engine.deadstock.loading', 'Measuring rotation...')} />

  const { totals, currencyCode } = data

  return (
    <Page>
      <PageBody>
        <p className="text-sm text-muted-foreground">
          {t(
            'pricing_engine.deadstock.description',
            'Stock that is not moving, what keeping it costs each month, and how low its price may go before selling stops being worth it. Every figure is net.',
          )}
        </p>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi
            label={t('pricing_engine.deadstock.kpi.tiedCapital', 'Capital asleep')}
            value={formatAmount(totals.tiedCapital, currencyCode, locale)}
            hint={t('pricing_engine.deadstock.kpi.tiedCapitalHint', '{count} positions with a verdict', {
              count: String(totals.atRiskCount),
            })}
          />
          <Kpi
            label={t('pricing_engine.deadstock.kpi.monthlyCarry', 'Burning per month')}
            value={formatAmount(totals.monthlyCarry, currencyCode, locale)}
            hint={t('pricing_engine.deadstock.kpi.perYear', '{amount} a year if nothing is done', {
              amount: formatAmount(totals.yearlyCarry, currencyCode, locale),
            })}
          />
          <Kpi
            label={t('pricing_engine.deadstock.kpi.recoverable', 'Recoverable at floor')}
            value={formatAmount(totals.recoverableAtFloor, currencyCode, locale)}
            hint={t('pricing_engine.deadstock.kpi.recoverableHint', 'If every position cleared at its floor')}
          />
          <Kpi
            label={t('pricing_engine.deadstock.kpi.stocked', 'Stocked products')}
            value={String(totals.stockedCount)}
            hint={t('pricing_engine.deadstock.kpi.suppressed', '{count} verdicts withheld', {
              count: String(totals.suppressedCount),
            })}
          />
        </div>

        {!data.warehouseCostConfigured ? (
          <p className="text-sm text-status-warning-foreground">
            {t(
              'pricing_engine.deadstock.noWarehouseCost',
              'No warehouse cost row is configured, so only frozen capital is charged and the carrying cost is understated.',
            )}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Input
            value={search}
            onChange={(event) => {
              setPage(1)
              setSearch(event.target.value)
            }}
            placeholder={t('pricing_engine.deadstock.searchPlaceholder', 'Search by name or SKU')}
            className="max-w-xs"
          />
          <Button
            variant={atRiskOnly ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setPage(1)
              setAtRiskOnly((value) => !value)
            }}
          >
            {t('pricing_engine.deadstock.filter.atRiskOnly', 'Only what is not moving')}
          </Button>
          <Button
            variant={includeSuppressed ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setPage(1)
              setIncludeSuppressed((value) => !value)
            }}
          >
            {t('pricing_engine.deadstock.filter.includeSuppressed', 'Show withheld verdicts')}
          </Button>
        </div>

        {data.items.length === 0 ? (
          <ListEmptyState
            title={t('pricing_engine.deadstock.empty', 'Nothing is sitting still. Every stocked product is moving.')}
            description={t(
              'pricing_engine.deadstock.emptyHint',
              'Widen the view with "Show withheld verdicts" to see what the detector decided NOT to accuse, and why.',
            )}
            icon="package-x"
          />
        ) : null}

        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead sortKey="title" sort={sort} onSort={toggleSort}>
                {t('pricing_engine.deadstock.column.product', 'Product')}
              </SortableHead>
              <SortableHead sortKey="onHandQuantity" sort={sort} onSort={toggleSort} numeric>
                {t('pricing_engine.deadstock.column.onHand', 'On hand')}
              </SortableHead>
              <SortableHead sortKey="units30" sort={sort} onSort={toggleSort} numeric>
                {t('pricing_engine.deadstock.column.units30', '30 d')}
              </SortableHead>
              <SortableHead sortKey="units90" sort={sort} onSort={toggleSort} numeric>
                {t('pricing_engine.deadstock.column.units90', '90 d')}
              </SortableHead>
              <SortableHead sortKey="units365" sort={sort} onSort={toggleSort} numeric>
                {t('pricing_engine.deadstock.column.units365', '365 d')}
              </SortableHead>
              <SortableHead sortKey="revenue365" sort={sort} onSort={toggleSort} numeric>
                {t('pricing_engine.deadstock.column.revenue365', 'Revenue 365 d')}
              </SortableHead>
              <SortableHead sortKey="daysSinceLastSale" sort={sort} onSort={toggleSort} numeric>
                {t('pricing_engine.deadstock.column.dormant', 'Days dormant')}
              </SortableHead>
              <SortableHead sortKey="tiedCapital" sort={sort} onSort={toggleSort} numeric>
                {t('pricing_engine.deadstock.column.tiedCapital', 'Capital')}
              </SortableHead>
              <SortableHead sortKey="monthlyCarry" sort={sort} onSort={toggleSort} numeric>
                {t('pricing_engine.deadstock.column.monthlyCarry', 'Per month')}
              </SortableHead>
              <SortableHead sortKey="floorUnitPrice" sort={sort} onSort={toggleSort} numeric>
                {t('pricing_engine.deadstock.column.floor', 'Floor')}
              </SortableHead>
              <TableHead className="text-right">
                {t('pricing_engine.deadstock.column.decision', 'Decision')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((row) => (
              <TableRow key={row.productId}>
                <TableCell>
                  {/* The first question a dormant row raises is "what IS this", so the name is the
                      way into the catalogue record rather than dead text. */}
                  <a className="font-medium underline-offset-2 hover:underline" href={`/backend/catalog/products/${row.productId}`}>
                    {row.title ?? row.sku ?? row.productId}
                  </a>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Badge variant={CLASS_TONE[row.suppression ? row.rawClass : row.productClass]}>
                      {t(CLASS_LABEL_KEYS[row.suppression ? row.rawClass : row.productClass], row.rawClass)}
                    </Badge>
                    {row.suppression ? (
                      <Badge variant="outline">
                        {t(SUPPRESSION_LABEL_KEYS[row.suppression], row.suppression)}
                      </Badge>
                    ) : null}
                    <ExpiryBadge nearestExpiryAt={row.nearestExpiryAt} asOf={data.asOf} />
                    {row.sku ? <span className="text-xs text-muted-foreground">{row.sku}</span> : null}
                  </div>
                </TableCell>
                <TableCell className="text-right">{formatQuantity(row.onHandQuantity, locale)}</TableCell>
                <TableCell className="text-right">{formatQuantity(unitsOf(row, 30), locale)}</TableCell>
                <TableCell className="text-right">{formatQuantity(unitsOf(row, 90), locale)}</TableCell>
                <TableCell className="text-right">{formatQuantity(unitsOf(row, 365), locale)}</TableCell>
                <TableCell className="text-right">{formatAmount(revenueOf(row, 365), currencyCode, locale)}</TableCell>
                <TableCell className="text-right">
                  {row.daysSinceLastSale === null
                    ? t('pricing_engine.deadstock.neverSoldShort', 'never')
                    : String(row.daysSinceLastSale)}
                </TableCell>
                <TableCell className="text-right">{formatAmount(row.carrying.tiedCapital, currencyCode, locale)}</TableCell>
                <TableCell className="text-right">
                  <div>{formatAmount(row.carrying.positionPerMonth, currencyCode, locale)}</div>
                  {/* A monthly rate alone is the wrong unit at both ends of the decision: "can this
                      wait a week" and "is this worth keeping another year" are different questions. */}
                  <div className="text-xs text-muted-foreground">
                    {t('pricing_engine.deadstock.column.perWeekYear', '{week} / week · {year} / year', {
                      week: formatAmount(row.carrying.positionPerWeek, currencyCode, locale),
                      year: formatAmount(row.carrying.positionPerYear, currencyCode, locale),
                    })}
                  </div>
                  <ConfidenceBadge confidence={row.carrying.confidence} />
                </TableCell>
                <TableCell className="text-right">
                  {row.markdown ? (
                    <div>
                      <div>{formatAmount(row.markdown.floorUnitPrice, currencyCode, locale)}</div>
                      <div className="text-xs text-muted-foreground">
                        {t('pricing_engine.deadstock.column.avoided', 'saves {amount}', {
                          amount: formatAmount(row.markdown.carryingCostAvoided, currencyCode, locale),
                        })}
                      </div>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {row.decision?.inForce ? (
                    <span className="text-xs text-muted-foreground">
                      {t(`pricing_engine.deadstock.verdict.${row.decision.verdict}`, row.decision.verdict)}
                    </span>
                  ) : (
                    <RowActions
                      items={[
                        {
                          id: 'open-product',
                          label: t('pricing_engine.deadstock.action.openProduct', 'Open product'),
                          href: `/backend/catalog/products/${row.productId}`,
                        },
                        ...(row.variantId
                          ? [
                              {
                                id: 'open-wms',
                                label: t('pricing_engine.deadstock.action.openWarehouse', 'Open in warehouse'),
                                href: `/backend/wms/sku/${row.variantId}`,
                              },
                            ]
                          : []),
                        {
                          id: 'confirm',
                          label: t('pricing_engine.deadstock.action.confirm', 'Confirm'),
                          onSelect: () => void decide(row, 'confirmed'),
                        },
                        {
                          id: 'dismiss',
                          label: t('pricing_engine.deadstock.action.dismiss', 'Not now'),
                          onSelect: () => void decide(row, 'dismissed'),
                        },
                      ]}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {data.totalPages > 1 ? (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {t('pricing_engine.deadstock.pageOf', 'Page {page} of {totalPages}', {
                page: String(data.page),
                totalPages: String(data.totalPages),
              })}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={data.page <= 1} onClick={() => setPage((value) => value - 1)}>
                {t('pricing_engine.deadstock.prev', 'Previous')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={data.page >= data.totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                {t('pricing_engine.deadstock.next', 'Next')}
              </Button>
            </div>
          </div>
        ) : null}
      </PageBody>
    </Page>
  )
}

function unitsOf(row: DeadstockRowView, windowDays: number): string {
  return row.windows.find((window) => window.windowDays === windowDays)?.unitsSold ?? '0'
}

function revenueOf(row: DeadstockRowView, windowDays: number): string {
  return row.windows.find((window) => window.windowDays === windowDays)?.revenueNet ?? '0'
}

/**
 * Dormant AND short-dated is the worst combination on this screen: no demand, and time running out
 * to find any. The action stays with the expiry ladder, which owns hard deadlines — this only
 * raises the alarm so the reader does not have to open two screens to see it.
 *
 * Counted from the response's `asOf`, never from the browser clock. Every other figure in this row
 * — the class, the days dormant, the floor — was computed server-side at that instant, and a badge
 * ticking along on a different clock would describe a different moment than the row it sits in. A
 * page left open over a shift, or a workstation whose clock has drifted, is enough to separate them.
 */
function ExpiryBadge({ nearestExpiryAt, asOf }: { nearestExpiryAt: string | null; asOf: string }) {
  const t = useT()
  const reference = React.useMemo(() => {
    const parsed = Date.parse(asOf)
    return Number.isFinite(parsed) ? new Date(parsed) : new Date()
  }, [asOf])
  const flag = resolveExpiryFlag(nearestExpiryAt, reference)
  if (!flag) return null
  return (
    <Badge variant="destructive">
      {flag.kind === 'pastDue'
        ? t('pricing_engine.deadstock.pastDue', 'past date by {days} d', { days: String(flag.days) })
        : t('pricing_engine.deadstock.expiringToo', 'expires in {days} d', { days: String(flag.days) })}
    </Badge>
  )
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="pt-1 text-2xl font-semibold">{value}</div>
      <div className="pt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  )
}

function SortableHead({
  sortKey,
  sort,
  onSort,
  numeric,
  children,
}: {
  sortKey: DeadstockSortKey
  sort: SortState
  onSort: (key: DeadstockSortKey) => void
  numeric?: boolean
  children: React.ReactNode
}) {
  const active = sort.key === sortKey
  return (
    <TableHead className={numeric ? 'text-right' : undefined}>
      <button type="button" className="inline-flex items-center gap-1" onClick={() => onSort(sortKey)}>
        <span className={active ? 'font-semibold' : undefined}>{children}</span>
        <span aria-hidden className="text-xs text-muted-foreground">
          {active ? (sort.dir === 'desc' ? '↓' : '↑') : ''}
        </span>
      </button>
    </TableHead>
  )
}
