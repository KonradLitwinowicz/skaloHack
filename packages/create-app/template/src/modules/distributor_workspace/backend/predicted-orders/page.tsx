'use client'

import * as React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { ErrorMessage, LoadingMessage, TabEmptyState } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import type { ConfidenceBand } from '../../lib/orderForecast'
import { formatCounted } from '../../lib/pluralize'

/**
 * The morning screen: every delivery the distributor is expecting, across every customer.
 *
 * A row here is a DELIVERY, not a product. That is the unit of work — nobody picks one line, loads
 * one line onto a van, or phones a customer about one line. The basket opens to show what is in
 * it, because the lines carry the evidence, but the list itself answers the question the day
 * starts with: who is getting a delivery, when, and roughly how big.
 *
 * What is coming leads; what was missed follows. The forward list is what an operator plans
 * against, and a screen that opened on last month's failures would be a report, not a plan.
 */

const HORIZON_OPTIONS = [3, 7, 14, 30] as const

const CONFIDENCE_VARIANTS: Record<ConfidenceBand, StatusBadgeVariant> = {
  high: 'success',
  medium: 'warning',
  low: 'neutral',
}

type BasketLine = {
  productKey: string
  productName: string
  sku: string | null
  predictedQuantity: number
  quantityUnit: string | null
  predictedLineNetAmount: number | null
  confidence: number
  confidenceBand: ConfidenceBand
  acknowledged: boolean
  cadenceDays: number
  occurrences: number
  lastOrderedAt: string
  history: Array<{ orderedAt: string; quantity: number; orderIds: string[] }>
}

type BasketRow = {
  customerEntityId: string
  customerName: string | null
  expectedAt: string
  weekday: number
  daysUntilExpected: number
  overdueDays: number
  lineCount: number
  totalNetAmount: number | null
  currencyCode: string | null
  confidence: number
  confidenceBand: ConfidenceBand
  acknowledgedLines: number
  onRhythm: boolean
  lines: BasketLine[]
}

type UpcomingResponse = {
  generatedAt: string
  horizonDays: number
  customersAnalysed: number
  customersWithPredictions: number
  totalValueNet: number | null
  currencyCode: string | null
  rows: BasketRow[]
}

type Translate = (key: string, fallback: string) => string

function useCountFormatters(t: Translate, locale: string) {
  return React.useMemo(() => {
    const forms = (kind: string) => ({
      one: t(`distributor_workspace.orderForecast.plural.${kind}.one`, kind),
      few: t(`distributor_workspace.orderForecast.plural.${kind}.few`, `${kind}s`),
      many: t(`distributor_workspace.orderForecast.plural.${kind}.many`, `${kind}s`),
      other: t(`distributor_workspace.orderForecast.plural.${kind}.other`, `${kind}s`),
    })
    return {
      days: (count: number) => formatCounted(count, locale, forms('day')),
      items: (count: number) => formatCounted(count, locale, forms('item')),
      orders: (count: number) => formatCounted(count, locale, forms('order')),
    }
  }, [locale, t])
}

function formatDate(value: string, locale: string): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(locale || undefined)
}

function formatMoney(value: number | null, currencyCode: string | null, locale: string): string | null {
  if (value === null || !Number.isFinite(value)) return null
  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: currencyCode ? 'currency' : 'decimal',
      currency: currencyCode ?? undefined,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return value.toFixed(2)
  }
}

/**
 * Keeps a customer's deliveries adjacent, in the order the list already put them.
 *
 * A customer with a weekly rhythm produces several baskets inside a 30-day window, and interleaved
 * with forty other customers they read as forty unrelated rows. Grouping is presentation only: the
 * chronological order the API returned is preserved inside each group and between groups, so the
 * soonest delivery is still the first thing on the screen.
 */
function groupByCustomer(rows: BasketRow[]): Array<{
  customerEntityId: string
  customerName: string | null
  rows: BasketRow[]
}> {
  const groups = new Map<string, { customerEntityId: string; customerName: string | null; rows: BasketRow[] }>()
  for (const row of rows) {
    const group = groups.get(row.customerEntityId) ?? {
      customerEntityId: row.customerEntityId,
      customerName: row.customerName,
      rows: [],
    }
    group.rows.push(row)
    groups.set(row.customerEntityId, group)
  }
  return [...groups.values()]
}

async function loadUpcoming(horizonDays: number): Promise<UpcomingResponse> {
  const call = await apiCall<UpcomingResponse>(
    `/api/distributor_workspace/order-forecast/upcoming?horizonDays=${horizonDays}`,
  )
  if (!call.ok || !call.result) {
    throw new Error(`[internal] Upcoming forecast request failed with status ${call.status}`)
  }
  return call.result
}

function BasketCard({
  row,
  locale,
  weekdayLabels,
  t,
  counted,
}: {
  row: BasketRow
  locale: string
  weekdayLabels: string[]
  t: Translate
  counted: ReturnType<typeof useCountFormatters>
}) {
  const [open, setOpen] = React.useState(false)
  const money = formatMoney(row.totalNetAmount, row.currencyCode, locale)
  const basketKey = `${row.customerEntityId}:${row.expectedAt}`

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0 space-y-1">
          <Link
            href={`/backend/customers/companies-v2/${row.customerEntityId}?tab=distributor_workspace.injection.customer-order-forecast`}
            className="font-medium text-primary hover:underline"
          >
            {row.customerName ??
              t('distributor_workspace.orderForecast.page.unnamedCustomer', 'Unnamed customer')}
          </Link>
          <div className="text-sm text-foreground">
            {weekdayLabels[row.weekday] ?? ''} {formatDate(row.expectedAt, locale)}
            {' · '}
            {counted.items(row.lineCount)}
            {money ? ` · ${money}` : ''}
          </div>
          <div
            className={
              row.overdueDays > 0
                ? 'text-xs font-medium text-status-warning-text'
                : 'text-xs text-muted-foreground'
            }
          >
            {row.overdueDays > 0
              ? `${t('distributor_workspace.orderForecast.overdueBy', 'Overdue by')} ${counted.days(row.overdueDays)}`
              : row.daysUntilExpected === 0
                ? t('distributor_workspace.orderForecast.today', 'today')
                : `${t('distributor_workspace.orderForecast.inDays', 'in')} ${counted.days(row.daysUntilExpected)}`}
            {row.onRhythm
              ? ` · ${t('distributor_workspace.orderForecast.basket.onRhythm', 'on the customer delivery rhythm')}`
              : ` · ${t('distributor_workspace.orderForecast.basket.offRhythm', 'outside the usual delivery rhythm')}`}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge variant={CONFIDENCE_VARIANTS[row.confidenceBand]} dot>
            {Math.round(row.confidence * 100)}%
          </StatusBadge>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={open}
            aria-controls={`basket-${basketKey}`}
            onClick={() => setOpen((previous) => !previous)}
          >
            {open
              ? t('distributor_workspace.orderForecast.basket.hide', 'Hide basket')
              : t('distributor_workspace.orderForecast.basket.show', 'Show basket')}
          </Button>
        </div>
      </div>

      {open ? (
        <div id={`basket-${basketKey}`} className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[42rem] text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3 text-left font-medium">
                  {t('distributor_workspace.orderForecast.column.product', 'Product')}
                </th>
                <th className="p-3 text-right font-medium">
                  {t('distributor_workspace.orderForecast.column.quantity', 'Expected quantity')}
                </th>
                <th className="p-3 text-left font-medium">
                  {t('distributor_workspace.orderForecast.column.confidence', 'Confidence')}
                </th>
                <th className="p-3 text-left font-medium">
                  {t('distributor_workspace.orderForecast.column.evidence', 'Why')}
                </th>
              </tr>
            </thead>
            <tbody>
              {row.lines.map((line) => (
                <tr key={line.productKey} className="border-t border-border align-top">
                  <td className="p-3">
                    <div className="font-medium text-foreground">{line.productName}</div>
                    {line.sku ? <div className="text-xs text-muted-foreground">{line.sku}</div> : null}
                  </td>
                  <td className="p-3 text-right">
                    <div className="font-semibold text-foreground">
                      {line.predictedQuantity}
                      {line.quantityUnit ? ` ${line.quantityUnit}` : ''}
                    </div>
                    {line.predictedLineNetAmount !== null ? (
                      <div className="text-xs text-muted-foreground">
                        {formatMoney(line.predictedLineNetAmount, row.currencyCode, locale)}
                      </div>
                    ) : null}
                  </td>
                  <td className="p-3">
                    <StatusBadge variant={CONFIDENCE_VARIANTS[line.confidenceBand]} dot>
                      {Math.round(line.confidence * 100)}%
                    </StatusBadge>
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    <div>
                      {counted.orders(line.occurrences)} ·{' '}
                      {t('distributor_workspace.orderForecast.evidence.every', 'every')} ~
                      {counted.days(line.cadenceDays)}
                    </div>
                    {line.history.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                        <span>{t('distributor_workspace.orderForecast.history.label', 'Bought on')}:</span>
                        {line.history.map((entry) => {
                          const label = `${formatDate(entry.orderedAt, locale)} (${entry.quantity})`
                          const orderId = entry.orderIds[0]
                          return orderId ? (
                            <Link
                              key={`${entry.orderedAt}:${orderId}`}
                              href={`/backend/sales/documents/${orderId}`}
                              className="text-primary hover:underline"
                            >
                              {label}
                            </Link>
                          ) : (
                            <span key={entry.orderedAt}>{label}</span>
                          )
                        })}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}

export default function PredictedOrdersPage() {
  const t = useT()
  const locale = useLocale()
  const [horizonDays, setHorizonDays] = React.useState<number>(7)

  const { data, isLoading, error } = useQuery({
    queryKey: ['distributor-upcoming-forecast', horizonDays],
    queryFn: () => loadUpcoming(horizonDays),
    staleTime: 60_000,
  })

  const counted = useCountFormatters(t, locale)

  const weekdayLabels = React.useMemo(
    () => [
      '',
      t('distributor_workspace.orderForecast.weekday.1', 'Monday'),
      t('distributor_workspace.orderForecast.weekday.2', 'Tuesday'),
      t('distributor_workspace.orderForecast.weekday.3', 'Wednesday'),
      t('distributor_workspace.orderForecast.weekday.4', 'Thursday'),
      t('distributor_workspace.orderForecast.weekday.5', 'Friday'),
      t('distributor_workspace.orderForecast.weekday.6', 'Saturday'),
      t('distributor_workspace.orderForecast.weekday.7', 'Sunday'),
    ],
    [t],
  )

  const { upcoming, overdue } = React.useMemo(() => {
    const rows = data?.rows ?? []
    return {
      upcoming: rows.filter((row) => row.overdueDays === 0),
      overdue: rows.filter((row) => row.overdueDays > 0),
    }
  }, [data])

  const sections = [
    {
      key: 'upcoming',
      rows: upcoming,
      title: t('distributor_workspace.orderForecast.page.upcomingSection', 'Coming up'),
      hint: t(
        'distributor_workspace.orderForecast.page.upcomingHint',
        'Deliveries falling due inside the selected window, soonest first.',
      ),
    },
    {
      key: 'overdue',
      rows: overdue,
      title: t('distributor_workspace.orderForecast.page.overdueSection', 'Missed — worth a call'),
      hint: t(
        'distributor_workspace.orderForecast.page.overdueHint',
        'The delivery these rhythms pointed at never arrived. A rhythm silent for longer than one missed cycle is dropped entirely rather than shown here.',
      ),
    },
  ].filter((section) => section.rows.length > 0)

  return (
    <Page>
      <PageHeader
        title={t('distributor_workspace.orderForecast.page.title', 'Predicted orders')}
        description={t(
          'distributor_workspace.orderForecast.page.description',
          'The deliveries your customers are about to place, read from their own purchase history.',
        )}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {HORIZON_OPTIONS.map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant={option === horizonDays ? 'default' : 'outline'}
                onClick={() => setHorizonDays(option)}
              >
                {counted.days(option)}
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!data || data.rows.length === 0}
              onClick={() => {
                window.open(
                  `/api/distributor_workspace/order-forecast/upcoming?horizonDays=${horizonDays}&format=csv`,
                  '_blank',
                  'noopener',
                )
              }}
            >
              {t('distributor_workspace.orderForecast.action.export', 'Export CSV')}
            </Button>
          </div>
        }
      />
      <PageBody>
        {isLoading ? (
          <LoadingMessage
            label={t('distributor_workspace.orderForecast.loading', 'Reading the order history…')}
          />
        ) : null}

        {error ? (
          <ErrorMessage
            label={t('distributor_workspace.orderForecast.errors.loadFailed', 'The forecast could not be built.')}
          />
        ) : null}

        {data ? (
          <>
            <div className="grid gap-3 rounded-lg border border-border bg-card p-4 shadow-sm sm:grid-cols-4">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  {t('distributor_workspace.orderForecast.page.deliveries', 'Expected deliveries')}
                </div>
                <div className="text-lg font-semibold text-foreground">{upcoming.length}</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  {t('distributor_workspace.orderForecast.page.overdue', 'Missed')}
                </div>
                <div
                  className={
                    overdue.length > 0
                      ? 'text-lg font-semibold text-status-warning-text'
                      : 'text-lg font-semibold text-foreground'
                  }
                >
                  {overdue.length}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  {t('distributor_workspace.orderForecast.page.customers', 'Customers')}
                </div>
                <div className="text-lg font-semibold text-foreground">
                  {data.customersWithPredictions} / {data.customersAnalysed}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  {t('distributor_workspace.orderForecast.page.value', 'Expected value net')}
                </div>
                <div className="text-lg font-semibold text-foreground">
                  {formatMoney(data.totalValueNet, data.currencyCode, locale) ??
                    t('distributor_workspace.orderForecast.empty', '—')}
                </div>
              </div>
            </div>

            {sections.length === 0 ? (
              <TabEmptyState
                title={t('distributor_workspace.orderForecast.page.emptyTitle', 'Nothing expected in this window')}
                description={t(
                  'distributor_workspace.orderForecast.page.emptyDescription',
                  'No customer has a repeating delivery falling due here. Widen the window, or check back once more orders have been recorded.',
                )}
              />
            ) : (
              <div className="space-y-6">
                {sections.map((section) => (
                  <div key={section.key} className="space-y-2">
                    <div>
                      <h2 className="text-sm font-semibold text-foreground">
                        {section.title} ({section.rows.length})
                      </h2>
                      <p className="text-xs text-muted-foreground">{section.hint}</p>
                    </div>
                    <div className="space-y-4">
                      {groupByCustomer(section.rows).map((group) => (
                        <div key={group.customerEntityId} className="space-y-2">
                          {group.rows.length > 1 ? (
                            <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
                              <Link
                                href={`/backend/customers/companies-v2/${group.customerEntityId}?tab=distributor_workspace.injection.customer-order-forecast`}
                                className="font-medium text-foreground hover:underline"
                              >
                                {group.customerName ??
                                  t('distributor_workspace.orderForecast.page.unnamedCustomer', 'Unnamed customer')}
                              </Link>
                              <span>
                                {t('distributor_workspace.orderForecast.page.deliveriesForCustomer', 'deliveries')}:{' '}
                                {group.rows.length}
                              </span>
                            </div>
                          ) : null}
                          {group.rows.map((row) => (
                            <BasketCard
                              key={`${row.customerEntityId}:${row.expectedAt}`}
                              row={row}
                              locale={locale}
                              weekdayLabels={weekdayLabels}
                              t={t}
                              counted={counted}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
      </PageBody>
    </Page>
  )
}
