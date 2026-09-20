"use client"

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { ErrorMessage, LoadingMessage, TabEmptyState } from '@open-mercato/ui/backend/detail'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { buildDeskHref } from '@open-mercato/pricing-engine/modules/pricing_engine/lib/frontend/basketDesk'
import { formatCounted } from '../../../lib/pluralize'
import type {
  ConfidenceBand,
  PredictionFeedbackKind,
  PredictionRejectionReason,
} from '../../../lib/orderForecast'

type PredictionNote = {
  productId: string | null
  productVariantId: string | null
  productName: string | null
  kind: PredictionFeedbackKind
  validUntil: string | null
}

const logger = createLogger('distributor_workspace').child({ component: 'customer-order-forecast' })

const SAVE_CONTEXT_ID = 'distributor_workspace.customer-order-forecast'

type ForecastPrediction = {
  productKey: string
  productId: string | null
  productVariantId: string | null
  productName: string
  sku: string | null
  predictedQuantity: number
  quantityMin: number
  quantityMax: number
  quantityUnit: string | null
  predictedUnitNetAmount: number | null
  predictedLineNetAmount: number | null
  currencyCode: string | null
  nextExpectedAt: string
  daysUntilNextExpected: number
  overdueDays: number
  cadence: {
    kind: 'weekly' | 'interval'
    intervalDays: number
    dominantWeekday: number | null
    weekdayShare: number
    weekdayHits: number
  }
  confidence: number
  confidenceBand: ConfidenceBand
  acknowledged: boolean
  history: Array<{ orderedAt: string; quantity: number; orderIds: string[] }>
  evidence: {
    occurrences: number
    lastOrderedAt: string
    medianIntervalDays: number
    coverage: number
  }
}

type PredictedBasket = {
  expectedAt: string
  weekday: number
  daysUntilExpected: number
  overdueDays: number
  lineCount: number
  totalQuantity: number
  totalNetAmount: number | null
  currencyCode: string | null
  confidence: number
  confidenceBand: ConfidenceBand
  acknowledgedLines: number
  onRhythm: boolean
  lines: ForecastPrediction[]
}

type ForecastResponse = {
  generatedAt: string
  customerId: string
  rhythm: {
    orderCount: number
    lastOrderAt: string | null
    daysSinceLastOrder: number | null
    medianIntervalDays: number | null
    dominantWeekday: number | null
    weekdayShare: number
    nextExpectedOrderAt: string | null
    daysUntilNextOrder: number | null
    orderOverdueDays: number
    typicalOrderNetAmount: number | null
    currencyCode: string | null
    confidence: number
  }
  accuracy: {
    trials: number
    hits: number
    hitRate: number | null
    toleranceDays: number
  }
  predictions: ForecastPrediction[]
  baskets: PredictedBasket[]
  notes: PredictionNote[]
  rejected: Array<{ reason: PredictionRejectionReason; count: number; examples: string[] }>
  history: {
    orderCount: number
    lineCount: number
    firstOrderAt: string | null
    lastOrderAt: string | null
  }
  thresholds: {
    minOccurrences: number
    minSpanDays: number
    minConfidence: number
    lookbackDays: number
    maxOverdueDays: number
  }
}

const CONFIDENCE_VARIANTS: Record<ConfidenceBand, StatusBadgeVariant> = {
  high: 'success',
  medium: 'warning',
  low: 'neutral',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readNestedCompanyId(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.company)) return null
  return readId(value.company.id)
}

function resolveCustomerId(context: unknown, data: unknown): string | null {
  if (!isRecord(context)) return readNestedCompanyId(data)
  return (
    readId(context.companyId) ??
    readId(context.resourceId) ??
    readId(context.entityId) ??
    readId(context.recordId) ??
    readNestedCompanyId(context.data) ??
    readNestedCompanyId(data)
  )
}

function formatDate(value: string | null, locale: string, emptyLabel: string): string {
  if (!value) return emptyLabel
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? emptyLabel
    : date.toLocaleDateString(locale || undefined, { timeZone: 'UTC' })
}

/**
 * A past purchase is dated AND named by its weekday.
 *
 * The rhythm the operator is being asked to trust is a weekday habit as much as an interval, and a
 * bare "12.05" does not say whether the customer kept their Tuesday or broke it. The weekday comes
 * from `Intl` rather than from a translation table so that it always agrees with the date rendered
 * beside it.
 */
function formatHistoryDate(value: string, locale: string, emptyLabel: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return emptyLabel
  const weekday = new Intl.DateTimeFormat(locale || undefined, {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(date)
  return `${weekday} ${date.toLocaleDateString(locale || undefined, { timeZone: 'UTC' })}`
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

async function loadForecast(customerId: string): Promise<ForecastResponse | null> {
  const call = await apiCall<ForecastResponse>(
    `/api/distributor_workspace/customers/${encodeURIComponent(customerId)}/order-forecast`,
    { headers: { 'x-om-forbidden-redirect': '0', 'x-om-unauthorized-redirect': '0' } },
  )
  if (!call.ok || !call.result) {
    throw new Error(`[internal] Order forecast request failed with status ${call.status}`)
  }
  return call.result
}

type BasketPricing = {
  currencyCode: string | null
  together: { totalNet: number; totalCostNet: number; marginPercent: number | null } | null
  separate: { totalNet: number; totalCostNet: number; marginPercent: number | null } | null
  savingAmount: number | null
  savingPercent: number | null
  lineCount: number
  warnings: string[]
  unavailableReason: string | null
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

/**
 * One expected delivery, with the basket it would carry.
 *
 * The basket is the actionable object — "create this order" takes it whole, the way the customer
 * would have sent it — and the lines inside are the evidence and the place where the operator's
 * corrections belong: this product is no longer bought, this one I already confirmed by phone.
 */
function CustomerBasketCard({
  basket,
  customerId,
  locale,
  weekdayLabels,
  weekdayInLabels,
  emptyLabel,
  isCreating,
  t,
  counted,
  onCreateOrder,
  onConfirm,
  onDismiss,
  onClearNote,
}: {
  basket: PredictedBasket
  customerId: string
  locale: string
  weekdayLabels: string[]
  weekdayInLabels: string[]
  emptyLabel: string
  isCreating: boolean
  t: Translate
  counted: ReturnType<typeof useCountFormatters>
  onCreateOrder: (lines: ForecastPrediction[]) => void
  onConfirm: (line: ForecastPrediction) => void
  onDismiss: (line: ForecastPrediction) => void
  onClearNote: (line: { productId: string | null; productVariantId: string | null }) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [pricing, setPricing] = React.useState<BasketPricing | null>(null)
  const [pricingPending, setPricingPending] = React.useState(false)
  const money = formatMoney(basket.totalNetAmount, basket.currencyCode, locale)
  const deskLines = basket.lines.flatMap((line) =>
    line.productId ? [{ productId: line.productId, quantity: String(line.predictedQuantity) }] : [],
  )
  const deskHref = deskLines.length > 0 ? buildDeskHref({ customerId, lines: deskLines }) : null

  const priceBasket = React.useCallback(async () => {
    const lines = basket.lines
      .filter((line) => line.productId)
      .map((line) => ({
        productId: line.productId as string,
        variantId: line.productVariantId,
        quantity: line.predictedQuantity,
      }))
    if (lines.length === 0) return
    setPricingPending(true)
    try {
      const call = await apiCall<BasketPricing>(
        `/api/distributor_workspace/customers/${encodeURIComponent(customerId)}/basket-pricing`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lines, currencyCode: basket.currencyCode ?? undefined }),
        },
      )
      setPricing(call.ok ? (call.result ?? null) : null)
    } catch (err) {
      logger.error('Basket pricing comparison failed', { err })
      setPricing(null)
    } finally {
      setPricingPending(false)
    }
  }, [basket.currencyCode, basket.lines, customerId])

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-medium text-foreground">
            {weekdayLabels[basket.weekday] ?? ''} {formatDate(basket.expectedAt, locale, emptyLabel)}
            {' · '}
            {counted.items(basket.lineCount)}
            {money ? ` · ${money}` : ''}
          </div>
          <div
            className={
              basket.overdueDays > 0
                ? 'text-xs font-medium text-status-warning-text'
                : 'text-xs text-muted-foreground'
            }
          >
            {basket.overdueDays > 0
              ? `${t('distributor_workspace.orderForecast.overdueBy', 'Overdue by')} ${counted.days(basket.overdueDays)}`
              : basket.daysUntilExpected === 0
                ? t('distributor_workspace.orderForecast.today', 'today')
                : `${t('distributor_workspace.orderForecast.inDays', 'in')} ${counted.days(basket.daysUntilExpected)}`}
            {basket.onRhythm
              ? ` · ${t('distributor_workspace.orderForecast.basket.onRhythm', 'on the customer delivery rhythm')}`
              : ` · ${t('distributor_workspace.orderForecast.basket.offRhythm', 'outside the usual delivery rhythm')}`}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge variant={CONFIDENCE_VARIANTS[basket.confidenceBand]} dot>
            {Math.round(basket.confidence * 100)}%
          </StatusBadge>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setOpen((previous) => !previous)}
          >
            {open
              ? t('distributor_workspace.orderForecast.basket.hide', 'Hide basket')
              : t('distributor_workspace.orderForecast.basket.show', 'Show basket')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pricingPending}
            onClick={priceBasket}
          >
            {t('distributor_workspace.orderForecast.pricing.action', 'Price it')}
          </Button>
          {deskHref ? (
            <Button asChild size="sm" variant="outline">
              <Link href={deskHref}>{t('distributor_workspace.orderForecast.action.openDesk', 'Price it on the desk')}</Link>
            </Button>
          ) : null}
          <Button type="button" size="sm" disabled={isCreating} onClick={() => onCreateOrder(basket.lines)}>
            {t('distributor_workspace.orderForecast.action.createOrder', 'Create draft order')}
          </Button>
        </div>
      </div>

      {pricing ? (
        <div className="border-t border-border px-4 py-3 text-xs">
          {pricing.unavailableReason ? (
            <span className="text-muted-foreground">
              {t(pricing.unavailableReason, 'The pricing engine could not price this basket.')}
            </span>
          ) : (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
              <span>
                <span className="text-muted-foreground">
                  {t('distributor_workspace.orderForecast.pricing.together', 'As one delivery')}:{' '}
                </span>
                <span className="font-semibold text-foreground">
                  {formatMoney(pricing.together?.totalNet ?? null, pricing.currencyCode, locale) ?? emptyLabel}
                </span>
              </span>
              <span>
                <span className="text-muted-foreground">
                  {t('distributor_workspace.orderForecast.pricing.separate', 'Ordered separately')}:{' '}
                </span>
                <span className="font-semibold text-foreground">
                  {formatMoney(pricing.separate?.totalNet ?? null, pricing.currencyCode, locale) ?? emptyLabel}
                </span>
              </span>
              {pricing.savingAmount !== null && pricing.savingAmount > 0 ? (
                <span className="font-medium text-status-success-text">
                  {t('distributor_workspace.orderForecast.pricing.saving', 'Cheaper together by')}{' '}
                  {formatMoney(pricing.savingAmount, pricing.currencyCode, locale)}
                  {pricing.savingPercent !== null ? ` (${pricing.savingPercent.toFixed(1)}%)` : ''}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {t(
                    'distributor_workspace.orderForecast.pricing.noSaving',
                    'Consolidating this basket changes nothing on the price.',
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      ) : null}

      {open ? (
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[48rem] text-sm">
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
                <th className="w-32 p-3" />
              </tr>
            </thead>
            <tbody>
              {basket.lines.map((line) => (
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
                    <div className="text-xs text-muted-foreground">
                      {line.quantityMin}–{line.quantityMax}
                      {line.predictedLineNetAmount !== null
                        ? ` · ${formatMoney(line.predictedLineNetAmount, line.currencyCode, locale)}`
                        : ''}
                    </div>
                  </td>
                  <td className="p-3">
                    <StatusBadge variant={CONFIDENCE_VARIANTS[line.confidenceBand]} dot>
                      {Math.round(line.confidence * 100)}%
                    </StatusBadge>
                    {line.acknowledged ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t('distributor_workspace.orderForecast.acknowledged', 'Confirmed with the customer')}
                      </div>
                    ) : null}
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    <div>
                      {counted.orders(line.evidence.occurrences)}
                      {line.cadence.dominantWeekday !== null
                        ? `, ${t('distributor_workspace.orderForecast.evidence.mostlyOn', 'mostly on')} ${
                            weekdayInLabels[line.cadence.dominantWeekday] ?? ''
                          } (${line.cadence.weekdayHits}/${line.evidence.occurrences})`
                        : ''}
                    </div>
                    <div>
                      {t('distributor_workspace.orderForecast.evidence.every', 'every')} ~
                      {counted.days(line.evidence.medianIntervalDays)} ·{' '}
                      {t('distributor_workspace.orderForecast.evidence.last', 'last')}{' '}
                      {formatDate(line.evidence.lastOrderedAt, locale, emptyLabel)}
                    </div>
                    {line.history.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                        <span>
                          {t('distributor_workspace.orderForecast.history.label', 'Bought on')}:
                        </span>
                        {line.history.map((entry) => {
                          const label = `${formatHistoryDate(entry.orderedAt, locale, emptyLabel)} (${entry.quantity})`
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
                  <td className="p-3">
                    <div className="flex flex-col gap-1">
                      {line.acknowledged ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => onClearNote(line)}>
                          {t('distributor_workspace.orderForecast.action.undoConfirm', 'Undo confirmation')}
                        </Button>
                      ) : (
                        <Button type="button" variant="ghost" size="sm" onClick={() => onConfirm(line)}>
                          {t('distributor_workspace.orderForecast.action.confirm', 'Confirmed')}
                        </Button>
                      )}
                      <Button type="button" variant="ghost" size="sm" onClick={() => onDismiss(line)}>
                        {t('distributor_workspace.orderForecast.action.dismiss', 'Do not show')}
                      </Button>
                    </div>
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

export default function CustomerOrderForecastWidget({
  context,
  data,
}: InjectionWidgetComponentProps<unknown, unknown>) {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const queryClient = useQueryClient()
  const customerId = resolveCustomerId(context, data)
  const [isCreating, setIsCreating] = React.useState(false)

  const { runMutation, retryLastMutation } = useGuardedMutation<{
    formId: string
    resourceKind: string
    resourceId: string
    retryLastMutation: () => Promise<boolean>
  }>({
    contextId: SAVE_CONTEXT_ID,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  const queryKey = React.useMemo(() => ['distributor-order-forecast', customerId], [customerId])
  const { data: forecast, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => (customerId ? loadForecast(customerId) : Promise.resolve(null)),
    enabled: Boolean(customerId),
    staleTime: 30_000,
  })

  const counted = useCountFormatters(t, locale)

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

  const sendFeedback = React.useCallback(
    async (prediction: ForecastPrediction, kind: 'confirmed' | 'dismissed' | 'snoozed') => {
      if (!customerId) return
      const payload = {
        productId: prediction.productId,
        productVariantId: prediction.productVariantId,
        productName: prediction.productName,
        kind,
      }
      try {
        await runMutation({
          operation: () =>
            apiCallOrThrow(
              `/api/distributor_workspace/customers/${encodeURIComponent(customerId)}/prediction-feedback`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              },
              {
                errorMessage: t(
                  'distributor_workspace.orderForecast.errors.feedbackFailed',
                  'The note could not be saved.',
                ),
              },
            ),
          context: {
            formId: SAVE_CONTEXT_ID,
            resourceKind: 'customers.company',
            resourceId: customerId,
            retryLastMutation,
          },
          mutationPayload: payload,
        })
        flash(
          t('distributor_workspace.orderForecast.feedbackSaved', 'Note saved. The forecast has been updated.'),
          'success',
        )
        await queryClient.invalidateQueries({ queryKey })
      } catch (err) {
        logger.error('Prediction feedback failed', { err })
      }
    },
    [customerId, queryClient, queryKey, retryLastMutation, runMutation, t],
  )

  /**
   * Removes a note so the raw rhythm shows through again.
   *
   * Without this the row actions are one-way: a dismissed product leaves the table, and the only
   * place it still exists is a database row the operator cannot see. Every note the customer has
   * is therefore listed below the table with this attached, including the confirmations, so no
   * click the operator makes here is irreversible from here.
   */
  const clearNote = React.useCallback(
    async (note: { productId: string | null; productVariantId: string | null }) => {
      if (!customerId) return
      const params = new URLSearchParams()
      if (note.productId) params.set('productId', note.productId)
      if (note.productVariantId) params.set('productVariantId', note.productVariantId)
      const payload = { productId: note.productId, productVariantId: note.productVariantId }
      try {
        await runMutation({
          operation: () =>
            apiCallOrThrow(
              `/api/distributor_workspace/customers/${encodeURIComponent(customerId)}/prediction-feedback?${params.toString()}`,
              { method: 'DELETE' },
              {
                errorMessage: t(
                  'distributor_workspace.orderForecast.errors.feedbackFailed',
                  'The note could not be saved.',
                ),
              },
            ),
          context: {
            formId: SAVE_CONTEXT_ID,
            resourceKind: 'customers.company',
            resourceId: customerId,
            retryLastMutation,
          },
          mutationPayload: payload,
        })
        flash(
          t('distributor_workspace.orderForecast.noteCleared', 'Note removed. The prediction is back.'),
          'success',
        )
        await queryClient.invalidateQueries({ queryKey })
      } catch (err) {
        logger.error('Clearing prediction feedback failed', { err })
      }
    },
    [customerId, queryClient, queryKey, retryLastMutation, runMutation, t],
  )

  /**
   * Creates one draft order per BASKET, which is the shape the customer would have sent.
   *
   * Taking the basket whole rather than a hand-picked selection is the point: the delivery is the
   * unit the customer orders in, and the operator's job here is to confirm or adjust it, not to
   * reassemble it line by line from a checklist.
   */
  const createOrder = React.useCallback(
    async (lines: ForecastPrediction[]) => {
    if (!customerId || !forecast) return
    if (lines.length === 0) return

    const currencyCode = lines.find((line) => line.currencyCode)?.currencyCode ?? 'PLN'
    const payload = {
      customerEntityId: customerId,
      currencyCode,
      comments: t(
        'distributor_workspace.orderForecast.orderComment',
        'Draft prepared from the recurring-order forecast. Confirm the quantities with the customer before releasing it.',
      ),
      lines: lines.map((line) => ({
        productId: line.productId ?? undefined,
        productVariantId: line.productVariantId ?? undefined,
        name: line.productName,
        currencyCode: line.currencyCode ?? currencyCode,
        quantity: String(line.predictedQuantity),
        quantityUnit: line.quantityUnit ?? undefined,
        unitPriceNet: line.predictedUnitNetAmount === null ? undefined : String(line.predictedUnitNetAmount),
      })),
    }

    setIsCreating(true)
    try {
      const created = await runMutation({
        operation: () =>
          apiCallOrThrow<{ id?: string }>(
            '/api/sales/orders',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            },
            {
              errorMessage: t(
                'distributor_workspace.orderForecast.errors.createOrderFailed',
                'The draft order could not be created.',
              ),
            },
          ),
        context: {
          formId: SAVE_CONTEXT_ID,
          resourceKind: 'customers.company',
          resourceId: customerId,
          retryLastMutation,
        },
        mutationPayload: payload,
      })
      flash(
        t('distributor_workspace.orderForecast.orderCreated', 'Draft order created from the forecast.'),
        'success',
      )
      const createdId = created?.result?.id
      if (typeof createdId === 'string' && createdId.length > 0) {
        router.push(`/backend/sales/documents/${createdId}`)
      }
    } catch (err) {
      logger.error('Creating an order from the forecast failed', { err })
    } finally {
      setIsCreating(false)
    }
  },
    [customerId, forecast, retryLastMutation, router, runMutation, t],
  )

  if (!customerId) return null
  if (isLoading) {
    return <LoadingMessage label={t('distributor_workspace.orderForecast.loading', 'Reading the order history…')} />
  }
  if (error) {
    return (
      <ErrorMessage
        label={t('distributor_workspace.orderForecast.errors.loadFailed', 'The forecast could not be built.')}
      />
    )
  }
  if (!forecast) return null

  const emptyLabel = t('distributor_workspace.orderForecast.empty', '—')
  const { rhythm, accuracy, baskets, notes, rejected, history, thresholds } = forecast
  const typicalBasket = formatMoney(rhythm.typicalOrderNetAmount, rhythm.currencyCode, locale)

  const rhythmSentence =
    rhythm.medianIntervalDays === null
      ? t(
          'distributor_workspace.orderForecast.rhythm.none',
          'There is not enough order history yet to describe how often this customer buys.',
        )
      : rhythm.dominantWeekday === null
        ? `${t('distributor_workspace.orderForecast.rhythm.everyNDays', 'Orders roughly every')} ${rhythm.medianIntervalDays} ${t('distributor_workspace.orderForecast.rhythm.days', 'days')}`
        : `${t('distributor_workspace.orderForecast.rhythm.everyNDays', 'Orders roughly every')} ${rhythm.medianIntervalDays} ${t('distributor_workspace.orderForecast.rhythm.days', 'days')}, ${t('distributor_workspace.orderForecast.rhythm.usuallyOn', 'usually on')} ${weekdayInLabels[rhythm.dominantWeekday] ?? ''}`

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-lg border border-border bg-card p-4 shadow-sm sm:grid-cols-4">
        <div className="space-y-1 sm:col-span-2">
          <div className="text-xs text-muted-foreground">
            {t('distributor_workspace.orderForecast.rhythm.title', 'Ordering rhythm')}
          </div>
          <div className="text-sm font-medium text-foreground">{rhythmSentence}</div>
          <div className="text-xs text-muted-foreground">
            {t('distributor_workspace.orderForecast.rhythm.basedOn', 'Based on')}{' '}
            {counted.orders(history.orderCount)}
            {history.firstOrderAt ? ` · ${formatDate(history.firstOrderAt, locale, emptyLabel)} – ${formatDate(history.lastOrderAt, locale, emptyLabel)}` : ''}
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">
            {t('distributor_workspace.orderForecast.rhythm.nextOrder', 'Next order expected')}
          </div>
          <div
            className={
              rhythm.orderOverdueDays > 0
                ? 'text-lg font-semibold text-status-warning-text'
                : 'text-lg font-semibold text-foreground'
            }
          >
            {formatDate(rhythm.nextExpectedOrderAt, locale, emptyLabel)}
          </div>
          {rhythm.orderOverdueDays > 0 ? (
            <div className="text-xs font-medium text-status-warning-text">
              {t('distributor_workspace.orderForecast.overdueBy', 'Overdue by')}{' '}
              {counted.days(rhythm.orderOverdueDays)}
            </div>
          ) : null}
          {typicalBasket ? (
            <div className="text-xs text-muted-foreground">
              {t('distributor_workspace.orderForecast.rhythm.typicalBasket', 'Typical basket')}: {typicalBasket}
            </div>
          ) : null}
        </div>
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">
            {t('distributor_workspace.orderForecast.accuracy.title', 'Historical accuracy')}
          </div>
          <div className="text-lg font-semibold text-foreground">
            {accuracy.hitRate === null ? emptyLabel : `${Math.round(accuracy.hitRate * 100)}%`}
          </div>
          <div className="text-xs text-muted-foreground">
            {accuracy.trials === 0
              ? t(
                  'distributor_workspace.orderForecast.accuracy.none',
                  'Not enough history to score this method yet.',
                )
              : `${accuracy.hits}/${accuracy.trials} ${t('distributor_workspace.orderForecast.accuracy.scored', 'replayed cycles')} · ±${accuracy.toleranceDays} ${t('distributor_workspace.orderForecast.rhythm.days', 'days')}`}
          </div>
        </div>
      </div>

      {baskets.length === 0 ? (
        <TabEmptyState
          title={t('distributor_workspace.orderForecast.emptyTitle', 'No repeating pattern found')}
          description={t(
            'distributor_workspace.orderForecast.emptyDescription',
            'A product is only predicted once it has been bought at least a few times, over several weeks, and is still being bought. Nothing in this customer history meets that yet.',
          )}
        />
      ) : (
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              {t('distributor_workspace.orderForecast.basket.title', 'Expected deliveries')}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t(
                'distributor_workspace.orderForecast.basket.hint',
                'Each card is a delivery this customer is expected to place, with the basket it would carry.',
              )}
            </p>
          </div>
          {baskets.map((basket) => (
            <CustomerBasketCard
              key={basket.expectedAt}
              basket={basket}
              customerId={customerId}
              locale={locale}
              weekdayLabels={weekdayLabels}
              weekdayInLabels={weekdayInLabels}
              emptyLabel={emptyLabel}
              counted={counted}
              isCreating={isCreating}
              t={t}
              onCreateOrder={createOrder}
              onConfirm={(line) => sendFeedback(line, 'confirmed')}
              onDismiss={(line) => sendFeedback(line, 'dismissed')}
              onClearNote={clearNote}
            />
          ))}
        </div>
      )}

      {notes.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <div className="text-xs font-medium text-foreground">
            {t('distributor_workspace.orderForecast.notes.title', 'Your notes on this customer')}
          </div>
          <ul className="space-y-1">
            {notes.map((note) => (
              <li
                key={`${note.productId ?? ''}:${note.productVariantId ?? ''}`}
                className="flex flex-wrap items-center justify-between gap-2 text-xs"
              >
                <span className="text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {note.productName ?? t('distributor_workspace.orderForecast.notes.unnamed', 'Unnamed product')}
                  </span>
                  {' — '}
                  {t(`distributor_workspace.orderForecast.notes.${note.kind}`, note.kind)}
                </span>
                <Button type="button" variant="ghost" size="sm" onClick={() => clearNote(note)}>
                  {t('distributor_workspace.orderForecast.action.clearNote', 'Undo')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          {rejected.length === 0
            ? t(
                'distributor_workspace.orderForecast.rejected.none',
                'Every product in this customer history was considered.',
              )
            : `${t('distributor_workspace.orderForecast.rejected.prefix', 'Left out')}: ${rejected
                .map(
                  (entry) =>
                    `${entry.count} ${t(
                      `distributor_workspace.orderForecast.rejected.${entry.reason}`,
                      entry.reason,
                    )}`,
                )
                .join(', ')}`}
          {' · '}
          {t('distributor_workspace.orderForecast.thresholds', 'Threshold')}:{' '}
          {counted.orders(thresholds.minOccurrences)} / {counted.days(thresholds.minSpanDays)}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={baskets.length === 0}
          onClick={() => {
            window.open(
              `/api/distributor_workspace/customers/${encodeURIComponent(customerId)}/order-forecast?format=csv`,
              '_blank',
              'noopener',
            )
          }}
        >
          {t('distributor_workspace.orderForecast.action.export', 'Export CSV')}
        </Button>
      </div>
    </div>
  )
}
