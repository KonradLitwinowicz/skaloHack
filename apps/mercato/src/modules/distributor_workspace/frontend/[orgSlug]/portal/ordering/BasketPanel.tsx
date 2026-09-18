"use client"

import * as React from 'react'
import { Trash2 } from 'lucide-react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { CounterInput } from '@open-mercato/ui/primitives/counter-input'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { ErrorMessage } from '@open-mercato/ui/backend/detail'
import {
  PortalCard,
  PortalCardDivider,
  PortalCardHeader,
} from '@open-mercato/ui/portal/components/PortalCard'
import {
  formatMoney,
  type BasketEntry,
  type PortalQuoteResponse,
  type SubmitKind,
} from './types'

type BasketPanelProps = {
  entries: BasketEntry[]
  quote: PortalQuoteResponse | null
  isPricing: boolean
  pricingError: string | null
  isSubmitting: boolean
  canRequestQuote: boolean
  canPlaceOrder: boolean
  onQuantityChange: (productId: string, quantity: number | null) => void
  onRemove: (productId: string) => void
  onClear: () => void
  onSubmitRequest: (kind: SubmitKind) => void
}

export function BasketPanel({
  entries,
  quote,
  isPricing,
  pricingError,
  isSubmitting,
  canRequestQuote,
  canPlaceOrder,
  onQuantityChange,
  onRemove,
  onClear,
  onSubmitRequest,
}: BasketPanelProps) {
  const t = useT()
  const locale = useLocale()
  const currencyCode = quote?.currencyCode ?? ''
  const lineByProductId = React.useMemo(() => {
    const map = new Map<string, { unitPriceNet: string; totalPriceNet: string }>()
    for (const line of quote?.lines ?? []) {
      map.set(line.productId, {
        unitPriceNet: line.unitPriceNet,
        totalPriceNet: line.totalPriceNet,
      })
    }
    return map
  }, [quote])

  return (
    <PortalCard className="lg:sticky lg:top-6">
      <PortalCardHeader
        title={t('distributor_workspace.portal.ordering.basket.title', 'Your basket')}
        description={t(
          'distributor_workspace.portal.ordering.basket.description',
          'All amounts are net of tax.',
        )}
        action={
          entries.length ? (
            <Button type="button" size="sm" variant="ghost" onClick={onClear} disabled={isSubmitting}>
              {t('distributor_workspace.portal.ordering.basket.clear', 'Clear')}
            </Button>
          ) : null
        }
      />

      {entries.length === 0 ? (
        <EmptyState
          variant="subtle"
          size="lg"
          title={t('distributor_workspace.portal.ordering.basket.emptyTitle', 'Your basket is empty')}
          description={t(
            'distributor_workspace.portal.ordering.basket.emptyDescription',
            'Add products from the catalog to see what they cost you.',
          )}
        />
      ) : (
        <ul className="flex flex-col">
          {entries.map((entry) => {
            const priced = lineByProductId.get(entry.productId)
            return (
              <li
                key={entry.productId}
                className="flex flex-col gap-2 border-t py-3 first:border-t-0 first:pt-0"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{entry.title}</p>
                    {entry.sku ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">{entry.sku}</p>
                    ) : null}
                  </div>
                  <IconButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={t('distributor_workspace.portal.ordering.basket.remove', 'Remove line')}
                    onClick={() => onRemove(entry.productId)}
                    disabled={isSubmitting}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <CounterInput
                    size="sm"
                    min={1}
                    step={1}
                    value={entry.quantity}
                    onChange={(next) => onQuantityChange(entry.productId, next)}
                    inputClassName="w-14"
                    disabled={isSubmitting}
                    decrementAriaLabel={t(
                      'distributor_workspace.portal.ordering.counter.decrease',
                      'Decrease quantity',
                    )}
                    incrementAriaLabel={t(
                      'distributor_workspace.portal.ordering.counter.increase',
                      'Increase quantity',
                    )}
                  />
                  <div className="text-right">
                    <p className="text-sm font-semibold tabular-nums text-foreground">
                      {priced
                        ? formatMoney(priced.totalPriceNet, currencyCode, locale)
                        : t('distributor_workspace.portal.ordering.basket.pending', 'Calculating')}
                    </p>
                    {priced ? (
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {t(
                          'distributor_workspace.portal.ordering.basket.unitPrice',
                          '{price} per unit',
                          { price: formatMoney(priced.unitPriceNet, currencyCode, locale) },
                        )}
                      </p>
                    ) : null}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {pricingError ? (
        <div className="mt-4">
          <ErrorMessage label={pricingError} />
        </div>
      ) : null}

      {entries.length > 0 ? (
        <>
          <div className="mt-4">
            <PortalCardDivider />
          </div>
          <div className="flex items-center justify-between py-3">
            <span className="text-overline font-medium uppercase tracking-wider text-muted-foreground/70">
              {t('distributor_workspace.portal.ordering.basket.total', 'Total net')}
            </span>
            <span className="flex items-center gap-2 text-base font-semibold tabular-nums text-foreground">
              {isPricing ? <Spinner size="sm" /> : null}
              {quote
                ? formatMoney(quote.totalNet, currencyCode, locale)
                : t('distributor_workspace.portal.ordering.basket.pending', 'Calculating')}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {canRequestQuote ? (
              <Button
                type="button"
                variant="outline"
                disabled={isSubmitting || isPricing || !quote}
                onClick={() => onSubmitRequest('quote')}
              >
                {t('distributor_workspace.portal.ordering.basket.requestQuote', 'Request a quote')}
              </Button>
            ) : null}
            {canPlaceOrder ? (
              <Button
                type="button"
                disabled={isSubmitting || isPricing || !quote}
                onClick={() => onSubmitRequest('order')}
              >
                {t('distributor_workspace.portal.ordering.basket.placeOrder', 'Place order')}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </PortalCard>
  )
}
