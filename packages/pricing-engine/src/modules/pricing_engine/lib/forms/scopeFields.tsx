'use client'

import * as React from 'react'
import { LookupSelect } from '@open-mercato/ui/backend/inputs'
import { createCrudFormError } from '@open-mercato/ui/backend/utils/serverErrors'
import type { CrudField, CrudCustomFieldRenderProps } from '@open-mercato/ui/backend/CrudForm'
import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import type { PricingParamScopeValue } from '../../data/validators'
import {
  loadCustomerGroupOptions,
  loadCustomerLookupItems,
  loadProductGroupOptions,
  loadProductLookupItems,
} from './paramOptions'
import { readOptionalText, readText, type ParamFormValues } from './paramScreens'

/**
 * Scope is shared by margin rules and guardrails, and both resolve it through the same precedence
 * in `lib/params.ts`: customer > customer_group > product > product_group > global.
 *
 * Each scope needs a different kind of reference — a UUID for a customer or product, a code for a
 * group, nothing at all for global — so the form carries one field per scope and `readScopeRef`
 * picks the one the chosen scope actually uses. A single shared field would have to be a picker
 * and a text box at once, and would silently keep the previous scope's value on a scope change.
 */

const SCOPE_VALUES: PricingParamScopeValue[] = [
  'global',
  'product_group',
  'product',
  'customer_group',
  'customer',
]

export function scopeOptions(t: TranslateFn) {
  return [
    { value: 'global', label: t('pricing_engine.params.scope.global', 'Everything (house default)') },
    { value: 'product_group', label: t('pricing_engine.params.scope.productGroup', 'Product group') },
    { value: 'product', label: t('pricing_engine.params.scope.product', 'Single product') },
    { value: 'customer_group', label: t('pricing_engine.params.scope.customerGroup', 'Customer group') },
    { value: 'customer', label: t('pricing_engine.params.scope.customer', 'Single customer') },
  ]
}

export function scopeLabel(t: TranslateFn, scope: string): string {
  const match = scopeOptions(t).find((option) => option.value === scope)
  return match?.label ?? scope
}

/** Lower index wins when two rules could both apply. Mirrors SCOPE_PRECEDENCE in lib/params.ts. */
export function scopePrecedenceRank(scope: string): number {
  const order: PricingParamScopeValue[] = [
    'customer',
    'customer_group',
    'product',
    'product_group',
    'global',
  ]
  const index = order.indexOf(scope as PricingParamScopeValue)
  return index === -1 ? order.length : index
}

function lookupField(
  id: string,
  label: string,
  scope: PricingParamScopeValue,
  fetchItems: (query?: string) => Promise<Array<{ id: string; title: string; subtitle?: string | null }>>,
  description: string,
): CrudField {
  return {
    id,
    type: 'custom',
    label,
    description,
    visibleWhen: { field: 'scope', equals: scope },
    component: ({ value, setValue, disabled }: CrudCustomFieldRenderProps) => (
      <LookupSelect
        value={typeof value === 'string' && value.length > 0 ? value : null}
        onChange={(next) => setValue(next ?? '')}
        fetchItems={(query) => fetchItems(query)}
        disabled={disabled}
      />
    ),
  }
}

export function scopeFields(t: TranslateFn): CrudField[] {
  return [
    {
      id: 'scope',
      type: 'select',
      label: t('pricing_engine.params.field.scope', 'Applies to'),
      required: true,
      options: scopeOptions(t),
      description: t(
        'pricing_engine.params.field.scopeHint',
        'The most specific match wins: customer, then customer group, then product, then product group, then the house default.',
      ),
      layout: 'half',
    },
    {
      id: 'scopeRefProductGroup',
      type: 'combobox',
      label: t('pricing_engine.params.field.productGroup', 'Product group code'),
      allowCustomValues: true,
      loadOptions: () => loadProductGroupOptions(),
      visibleWhen: { field: 'scope', equals: 'product_group' },
      description: t(
        'pricing_engine.params.field.productGroupHint',
        'Must match the group code on the purchase position, or the rule never matches a quote.',
      ),
      layout: 'half',
    },
    {
      id: 'scopeRefCustomerGroup',
      type: 'combobox',
      label: t('pricing_engine.params.field.customerGroup', 'Customer group code'),
      allowCustomValues: true,
      loadOptions: () => loadCustomerGroupOptions(),
      visibleWhen: { field: 'scope', equals: 'customer_group' },
      description: t(
        'pricing_engine.params.field.customerGroupHint',
        "Must match the group code on the customer's pricing profile.",
      ),
      layout: 'half',
    },
    lookupField(
      'scopeRefProduct',
      t('pricing_engine.params.field.product', 'Product'),
      'product',
      loadProductLookupItems,
      t('pricing_engine.params.field.productHint', 'The rule applies to this product only.'),
    ),
    lookupField(
      'scopeRefCustomer',
      t('pricing_engine.params.field.customer', 'Customer'),
      'customer',
      loadCustomerLookupItems,
      t('pricing_engine.params.field.customerHint', 'The rule applies to this customer only.'),
    ),
  ]
}

const SCOPE_FIELD_BY_SCOPE: Partial<Record<PricingParamScopeValue, string>> = {
  product_group: 'scopeRefProductGroup',
  customer_group: 'scopeRefCustomerGroup',
  product: 'scopeRefProduct',
  customer: 'scopeRefCustomer',
}

export function readScope(values: ParamFormValues): PricingParamScopeValue {
  const raw = readText(values, 'scope')
  return (SCOPE_VALUES as string[]).includes(raw) ? (raw as PricingParamScopeValue) : 'global'
}

export function readScopeRef(
  values: ParamFormValues,
  t: TranslateFn,
): { scope: PricingParamScopeValue; scopeRefId: string | null } {
  const scope = readScope(values)
  if (scope === 'global') return { scope, scopeRefId: null }
  const fieldId = SCOPE_FIELD_BY_SCOPE[scope]
  const scopeRefId = fieldId ? readOptionalText(values, fieldId) : null
  if (!scopeRefId) {
    throw createCrudFormError(
      t('pricing_engine.params.errors.scopeRefRequired', 'Pick what this applies to.'),
      fieldId
        ? { [fieldId]: t('pricing_engine.params.errors.required', 'Required.') }
        : undefined,
    )
  }
  return { scope, scopeRefId }
}

export function scopeValues(
  scope: string,
  scopeRefId: string | null | undefined,
): ParamFormValues {
  const fieldId = SCOPE_FIELD_BY_SCOPE[scope as PricingParamScopeValue]
  return {
    scope,
    scopeRefProductGroup: '',
    scopeRefCustomerGroup: '',
    scopeRefProduct: '',
    scopeRefCustomer: '',
    ...(fieldId ? { [fieldId]: scopeRefId ?? '' } : {}),
  }
}
