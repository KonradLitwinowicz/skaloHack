"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { hasAllFeatures } from '@open-mercato/shared/security/features'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { usePortalContext } from '@open-mercato/ui/portal/PortalContext'
import { PortalPageHeader } from '@open-mercato/ui/portal/components/PortalPageHeader'
import { ALL_CATEGORIES, CatalogBrowser } from './CatalogBrowser'
import { BasketPanel } from './BasketPanel'
import { SubmitDialog } from './SubmitDialog'
import type {
  BasketEntry,
  PortalCatalogCategory,
  PortalCatalogItem,
  PortalCatalogResponse,
  PortalQuoteResponse,
  PortalSubmitResponse,
  SubmitKind,
} from './types'

const CATALOG_ENDPOINT = '/api/distributor_workspace/portal/catalog'
const QUOTE_ENDPOINT = '/api/distributor_workspace/portal/quote'
const REQUESTS_ENDPOINT = '/api/distributor_workspace/portal/requests'
const SUBMIT_MUTATION_CONTEXT_ID = 'distributor_workspace:portal-ordering:submit'
const PAGE_SIZE = 24
const SEARCH_DEBOUNCE_MS = 300
const BASKET_DEBOUNCE_MS = 400

type Props = { params: { orgSlug: string } }

type QuoteRequestLine = { productId: string; quantity: number }

async function requestQuote(lines: QuoteRequestLine[]): Promise<PortalQuoteResponse | null> {
  const call = await apiCall<PortalQuoteResponse>(QUOTE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ lines }),
  })
  if (!call.ok || !call.result) return null
  return call.result
}

export default function PortalOrderingPage({ params }: Props) {
  const t = useT()
  const router = useRouter()
  const { auth } = usePortalContext()
  const { user, loading, resolvedFeatures } = auth

  const [searchInput, setSearchInput] = React.useState('')
  const [search, setSearch] = React.useState('')
  const [categoryCode, setCategoryCode] = React.useState(ALL_CATEGORIES)
  const [page, setPage] = React.useState(1)
  const [items, setItems] = React.useState<PortalCatalogItem[]>([])
  const [categories, setCategories] = React.useState<PortalCatalogCategory[]>([])
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [catalogLoading, setCatalogLoading] = React.useState(true)
  const [catalogError, setCatalogError] = React.useState<string | null>(null)

  const [listPrices, setListPrices] = React.useState<Map<string, string>>(new Map())
  const [listCurrency, setListCurrency] = React.useState('')

  const [entries, setEntries] = React.useState<BasketEntry[]>([])
  const [quote, setQuote] = React.useState<PortalQuoteResponse | null>(null)
  const [isPricing, setIsPricing] = React.useState(false)
  const [pricingError, setPricingError] = React.useState<string | null>(null)

  const [dialogKind, setDialogKind] = React.useState<SubmitKind | null>(null)
  const [comments, setComments] = React.useState('')
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  const guardedMutation = useGuardedMutation<Record<string, unknown>>({
    contextId: SUBMIT_MUTATION_CONTEXT_ID,
    blockedMessage: t(
      'distributor_workspace.portal.ordering.errors.submitBlocked',
      'The request was blocked before it was sent.',
    ),
  })

  React.useEffect(() => {
    if (!loading && !user) router.replace(`/${params.orgSlug}/portal/login`)
  }, [loading, user, router, params.orgSlug])

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  React.useEffect(() => {
    if (!user) return
    let cancelled = false
    setCatalogLoading(true)
    setCatalogError(null)
    const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
    if (search) query.set('search', search)
    if (categoryCode !== ALL_CATEGORIES) query.set('category', categoryCode)
    apiCall<PortalCatalogResponse>(`${CATALOG_ENDPOINT}?${query.toString()}`, {
      credentials: 'include',
    })
      .then((call) => {
        if (cancelled) return
        if (!call.ok || !call.result) {
          setCatalogError(
            t('distributor_workspace.portal.ordering.errors.catalogFailed', 'The catalog could not be loaded.'),
          )
          setItems([])
          setTotal(0)
          setTotalPages(1)
          return
        }
        setItems(call.result.items)
        setCategories(call.result.categories)
        setTotal(call.result.total)
        setTotalPages(call.result.totalPages)
      })
      .catch(() => {
        if (cancelled) return
        setCatalogError(
          t('distributor_workspace.portal.ordering.errors.catalogFailed', 'The catalog could not be loaded.'),
        )
        setItems([])
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user, page, search, categoryCode, t])

  // Browse prices are quoted for the visible page as one basket of single units. The basket panel
  // below is the authoritative figure: order-level components are shared across the basket, so a
  // line's price moves once it sits next to the customer's real quantities.
  React.useEffect(() => {
    if (!user || items.length === 0) {
      setListPrices(new Map())
      return
    }
    let cancelled = false
    requestQuote(items.map((item) => ({ productId: item.productId, quantity: 1 })))
      .then((result) => {
        if (cancelled || !result) return
        const next = new Map<string, string>()
        for (const line of result.lines) next.set(line.productId, line.unitPriceNet)
        setListPrices(next)
        setListCurrency(result.currencyCode)
      })
      .catch(() => {
        if (!cancelled) setListPrices(new Map())
      })
    return () => {
      cancelled = true
    }
  }, [user, items])

  React.useEffect(() => {
    if (!user || entries.length === 0) {
      setQuote(null)
      setPricingError(null)
      setIsPricing(false)
      return
    }
    let cancelled = false
    setIsPricing(true)
    const lines = entries.map((entry) => ({ productId: entry.productId, quantity: entry.quantity }))
    const timer = window.setTimeout(() => {
      requestQuote(lines)
        .then((result) => {
          if (cancelled) return
          if (!result) {
            setQuote(null)
            setPricingError(
              t('distributor_workspace.portal.ordering.errors.quoteFailed', 'We could not price this basket.'),
            )
            return
          }
          setQuote(result)
          setPricingError(null)
        })
        .catch(() => {
          if (cancelled) return
          setQuote(null)
          setPricingError(
            t('distributor_workspace.portal.ordering.errors.quoteFailed', 'We could not price this basket.'),
          )
        })
        .finally(() => {
          if (!cancelled) setIsPricing(false)
        })
    }, BASKET_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [user, entries, t])

  const handleAdd = React.useCallback((item: PortalCatalogItem, quantity: number) => {
    setEntries((current) => {
      const existing = current.find((entry) => entry.productId === item.productId)
      if (existing) {
        return current.map((entry) =>
          entry.productId === item.productId
            ? { ...entry, quantity: entry.quantity + quantity }
            : entry,
        )
      }
      return [
        ...current,
        { productId: item.productId, sku: item.sku, title: item.title, quantity },
      ]
    })
  }, [])

  const handleQuantityChange = React.useCallback((productId: string, quantity: number | null) => {
    setEntries((current) =>
      current.map((entry) =>
        entry.productId === productId ? { ...entry, quantity: quantity && quantity > 0 ? quantity : 1 } : entry,
      ),
    )
  }, [])

  const handleRemove = React.useCallback((productId: string) => {
    setEntries((current) => current.filter((entry) => entry.productId !== productId))
  }, [])

  const handleSubmit = React.useCallback(async () => {
    if (!dialogKind || !quote) return
    setIsSubmitting(true)
    const payload = {
      kind: dialogKind,
      comments: comments.trim() ? comments.trim() : undefined,
      lines: entries.map((entry) => ({ productId: entry.productId, quantity: entry.quantity })),
    }
    try {
      const call = await guardedMutation.runMutation({
        operation: () =>
          apiCall<PortalSubmitResponse>(REQUESTS_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload),
          }),
        context: {
          moduleId: 'distributor_workspace',
          entityId: dialogKind === 'order' ? 'sales:sales_order' : 'sales:sales_quote',
          operation: 'portal_create',
          formId: SUBMIT_MUTATION_CONTEXT_ID,
          resourceKind: dialogKind === 'order' ? 'sales.order' : 'sales.quote',
          retryLastMutation: guardedMutation.retryLastMutation,
        },
        mutationPayload: payload,
      })
      if (!call.ok || !call.result?.ok) {
        flash(
          t('distributor_workspace.portal.ordering.errors.submitFailed', 'We could not submit your basket.'),
          'error',
        )
        return
      }
      flash(
        dialogKind === 'order'
          ? t('distributor_workspace.portal.ordering.flash.orderPlaced', 'Your order has been placed.')
          : t('distributor_workspace.portal.ordering.flash.quoteRequested', 'Your quote request has been sent.'),
        'success',
      )
      setEntries([])
      setComments('')
      setDialogKind(null)
    } catch {
      flash(
        t('distributor_workspace.portal.ordering.errors.submitFailed', 'We could not submit your basket.'),
        'error',
      )
    } finally {
      setIsSubmitting(false)
    }
  }, [comments, dialogKind, entries, guardedMutation, quote, t])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner />
      </div>
    )
  }
  if (!user) return null

  const canRequestQuote = hasAllFeatures(resolvedFeatures, ['portal.quotes.request'])
  const canPlaceOrder = hasAllFeatures(resolvedFeatures, ['portal.orders.create'])

  return (
    <div className="flex flex-col gap-8">
      <PortalPageHeader
        title={t('distributor_workspace.portal.ordering.title', 'Order')}
        description={t(
          'distributor_workspace.portal.ordering.description',
          'Browse what we stock for you and build a basket. Prices are yours, net of tax.',
        )}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <CatalogBrowser
          items={items}
          categories={categories}
          search={searchInput}
          onSearchChange={setSearchInput}
          categoryCode={categoryCode}
          onCategoryChange={(next) => {
            setCategoryCode(next)
            setPage(1)
          }}
          page={page}
          totalPages={totalPages}
          total={total}
          onPageChange={setPage}
          isLoading={catalogLoading}
          error={catalogError}
          currencyCode={quote?.currencyCode ?? listCurrency}
          unitPriceByProductId={listPrices}
          onAdd={handleAdd}
        />
        <BasketPanel
          entries={entries}
          quote={quote}
          isPricing={isPricing}
          pricingError={pricingError}
          isSubmitting={isSubmitting}
          canRequestQuote={canRequestQuote}
          canPlaceOrder={canPlaceOrder}
          onQuantityChange={handleQuantityChange}
          onRemove={handleRemove}
          onClear={() => setEntries([])}
          onSubmitRequest={setDialogKind}
        />
      </div>
      <SubmitDialog
        open={dialogKind !== null}
        kind={dialogKind ?? 'quote'}
        quote={quote}
        lineCount={entries.length}
        isSubmitting={isSubmitting}
        comments={comments}
        onCommentsChange={setComments}
        onConfirm={handleSubmit}
        onClose={() => {
          if (!isSubmitting) setDialogKind(null)
        }}
      />
    </div>
  )
}
