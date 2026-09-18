'use client'

import * as React from 'react'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { LookupSelect } from '@open-mercato/ui/backend/inputs'
import type { CrudCustomFieldRenderProps } from '@open-mercato/ui/backend/CrudForm'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { loadProductGroupOptions, loadProductLookupItems } from './paramOptions'
import {
  demoColumn,
  isoToDateInput,
  optionalDate,
  optionalDecimal,
  readOptionalText,
  requireDecimal,
  requireText,
  type ParamRowBase,
  type ParamScreenDescriptor,
} from './paramScreens'

/**
 * The measured purchase cost every price starts from. `last_delivery_unit_cost` is the only
 * number in the whole waterfall that comes from an invoice rather than an assumption, and its age
 * decides whether `product_cost` reports itself as fresh, stale or missing — so the list leads with
 * how old it is.
 */

const STALE_AFTER_DAYS = 90

export type PurchasePositionRow = ParamRowBase & {
  catalogProductId: string
  sku: string | null
  annualVolume: string
  currentTierCode: string | null
  currentTierDiscount: string
  nextTierVolume: string | null
  nextTierDiscount: string | null
  lastDeliveryUnitCost: string | null
  lastDeliveryAt: string | null
  lastDeliveryAgeDays: number | null
  lastDeliveryQuantity: string | null
  soldQuantityPeriod: string | null
  productGroupCode: string | null
}

export const purchasePositionDescriptor: ParamScreenDescriptor<PurchasePositionRow> = {
  segment: 'purchase-positions',
  apiPath: 'pricing/purchase-positions',
  keyPrefix: 'pricing_engine.params.purchasePositions',
  titleFallback: 'Purchase positions',
  resourceKind: 'pricing_engine.purchase_position',
  timeVersioned: false,
  searchPlaceholderFallback: 'Search by SKU or product group',
  columns: (t) => [
    {
      accessorKey: 'sku',
      header: t('pricing_engine.params.purchasePositions.column.sku', 'SKU'),
      cell: ({ row }) => <span className="font-mono">{row.original.sku ?? '—'}</span>,
    },
    {
      accessorKey: 'productGroupCode',
      header: t('pricing_engine.params.purchasePositions.column.group', 'Product group'),
      cell: ({ row }) => row.original.productGroupCode ?? '—',
    },
    {
      accessorKey: 'lastDeliveryUnitCost',
      header: t('pricing_engine.params.purchasePositions.column.unitCost', 'Purchase cost'),
      cell: ({ row }) => <span className="font-mono">{row.original.lastDeliveryUnitCost ?? '—'}</span>,
    },
    {
      accessorKey: 'lastDeliveryAgeDays',
      header: t('pricing_engine.params.purchasePositions.column.freshness', 'Cost age'),
      cell: ({ row }) => {
        const age = row.original.lastDeliveryAgeDays
        if (age === null) {
          return (
            <Badge variant="error">
              {t('pricing_engine.params.purchasePositions.freshness.missing', 'No delivery recorded')}
            </Badge>
          )
        }
        const label = t('pricing_engine.params.purchasePositions.freshness.days', '{days} days', {
          days: String(age),
        })
        return age > STALE_AFTER_DAYS ? (
          <Badge variant="warning">{label}</Badge>
        ) : (
          <Badge variant="success">{label}</Badge>
        )
      },
    },
    {
      accessorKey: 'currentTierDiscount',
      header: t('pricing_engine.params.purchasePositions.column.tier', 'Rebate tier'),
      cell: ({ row }) => (
        <span className="font-mono">
          {row.original.currentTierCode ? `${row.original.currentTierCode} ` : ''}
          {row.original.currentTierDiscount}%
        </span>
      ),
    },
    demoColumn<PurchasePositionRow>(t),
  ],
  filters: (t) => [
    {
      id: 'productGroupCode',
      type: 'combobox',
      label: t('pricing_engine.params.purchasePositions.column.group', 'Product group'),
      loadOptions: () => loadProductGroupOptions(),
    },
  ] satisfies FilterDef[],
  filterParams: (values: FilterValues) => ({
    productGroupCode: typeof values.productGroupCode === 'string' ? values.productGroupCode : '',
  }),
  groups: (t) => [
    {
      id: 'product',
      title: t('pricing_engine.params.purchasePositions.group.product', 'Product'),
      fields: [
        {
          id: 'catalogProductId',
          type: 'custom',
          label: t('pricing_engine.params.purchasePositions.field.product', 'Catalog product'),
          required: true,
          component: ({ value, setValue, disabled }: CrudCustomFieldRenderProps) => (
            <LookupSelect
              value={typeof value === 'string' && value.length > 0 ? value : null}
              onChange={(next) => setValue(next ?? '')}
              fetchItems={(query) => loadProductLookupItems(query)}
              disabled={disabled}
            />
          ),
        },
        {
          id: 'sku',
          type: 'text',
          label: t('pricing_engine.params.purchasePositions.column.sku', 'SKU'),
          layout: 'half',
        },
        {
          id: 'productGroupCode',
          type: 'combobox',
          label: t('pricing_engine.params.purchasePositions.column.group', 'Product group'),
          allowCustomValues: true,
          loadOptions: () => loadProductGroupOptions(),
          description: t(
            'pricing_engine.params.purchasePositions.field.groupHint',
            'The key every product-group margin rule resolves against.',
          ),
          layout: 'half',
        },
      ],
    },
    {
      id: 'delivery',
      title: t('pricing_engine.params.purchasePositions.group.delivery', 'Last delivery'),
      description: t(
        'pricing_engine.params.purchasePositions.group.deliveryHint',
        'This is the measured cost the whole price is built on.',
      ),
      fields: [
        {
          id: 'lastDeliveryUnitCost',
          type: 'number',
          label: t('pricing_engine.params.purchasePositions.field.unitCost', 'Unit cost'),
          layout: 'third',
        },
        {
          id: 'lastDeliveryQuantity',
          type: 'number',
          label: t('pricing_engine.params.purchasePositions.field.quantity', 'Quantity'),
          layout: 'third',
        },
        {
          id: 'lastDeliveryAt',
          type: 'date',
          label: t('pricing_engine.params.purchasePositions.field.deliveredOn', 'Delivered on'),
          layout: 'third',
        },
      ],
    },
    {
      id: 'tiers',
      title: t('pricing_engine.params.purchasePositions.group.tiers', 'Supplier rebate tiers'),
      fields: [
        {
          id: 'annualVolume',
          type: 'number',
          label: t('pricing_engine.params.purchasePositions.field.annualVolume', 'Annual volume'),
          required: true,
          layout: 'half',
        },
        {
          id: 'soldQuantityPeriod',
          type: 'number',
          label: t('pricing_engine.params.purchasePositions.field.soldQuantity', 'Sold in period'),
          layout: 'half',
        },
        {
          id: 'currentTierCode',
          type: 'text',
          label: t('pricing_engine.params.purchasePositions.field.currentTier', 'Current tier'),
          layout: 'half',
        },
        {
          id: 'currentTierDiscount',
          type: 'number',
          label: t('pricing_engine.params.purchasePositions.field.currentDiscount', 'Current discount (%)'),
          required: true,
          layout: 'half',
        },
        {
          id: 'nextTierVolume',
          type: 'number',
          label: t('pricing_engine.params.purchasePositions.field.nextVolume', 'Next tier volume'),
          layout: 'half',
        },
        {
          id: 'nextTierDiscount',
          type: 'number',
          label: t('pricing_engine.params.purchasePositions.field.nextDiscount', 'Next tier discount (%)'),
          layout: 'half',
        },
      ],
    },
  ],
  createDefaults: () => ({
    catalogProductId: '',
    sku: '',
    productGroupCode: '',
    lastDeliveryUnitCost: '',
    lastDeliveryQuantity: '',
    lastDeliveryAt: '',
    annualVolume: '0',
    soldQuantityPeriod: '',
    currentTierCode: '',
    currentTierDiscount: '0',
    nextTierVolume: '',
    nextTierDiscount: '',
  }),
  toValues: (row) => ({
    catalogProductId: row.catalogProductId,
    sku: row.sku ?? '',
    productGroupCode: row.productGroupCode ?? '',
    lastDeliveryUnitCost: row.lastDeliveryUnitCost ?? '',
    lastDeliveryQuantity: row.lastDeliveryQuantity ?? '',
    lastDeliveryAt: isoToDateInput(row.lastDeliveryAt),
    annualVolume: row.annualVolume,
    soldQuantityPeriod: row.soldQuantityPeriod ?? '',
    currentTierCode: row.currentTierCode ?? '',
    currentTierDiscount: row.currentTierDiscount,
    nextTierVolume: row.nextTierVolume ?? '',
    nextTierDiscount: row.nextTierDiscount ?? '',
  }),
  buildPayload: (values, t) => ({
    catalogProductId: requireText(
      values,
      'catalogProductId',
      t,
      t('pricing_engine.params.purchasePositions.field.product', 'Catalog product'),
    ),
    sku: readOptionalText(values, 'sku'),
    productGroupCode: readOptionalText(values, 'productGroupCode'),
    lastDeliveryUnitCost: optionalDecimal(
      values,
      'lastDeliveryUnitCost',
      t,
      t('pricing_engine.params.purchasePositions.field.unitCost', 'Unit cost'),
    ),
    lastDeliveryQuantity: optionalDecimal(
      values,
      'lastDeliveryQuantity',
      t,
      t('pricing_engine.params.purchasePositions.field.quantity', 'Quantity'),
    ),
    lastDeliveryAt: optionalDate(values, 'lastDeliveryAt'),
    annualVolume: requireDecimal(
      values,
      'annualVolume',
      t,
      t('pricing_engine.params.purchasePositions.field.annualVolume', 'Annual volume'),
    ),
    soldQuantityPeriod: optionalDecimal(
      values,
      'soldQuantityPeriod',
      t,
      t('pricing_engine.params.purchasePositions.field.soldQuantity', 'Sold in period'),
    ),
    currentTierCode: readOptionalText(values, 'currentTierCode'),
    currentTierDiscount: requireDecimal(
      values,
      'currentTierDiscount',
      t,
      t('pricing_engine.params.purchasePositions.field.currentDiscount', 'Current discount (%)'),
    ),
    nextTierVolume: optionalDecimal(
      values,
      'nextTierVolume',
      t,
      t('pricing_engine.params.purchasePositions.field.nextVolume', 'Next tier volume'),
    ),
    nextTierDiscount: optionalDecimal(
      values,
      'nextTierDiscount',
      t,
      t('pricing_engine.params.purchasePositions.field.nextDiscount', 'Next tier discount (%)'),
    ),
  }),
  rowTitle: (row) => row.sku ?? row.catalogProductId,
}
