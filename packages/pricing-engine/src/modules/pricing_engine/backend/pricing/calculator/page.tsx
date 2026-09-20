'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CollapsibleSection, SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import type { LookupSelectItem } from '@open-mercato/ui/backend/inputs'
import { CounterInput } from '@open-mercato/ui/primitives/counter-input'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { Kbd } from '@open-mercato/ui/primitives/kbd'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { MarginAssumptions } from '../../../components/MarginAssumptions'
import { PriceWaterfall } from '../../../components/PriceWaterfall'
import type { AdviseResponse, AdvisorSuggestion } from '../../../lib/frontend/advisorTypes'
import {
  applySuggestion,
  buildDeskHref,
  deriveMarginTargets,
  mergeLineFloors,
  parseDeskSearch,
  toSimulateLines,
  type DeskLine,
} from '../../../lib/frontend/basketDesk'
import { simulateQuote } from '../../../lib/frontend/quoteClient'
import type { QuoteResponse } from '../../../lib/frontend/quoteTypes'
import { AdviceStrip } from './AdviceStrip'
import { BasketTable } from './BasketTable'
import { DeskSummary } from './DeskSummary'
import { QuickPicker } from './QuickPicker'

const logger = createLogger('pricing_engine').child({ component: 'pricing-desk' })

// The order-scenario table is tenant data, but the engine ships these codes as its defaults and
// the desk has to stay usable on a tenant whose scenario list is not exposed yet.
const FALLBACK_ORDER_SCENARIO_CODES = ['ideal_file', 'nonstandard_file', 'email', 'sms', 'phone', 'rep_visit'] as const
const DEFAULT_ORDER_SCENARIO = 'phone'
const LOOKUP_PAGE_SIZE = '12'
const RECENT_ORDERS_PAGE_SIZE = '5'
const ORDER_LINES_PAGE_SIZE = '100'
const REPRICE_DEBOUNCE_MS = 350
const ADVISOR_MAX_PER_KIND = 2
const DESK_CONTEXT_ID = 'pricing_engine.desk'
const ADVISE_PATH = '/api/pricing/advise'

type CodedOption = { code: string; label: string }
type RecentOrder = { id: string; orderNumber: string; placedAt: string | null }
type ListEnvelope = { items?: Array<Record<string, unknown>> }

function readString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

function readNumber(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key]
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

function toCamelCase(code: string): string {
  return code.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

async function fetchCodedOptions(path: string): Promise<CodedOption[]> {
  const call = await apiCall<ListEnvelope>(path, undefined, { fallback: { items: [] } })
  if (!call.ok || !Array.isArray(call.result?.items)) return []
  return call.result.items.flatMap<CodedOption>((item) => {
    const code = readString(item, 'code')
    return code ? [{ code, label: readString(item, 'label', 'name', 'title') ?? code }] : []
  })
}

function productToItem(item: Record<string, unknown>): LookupSelectItem | null {
  const id = readString(item, 'id')
  if (!id) return null
  return { id, title: readString(item, 'title', 'name') ?? id, subtitle: readString(item, 'sku') }
}

async function searchProducts(query: string): Promise<LookupSelectItem[]> {
  const params = new URLSearchParams({ page: '1', pageSize: LOOKUP_PAGE_SIZE })
  if (query.trim().length) params.set('search', query.trim())
  else params.set('sortField', 'title')
  const call = await apiCall<ListEnvelope>(`/api/catalog/products?${params.toString()}`, undefined, {
    fallback: { items: [] },
  })
  return (call.result?.items ?? []).flatMap((item) => {
    const mapped = productToItem(item)
    return mapped ? [mapped] : []
  })
}

async function fetchProductsByIds(ids: string[]): Promise<Map<string, LookupSelectItem>> {
  const found = new Map<string, LookupSelectItem>()
  if (ids.length === 0) return found
  const params = new URLSearchParams({ page: '1', pageSize: String(Math.min(100, ids.length)), ids: ids.join(',') })
  const call = await apiCall<ListEnvelope>(`/api/catalog/products?${params.toString()}`, undefined, {
    fallback: { items: [] },
  })
  for (const item of call.result?.items ?? []) {
    const mapped = productToItem(item)
    if (mapped) found.set(mapped.id, mapped)
  }
  return found
}

function customerToItem(item: Record<string, unknown>): LookupSelectItem | null {
  const id = readString(item, 'id')
  if (!id) return null
  return {
    id,
    title: readString(item, 'display_name', 'displayName', 'name', 'primary_email') ?? id,
    subtitle: readString(item, 'primary_domain', 'primaryDomain', 'primary_email', 'primaryEmail'),
  }
}

async function searchCustomers(query: string): Promise<LookupSelectItem[]> {
  const params = new URLSearchParams({ page: '1', pageSize: LOOKUP_PAGE_SIZE })
  if (query.trim().length) params.set('search', query.trim())
  const [companies, people] = await Promise.all([
    apiCall<ListEnvelope>(`/api/customers/companies?${params.toString()}`, undefined, { fallback: { items: [] } }),
    apiCall<ListEnvelope>(`/api/customers/people?${params.toString()}`, undefined, { fallback: { items: [] } }),
  ])
  return [...(companies.result?.items ?? []), ...(people.result?.items ?? [])].flatMap((item) => {
    const mapped = customerToItem(item)
    return mapped ? [mapped] : []
  })
}

async function fetchCustomerById(id: string): Promise<LookupSelectItem> {
  const params = new URLSearchParams({ page: '1', pageSize: '1', ids: id })
  const [companies, people] = await Promise.all([
    apiCall<ListEnvelope>(`/api/customers/companies?${params.toString()}`, undefined, { fallback: { items: [] } }),
    apiCall<ListEnvelope>(`/api/customers/people?${params.toString()}`, undefined, { fallback: { items: [] } }),
  ])
  for (const item of [...(companies.result?.items ?? []), ...(people.result?.items ?? [])]) {
    const mapped = customerToItem(item)
    if (mapped && mapped.id === id) return mapped
  }
  return { id, title: id }
}

async function fetchRecentOrders(customerId: string): Promise<RecentOrder[]> {
  const params = new URLSearchParams({
    page: '1',
    pageSize: RECENT_ORDERS_PAGE_SIZE,
    sortField: 'placedAt',
    sortDir: 'desc',
    customerId,
  })
  const call = await apiCall<ListEnvelope>(`/api/sales/orders?${params.toString()}`, undefined, { fallback: { items: [] } })
  return (call.result?.items ?? []).flatMap<RecentOrder>((item) => {
    const id = readString(item, 'id')
    if (!id) return []
    return [{ id, orderNumber: readString(item, 'orderNumber', 'order_number') ?? id, placedAt: readString(item, 'placedAt', 'placed_at') }]
  })
}

async function fetchOrderLines(orderId: string): Promise<DeskLine[]> {
  const params = new URLSearchParams({ page: '1', pageSize: ORDER_LINES_PAGE_SIZE, orderId })
  const call = await apiCall<ListEnvelope>(`/api/sales/order-lines?${params.toString()}`, undefined, { fallback: { items: [] } })
  const lines: DeskLine[] = []
  const seen = new Set<string>()
  for (const row of call.result?.items ?? []) {
    const productId = readString(row, 'product_id', 'productId')
    const quantity = readNumber(row, 'quantity', 'normalized_quantity', 'normalizedQuantity')
    if (!productId || !quantity || seen.has(productId)) continue
    seen.add(productId)
    lines.push({
      key: newKey(),
      productId,
      title: readString(row, 'name', 'title') ?? productId,
      sku: readString(row, 'sku'),
      quantity,
    })
  }
  return lines
}

async function adviseBasket(
  body: {
    customerId: string | null
    orderScenarioCode: string | null
    lines: Array<{ productId: string; quantity: string }>
  },
  signal?: AbortSignal,
): Promise<AdviseResponse | null> {
  // `/pricing/advise` persists nothing — a read expressed as a POST, so no mutation guard.
  //
  // Never rejects. `apiCall` throws on an aborted request, and the caller fires this with `void`,
  // so a rejection here would surface as an unhandled rejection in the browser and in the dev
  // server log every time the operator touches the quantity stepper.
  try {
    const call = await apiCall<AdviseResponse>(ADVISE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, advisor: { maxPerKind: ADVISOR_MAX_PER_KIND } }),
      signal,
    })
    return call.ok && call.result?.baseline ? call.result : null
  } catch {
    return null
  }
}

function formatOrderDate(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
}

export default function PricingDeskPage() {
  const t = useT()
  const router = useRouter()
  const searchParams = useSearchParams()
  const initial = React.useMemo(() => parseDeskSearch(searchParams?.toString() ?? ''), [searchParams])

  const [customer, setCustomer] = React.useState<LookupSelectItem | null>(null)
  const [orderScenarioCode, setOrderScenarioCode] = React.useState<string>(initial.orderScenarioCode ?? DEFAULT_ORDER_SCENARIO)
  const [deliveryZoneCode, setDeliveryZoneCode] = React.useState<string | null>(initial.deliveryZoneCode)
  const [scenarioOptions, setScenarioOptions] = React.useState<CodedOption[] | null>(null)
  const [zoneOptions, setZoneOptions] = React.useState<CodedOption[] | null>(null)
  const [rows, setRows] = React.useState<DeskLine[]>(() =>
    initial.lines.map((line) => ({ key: newKey(), productId: line.productId, title: line.productId, sku: null, quantity: Number(line.quantity) })),
  )
  const [addQuantity, setAddQuantity] = React.useState<number | null>(1)
  const [selectedProductId, setSelectedProductId] = React.useState<string | null>(null)
  const [quote, setQuote] = React.useState<QuoteResponse | null>(null)
  const [advice, setAdvice] = React.useState<AdviseResponse | null>(null)
  const [pending, setPending] = React.useState(false)
  const [advicePending, setAdvicePending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [repriceToken, setRepriceToken] = React.useState(0)
  const [recentOrders, setRecentOrders] = React.useState<RecentOrder[]>([])
  const [loadingOrder, setLoadingOrder] = React.useState(false)
  const [creating, setCreating] = React.useState<'quote' | 'order' | null>(null)
  const [copied, setCopied] = React.useState(false)
  const sequenceRef = React.useRef(0)
  /** Aborts the simulate/advise pair of the basket that the current edit has just replaced. */
  const inFlightRef = React.useRef<AbortController | null>(null)

  const { runMutation, retryLastMutation } = useGuardedMutation<{
    formId: string
    resourceKind: string
    resourceId: string | null
    retryLastMutation: () => Promise<boolean>
  }>({
    contextId: DESK_CONTEXT_ID,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  React.useEffect(() => {
    let cancelled = false
    void Promise.all([
      fetchCodedOptions('/api/pricing/order-scenarios?page=1&pageSize=50'),
      fetchCodedOptions('/api/pricing/delivery-zones?page=1&pageSize=50'),
    ]).then(([scenarios, zones]) => {
      if (cancelled) return
      setScenarioOptions(scenarios)
      setZoneOptions(zones)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // A basket that arrived by link carries ids only; the titles are fetched once, and a line whose
  // product no longer exists keeps its id as a label rather than vanishing.
  React.useEffect(() => {
    const unresolved = initial.lines.map((line) => line.productId)
    if (unresolved.length === 0) return
    let cancelled = false
    void fetchProductsByIds(unresolved).then((found) => {
      if (cancelled || found.size === 0) return
      setRows((previous) =>
        previous.map((row) => {
          const product = found.get(row.productId)
          return product ? { ...row, title: product.title, sku: product.subtitle ?? null } : row
        }),
      )
    })
    return () => {
      cancelled = true
    }
  }, [initial.lines])

  React.useEffect(() => {
    if (!initial.customerId) return
    let cancelled = false
    void fetchCustomerById(initial.customerId).then((item) => {
      if (!cancelled) setCustomer(item)
    })
    return () => {
      cancelled = true
    }
  }, [initial.customerId])

  const customerId = customer?.id ?? null

  React.useEffect(() => {
    if (!customerId) {
      setRecentOrders([])
      return
    }
    let cancelled = false
    void fetchRecentOrders(customerId).then((orders) => {
      if (!cancelled) setRecentOrders(orders)
    })
    return () => {
      cancelled = true
    }
  }, [customerId])

  const simulateLines = React.useMemo(() => toSimulateLines(rows), [rows])

  // Every change re-prices after a short pause. Responses are stamped with a sequence number so a
  // slow answer to an older basket can never overwrite the answer to the current one, AND the
  // superseded request is aborted rather than left running.
  //
  // The sequence number alone only discarded the stale ANSWER. The work behind it carried on:
  // clicking the quantity stepper five times left five simulations and five advisor runs pricing
  // baskets nobody was looking at, each holding a database connection, and the answer the operator
  // was waiting for queued behind all of them. Measured on the reference basket that turned a
  // ~110 ms simulation into eighteen seconds — which reads on screen as "the price does not
  // change when I change the quantity".
  React.useEffect(() => {
    if (simulateLines.length === 0) {
      sequenceRef.current += 1
      inFlightRef.current?.abort()
      inFlightRef.current = null
      setQuote(null)
      setAdvice(null)
      setPending(false)
      setAdvicePending(false)
      setError(null)
      return
    }
    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence
    setPending(true)
    setAdvicePending(true)
    inFlightRef.current?.abort()
    const controller = new AbortController()
    inFlightRef.current = controller
    const timer = setTimeout(() => {
      // The price lands as soon as the simulation answers; the advisor prices many what-if
      // baskets and can take seconds longer, so it must never hold the totals hostage.
      void simulateQuote(
        { customerId, orderScenarioCode, deliveryZoneCode, lines: simulateLines },
        controller.signal,
      ).then((outcome) => {
        // Two guards, not one. The sequence number catches a slow answer to an older basket; the
        // signal catches the abort itself, which `simulateQuote` reports as an ordinary failure
        // and which must never be painted as "Pricing failed".
        if (controller.signal.aborted || sequence !== sequenceRef.current) return
        if (!outcome.ok) {
          setQuote(null)
          setError(t(outcome.errorKey, 'Pricing failed.'))
        } else {
          setQuote(outcome.quote)
          setError(null)
        }
        setPending(false)
      })
      void adviseBasket(
        { customerId, orderScenarioCode, lines: simulateLines },
        controller.signal,
      ).then((advised) => {
        if (controller.signal.aborted || sequence !== sequenceRef.current) return
        setAdvice(advised)
        setAdvicePending(false)
      })
    }, REPRICE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [customerId, deliveryZoneCode, orderScenarioCode, repriceToken, simulateLines, t])

  // The address bar mirrors the basket, so a refresh keeps it and the link button has nothing to
  // compute. `replaceState` rather than the router: this must not add history entries per keystroke.
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const href = buildDeskHref({ customerId, orderScenarioCode, deliveryZoneCode, lines: simulateLines })
    if (`${window.location.pathname}${window.location.search}` !== href) {
      window.history.replaceState(window.history.state, '', href)
    }
  }, [customerId, deliveryZoneCode, orderScenarioCode, simulateLines])

  const resolvedScenarioOptions = React.useMemo<CodedOption[]>(() => {
    if (scenarioOptions && scenarioOptions.length > 0) return scenarioOptions
    return FALLBACK_ORDER_SCENARIO_CODES.map((code) => ({
      code,
      label: t(`pricing_engine.scenarios.${toCamelCase(code)}`, code),
    }))
  }, [scenarioOptions, t])

  const addProduct = React.useCallback(
    (item: LookupSelectItem) => {
      const quantity = addQuantity && addQuantity > 0 ? addQuantity : 1
      setRows((previous) => {
        const existing = previous.find((row) => row.productId === item.id)
        if (existing) {
          return previous.map((row) => (row.key === existing.key ? { ...row, quantity: row.quantity + quantity } : row))
        }
        return [...previous, { key: newKey(), productId: item.id, title: item.title, sku: item.subtitle ?? null, quantity }]
      })
      setSelectedProductId(item.id)
      setAddQuantity(1)
    },
    [addQuantity],
  )

  const updateQuantity = React.useCallback((key: string, quantity: number | null) => {
    if (quantity === null || quantity <= 0) return
    setRows((previous) => previous.map((row) => (row.key === key ? { ...row, quantity } : row)))
  }, [])

  const removeRow = React.useCallback((key: string) => {
    setRows((previous) => previous.filter((row) => row.key !== key))
  }, [])

  const loadOrder = React.useCallback(
    async (orderId: string) => {
      setLoadingOrder(true)
      try {
        const lines = await fetchOrderLines(orderId)
        if (lines.length === 0) {
          flash(t('pricing_engine.desk.recent.empty', 'That order has no catalog lines to load.'), 'info')
          return
        }
        setRows(lines)
        setSelectedProductId(lines[0]?.productId ?? null)
      } finally {
        setLoadingOrder(false)
      }
    },
    [t],
  )

  const canApply = React.useCallback(
    (suggestion: AdvisorSuggestion) => applySuggestion(rows, suggestion).kind !== 'none',
    [rows],
  )

  const onApply = React.useCallback(
    (suggestion: AdvisorSuggestion) => {
      const outcome = applySuggestion(rows, suggestion)
      if (outcome.kind === 'channel') {
        setOrderScenarioCode(outcome.orderScenarioCode)
        return
      }
      if (outcome.kind === 'quantity') {
        setRows(outcome.lines)
        return
      }
      if (outcome.kind === 'product') {
        setRows(outcome.lines)
        setSelectedProductId(outcome.productId)
        void fetchProductsByIds([outcome.productId]).then((found) => {
          const product = found.get(outcome.productId)
          if (!product) return
          setRows((previous) =>
            previous.map((row) =>
              row.productId === outcome.productId ? { ...row, title: product.title, sku: product.subtitle ?? null } : row,
            ),
          )
        })
      }
    },
    [rows],
  )

  const createDocument = React.useCallback(
    async (kind: 'quote' | 'order') => {
      if (!quote || rows.length === 0 || creating) return
      const quotedByProduct = new Map(quote.lines.map((line) => [line.productId, line]))
      const payload = {
        ...(customerId ? { customerEntityId: customerId } : {}),
        currencyCode: quote.currencyCode,
        comments: t('pricing_engine.desk.document.comment', 'Prepared on the pricing desk with engine prices.'),
        lines: rows.map((row) => {
          const quoted = quotedByProduct.get(row.productId)
          return {
            productId: row.productId,
            name: row.title,
            currencyCode: quote.currencyCode,
            quantity: String(row.quantity),
            ...(quoted ? { unitPriceNet: quoted.unitPriceNet } : {}),
          }
        }),
      }
      const path = kind === 'quote' ? '/api/sales/quotes' : '/api/sales/orders'
      setCreating(kind)
      try {
        const created = await runMutation({
          operation: () =>
            apiCallOrThrow<{ id?: string }>(
              path,
              { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
              {
                errorMessage: t('pricing_engine.desk.document.failed', 'The document could not be created.'),
              },
            ),
          context: {
            formId: DESK_CONTEXT_ID,
            resourceKind: kind === 'quote' ? 'sales.quote' : 'sales.order',
            resourceId: null,
            retryLastMutation,
          },
          mutationPayload: payload,
        })
        const createdId = created?.result?.id
        flash(
          kind === 'quote'
            ? t('pricing_engine.desk.document.quoteCreated', 'Quote created from the desk.')
            : t('pricing_engine.desk.document.orderCreated', 'Order created from the desk.'),
          'success',
        )
        if (typeof createdId === 'string' && createdId.length > 0) {
          router.push(`/backend/sales/documents/${createdId}?kind=${kind}`)
        }
      } catch (err) {
        logger.error('Creating a document from the pricing desk failed', { err, kind })
        flash(t('pricing_engine.desk.document.failed', 'The document could not be created.'), 'error')
      } finally {
        setCreating(null)
      }
    },
    [creating, customerId, quote, retryLastMutation, router, rows, runMutation, t],
  )

  const copyLink = React.useCallback(async () => {
    if (typeof window === 'undefined') return
    const href = `${window.location.origin}${buildDeskHref({ customerId, orderScenarioCode, deliveryZoneCode, lines: simulateLines })}`
    try {
      await navigator.clipboard.writeText(href)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      logger.warn('Clipboard unavailable for the desk link', { err })
      flash(href, 'info')
    }
  }, [customerId, deliveryZoneCode, orderScenarioCode, simulateLines])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        void createDocument('quote')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [createDocument])

  const targets = React.useMemo(() => deriveMarginTargets(quote), [quote])
  const floors = React.useMemo(() => mergeLineFloors(quote, advice), [advice, quote])
  const currencyCode = quote?.currencyCode ?? ''
  const selectedLine = React.useMemo(() => {
    const lines = quote?.lines ?? []
    return lines.find((line) => line.productId === selectedProductId) ?? lines[0] ?? null
  }, [quote, selectedProductId])
  const selectedRow = rows.find((row) => row.productId === selectedLine?.productId) ?? null
  const selectedVolume = React.useMemo(
    () => (advice?.volumeSensitivity ?? []).find((entry) => entry.productId === (selectedLine?.productId ?? selectedProductId)) ?? null,
    [advice, selectedLine, selectedProductId],
  )
  const zonesUnavailable = zoneOptions === null || zoneOptions.length === 0

  return (
    <Page>
      <PageBody>
        <p className="text-sm text-muted-foreground">
          {t(
            'pricing_engine.desk.description',
            'Add products, the price and the margin follow as you go, then turn the basket into a quote or an order.',
          )}
        </p>

        <div className="grid gap-3 lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)_auto] lg:items-start">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t('pricing_engine.calculator.field.customer', 'Customer')}</span>
            <QuickPicker
              fetchItems={searchCustomers}
              onPick={setCustomer}
              selected={customer}
              onClear={() => setCustomer(null)}
              keepQueryOnPick
              placeholder={t('pricing_engine.desk.customer.placeholder', 'Any customer — type a name to pick one')}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t('pricing_engine.desk.channel.label', 'How they order')}</span>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('pricing_engine.desk.channel.label', 'How they order')}>
              {resolvedScenarioOptions.map((option) => {
                const active = option.code === orderScenarioCode
                return (
                  <Button
                    key={option.code}
                    type="button"
                    size="sm"
                    variant={active ? 'default' : 'outline'}
                    role="radio"
                    aria-checked={active}
                    onClick={() => setOrderScenarioCode(option.code)}
                  >
                    {t(option.label, option.label)}
                  </Button>
                )
              })}
            </div>
          </div>
          {!zonesUnavailable ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('pricing_engine.calculator.field.deliveryZone', 'Delivery zone')}</span>
              <Select value={deliveryZoneCode ?? ''} onValueChange={(value) => setDeliveryZoneCode(value || null)}>
                <SelectTrigger className="min-w-44">
                  <SelectValue placeholder={t('pricing_engine.calculator.field.deliveryZonePlaceholder', 'No delivery zone')} />
                </SelectTrigger>
                <SelectContent>
                  {(zoneOptions ?? []).map((option) => (
                    <SelectItem key={option.code} value={option.code}>
                      {t(option.label, option.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>

        <DeskSummary
          quote={quote}
          currencyCode={currencyCode}
          targets={targets}
          lineCount={rows.length}
          pending={pending}
          error={error}
          creating={creating}
          copied={copied}
          onCreateQuote={() => void createDocument('quote')}
          onCreateOrder={() => void createDocument('order')}
          onCopyLink={() => void copyLink()}
          onRetry={() => setRepriceToken((token) => token + 1)}
        />

        <div className="space-y-6">
          <div className="min-w-0 space-y-6">
            <div className="space-y-3">
              <SectionHeader title={t('pricing_engine.calculator.basket.title', 'Basket')} count={rows.length} />
              <div className="flex flex-wrap items-start gap-2">
                <CounterInput
                  min={1}
                  step={1}
                  value={addQuantity}
                  onChange={setAddQuantity}
                  className="w-32"
                  aria-label={t('pricing_engine.calculator.field.quantity', 'Quantity')}
                  decrementAriaLabel={t('pricing_engine.ui.counter.decrease', 'Decrease quantity')}
                  incrementAriaLabel={t('pricing_engine.ui.counter.increase', 'Increase quantity')}
                />
                <QuickPicker
                  className="min-w-64 flex-1"
                  fetchItems={searchProducts}
                  onPick={addProduct}
                  autoFocus={rows.length === 0}
                  placeholder={t('pricing_engine.desk.add.placeholder', 'Type a product name or SKU…')}
                  hint={
                    <span className="inline-flex flex-wrap items-center gap-1">
                      <Kbd>↵</Kbd> {t('pricing_engine.desk.add.hintEnter', 'adds the line')}
                      {' · '}
                      <Kbd>↑</Kbd>
                      <Kbd>↓</Kbd> {t('pricing_engine.desk.add.hintArrows', 'pick')}
                      {' · '}
                      {t('pricing_engine.desk.add.hintRepeat', 'the box stays focused for the next one')}
                    </span>
                  }
                />
                {customerId && recentOrders.length > 0 ? (
                  <Select value="" onValueChange={(value) => void loadOrder(value)} disabled={loadingOrder}>
                    <SelectTrigger className="w-64">
                      <SelectValue
                        placeholder={
                          loadingOrder
                            ? t('pricing_engine.desk.recent.loading', 'Loading the order…')
                            : t('pricing_engine.desk.recent.placeholder', 'Load a recent order of this customer')
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {recentOrders.map((order) => (
                        <SelectItem key={order.id} value={order.id}>
                          {order.orderNumber}
                          {order.placedAt ? ` · ${formatOrderDate(order.placedAt)}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>

              {rows.length === 0 ? (
                <EmptyState
                  title={t('pricing_engine.desk.empty.title', 'Start typing a product')}
                  description={t(
                    'pricing_engine.desk.empty.description',
                    'Each line is priced the moment it lands. Pick a customer first and their terms, channel and delivery come with it.',
                  )}
                />
              ) : (
                <BasketTable
                  lines={rows}
                  quote={quote}
                  floors={floors}
                  targets={targets}
                  currencyCode={currencyCode}
                  selectedProductId={selectedLine?.productId ?? selectedProductId}
                  pending={pending}
                  volume={selectedVolume}
                  onSelect={setSelectedProductId}
                  onQuantityChange={updateQuantity}
                  onRemove={removeRow}
                />
              )}
            </div>

            {selectedLine ? (
              <CollapsibleSection
                title={`${t('pricing_engine.playground.waterfall.title', 'How the price was built')}: ${selectedRow?.title ?? selectedLine.sku ?? ''}`}
                count={selectedLine.breakdown.length}
                defaultCollapsed
              >
                <div className="space-y-4">
                  <PriceWaterfall breakdown={selectedLine.breakdown} currencyCode={currencyCode} />
                  <div className="space-y-2">
                    <div className="text-sm font-medium">{t('pricing_engine.margin.assumptions.title', 'What this price assumes')}</div>
                    <p className="text-sm text-muted-foreground">
                      {t(
                        'pricing_engine.margin.assumptions.description',
                        'Every number above rests on these values. Anything marked as assumed came from a default, not from your data.',
                      )}
                    </p>
                    <MarginAssumptions breakdown={selectedLine.breakdown} currencyCode={currencyCode} />
                  </div>
                </div>
              </CollapsibleSection>
            ) : null}

            {rows.length > 0 ? (
              <AdviceStrip advice={advice} currencyCode={currencyCode} pending={pending || advicePending} canApply={canApply} onApply={onApply} />
            ) : null}
          </div>
        </div>
      </PageBody>
    </Page>
  )
}
