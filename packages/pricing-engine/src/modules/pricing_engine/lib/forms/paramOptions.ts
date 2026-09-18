'use client'

import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import type { CrudFieldOption } from '@open-mercato/ui/backend/CrudForm'
import type { LookupSelectItem } from '@open-mercato/ui/backend/inputs'

/**
 * Option loaders for the pricing parameter forms.
 *
 * Several of these fields are free-text `text` columns that behave as enumerations in practice:
 * a process step's `role_code` only does anything if a labour rate exists for the same code, and a
 * vehicle's `fuel_type` only does anything if a fuel observation exists for it. Offering the codes
 * that are actually present turns a silent no-op into a visible choice, which is why these read the
 * live tables instead of hard-coding the seeded set.
 */

type ListResult = { items?: Array<Record<string, unknown>> }

const LOOKUP_PAGE_SIZE = '100'

async function fetchItems(path: string): Promise<Array<Record<string, unknown>>> {
  const call = await apiCall<ListResult>(path, undefined, { fallback: { items: [] } })
  const items = call.result?.items
  return Array.isArray(items) ? items : []
}

function readString(item: Record<string, unknown>, key: string): string | null {
  const value = item[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function distinctOptions(
  items: Array<Record<string, unknown>>,
  valueKey: string,
  labelKey?: string,
): CrudFieldOption[] {
  const byValue = new Map<string, string>()
  for (const item of items) {
    const value = readString(item, valueKey)
    if (!value || byValue.has(value)) continue
    const label = labelKey ? readString(item, labelKey) : null
    byValue.set(value, label ? `${label} (${value})` : value)
  }
  return Array.from(byValue.entries())
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label))
}

export async function loadLaborRoleOptions(): Promise<CrudFieldOption[]> {
  return distinctOptions(
    await fetchItems(`/api/pricing/labor-rates?pageSize=${LOOKUP_PAGE_SIZE}`),
    'roleCode',
  )
}

export async function loadProcessStepCodeOptions(): Promise<CrudFieldOption[]> {
  return distinctOptions(
    await fetchItems(`/api/pricing/process-steps?pageSize=${LOOKUP_PAGE_SIZE}`),
    'code',
  )
}

export async function loadVehicleCodeOptions(): Promise<CrudFieldOption[]> {
  return distinctOptions(
    await fetchItems(`/api/pricing/vehicles?isActive=true&pageSize=${LOOKUP_PAGE_SIZE}`),
    'code',
    'label',
  )
}

export async function loadFuelTypeOptions(): Promise<CrudFieldOption[]> {
  return distinctOptions(
    await fetchItems(`/api/pricing/fuel-prices?pageSize=${LOOKUP_PAGE_SIZE}`),
    'fuelType',
  )
}

export async function loadPackagingUnitOptions(): Promise<CrudFieldOption[]> {
  return distinctOptions(
    await fetchItems(`/api/pricing/packaging-costs?pageSize=${LOOKUP_PAGE_SIZE}`),
    'unitCode',
  )
}

/**
 * The product-group codes a `product_group` rule can point at. These are the catalog group codes
 * the engine sees, which it reads off the purchase position — so anything not listed here would
 * never match a quote.
 */
export async function loadProductGroupOptions(): Promise<CrudFieldOption[]> {
  return distinctOptions(
    await fetchItems(`/api/pricing/purchase-positions?pageSize=${LOOKUP_PAGE_SIZE}`),
    'productGroupCode',
  )
}

/**
 * Customer-group codes already used by a rule or a guardrail. There is no table of customer groups
 * to enumerate — the code is a free string on the customer's pricing profile — so the existing
 * rules are the only evidence of which codes are real. The field stays free-text on purpose.
 */
export async function loadCustomerGroupOptions(): Promise<CrudFieldOption[]> {
  const [rules, guardrails] = await Promise.all([
    fetchItems(`/api/pricing/margin-rules?scope=customer_group&pageSize=${LOOKUP_PAGE_SIZE}`),
    fetchItems(`/api/pricing/guardrails?scope=customer_group&pageSize=${LOOKUP_PAGE_SIZE}`),
  ])
  return distinctOptions([...rules, ...guardrails], 'scopeRefId')
}

function buildQuery(query: string | undefined, pageSize: number): string {
  const params = new URLSearchParams({ page: '1', pageSize: String(pageSize) })
  const trimmed = query?.trim()
  if (trimmed) params.set('search', trimmed)
  return params.toString()
}

export async function loadProductLookupItems(query?: string): Promise<LookupSelectItem[]> {
  const items = await fetchItems(`/api/catalog/products?${buildQuery(query, 20)}`)
  return items
    .map((item) => {
      const id = readString(item, 'id')
      if (!id) return null
      const option: LookupSelectItem = {
        id,
        title: readString(item, 'title') ?? readString(item, 'name') ?? id,
        subtitle: readString(item, 'sku'),
      }
      return option
    })
    .filter((item): item is LookupSelectItem => item !== null)
}

function customerTitle(item: Record<string, unknown>): string | null {
  const name = readString(item, 'name') ?? readString(item, 'displayName')
  if (name) return name
  const first = readString(item, 'firstName')
  const last = readString(item, 'lastName')
  const joined = [first, last].filter(Boolean).join(' ')
  return joined.length > 0 ? joined : readString(item, 'email')
}

/**
 * A `customer`-scoped rule keys off the customer's UUID, not a code — so this has to resolve real
 * records. Customers live in two tables (people and companies) and both can hold a contract.
 */
export async function loadCustomerLookupItems(query?: string): Promise<LookupSelectItem[]> {
  const search = buildQuery(query, 20)
  const [people, companies] = await Promise.all([
    fetchItems(`/api/customers/people?${search}`),
    fetchItems(`/api/customers/companies?${search}`),
  ])
  const mapped = [...people, ...companies]
    .map((item) => {
      const id = readString(item, 'id')
      if (!id) return null
      const option: LookupSelectItem = {
        id,
        title: customerTitle(item) ?? id,
        subtitle: readString(item, 'email') ?? readString(item, 'taxId'),
      }
      return option
    })
    .filter((item): item is LookupSelectItem => item !== null)
  const byId = new Map(mapped.map((item) => [item.id, item]))
  return Array.from(byId.values())
}
