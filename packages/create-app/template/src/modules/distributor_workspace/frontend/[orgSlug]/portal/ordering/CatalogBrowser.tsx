"use client"

import * as React from 'react'
import { Plus, Search } from 'lucide-react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { CounterInput } from '@open-mercato/ui/primitives/counter-input'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { Input } from '@open-mercato/ui/primitives/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { ErrorMessage } from '@open-mercato/ui/backend/detail'
import { PortalCard, PortalCardHeader } from '@open-mercato/ui/portal/components/PortalCard'
import { formatMoney, type PortalCatalogCategory, type PortalCatalogItem } from './types'

export const ALL_CATEGORIES = '__all__'

type CatalogBrowserProps = {
  items: PortalCatalogItem[]
  categories: PortalCatalogCategory[]
  search: string
  onSearchChange: (value: string) => void
  categoryCode: string
  onCategoryChange: (value: string) => void
  page: number
  totalPages: number
  total: number
  onPageChange: (page: number) => void
  isLoading: boolean
  error: string | null
  currencyCode: string
  unitPriceByProductId: Map<string, string>
  onAdd: (item: PortalCatalogItem, quantity: number) => void
}

function CatalogRow({
  item,
  price,
  currencyCode,
  locale,
  onAdd,
}: {
  item: PortalCatalogItem
  price: string | undefined
  currencyCode: string
  locale: string
  onAdd: (item: PortalCatalogItem, quantity: number) => void
}) {
  const t = useT()
  const [quantity, setQuantity] = React.useState<number | null>(1)
  const effectiveQuantity = quantity && quantity > 0 ? quantity : 1

  return (
    <li className="flex flex-col gap-3 border-t py-4 first:border-t-0 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {item.sku ?? t('distributor_workspace.portal.ordering.catalog.noSku', 'No SKU')}
        </p>
      </div>
      <div className="flex items-center gap-3 sm:justify-end">
        <span className="min-w-24 text-right text-sm font-semibold tabular-nums text-foreground">
          {price
            ? formatMoney(price, currencyCode, locale)
            : t('distributor_workspace.portal.ordering.catalog.priceOnAdd', 'Add to see price')}
        </span>
        <CounterInput
          size="sm"
          min={1}
          step={1}
          value={quantity}
          onChange={setQuantity}
          inputClassName="w-14"
          decrementAriaLabel={t('distributor_workspace.portal.ordering.counter.decrease', 'Decrease quantity')}
          incrementAriaLabel={t('distributor_workspace.portal.ordering.counter.increase', 'Increase quantity')}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onAdd(item, effectiveQuantity)}
        >
          <Plus className="size-4" />
          {t('distributor_workspace.portal.ordering.catalog.add', 'Add')}
        </Button>
      </div>
    </li>
  )
}

export function CatalogBrowser({
  items,
  categories,
  search,
  onSearchChange,
  categoryCode,
  onCategoryChange,
  page,
  totalPages,
  total,
  onPageChange,
  isLoading,
  error,
  currencyCode,
  unitPriceByProductId,
  onAdd,
}: CatalogBrowserProps) {
  const t = useT()
  const locale = useLocale()

  return (
    <PortalCard>
      <PortalCardHeader
        title={t('distributor_workspace.portal.ordering.catalog.title', 'Catalog')}
        description={t(
          'distributor_workspace.portal.ordering.catalog.description',
          'Net prices for your account. The basket recalculates every time you change it.',
        )}
      />
      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          leftIcon={<Search className="size-4" />}
          placeholder={t(
            'distributor_workspace.portal.ordering.catalog.searchPlaceholder',
            'Search by name or SKU',
          )}
          aria-label={t('distributor_workspace.portal.ordering.catalog.searchLabel', 'Search the catalog')}
          className="sm:flex-1"
        />
        <Select value={categoryCode} onValueChange={onCategoryChange}>
          <SelectTrigger
            className="sm:w-64"
            aria-label={t('distributor_workspace.portal.ordering.catalog.categoryLabel', 'Category')}
          >
            <SelectValue
              placeholder={t('distributor_workspace.portal.ordering.catalog.allCategories', 'All categories')}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CATEGORIES}>
              {t('distributor_workspace.portal.ordering.catalog.allCategories', 'All categories')}
            </SelectItem>
            {categories.map((category) => (
              <SelectItem key={category.code} value={category.code}>
                {`${category.label} (${category.productCount})`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4">
        {error ? <ErrorMessage label={error} /> : null}
        {!error && isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner />
          </div>
        ) : null}
        {!error && !isLoading && items.length === 0 ? (
          <EmptyState
            variant="subtle"
            size="lg"
            title={t('distributor_workspace.portal.ordering.catalog.emptyTitle', 'Nothing matches')}
            description={t(
              'distributor_workspace.portal.ordering.catalog.emptyDescription',
              'Try a different search term or clear the category filter.',
            )}
          />
        ) : null}
        {!error && !isLoading && items.length > 0 ? (
          <ul className="flex flex-col">
            {items.map((item) => (
              <CatalogRow
                key={item.productId}
                item={item}
                price={unitPriceByProductId.get(item.productId)}
                currencyCode={currencyCode}
                locale={locale}
                onAdd={onAdd}
              />
            ))}
          </ul>
        ) : null}
      </div>

      {totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-between border-t pt-4">
          <span className="text-xs text-muted-foreground">
            {t(
              'distributor_workspace.portal.ordering.catalog.pageOf',
              'Page {page} of {totalPages} ({total} products)',
              { page: String(page), totalPages: String(totalPages), total: String(total) },
            )}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={page <= 1 || isLoading}
              onClick={() => onPageChange(page - 1)}
            >
              {t('distributor_workspace.portal.ordering.catalog.previous', 'Previous')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={page >= totalPages || isLoading}
              onClick={() => onPageChange(page + 1)}
            >
              {t('distributor_workspace.portal.ordering.catalog.next', 'Next')}
            </Button>
          </div>
        </div>
      ) : null}
    </PortalCard>
  )
}
