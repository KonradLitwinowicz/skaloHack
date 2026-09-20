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
import { buildDeskHref } from '@open-mercato/pricing-engine/modules/pricing_engine/lib/frontend/basketDesk'
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

/**
 * How many customers (deliveries view) or products (products view) are rendered before the
 * operator asks for more.
 *
 * The endpoint hands over the whole window — up to 500 baskets, each of which expands into its
 * own lines — and mounting all of them costs a second of scripting on a screen whose first answer
 * sits in the first few rows. The counts in the section headings stay counted over everything, so
 * what is hidden is the markup, never the number.
 */
const REVEAL_STEP = 25

function useRevealLimit(resetKey: string): { limit: number; revealMore: () => void } {
  const [limit, setLimit] = React.useState(REVEAL_STEP)
  React.useEffect(() => {
    setLimit(REVEAL_STEP)
  }, [resetKey])
  const revealMore = React.useCallback(() => setLimit((current) => current + REVEAL_STEP), [])
  return { limit, revealMore }
}

function RevealMore({
  hidden,
  onReveal,
  t,
}: {
  hidden: number
  onReveal: () => void
  t: Translate
}) {
  if (hidden <= 0) return null
  return (
    <Button type="button" variant="outline" size="sm" onClick={onReveal}>
      {t('distributor_workspace.orderForecast.page.showMore', 'Show more')} ({hidden})
    </Button>
  )
}

const CONFIDENCE_VARIANTS: Record<ConfidenceBand, StatusBadgeVariant> = {
  high: 'success',
  medium: 'warning',
  low: 'neutral',
}

type BasketLine = {
  productKey: string
  productId: string | null
  productName: string
  sku: string | null
  predictedQuantity: number
  quantityUnit: string | null
  predictedLineNetAmount: number | null
  confidence: number
  confidenceBand: ConfidenceBand
  acknowledged: boolean
  cadenceDays: number
  dominantWeekday: number | null
  weekdayHits: number
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

/**
 * Two ways to read the same forecast, and two different jobs.
 *
 * `deliveries` is the plan: who is getting what, and when. `products` is the buy and the pick —
 * one row per item, summed across every customer in the window, because nobody orders stock
 * customer by customer.
 */
type ViewMode = 'deliveries' | 'products'

/**
 * `confidence` leads by default: the list is read top-down and abandoned part-way, so the rows
 * worth acting on must be the ones reached first. `soonest` restores the calendar for whoever is
 * loading a van rather than deciding what to trust.
 */
type SortMode = 'confidence' | 'soonest'

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
      customers: (count: number) => formatCounted(count, locale, forms('customer')),
      deliveries: (count: number) => formatCounted(count, locale, forms('delivery')),
    }
  }, [locale, t])
}

function formatDate(value: string, locale: string): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(locale || undefined, { timeZone: 'UTC' })
}

/**
 * A past purchase is dated AND named by its weekday.
 *
 * The rhythm an operator is being asked to trust is a weekday habit as much as an interval, and
 * "12.05" does not say whether the customer ordered on their usual Tuesday or broke the pattern.
 * The weekday comes from `Intl` in the operator's locale rather than from a translation table,
 * because it must agree with the date rendered beside it in any calendar the browser uses.
 */
function formatHistoryDate(value: string, locale: string): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return value
  const weekday = new Intl.DateTimeFormat(locale || undefined, {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(date)
  return `${weekday} ${date.toLocaleDateString(locale || undefined, { timeZone: 'UTC' })}`
}

/**
 * Short weekday names for the filter chips, in the operator's own locale.
 *
 * Built from a known week (2024-01-01 was a Monday) rather than from the locale files: the chips sit
 * beside dates rendered by `Intl`, and a hand-translated abbreviation would eventually disagree with
 * one of them.
 */
function buildWeekdayShortLabels(locale: string): string[] {
  const formatter = new Intl.DateTimeFormat(locale || undefined, { weekday: 'short', timeZone: 'UTC' })
  return ['', ...Array.from({ length: 7 }, (_, index) => formatter.format(new Date(Date.UTC(2024, 0, index + 1))))]
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

/**
 * Orders the list the way the operator asked to read it.
 *
 * The API returns the calendar order, which is the right default for a van but the wrong one for
 * a screen nobody scrolls to the bottom of. Whichever key leads, the other breaks the ties, so two
 * rows that agree on confidence still come out in date order.
 */
function sortBaskets(rows: BasketRow[], mode: SortMode): BasketRow[] {
  return [...rows].sort((a, b) => {
    if (mode === 'confidence') {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return a.daysUntilExpected - b.daysUntilExpected
    }
    if (a.daysUntilExpected !== b.daysUntilExpected) return a.daysUntilExpected - b.daysUntilExpected
    return b.confidence - a.confidence
  })
}

type ProductDemand = {
  customerEntityId: string
  customerName: string | null
  expectedAt: string
  weekday: number
  overdueDays: number
  quantity: number
  confidence: number
  confidenceBand: ConfidenceBand
}

type ProductRow = {
  productKey: string
  productName: string
  sku: string | null
  quantity: number
  quantityUnit: string | null
  totalNetAmount: number | null
  confidence: number
  confidenceBand: ConfidenceBand
  customerCount: number
  overdueCount: number
  earliestExpectedAt: string
  demands: ProductDemand[]
}

/**
 * The same predictions read down the other axis: one row per product, across every customer.
 *
 * A buyer ordering stock and a picker filling a pallet do not work customer by customer. Their
 * question is how much of one item the window owes in total, and the delivery list answers it only
 * by making them add the baskets up themselves. Nothing new is predicted here — the lines are the
 * ones already on screen, regrouped.
 *
 * Confidence is not averaged into a band: the thresholds that turn a number into high/medium/low
 * belong to the engine, and re-deriving them here would let the two views disagree. So the
 * percentage is the quantity-weighted mean, and the badge takes the band that already holds most
 * of the predicted quantity.
 */
function buildProductRows(rows: BasketRow[]): ProductRow[] {
  type Accumulator = {
    productKey: string
    productName: string
    sku: string | null
    quantity: number
    quantityUnit: string | null
    netAmount: number
    hasNetAmount: boolean
    weightedConfidence: number
    quantityByBand: Map<ConfidenceBand, number>
    customers: Set<string>
    overdueCount: number
    earliestExpectedAt: string
    demands: ProductDemand[]
  }

  const accumulators = new Map<string, Accumulator>()
  for (const row of rows) {
    for (const line of row.lines) {
      const accumulator = accumulators.get(line.productKey) ?? {
        productKey: line.productKey,
        productName: line.productName,
        sku: line.sku,
        quantity: 0,
        quantityUnit: line.quantityUnit,
        netAmount: 0,
        hasNetAmount: false,
        weightedConfidence: 0,
        quantityByBand: new Map<ConfidenceBand, number>(),
        customers: new Set<string>(),
        overdueCount: 0,
        earliestExpectedAt: row.expectedAt,
        demands: [],
      }
      accumulator.quantity += line.predictedQuantity
      accumulator.quantityUnit = accumulator.quantityUnit ?? line.quantityUnit
      if (line.predictedLineNetAmount !== null) {
        accumulator.netAmount += line.predictedLineNetAmount
        accumulator.hasNetAmount = true
      }
      accumulator.weightedConfidence += line.confidence * line.predictedQuantity
      accumulator.quantityByBand.set(
        line.confidenceBand,
        (accumulator.quantityByBand.get(line.confidenceBand) ?? 0) + line.predictedQuantity,
      )
      accumulator.customers.add(row.customerEntityId)
      if (row.overdueDays > 0) accumulator.overdueCount += 1
      if (row.expectedAt < accumulator.earliestExpectedAt) accumulator.earliestExpectedAt = row.expectedAt
      accumulator.demands.push({
        customerEntityId: row.customerEntityId,
        customerName: row.customerName,
        expectedAt: row.expectedAt,
        weekday: row.weekday,
        overdueDays: row.overdueDays,
        quantity: line.predictedQuantity,
        confidence: line.confidence,
        confidenceBand: line.confidenceBand,
      })
      accumulators.set(line.productKey, accumulator)
    }
  }

  return [...accumulators.values()].map((accumulator) => {
    const dominantBand = [...accumulator.quantityByBand.entries()].sort((a, b) => b[1] - a[1])[0]
    return {
      productKey: accumulator.productKey,
      productName: accumulator.productName,
      sku: accumulator.sku,
      quantity: accumulator.quantity,
      quantityUnit: accumulator.quantityUnit,
      totalNetAmount: accumulator.hasNetAmount ? accumulator.netAmount : null,
      confidence: accumulator.quantity > 0 ? accumulator.weightedConfidence / accumulator.quantity : 0,
      confidenceBand: dominantBand?.[0] ?? 'low',
      customerCount: accumulator.customers.size,
      overdueCount: accumulator.overdueCount,
      earliestExpectedAt: accumulator.earliestExpectedAt,
      demands: accumulator.demands.sort((a, b) => a.expectedAt.localeCompare(b.expectedAt)),
    }
  })
}

function sortProducts(rows: ProductRow[], mode: SortMode): ProductRow[] {
  return [...rows].sort((a, b) => {
    if (mode === 'confidence') {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return a.earliestExpectedAt.localeCompare(b.earliestExpectedAt)
    }
    const byDate = a.earliestExpectedAt.localeCompare(b.earliestExpectedAt)
    if (byDate !== 0) return byDate
    return b.confidence - a.confidence
  })
}

async function loadUpcoming(horizonDays: number): Promise<UpcomingResponse> {
  // The API truncates by its own calendar order, so a client-side sort on a short slice would
  // rank the wrong rows. Ask for the whole window the endpoint will give.
  const call = await apiCall<UpcomingResponse>(
    `/api/distributor_workspace/order-forecast/upcoming?horizonDays=${horizonDays}&limit=500`,
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
  weekdayInLabels,
  t,
  counted,
}: {
  row: BasketRow
  locale: string
  weekdayLabels: string[]
  weekdayInLabels: string[]
  t: Translate
  counted: ReturnType<typeof useCountFormatters>
}) {
  const [open, setOpen] = React.useState(false)
  const money = formatMoney(row.totalNetAmount, row.currencyCode, locale)
  const basketKey = `${row.customerEntityId}:${row.expectedAt}`
  // The desk opens with this delivery as its basket: the same lines, the same customer, priced
  // live and one click from a quote.
  const deskLines = row.lines.flatMap((line) =>
    line.productId ? [{ productId: line.productId, quantity: String(line.predictedQuantity) }] : [],
  )
  const deskHref = deskLines.length > 0 ? buildDeskHref({ customerId: row.customerEntityId, lines: deskLines }) : null

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
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge variant={CONFIDENCE_VARIANTS[row.confidenceBand]} dot>
            {Math.round(row.confidence * 100)}%
          </StatusBadge>
          {deskHref ? (
            <Button asChild size="sm" variant="outline">
              <Link href={deskHref}>{t('distributor_workspace.orderForecast.action.openDesk', 'Price it on the desk')}</Link>
            </Button>
          ) : null}
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
                      {line.dominantWeekday !== null
                        ? ` · ${t('distributor_workspace.orderForecast.evidence.mostlyOn', 'mostly on')} ${
                            weekdayInLabels[line.dominantWeekday] ?? ''
                          } (${line.weekdayHits}/${line.occurrences})`
                        : ''}
                    </div>
                    {line.history.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                        <span>{t('distributor_workspace.orderForecast.history.label', 'Bought on')}:</span>
                        {line.history.map((entry) => {
                          const label = `${formatHistoryDate(entry.orderedAt, locale)} (${entry.quantity})`
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

/**
 * One product, every customer who is about to want it.
 *
 * The totals are the line an operator acts on; the expansion is the proof behind it, because a
 * quantity nobody can trace back to a named customer and a date is a number, not an instruction.
 */
function ProductCard({
  row,
  locale,
  weekdayLabels,
  currencyCode,
  t,
  counted,
}: {
  row: ProductRow
  locale: string
  weekdayLabels: string[]
  currencyCode: string | null
  t: Translate
  counted: ReturnType<typeof useCountFormatters>
}) {
  const [open, setOpen] = React.useState(false)
  const money = formatMoney(row.totalNetAmount, currencyCode, locale)

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0 space-y-1">
          <div className="font-medium text-foreground">{row.productName}</div>
          {row.sku ? <div className="text-xs text-muted-foreground">{row.sku}</div> : null}
          <div className="text-sm text-foreground">
            <span className="font-semibold">
              {Math.round(row.quantity * 100) / 100}
              {row.quantityUnit ? ` ${row.quantityUnit}` : ''}
            </span>
            {' · '}
            {counted.customers(row.customerCount)}
            {' · '}
            {counted.deliveries(row.demands.length)}
            {money ? ` · ${money}` : ''}
          </div>
          <div
            className={
              row.overdueCount > 0
                ? 'text-xs font-medium text-status-warning-text'
                : 'text-xs text-muted-foreground'
            }
          >
            {t('distributor_workspace.orderForecast.products.earliest', 'Earliest delivery')}:{' '}
            {formatDate(row.earliestExpectedAt, locale)}
            {row.overdueCount > 0
              ? ` · ${t('distributor_workspace.orderForecast.products.overdue', 'overdue')}: ${row.overdueCount}`
              : ''}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge variant={CONFIDENCE_VARIANTS[row.confidenceBand]} dot>
            {Math.round(row.confidence * 100)}%
          </StatusBadge>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={open}
            aria-controls={`product-${row.productKey}`}
            onClick={() => setOpen((previous) => !previous)}
          >
            {open
              ? t('distributor_workspace.orderForecast.products.hide', 'Hide customers')
              : t('distributor_workspace.orderForecast.products.show', 'Show customers')}
          </Button>
        </div>
      </div>

      {open ? (
        <div id={`product-${row.productKey}`} className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3 text-left font-medium">
                  {t('distributor_workspace.orderForecast.products.column.customer', 'Customer')}
                </th>
                <th className="p-3 text-left font-medium">
                  {t('distributor_workspace.orderForecast.products.column.delivery', 'Delivery')}
                </th>
                <th className="p-3 text-right font-medium">
                  {t('distributor_workspace.orderForecast.column.quantity', 'Expected quantity')}
                </th>
                <th className="p-3 text-left font-medium">
                  {t('distributor_workspace.orderForecast.column.confidence', 'Confidence')}
                </th>
              </tr>
            </thead>
            <tbody>
              {row.demands.map((demand) => (
                <tr
                  key={`${demand.customerEntityId}:${demand.expectedAt}`}
                  className="border-t border-border align-top"
                >
                  <td className="p-3">
                    <Link
                      href={`/backend/customers/companies-v2/${demand.customerEntityId}?tab=distributor_workspace.injection.customer-order-forecast`}
                      className="text-primary hover:underline"
                    >
                      {demand.customerName ??
                        t('distributor_workspace.orderForecast.page.unnamedCustomer', 'Unnamed customer')}
                    </Link>
                  </td>
                  <td className="p-3">
                    <div>
                      {weekdayLabels[demand.weekday] ?? ''} {formatDate(demand.expectedAt, locale)}
                    </div>
                    {demand.overdueDays > 0 ? (
                      <div className="text-xs font-medium text-status-warning-text">
                        {t('distributor_workspace.orderForecast.overdueBy', 'Overdue by')}{' '}
                        {counted.days(demand.overdueDays)}
                      </div>
                    ) : null}
                  </td>
                  <td className="p-3 text-right font-semibold text-foreground">
                    {demand.quantity}
                    {row.quantityUnit ? ` ${row.quantityUnit}` : ''}
                  </td>
                  <td className="p-3">
                    <StatusBadge variant={CONFIDENCE_VARIANTS[demand.confidenceBand]} dot>
                      {Math.round(demand.confidence * 100)}%
                    </StatusBadge>
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

/**
 * One titled block of the deliveries view. It owns its own reveal limit so "Coming up" and
 * "Missed" grow independently — expanding the overdue list must not also mount 25 more baskets
 * of a list the operator is not looking at.
 */
function BasketSection({
  rows,
  title,
  hint,
  resetKey,
  locale,
  weekdayLabels,
  weekdayInLabels,
  t,
  counted,
}: {
  rows: BasketRow[]
  title: string
  hint: string
  resetKey: string
  locale: string
  weekdayLabels: string[]
  weekdayInLabels: string[]
  t: Translate
  counted: ReturnType<typeof useCountFormatters>
}) {
  const { limit, revealMore } = useRevealLimit(resetKey)
  const groups = React.useMemo(() => groupByCustomer(rows), [rows])
  const visibleGroups = groups.slice(0, limit)

  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          {title} ({rows.length})
        </h2>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="space-y-4">
        {visibleGroups.map((group) => (
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
                weekdayInLabels={weekdayInLabels}
                t={t}
                counted={counted}
              />
            ))}
          </div>
        ))}
      </div>
      <RevealMore hidden={groups.length - visibleGroups.length} onReveal={revealMore} t={t} />
    </div>
  )
}

export default function PredictedOrdersPage() {
  const t = useT()
  const locale = useLocale()
  const [horizonDays, setHorizonDays] = React.useState<number>(7)
  /** Empty means every weekday; a van planner narrows it to the days they are actually loading. */
  const [weekdayFilter, setWeekdayFilter] = React.useState<number[]>([])
  const [view, setView] = React.useState<ViewMode>('deliveries')
  const [sortMode, setSortMode] = React.useState<SortMode>('confidence')

  const { data, isLoading, error } = useQuery({
    queryKey: ['distributor-upcoming-forecast', horizonDays],
    queryFn: () => loadUpcoming(horizonDays),
    staleTime: 60_000,
  })

  const counted = useCountFormatters(t, locale)

  // Every control that reorders or renarrows the list restarts the reveal: after switching to
  // "Soonest" the first rows are different rows, and keeping a deep reveal would hide them under
  // everything already mounted.
  const revealResetKey = `${horizonDays}:${sortMode}:${view}:${weekdayFilter.join(',')}`
  const { limit: productLimit, revealMore: revealMoreProducts } = useRevealLimit(revealResetKey)

  const weekdayShortLabels = React.useMemo(() => buildWeekdayShortLabels(locale), [locale])

  const toggleWeekday = React.useCallback((weekday: number) => {
    setWeekdayFilter((previous) =>
      previous.includes(weekday)
        ? previous.filter((entry) => entry !== weekday)
        : [...previous, weekday].sort((a, b) => a - b),
    )
  }, [])

  const weekdayInLabels = React.useMemo(
    () => [
      '',
      t('distributor_workspace.orderForecast.weekdayIn.1', 'Monday'),
      t('distributor_workspace.orderForecast.weekdayIn.2', 'Tuesday'),
      t('distributor_workspace.orderForecast.weekdayIn.3', 'Wednesday'),
      t('distributor_workspace.orderForecast.weekdayIn.4', 'Thursday'),
      t('distributor_workspace.orderForecast.weekdayIn.5', 'Friday'),
      t('distributor_workspace.orderForecast.weekdayIn.6', 'Saturday'),
      t('distributor_workspace.orderForecast.weekdayIn.7', 'Sunday'),
    ],
    [t],
  )

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

  /**
   * Counted over ALL rows, not the visible ones, so a chip keeps saying how much work that weekday
   * holds while it is switched off — otherwise turning Tuesday on would be the only way to find out
   * whether Tuesday is worth turning on.
   */
  const weekdayCounts = React.useMemo(() => {
    const counts = new Map<number, number>()
    for (const row of data?.rows ?? []) counts.set(row.weekday, (counts.get(row.weekday) ?? 0) + 1)
    return counts
  }, [data])

  const { upcoming, overdue, products, visibleValueNet, visibleCustomers, visibleCurrency } =
    React.useMemo(() => {
      const rows = data?.rows ?? []
      const visible =
        weekdayFilter.length === 0 ? rows : rows.filter((row) => weekdayFilter.includes(row.weekday))
      // The same rule the API applies to its own total: a sum across two currencies is money in
      // neither of them.
      const currencies = new Set(visible.map((row) => row.currencyCode ?? ''))
      const singleCurrency = currencies.size === 1
      const sorted = sortBaskets(visible, sortMode)
      return {
        upcoming: sorted.filter((row) => row.overdueDays === 0),
        overdue: sorted.filter((row) => row.overdueDays > 0),
        // Both halves feed the product view: a buyer needs the missed delivery in the same total
        // as the coming one, since the stock it was going to consume is still sitting there.
        products: sortProducts(buildProductRows(sorted), sortMode),
        visibleValueNet: singleCurrency
          ? visible.reduce((total, row) => total + (row.totalNetAmount ?? 0), 0)
          : null,
        visibleCustomers: new Set(visible.map((row) => row.customerEntityId)).size,
        visibleCurrency: singleCurrency ? (visible[0]?.currencyCode ?? null) : null,
      }
    }, [data, sortMode, weekdayFilter])

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
                const weekdays = weekdayFilter.length > 0 ? `&weekdays=${weekdayFilter.join(',')}` : ''
                window.open(
                  `/api/distributor_workspace/order-forecast/upcoming?horizonDays=${horizonDays}${weekdays}&format=csv`,
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
                  {visibleCustomers} / {data.customersAnalysed}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  {t('distributor_workspace.orderForecast.page.value', 'Expected value net')}
                </div>
                <div className="text-lg font-semibold text-foreground">
                  {formatMoney(visibleValueNet, data.currencyCode, locale) ??
                    t('distributor_workspace.orderForecast.empty', '—')}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                {(['deliveries', 'products'] as const).map((option) => (
                  <Button
                    key={option}
                    type="button"
                    size="sm"
                    variant={view === option ? 'default' : 'outline'}
                    aria-pressed={view === option}
                    onClick={() => setView(option)}
                  >
                    {option === 'deliveries'
                      ? t('distributor_workspace.orderForecast.view.deliveries', 'Deliveries')
                      : t('distributor_workspace.orderForecast.view.products', 'Products')}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {t('distributor_workspace.orderForecast.sort.label', 'Order')}:
                </span>
                {(['confidence', 'soonest'] as const).map((option) => (
                  <Button
                    key={option}
                    type="button"
                    size="sm"
                    variant={sortMode === option ? 'default' : 'outline'}
                    aria-pressed={sortMode === option}
                    onClick={() => setSortMode(option)}
                  >
                    {option === 'confidence'
                      ? t('distributor_workspace.orderForecast.sort.confidence', 'Most certain')
                      : t('distributor_workspace.orderForecast.sort.soonest', 'Soonest')}
                  </Button>
                ))}
              </div>
            </div>

            {weekdayCounts.size > 1 ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 shadow-sm">
                <span className="text-xs text-muted-foreground">
                  {t('distributor_workspace.orderForecast.page.weekdayFilter', 'Delivery weekday')}:
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant={weekdayFilter.length === 0 ? 'default' : 'outline'}
                  onClick={() => setWeekdayFilter([])}
                >
                  {t('distributor_workspace.orderForecast.page.weekdayFilterAll', 'All')}
                </Button>
                {[...weekdayCounts.keys()]
                  .sort((a, b) => a - b)
                  .map((weekday) => (
                    <Button
                      key={weekday}
                      type="button"
                      size="sm"
                      variant={weekdayFilter.includes(weekday) ? 'default' : 'outline'}
                      aria-pressed={weekdayFilter.includes(weekday)}
                      title={weekdayLabels[weekday] ?? ''}
                      onClick={() => toggleWeekday(weekday)}
                    >
                      {weekdayShortLabels[weekday] ?? ''} {weekdayCounts.get(weekday) ?? 0}
                    </Button>
                  ))}
              </div>
            ) : null}

            {view === 'products' ? (
              products.length === 0 ? (
                <TabEmptyState
                  title={t(
                    'distributor_workspace.orderForecast.products.emptyTitle',
                    'No product is owed here',
                  )}
                  description={t(
                    'distributor_workspace.orderForecast.products.emptyDescription',
                    'Nothing repeating falls due in this window. Widen it, or clear the weekday filter.',
                  )}
                />
              ) : (
                <div className="space-y-2">
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">
                      {t('distributor_workspace.orderForecast.products.title', 'Product demand')} (
                      {products.length})
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'distributor_workspace.orderForecast.products.hint',
                        'The same predictions summed per product — how much of one item every customer in this window owes, missed deliveries included.',
                      )}
                    </p>
                  </div>
                  <div className="space-y-4">
                    {products.slice(0, productLimit).map((row) => (
                      <ProductCard
                        key={row.productKey}
                        row={row}
                        locale={locale}
                        weekdayLabels={weekdayLabels}
                        currencyCode={visibleCurrency}
                        t={t}
                        counted={counted}
                      />
                    ))}
                  </div>
                  <RevealMore
                    hidden={products.length - Math.min(products.length, productLimit)}
                    onReveal={revealMoreProducts}
                    t={t}
                  />
                </div>
              )
            ) : sections.length === 0 ? (
              <TabEmptyState
                title={t('distributor_workspace.orderForecast.page.emptyTitle', 'Nothing expected in this window')}
                description={
                  weekdayFilter.length > 0
                    ? t(
                        'distributor_workspace.orderForecast.page.weekdayFilterEmpty',
                        'No delivery in this window falls on the selected weekdays.',
                      )
                    : t(
                        'distributor_workspace.orderForecast.page.emptyDescription',
                        'No customer has a repeating delivery falling due here. Widen the window, or check back once more orders have been recorded.',
                      )
                }
              />
            ) : (
              <div className="space-y-6">
                {sections.map((section) => (
                  <BasketSection
                    key={section.key}
                    rows={section.rows}
                    title={section.title}
                    hint={section.hint}
                    resetKey={revealResetKey}
                    locale={locale}
                    weekdayLabels={weekdayLabels}
                    weekdayInLabels={weekdayInLabels}
                    t={t}
                    counted={counted}
                  />
                ))}
              </div>
            )}
          </>
        ) : null}
      </PageBody>
    </Page>
  )
}
