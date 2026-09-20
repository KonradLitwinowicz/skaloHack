'use client'

import * as React from 'react'
import Link from 'next/link'
import { z } from 'zod'
import { Trash2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@open-mercato/ui/primitives/table'
import { LookupSelect, type LookupSelectItem } from '@open-mercato/ui/backend/inputs'
import {
  CrudForm,
  type CrudCustomFieldRenderProps,
  type CrudFieldOption,
  type CrudFormGroup,
} from '@open-mercato/ui/backend/CrudForm'
import { createCrud, updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { createCrudFormError } from '@open-mercato/ui/backend/utils/serverErrors'
import { ErrorMessage, LoadingMessage, TabEmptyState } from '@open-mercato/ui/backend/detail'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { hasFeature } from '@open-mercato/shared/security/features'
import { useT, type TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { buildDeskHref } from '../../../lib/frontend/basketDesk'
import { formatMoney, lineMargin } from '../../../lib/frontend/marginMath'
import { isoToDateInput } from '../../../lib/forms/paramValues'

export const PROFILES_API_PATH = 'pricing/customer-profiles'
export const IMPACT_API_PATH = 'pricing/customer-pricing-impact'

const PRODUCT_PAGE_SIZE = 8
const OPTION_PAGE_SIZE = 100

/**
 * `/api/pricing/customer-pricing-impact` prices ONE line per call and requires a proposed price,
 * so a row the operator has only just added — no agreed price typed yet — still needs a number to
 * send. Zero is the safe one: the engine price, the cost and the floor come from runs that never
 * see the proposed price (`route.ts` prices the line three ways and only `appliedPrice` /
 * `proposedPrice` depend on it), so a zero probe returns exactly the same three figures a real
 * price would. Verified live: the same product answers `enginePrice 160.66` / `floor 112.61` at
 * `proposedUnitPriceNet=25.00` and at `proposedUnitPriceNet=0`.
 */
export const IMPACT_PROBE_UNIT_PRICE = '0'

/** Enough to keep a normal negotiated list snappy without opening a socket per product. */
const IMPACT_CONCURRENCY = 4

/**
 * The host page (`customers/backend/customers/companies-v2/[id]/page.tsx`) hands over
 * `{ formId, companyId, resourceKind, resourceId, data, retryLastMutation }`. `companyId` is
 * `CompanyOverview.company.id`, which the companies API fills from a `CustomerEntity` — the same
 * id `pricing_customer_profiles.customer_id` stores (verified: all 40 seeded profiles join
 * `customer_entities`, none join `customer_companies`).
 */
export type CustomerPricingContext = {
  companyId?: string | null
  resourceKind?: string | null
  resourceId?: string | null
}

export function readCustomerId(context: unknown): string | null {
  if (!context || typeof context !== 'object') return null
  const candidate = context as CustomerPricingContext
  const companyId = typeof candidate.companyId === 'string' ? candidate.companyId.trim() : ''
  if (companyId) return companyId
  if (candidate.resourceKind !== 'customers.company') return null
  const resourceId = typeof candidate.resourceId === 'string' ? candidate.resourceId.trim() : ''
  return resourceId || null
}

export type CustomerPricingProfileRow = {
  id: string
  updatedAt: string | null
  customerGroupCode: string | null
  deliveryZoneCode: string | null
  defaultOrderScenarioCode: string | null
  negotiatedPrices: Record<string, string>
  negotiatedPriceExpiresAt: string | null
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  if (typeof value === 'string' && value.trim().length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function readPriceMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries: Array<[string, string]> = []
  for (const [productId, price] of Object.entries(value as Record<string, unknown>)) {
    if (!productId.trim()) continue
    if (typeof price === 'string' && price.trim().length > 0) entries.push([productId, price])
    else if (typeof price === 'number' && Number.isFinite(price)) entries.push([productId, String(price)])
  }
  return Object.fromEntries(entries)
}

export function toProfileRow(row: unknown): CustomerPricingProfileRow | null {
  if (!row || typeof row !== 'object') return null
  const source = row as Record<string, unknown>
  const id = readString(source, 'id')
  if (!id) return null
  return {
    id,
    updatedAt: readString(source, 'updatedAt'),
    customerGroupCode: readString(source, 'customerGroupCode'),
    deliveryZoneCode: readString(source, 'deliveryZoneCode'),
    defaultOrderScenarioCode: readString(source, 'defaultOrderScenarioCode'),
    negotiatedPrices: readPriceMap(source.negotiatedPrices),
    negotiatedPriceExpiresAt: readString(source, 'negotiatedPriceExpiresAt'),
  }
}

// ---------------------------------------------------------------------------
// The engine comparison
//
// The route answers for ONE product per call: `productId` (singular) plus a mandatory
// `proposedUnitPriceNet`. Its payload is a set of price facets, not an `items[]` array, so the tab
// asks once per product and assembles the table itself.
//
// The schema below is deliberately narrow — only the fields this tab renders. Zod strips unknown
// keys, so a field added to the route later reaches here as a no-op instead of a parse failure.
// ---------------------------------------------------------------------------

const impactPriceFacetSchema = z.object({ unitPriceNet: z.string() })

const impactResponseSchema = z.object({
  available: z.boolean(),
  unavailableReasonKeys: z.array(z.string()).default([]),
  currencyCode: z.string().default(''),
  productId: z.string().min(1),
  unitCostNet: z.string().nullable().default(null),
  negotiatedPrice: z
    .object({
      appliesToQuote: z.boolean().default(false),
      precedence: z.string().nullable().default(null),
    })
    .default({ appliesToQuote: false, precedence: null }),
  enginePrice: impactPriceFacetSchema.nullable().default(null),
  floor: z
    .object({
      unitPriceNet: z.string().nullable().default(null),
      // The engine's own name for the floor that bound the line. Read as a free string, not an
      // enum, so a source the engine adds later reaches the screen as an unfamiliar label instead
      // of failing the whole parse — and so a route that does not send the field at all still
      // parses, which keeps this tab working across a route deploy either way.
      source: z.string().nullable().default(null),
      unavailableReasonKey: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
})

/** The route's key for "no floor is in force here", as opposed to "the measurement failed". */
const FLOOR_NOT_CONFIGURED_KEY = 'pricing_engine.customerPricingImpact.floor.notConfigured'

export type CustomerPricingImpactPayload = z.infer<typeof impactResponseSchema>

export type PricingImpactItem = {
  productId: string
  available: boolean
  unavailableReasonKeys: string[]
  /** The only place this tab learns the currency from — the profile row carries none. */
  currencyCode: string
  unitCostNet: string | null
  enginePriceNet: string | null
  /** The engine's own floor, read back from the route. Never re-derived on this side. */
  floorPriceNet: string | null
  /** Which floor bound the line — a minimum margin is a policy, an expiry ladder is a deadline. */
  floorSource: string | null
  /** Set when the route says there is no floor at all, which is not the same as "not known". */
  floorUnavailableReasonKey: string | null
  /** `null` means the route did not say — the panel then refuses to claim the price will apply. */
  negotiatedPriceApplies: boolean | null
  negotiatedPricePrecedence: string | null
}

export type PricingImpact = {
  currencyCode: string
  items: Record<string, PricingImpactItem>
  /** `null` when nothing could be projected, or when the products disagree. */
  negotiatedPriceApplies: boolean | null
}

export function parseImpactPayload(payload: unknown): PricingImpactItem | null {
  const parsed = impactResponseSchema.safeParse(payload)
  if (!parsed.success) return null
  const data = parsed.data
  // An unavailable answer reports `appliesToQuote: false` because it computed nothing, not because
  // a guardrail switched negotiated prices off. Reading it as a decision would put a false
  // "negotiated prices are switched off" banner on the screen.
  const negotiatedPriceApplies = data.available ? data.negotiatedPrice.appliesToQuote : null
  return {
    productId: data.productId,
    available: data.available,
    unavailableReasonKeys: data.unavailableReasonKeys,
    currencyCode: data.currencyCode,
    unitCostNet: data.unitCostNet,
    enginePriceNet: data.enginePrice?.unitPriceNet ?? null,
    floorPriceNet: data.floor?.unitPriceNet ?? null,
    floorSource: data.floor?.source ?? null,
    floorUnavailableReasonKey: data.floor?.unavailableReasonKey ?? null,
    negotiatedPriceApplies,
    negotiatedPricePrecedence: data.available ? data.negotiatedPrice.precedence : null,
  }
}

/**
 * One answer per product, so precedence is answered per product too. It is reported for the whole
 * customer only when every product agrees; a single "switched off" product is worth the warning,
 * and anything else stays unknown rather than being averaged into a claim.
 */
export function summarizeNegotiatedPrecedence(items: PricingImpactItem[]): boolean | null {
  const decided = items
    .map((item) => item.negotiatedPriceApplies)
    .filter((applies): applies is boolean => applies !== null)
  if (decided.length === 0 || decided.length !== items.length) return null
  if (decided.some((applies) => applies === false)) return false
  return true
}

export function buildImpactRequestUrl(args: {
  customerId: string
  productId: string
  proposedUnitPriceNet: string
}): string {
  const params = new URLSearchParams({
    customerId: args.customerId,
    productId: args.productId,
    proposedUnitPriceNet: args.proposedUnitPriceNet,
  })
  return `/api/${IMPACT_API_PATH}?${params.toString()}`
}

export type ImpactProductRequest = { productId: string; proposedUnitPriceNet: string }

export type ImpactFetcher = (url: string) => Promise<unknown>

async function fetchImpactPayload(url: string): Promise<unknown> {
  const call = await apiCall<unknown>(url, undefined, { fallback: null })
  if (!call.ok) return null
  return call.result
}

async function mapWithConcurrency<TInput, TOutput>(
  inputs: TInput[],
  limit: number,
  run: (input: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = new Array<TOutput>(inputs.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, inputs.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= inputs.length) return
      results[index] = await run(inputs[index])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Failures are isolated per product on purpose: one product missing from the catalogue must not
 * blank the engine figures for every other row in the table.
 */
export async function loadCustomerPricingImpact(args: {
  customerId: string
  products: ImpactProductRequest[]
  fetcher?: ImpactFetcher
}): Promise<PricingImpact> {
  const fetcher = args.fetcher ?? fetchImpactPayload
  const parsed = await mapWithConcurrency(args.products, IMPACT_CONCURRENCY, async (product) => {
    try {
      const payload = await fetcher(
        buildImpactRequestUrl({
          customerId: args.customerId,
          productId: product.productId,
          proposedUnitPriceNet: product.proposedUnitPriceNet,
        }),
      )
      return parseImpactPayload(payload)
    } catch {
      return null
    }
  })
  const items: Record<string, PricingImpactItem> = {}
  let currencyCode = ''
  for (const [index, item] of parsed.entries()) {
    if (!item) continue
    // The route echoes the product it was asked about; key on the request so a mismatched echo
    // cannot silently attach one product's figures to another product's row.
    items[args.products[index].productId] = item
    if (!currencyCode) currencyCode = item.currencyCode
  }
  return {
    currencyCode,
    items,
    negotiatedPriceApplies: summarizeNegotiatedPrecedence(Object.values(items)),
  }
}

export type NegotiatedRow = {
  productId: string
  label: string
  price: string
}

export type EngineOutcomeState = 'applied' | 'raisedToFloor' | 'ignored' | 'unknown'

export type FloorState = 'known' | 'notConfigured' | 'unknown'

export type EngineOutcome = {
  state: EngineOutcomeState
  enginePriceNet: string | null
  floorState: FloorState
  floorPriceNet: string | null
  floorSource: string | null
  effectivePriceNet: string | null
  operatorMarginPercent: string | null
  unavailableReasonKeys: string[]
}

function toFiniteNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * The floor is the engine's answer or nothing.
 *
 * There is deliberately no fallback arithmetic here. `max(floorPrice, price for minMargin)` is only
 * the ORDINARY floor: the shelf-life ladder replaces it with a quantity-weighted blend
 * (`lib/components/guardrails.ts`), and `api/customer-pricing-impact/route.ts` avoids re-deriving it
 * for exactly that reason — it pushes a price under every floor and reads back what the pipeline
 * returns. A second copy of the rule on this side would print a different number for the same thing
 * on the same screen the first time either half changed.
 */
function resolveFloor(item: PricingImpactItem | null): { state: FloorState; priceNet: string | null } {
  if (!item || !item.available) return { state: 'unknown', priceNet: null }
  if (item.floorPriceNet !== null) return { state: 'known', priceNet: item.floorPriceNet }
  // Only THIS key means "nothing clamps this line". The route also reports a floor it could not
  // MEASURE, which is a failed measurement rather than the absence of a floor — reading the two as
  // one would tell the operator a price stands when the engine may still raise it.
  if (item.floorUnavailableReasonKey === FLOOR_NOT_CONFIGURED_KEY) {
    return { state: 'notConfigured', priceNet: null }
  }
  return { state: 'unknown', priceNet: null }
}

/**
 * What the engine will DO with the operator's price — never a veto.
 *
 * `lib/components/guardrails.ts` sets the negotiated price as the target and then runs
 * `applyNormalFloors` over it, so a price under the minimum-margin floor is RAISED to the floor and
 * reported through the `pricing_engine.warnings.minMarginEnforced` warning. Measured: 25 PLN on a
 * product the engine prices at 80.67 comes back as 49.82 at a 12% floor. A form that blocked the
 * entry would be describing behaviour the engine does not have.
 */
export function projectEngineOutcome(price: string, item: PricingImpactItem | null): EngineOutcome {
  const floor = resolveFloor(item)
  const enginePriceNet = item?.available ? item.enginePriceNet : null
  const operatorPrice = toFiniteNumber(price)
  const unitCostNet = item?.available ? item.unitCostNet : null
  // Margin has the PRICE in its denominator, so it is undefined at a price of zero and meaningless
  // below it. The route refuses to print one there (`marginUnavailableReasonKey`) and this side
  // follows: `lineMargin` would otherwise report a flat `0,0000%` for a price of 0, which reads as
  // a break-even line rather than as "no answer".
  const operatorMarginPercent =
    operatorPrice !== null && operatorPrice > 0 && unitCostNet !== null
      ? lineMargin(price, unitCostNet, '1').marginPercent
      : null
  const base = {
    enginePriceNet,
    floorState: floor.state,
    floorPriceNet: floor.priceNet,
    floorSource: item?.available ? item.floorSource : null,
    operatorMarginPercent,
    unavailableReasonKeys: item?.unavailableReasonKeys ?? [],
  }
  const negotiatedPriceApplies = item?.negotiatedPriceApplies ?? null

  if (negotiatedPriceApplies === false) {
    return { ...base, state: 'ignored', effectivePriceNet: enginePriceNet }
  }
  if (negotiatedPriceApplies === null || operatorPrice === null) {
    return { ...base, state: 'unknown', effectivePriceNet: null }
  }
  if (floor.state === 'unknown') {
    return { ...base, state: 'unknown', effectivePriceNet: null }
  }
  const floorValue = toFiniteNumber(floor.priceNet)
  if (floorValue !== null && operatorPrice < floorValue) {
    return { ...base, state: 'raisedToFloor', effectivePriceNet: floor.priceNet }
  }
  return { ...base, state: 'applied', effectivePriceNet: price }
}

/**
 * The stored map is `productId -> decimal string` and nothing else, so a row starts out labelled by
 * its id. The readable name arrives through `NegotiatedPricingContext.productLabels`, never through
 * `initialValues`: rebuilding those on every catalogue or impact refresh would remount the price
 * inputs and throw away what the operator has typed.
 */
export function rowsFromPrices(prices: Record<string, string>): NegotiatedRow[] {
  return Object.entries(prices).map(([productId, price]) => ({
    productId,
    label: productId,
    price,
  }))
}

export function pricesFromRows(rows: NegotiatedRow[]): Record<string, string> {
  const entries: Array<[string, string]> = []
  for (const row of rows) {
    const productId = row.productId.trim()
    const price = row.price.trim()
    if (!productId || !price) continue
    entries.push([productId, price])
  }
  return Object.fromEntries(entries)
}

export function labelForProduct(
  row: NegotiatedRow,
  productLabels: Record<string, string>,
): string {
  const resolved = productLabels[row.productId]
  if (resolved) return resolved
  return row.label.trim() || row.productId
}

/**
 * Percentages share the money formatter so one table row cannot mix `1 234,5600 PLN` with
 * `-75.36%`. `formatMoney` with no currency code is exactly the number half of that format.
 */
function formatPercent(value: string | null): string | null {
  if (toFiniteNumber(value) === null) return null
  return `${formatMoney(value ?? '', '')}%`
}

function toCamelCase(code: string): string {
  return code.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

/**
 * `/api/pricing/order-scenarios` stores TRANSLATION KEYS in `label`, and `/api/pricing/delivery-zones`
 * stores them for some rows and the operator's own wording for others. A code therefore reads best
 * off the loaded option list (already resolved by `loadCodeOptions`), and falls back to the key
 * convention the calculator, advisor and playground screens use before it ever shows a bare code.
 */
export function labelForCode(
  code: string | null,
  options: CodeOption[],
  keyPrefix: string,
  t: TranslateFn,
): string | null {
  if (!code) return null
  const match = options.find((option) => option.code === code)
  if (match && match.label.trim()) return match.label
  return t(`${keyPrefix}.${toCamelCase(code)}`, code)
}

function outcomeBadgeVariant(state: EngineOutcomeState): 'success' | 'warning' | 'neutral' {
  if (state === 'applied') return 'success'
  if (state === 'unknown') return 'neutral'
  return 'warning'
}

function outcomeLabel(state: EngineOutcomeState, t: TranslateFn): string {
  if (state === 'applied') {
    return t('pricing_engine.customerPricing.outcome.applied', 'Applied as entered')
  }
  if (state === 'raisedToFloor') {
    // Source-neutral on purpose: the minimum margin is only ONE of four floors the engine can
    // apply (the others are a fixed floor price, the shelf-life ladder and an authorised deadstock
    // floor). Naming one of them here would mislabel the other three; the row prints the actual
    // source next to the number, read from `effectiveFloorSource`.
    return t('pricing_engine.customerPricing.outcome.raisedToFloor', 'Raised to the floor')
  }
  if (state === 'ignored') {
    return t('pricing_engine.customerPricing.outcome.ignored', 'Ignored by the engine')
  }
  return t('pricing_engine.customerPricing.outcome.unknown', 'Cannot be projected yet')
}

// ---------------------------------------------------------------------------
// Impact wiring
//
// The negotiated-price editor lives inside a `CrudForm` custom field, whose definition has to stay
// referentially stable or the form remounts its inputs on every impact refresh. The impact data
// therefore reaches the editor through context rather than through the field definition.
// ---------------------------------------------------------------------------

export type NegotiatedPricingContextValue = {
  currencyCode: string
  impact: PricingImpact | null
  impactUnavailable: boolean
  productLabels: Record<string, string>
  canWrite: boolean
  onProductAdded: (productId: string) => void
}

const defaultNegotiatedPricingContext: NegotiatedPricingContextValue = {
  currencyCode: '',
  impact: null,
  impactUnavailable: true,
  productLabels: {},
  canWrite: false,
  onProductAdded: () => {},
}

export const NegotiatedPricingContext = React.createContext<NegotiatedPricingContextValue>(
  defaultNegotiatedPricingContext,
)

function toLookupItem(record: Record<string, unknown>): LookupSelectItem | null {
  const id = readString(record, 'id')
  if (!id) return null
  const title = readString(record, 'title') ?? readString(record, 'name') ?? readString(record, 'sku') ?? id
  return { id, title, subtitle: readString(record, 'sku') }
}

async function loadProductOptions(query?: string): Promise<LookupSelectItem[]> {
  const params = new URLSearchParams({ pageSize: String(PRODUCT_PAGE_SIZE) })
  const trimmed = query?.trim()
  if (trimmed) params.set('search', trimmed)
  else params.set('sortField', 'title')
  const call = await apiCall<{ items?: Array<Record<string, unknown>> }>(
    `/api/catalog/products?${params.toString()}`,
    undefined,
    { fallback: { items: [] } },
  )
  const items = Array.isArray(call.result?.items) ? call.result.items : []
  return items.map(toLookupItem).filter((item): item is LookupSelectItem => item !== null)
}

/**
 * `pricing_customer_profiles.negotiated_prices` stores ids only, so a saved row would otherwise
 * print a raw UUID at a sales rep. Failure is survivable by design: the row keeps its id.
 */
export async function loadProductLabels(productIds: string[]): Promise<Record<string, string>> {
  if (productIds.length === 0) return {}
  const batches: string[][] = []
  for (let index = 0; index < productIds.length; index += OPTION_PAGE_SIZE) {
    batches.push(productIds.slice(index, index + OPTION_PAGE_SIZE))
  }
  const responses = await mapWithConcurrency(batches, IMPACT_CONCURRENCY, async (batch) => {
    const params = new URLSearchParams({ ids: batch.join(','), pageSize: String(OPTION_PAGE_SIZE) })
    const call = await apiCall<{ items?: Array<Record<string, unknown>> }>(
      `/api/catalog/products?${params.toString()}`,
      undefined,
      { fallback: { items: [] } },
    )
    if (!call.ok) return []
    return Array.isArray(call.result?.items) ? call.result.items : []
  })
  const labels: Record<string, string> = {}
  for (const record of responses.flat()) {
    const option = toLookupItem(record)
    if (!option) continue
    labels[option.id] = option.subtitle ? `${option.title} (${option.subtitle})` : option.title
  }
  return labels
}

export type NegotiatedPricesEditorProps = {
  rows: NegotiatedRow[]
  onChange: (next: NegotiatedRow[]) => void
  error?: string
  fetchProducts?: (query?: string) => Promise<LookupSelectItem[]>
}

export function NegotiatedPricesEditor({
  rows,
  onChange,
  error,
  fetchProducts = loadProductOptions,
}: NegotiatedPricesEditorProps) {
  const t = useT()
  const { currencyCode, impact, impactUnavailable, productLabels, canWrite, onProductAdded } =
    React.useContext(NegotiatedPricingContext)
  const [pickerOpen, setPickerOpen] = React.useState(false)
  // Titles seen while searching, so picking a product does not cost a second round trip just to
  // learn its name.
  const seenTitlesRef = React.useRef(new Map<string, string>())

  const items = impact?.items ?? {}

  const searchProducts = React.useCallback(
    async (query?: string) => {
      const options = await fetchProducts(query)
      for (const option of options) seenTitlesRef.current.set(option.id, option.title)
      return options
    },
    [fetchProducts],
  )

  const handlePriceChange = React.useCallback(
    (productId: string, price: string) => {
      onChange(rows.map((row) => (row.productId === productId ? { ...row, price } : row)))
    },
    [onChange, rows],
  )

  const handleRemove = React.useCallback(
    (productId: string) => {
      onChange(rows.filter((row) => row.productId !== productId))
    },
    [onChange, rows],
  )

  const handlePick = React.useCallback(
    (next: string | null) => {
      if (!next) return
      setPickerOpen(false)
      if (rows.some((row) => row.productId === next)) return
      onChange([
        ...rows,
        { productId: next, label: seenTitlesRef.current.get(next) ?? next, price: '' },
      ])
      onProductAdded(next)
    },
    [onChange, onProductAdded, rows],
  )

  return (
    <div className="space-y-3" data-testid="negotiated-prices-editor">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t(
            'pricing_engine.customerPricing.negotiated.empty',
            'No negotiated prices yet. Every product this customer is quoted is priced by the engine.',
          )}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t('pricing_engine.customerPricing.column.product', 'Product')}
                </TableHead>
                <TableHead>
                  {t('pricing_engine.customerPricing.column.negotiatedPrice', 'Agreed unit price (net)')}
                </TableHead>
                <TableHead>
                  {t('pricing_engine.customerPricing.column.enginePrice', 'Engine price (net)')}
                </TableHead>
                <TableHead>
                  {t('pricing_engine.customerPricing.column.floorPrice', 'Floor (net)')}
                </TableHead>
                <TableHead>
                  {t('pricing_engine.customerPricing.column.operatorMargin', 'Margin at your price')}
                </TableHead>
                <TableHead>
                  {t('pricing_engine.customerPricing.column.outcome', 'What the engine will do')}
                </TableHead>
                {canWrite ? (
                  <TableHead>
                    <span className="sr-only">
                      {t('pricing_engine.customerPricing.action.remove', 'Remove this product')}
                    </span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const item = items[row.productId] ?? null
                const outcome = projectEngineOutcome(row.price, item)
                const marginText = formatPercent(outcome.operatorMarginPercent)
                return (
                  <TableRow key={row.productId} data-testid={`negotiated-row-${row.productId}`}>
                    <TableCell>
                      <span className="font-medium">{labelForProduct(row, productLabels)}</span>
                    </TableCell>
                    <TableCell>
                      {canWrite ? (
                        <Input
                          value={row.price}
                          inputMode="decimal"
                          aria-label={t(
                            'pricing_engine.customerPricing.field.negotiatedPriceForProduct',
                            'Agreed unit price, net',
                          )}
                          onChange={(event) => handlePriceChange(row.productId, event.target.value)}
                        />
                      ) : (
                        <span>{formatMoney(row.price, currencyCode)}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {outcome.enginePriceNet
                        ? formatMoney(outcome.enginePriceNet, currencyCode)
                        : t('pricing_engine.customerPricing.value.unknown', 'Not available')}
                    </TableCell>
                    <TableCell>
                      {outcome.floorPriceNet ? (
                        <div className="space-y-1">
                          <span>{formatMoney(outcome.floorPriceNet, currencyCode)}</span>
                          {/* A minimum margin is a policy, an expiry ladder is a deadline: the
                              same number calls for a different conversation with the customer. */}
                          {outcome.floorSource ? (
                            <p className="text-xs text-muted-foreground">
                              {labelForCode(
                                outcome.floorSource,
                                [],
                                'pricing_engine.customerPricing.floorSource',
                                t,
                              )}
                            </p>
                          ) : null}
                        </div>
                      ) : outcome.floorState === 'notConfigured' ? (
                        t('pricing_engine.customerPricing.value.noFloor', 'No floor configured')
                      ) : (
                        t('pricing_engine.customerPricing.value.unknown', 'Not available')
                      )}
                    </TableCell>
                    <TableCell>
                      {marginText ?? t('pricing_engine.customerPricing.value.unknown', 'Not available')}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Badge variant={outcomeBadgeVariant(outcome.state)}>
                          {outcomeLabel(outcome.state, t)}
                        </Badge>
                        {outcome.state === 'raisedToFloor' && outcome.effectivePriceNet ? (
                          <p className="text-xs text-muted-foreground">
                            {/* The minimum-margin warning is raised ONLY by the minimum-margin
                                floor. Measured on the live engine: an authorised deadstock floor
                                deliberately bypasses `applyNormalFloors`, so the quote carries NO
                                `minMarginEnforced` — promising one here would be false for every
                                floor that is not `min_margin`. */}
                            {outcome.floorSource === 'min_margin'
                              ? t(
                                  'pricing_engine.customerPricing.outcome.raisedToFloorDetail',
                                  'The engine quotes {price} and adds a minimum-margin warning.',
                                  { price: formatMoney(outcome.effectivePriceNet, currencyCode) },
                                )
                              : t(
                                  'pricing_engine.customerPricing.outcome.raisedToFloorDetailPlain',
                                  'The engine quotes {price}.',
                                  { price: formatMoney(outcome.effectivePriceNet, currencyCode) },
                                )}
                          </p>
                        ) : null}
                        {outcome.state === 'ignored' && outcome.effectivePriceNet ? (
                          <p className="text-xs text-muted-foreground">
                            {t(
                              'pricing_engine.customerPricing.outcome.ignoredDetail',
                              'The engine quotes {price} instead.',
                              { price: formatMoney(outcome.effectivePriceNet, currencyCode) },
                            )}
                          </p>
                        ) : null}
                        {outcome.unavailableReasonKeys.map((reasonKey) => (
                          <p key={reasonKey} className="text-xs text-muted-foreground">
                            {t(reasonKey, reasonKey)}
                          </p>
                        ))}
                      </div>
                    </TableCell>
                    {canWrite ? (
                      <TableCell>
                        <IconButton
                          variant="ghost"
                          size="sm"
                          aria-label={t('pricing_engine.customerPricing.action.remove', 'Remove this product')}
                          onClick={() => handleRemove(row.productId)}
                        >
                          <Trash2 />
                        </IconButton>
                      </TableCell>
                    ) : null}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {impactUnavailable ? (
        <Alert status="warning" style="lighter" size="sm">
          <AlertDescription>
            {t(
              'pricing_engine.customerPricing.impact.unavailable',
              'The engine comparison is unavailable right now, so the engine price, the floor and the margin cannot be shown. The prices below are still saved as entered.',
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {rows.length > 0 && !currencyCode ? (
        <Alert status="information" style="lighter" size="sm">
          <AlertDescription>
            {t(
              'pricing_engine.customerPricing.currencyUnknown',
              'The pricing engine reported no currency for this customer, so the amounts below carry none. Every amount on this tab is net — the engine does not handle VAT.',
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? <p className="text-sm text-status-error-text">{error}</p> : null}

      {canWrite ? (
        <div className="space-y-2">
          <Button type="button" variant="outline" onClick={() => setPickerOpen((open) => !open)}>
            {pickerOpen
              ? t('pricing_engine.customerPricing.action.cancelAdd', 'Cancel')
              : t('pricing_engine.customerPricing.action.add', 'Add product')}
          </Button>
          {pickerOpen ? (
            <LookupSelect
              value={null}
              onChange={handlePick}
              fetchOptions={searchProducts}
              minQuery={0}
              placeholder={t(
                'pricing_engine.customerPricing.action.pickProduct',
                'Find a catalogue product',
              )}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function readRows(value: unknown): NegotiatedRow[] {
  if (!Array.isArray(value)) return []
  const rows: NegotiatedRow[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const productId = typeof record.productId === 'string' ? record.productId : ''
    if (!productId) continue
    rows.push({
      productId,
      label: typeof record.label === 'string' ? record.label : productId,
      price: typeof record.price === 'string' ? record.price : '',
    })
  }
  return rows
}

export type CustomerPricingFormValues = {
  id?: string
  updatedAt?: string
  customerGroupCode: string
  deliveryZoneCode: string
  defaultOrderScenarioCode: string
  negotiatedPriceExpiresAt: string
  negotiatedPrices: NegotiatedRow[]
}

export type CodeOption = { code: string; label: string }

function toOptions(values: CodeOption[], emptyLabel: string): CrudFieldOption[] {
  return [
    { value: '', label: emptyLabel },
    ...values.map((entry) => ({ value: entry.code, label: entry.label })),
  ]
}

export function buildGroups(args: {
  t: TranslateFn
  deliveryZones: CodeOption[]
  orderScenarios: CodeOption[]
  groupCodeSuggestions: string[]
}): CrudFormGroup[] {
  const { t, deliveryZones, orderScenarios, groupCodeSuggestions } = args
  const notSet = t('pricing_engine.customerPricing.value.notSet', 'Not set')
  return [
    {
      id: 'terms',
      title: t('pricing_engine.customerPricing.group.terms', 'How this customer is priced'),
      description: t(
        'pricing_engine.customerPricing.group.termsDescription',
        'These three codes decide which margin rules, delivery cost and handling scenario the engine uses for every quote.',
      ),
      fields: [
        {
          id: 'customerGroupCode',
          type: 'text',
          label: t('pricing_engine.customerPricing.field.customerGroupCode', 'Customer group code'),
          suggestions: groupCodeSuggestions,
          description: t(
            'pricing_engine.customerPricing.field.customerGroupCodeHint',
            'Free text — there is no dictionary of groups. The suggestions are the codes that currently have a margin rule or a guardrail attached; any other code is saved but changes nothing in pricing.',
          ),
          layout: 'half',
        },
        {
          id: 'deliveryZoneCode',
          type: 'select',
          label: t('pricing_engine.customerPricing.field.deliveryZoneCode', 'Delivery zone'),
          options: toOptions(deliveryZones, notSet),
          layout: 'half',
        },
        {
          id: 'defaultOrderScenarioCode',
          type: 'select',
          label: t('pricing_engine.customerPricing.field.defaultOrderScenarioCode', 'Default order scenario'),
          options: toOptions(orderScenarios, notSet),
          layout: 'half',
        },
      ],
    },
    {
      id: 'negotiated',
      title: t('pricing_engine.customerPricing.group.negotiated', 'Negotiated prices'),
      description: t(
        'pricing_engine.customerPricing.group.negotiatedDescription',
        'Prices agreed with this customer, keyed by catalogue product. All amounts are net; the engine does not handle VAT.',
      ),
      fields: [
        {
          id: 'negotiatedPriceExpiresAt',
          type: 'date',
          label: t('pricing_engine.customerPricing.field.expiresAt', 'All negotiated prices expire on'),
          description: t(
            'pricing_engine.customerPricing.field.expiresAtHint',
            'ONE date expires the WHOLE list at once. There is no per-product expiry. Leave it empty to keep every price open-ended.',
          ),
          layout: 'half',
        },
        {
          id: 'negotiatedPrices',
          type: 'custom',
          label: t('pricing_engine.customerPricing.field.negotiatedPrices', 'Agreed unit prices'),
          rendersOwnError: true,
          component: (props: CrudCustomFieldRenderProps) => (
            <NegotiatedPricesEditor
              rows={readRows(props.value)}
              error={props.error}
              onChange={(next) => props.setValue(next)}
            />
          ),
        },
      ],
    },
  ]
}

export function validateRows(rows: NegotiatedRow[], t: TranslateFn): Record<string, string> {
  const priced = rows.filter((row) => row.price.trim().length > 0)
  if (priced.length !== rows.length) {
    return {
      negotiatedPrices: t(
        'pricing_engine.customerPricing.errors.missingPrice',
        'Every product on the list needs a price, or remove it from the list.',
      ),
    }
  }
  const invalid = priced.find((row) => {
    const parsed = toFiniteNumber(row.price)
    return parsed === null || parsed <= 0
  })
  if (invalid) {
    return {
      negotiatedPrices: t(
        'pricing_engine.customerPricing.errors.invalidPrice',
        'Agreed prices have to be numbers greater than zero.',
      ),
    }
  }
  return {}
}

export type CustomerPricingPanelProps = {
  customerId: string
  profile: CustomerPricingProfileRow | null
  impact: PricingImpact | null
  impactUnavailable: boolean
  /** True once there is at least one product whose price the engine could be asked about. */
  hasNegotiatedPrices: boolean
  productLabels?: Record<string, string>
  deliveryZones: CodeOption[]
  orderScenarios: CodeOption[]
  groupCodeSuggestions: string[]
  currencyCode: string
  canWrite: boolean
  loading: boolean
  error: string | null
  onRetry?: () => void
  onSaved?: () => void
  onProductAdded?: (productId: string) => void
}

export function CustomerPricingPanel({
  customerId,
  profile,
  impact,
  impactUnavailable,
  hasNegotiatedPrices,
  productLabels,
  deliveryZones,
  orderScenarios,
  groupCodeSuggestions,
  currencyCode,
  canWrite,
  loading,
  error,
  onRetry,
  onSaved,
  onProductAdded,
}: CustomerPricingPanelProps) {
  const t = useT()

  const groups = React.useMemo(
    () => buildGroups({ t, deliveryZones, orderScenarios, groupCodeSuggestions }),
    [deliveryZones, groupCodeSuggestions, orderScenarios, t],
  )

  const initialValues = React.useMemo<CustomerPricingFormValues>(
    () => ({
      ...(profile ? { id: profile.id } : {}),
      ...(profile?.updatedAt ? { updatedAt: profile.updatedAt } : {}),
      customerGroupCode: profile?.customerGroupCode ?? '',
      deliveryZoneCode: profile?.deliveryZoneCode ?? '',
      defaultOrderScenarioCode: profile?.defaultOrderScenarioCode ?? '',
      negotiatedPriceExpiresAt: isoToDateInput(profile?.negotiatedPriceExpiresAt),
      // Labels are resolved at render time from the impact context, so the initial rows deliberately
      // carry only the product id — an impact refresh must never rebuild `initialValues` and throw
      // away what the operator has typed.
      negotiatedPrices: rowsFromPrices(profile?.negotiatedPrices ?? {}),
    }),
    [profile],
  )

  const contextValue = React.useMemo<NegotiatedPricingContextValue>(
    () => ({
      currencyCode,
      impact,
      impactUnavailable,
      productLabels: productLabels ?? {},
      canWrite,
      onProductAdded: onProductAdded ?? (() => {}),
    }),
    [canWrite, currencyCode, impact, impactUnavailable, onProductAdded, productLabels],
  )

  if (loading) {
    return (
      <LoadingMessage
        label={t('pricing_engine.customerPricing.loading', 'Loading this customer’s pricing terms…')}
      />
    )
  }

  if (error) {
    return (
      <ErrorMessage
        label={error}
        action={
          onRetry ? (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {t('pricing_engine.customerPricing.action.retry', 'Try again')}
            </Button>
          ) : undefined
        }
      />
    )
  }

  // Precedence is a statement about prices this customer actually has. With an empty list there is
  // nothing for a guardrail to override, so neither banner has anything to warn about and the
  // "unverified" one would sit on every customer card in the system saying nothing.
  const precedenceBanner = !hasNegotiatedPrices ? null : impact?.negotiatedPriceApplies === false ? (
      <Alert status="warning" style="lighter" size="sm">
        <AlertTitle>
          {t(
            'pricing_engine.customerPricing.precedence.offTitle',
            'Negotiated prices are switched off for this customer',
          )}
        </AlertTitle>
        <AlertDescription>
          {t(
            'pricing_engine.customerPricing.precedence.offDescription',
            'The guardrail in force sets negotiated-price precedence to “rules win”, so the engine ignores every price on this list and quotes its own. Change the guardrail under Pricing → Parameters → Guardrails before agreeing a price here.',
          )}
        </AlertDescription>
      </Alert>
    ) : impact?.negotiatedPriceApplies === null || impact === null ? (
      <Alert status="information" style="lighter" size="sm">
        <AlertDescription>
          {t(
            'pricing_engine.customerPricing.precedence.unknown',
            'It could not be confirmed whether the guardrail lets negotiated prices win for this customer. Treat the projections below as unverified.',
          )}
        </AlertDescription>
      </Alert>
    ) : null

  const floorNotice = (
    <Alert status="information" style="lighter" size="sm">
      <AlertDescription>
        {t(
          'pricing_engine.customerPricing.floorNotice',
          'A price below the minimum-margin floor is not rejected — the engine raises it to the floor and flags the quote with a minimum-margin warning. The table shows exactly what each price will do.',
        )}
      </AlertDescription>
    </Alert>
  )

  if (!canWrite) {
    const rows = rowsFromPrices(profile?.negotiatedPrices ?? {})
    const notSet = t('pricing_engine.customerPricing.value.notSet', 'Not set')
    return (
      <div className="space-y-4" data-testid="customer-pricing-readonly">
        <SectionHeader
        title={t('pricing_engine.customerPricing.title', 'Pricing terms')}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href={buildDeskHref({ customerId })}>
              {t('pricing_engine.customerPricing.openDesk', 'Price a basket for this customer')}
            </Link>
          </Button>
        }
      />
        {precedenceBanner}
        <dl className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">
              {t('pricing_engine.customerPricing.field.customerGroupCode', 'Customer group code')}
            </dt>
            {/* Free text by design — there is no dictionary of customer groups to label it from. */}
            <dd className="text-sm">{profile?.customerGroupCode ?? notSet}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {t('pricing_engine.customerPricing.field.deliveryZoneCode', 'Delivery zone')}
            </dt>
            <dd className="text-sm">
              {labelForCode(profile?.deliveryZoneCode ?? null, deliveryZones, 'pricing_engine.zones', t) ??
                notSet}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {t('pricing_engine.customerPricing.field.defaultOrderScenarioCode', 'Default order scenario')}
            </dt>
            <dd className="text-sm">
              {labelForCode(
                profile?.defaultOrderScenarioCode ?? null,
                orderScenarios,
                'pricing_engine.scenarios',
                t,
              ) ?? notSet}
            </dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground">
          {t(
            'pricing_engine.customerPricing.field.expiresAtReadOnly',
            'All negotiated prices expire on: {date}',
          ).replace(
            '{date}',
            isoToDateInput(profile?.negotiatedPriceExpiresAt) ||
              t('pricing_engine.customerPricing.value.openEnded', 'no expiry set'),
          )}
        </p>
        <NegotiatedPricingContext.Provider value={contextValue}>
          <NegotiatedPricesEditor rows={rows} onChange={() => {}} />
        </NegotiatedPricingContext.Provider>
        <p className="text-sm text-muted-foreground">
          {t(
            'pricing_engine.customerPricing.readOnlyHint',
            'You can see these terms but not change them — that needs the pricing parameters write permission.',
          )}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4" data-testid="customer-pricing-form">
      <SectionHeader
        title={t('pricing_engine.customerPricing.title', 'Pricing terms')}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href={buildDeskHref({ customerId })}>
              {t('pricing_engine.customerPricing.openDesk', 'Price a basket for this customer')}
            </Link>
          </Button>
        }
      />
      {precedenceBanner}
      {floorNotice}
      <NegotiatedPricingContext.Provider value={contextValue}>
        <CrudForm<CustomerPricingFormValues>
          embedded
          fields={[]}
          groups={groups}
          initialValues={initialValues}
          submitLabel={t('pricing_engine.customerPricing.action.save', 'Save pricing terms')}
          onSubmit={async (values) => {
            const rows = readRows(values.negotiatedPrices)
            const fieldErrors = validateRows(rows, t)
            if (Object.keys(fieldErrors).length > 0) {
              throw createCrudFormError(
                t(
                  'pricing_engine.customerPricing.errors.invalid',
                  'These pricing terms cannot be saved yet.',
                ),
                fieldErrors,
              )
            }
            const prices = pricesFromRows(rows)
            const payload = {
              customerId,
              customerGroupCode: values.customerGroupCode.trim() || null,
              deliveryZoneCode: values.deliveryZoneCode.trim() || null,
              defaultOrderScenarioCode: values.defaultOrderScenarioCode.trim() || null,
              negotiatedPrices: Object.keys(prices).length > 0 ? prices : null,
              negotiatedPriceExpiresAt: values.negotiatedPriceExpiresAt.trim() || null,
            }
            try {
              if (profile) await updateCrud(PROFILES_API_PATH, { id: profile.id, ...payload })
              else await createCrud(PROFILES_API_PATH, payload)
            } catch (err) {
              if (surfaceRecordConflict(err, t, { onRefresh: onRetry })) return
              throw err
            }
            flash(t('pricing_engine.customerPricing.flash.saved', 'Pricing terms saved.'), 'success')
            onSaved?.()
          }}
        />
      </NegotiatedPricingContext.Provider>
    </div>
  )
}

type ListEnvelope<TRow> = { items?: TRow[] }

/**
 * `label` is not uniformly a display string across these registries: delivery zones store the
 * operator's own wording ("Mazowieckie — daleko"), while order scenarios store a TRANSLATION KEY
 * (`pricing_engine.scenarios.idealFile`). Printing the field verbatim therefore showed the key
 * itself in the scenario picker, and the zone picker rendering correctly is exactly what hid it.
 *
 * Passing every label through `t(label, label)` resolves the ones that are keys and leaves plain
 * wording untouched, because a missing dictionary entry falls back to the value handed in.
 */
async function loadCodeOptions(
  path: string,
  query: string,
  translate: (key: string, fallback: string) => string,
): Promise<CodeOption[]> {
  const call = await apiCall<ListEnvelope<Record<string, unknown>>>(
    `/api/${path}?${query}`,
    undefined,
    { fallback: { items: [] } },
  )
  if (!call.ok) return []
  const items = Array.isArray(call.result?.items) ? call.result.items : []
  const options: CodeOption[] = []
  for (const item of items) {
    const code = readString(item, 'code')
    if (!code) continue
    const rawLabel = readString(item, 'label') ?? code
    options.push({ code, label: translate(rawLabel, rawLabel) })
  }
  return options
}

async function loadGroupCodeSuggestions(): Promise<string[]> {
  const query = `scope=customer_group&pageSize=${OPTION_PAGE_SIZE}`
  const [rules, guardrails] = await Promise.all([
    apiCall<ListEnvelope<Record<string, unknown>>>(`/api/pricing/margin-rules?${query}`, undefined, {
      fallback: { items: [] },
    }),
    apiCall<ListEnvelope<Record<string, unknown>>>(`/api/pricing/guardrails?${query}`, undefined, {
      fallback: { items: [] },
    }),
  ])
  const codes = new Set<string>()
  for (const call of [rules, guardrails]) {
    if (!call.ok) continue
    const items = Array.isArray(call.result?.items) ? call.result.items : []
    for (const item of items) {
      const code = readString(item, 'scopeRefId')
      if (code) codes.add(code)
    }
  }
  return [...codes].sort((left, right) => left.localeCompare(right))
}

export function CustomerPricingTabWidget({ context }: InjectionWidgetComponentProps<unknown, unknown>) {
  const t = useT()
  const { payload } = useBackendChrome()
  const customerId = readCustomerId(context)

  const [profile, setProfile] = React.useState<CustomerPricingProfileRow | null>(null)
  const [deliveryZones, setDeliveryZones] = React.useState<CodeOption[]>([])
  const [orderScenarios, setOrderScenarios] = React.useState<CodeOption[]>([])
  const [groupCodeSuggestions, setGroupCodeSuggestions] = React.useState<string[]>([])
  const [impact, setImpact] = React.useState<PricingImpact | null>(null)
  const [impactUnavailable, setImpactUnavailable] = React.useState(false)
  const [productLabels, setProductLabels] = React.useState<Record<string, string>>({})
  const [extraProductIds, setExtraProductIds] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)

  const canWrite = hasFeature(payload?.grantedFeatures ?? [], 'pricing.params.write')

  const reload = React.useCallback(() => setReloadToken((token) => token + 1), [])

  React.useEffect(() => {
    if (!customerId) {
      setLoading(false)
      return
    }
    const scopedCustomerId = customerId
    let cancelled = false
    async function run(): Promise<void> {
      setLoading(true)
      setError(null)
      try {
        const [profileCall, zones, scenarios, suggestions] = await Promise.all([
          apiCall<ListEnvelope<Record<string, unknown>>>(
            `/api/${PROFILES_API_PATH}?customerId=${encodeURIComponent(scopedCustomerId)}&pageSize=1`,
            undefined,
            { fallback: { items: [] } },
          ),
          loadCodeOptions('pricing/delivery-zones', `pageSize=${OPTION_PAGE_SIZE}&sortField=label`, t),
          loadCodeOptions('pricing/order-scenarios', `pageSize=${OPTION_PAGE_SIZE}&sortField=label`, t),
          loadGroupCodeSuggestions(),
        ])
        if (cancelled) return
        if (!profileCall.ok) {
          setError(
            t('pricing_engine.customerPricing.errors.load', 'Could not load this customer’s pricing terms.'),
          )
          return
        }
        const items = Array.isArray(profileCall.result?.items) ? profileCall.result.items : []
        setProfile(items.length > 0 ? toProfileRow(items[0]) : null)
        setDeliveryZones(zones)
        setOrderScenarios(scenarios)
        setGroupCodeSuggestions(suggestions)
      } catch {
        if (!cancelled) {
          setError(
            t('pricing_engine.customerPricing.errors.load', 'Could not load this customer’s pricing terms.'),
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [customerId, reloadToken, t])

  // One request per product, each carrying THAT product's agreed price. A product the operator has
  // only just picked has no agreed price yet, so it asks with the neutral probe — the engine price,
  // the cost and the floor it needs do not depend on the proposed number.
  const impactRequests = React.useMemo<ImpactProductRequest[]>(() => {
    const prices = profile?.negotiatedPrices ?? {}
    const ids = new Set<string>([...Object.keys(prices), ...extraProductIds])
    return [...ids].map((productId) => ({
      productId,
      proposedUnitPriceNet: prices[productId] ?? IMPACT_PROBE_UNIT_PRICE,
    }))
  }, [extraProductIds, profile])

  React.useEffect(() => {
    if (!customerId || impactRequests.length === 0) {
      setImpact(null)
      setImpactUnavailable(false)
      return
    }
    const scopedCustomerId = customerId
    let cancelled = false
    async function run(): Promise<void> {
      const next = await loadCustomerPricingImpact({
        customerId: scopedCustomerId,
        products: impactRequests,
      })
      if (cancelled) return
      setImpact(next)
      // Only a clean sweep counts as unavailable — a single product the engine cannot price says so
      // in its own row instead of blanking the table.
      setImpactUnavailable(Object.keys(next.items).length === 0)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [customerId, impactRequests])

  const productIdsKey = React.useMemo(
    () => impactRequests.map((request) => request.productId).join(','),
    [impactRequests],
  )

  React.useEffect(() => {
    const ids = productIdsKey ? productIdsKey.split(',') : []
    if (ids.length === 0) return
    let cancelled = false
    async function run(): Promise<void> {
      const labels = await loadProductLabels(ids)
      // Merged, not replaced: a label already resolved stays put when another product is added.
      if (!cancelled) setProductLabels((current) => ({ ...current, ...labels }))
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [productIdsKey])

  const handleProductAdded = React.useCallback((productId: string) => {
    setExtraProductIds((current) => (current.includes(productId) ? current : [...current, productId]))
  }, [])

  if (!customerId) {
    return (
      <TabEmptyState
        title={t('pricing_engine.customerPricing.noCustomer.title', 'No customer to price yet')}
        description={t(
          'pricing_engine.customerPricing.noCustomer.description',
          'Pricing terms appear once this company record has been saved.',
        )}
      />
    )
  }

  return (
    <CustomerPricingPanel
      customerId={customerId}
      profile={profile}
      impact={impact}
      impactUnavailable={impactUnavailable}
      hasNegotiatedPrices={impactRequests.length > 0}
      productLabels={productLabels}
      deliveryZones={deliveryZones}
      orderScenarios={orderScenarios}
      groupCodeSuggestions={groupCodeSuggestions}
      currencyCode={impact?.currencyCode ?? ''}
      canWrite={canWrite}
      loading={loading}
      error={error}
      onRetry={reload}
      onSaved={reload}
      onProductAdded={handleProductAdded}
    />
  )
}

export default CustomerPricingTabWidget
