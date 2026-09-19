'use client'

import * as React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { CounterInput } from '@open-mercato/ui/primitives/counter-input'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@open-mercato/ui/primitives/table'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { LookupSelect, type LookupSelectItem } from '@open-mercato/ui/backend/inputs'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { DocumentMarginPanel } from '../../../components/DocumentMarginPanel'
import { minUnitPriceForMargin, formatMoney } from '../../../lib/frontend/marginMath'
import { simulateQuote, type SimulateLine } from '../../../lib/frontend/quoteClient'
import type { QuoteLine, QuoteResponse } from '../../../lib/frontend/quoteTypes'

// The order-scenario table is tenant data, but the engine ships these six codes as its defaults and
// the calculator has to stay usable on a tenant whose scenario list is not exposed yet.
const FALLBACK_ORDER_SCENARIO_CODES = [
  'ideal_file',
  'nonstandard_file',
  'email',
  'sms',
  'phone',
  'rep_visit',
] as const

const GUARDRAILS_COMPONENT_CODE = 'guardrails'
const LOOKUP_PAGE_SIZE = '20'

type CodedOption = { code: string; label: string }

type BasketRow = {
  key: string
  productId: string | null
  quantity: number | null
}

type LineFloor = {
  productId: string
  label: string
  unitPriceNet: string
  unitCostNet: string
  minMarginPercent: string | null
  lowestUnitPrice: string | null
}

// LookupSelect drops every prop it does not declare, so FormField's label-to-input wiring would
// dangle on it. These fields get a plain caption instead of a <label> pointing at nothing.
function LookupField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </div>
  )
}

// The first row is rendered on the server too, so its key must be deterministic: a random key
// there differs between the server and client render and breaks hydration (its `htmlFor`/`id`
// derive from it). Rows added later are created in the browser only and may be random.
const INITIAL_ROW_KEY = 'initial'

function newBasketRow(key?: string): BasketRow {
  return {
    key: key ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())),
    productId: null,
    quantity: 1,
  }
}

function toCamelCase(code: string): string {
  return code.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

function readString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

function readDecimalParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key]
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) return value
  return null
}

/**
 * The lowest unit price that still respects the guardrails the engine actually applied: the
 * minimum-margin clamp and, when one is configured, the hard floor price. Both are read back off
 * the guardrails component of the simulated line, so the number can never disagree with the engine.
 */
function toLineFloor(line: QuoteLine, index: number): LineFloor {
  const guardrails = line.breakdown.find((component) => component.code === GUARDRAILS_COMPONENT_CODE)
  const params = guardrails?.params ?? {}
  const minMarginPercent = readDecimalParam(params, 'minMarginPercent')
  const floorPrice = readDecimalParam(params, 'floorPrice')
  const marginFloor = minMarginPercent ? minUnitPriceForMargin(line.unitCostNet, minMarginPercent) : null
  const candidates = [marginFloor, floorPrice].filter((value): value is string => value !== null)
  const lowestUnitPrice = candidates.length
    ? candidates.reduce((highest, candidate) => (Number(candidate) > Number(highest) ? candidate : highest))
    : null
  return {
    productId: line.productId,
    label: line.sku ?? `#${index + 1}`,
    unitPriceNet: line.unitPriceNet,
    unitCostNet: line.unitCostNet,
    minMarginPercent,
    lowestUnitPrice,
  }
}

async function fetchCodedOptions(path: string): Promise<CodedOption[]> {
  const call = await apiCall<{ items?: Array<Record<string, unknown>> }>(path, undefined, {
    fallback: { items: [] },
  })
  if (!call.ok || !Array.isArray(call.result?.items)) return []
  return call.result.items.flatMap<CodedOption>((item) => {
    const code = readString(item, 'code')
    if (!code) return []
    return [{ code, label: readString(item, 'label', 'name', 'title') ?? code }]
  })
}

export default function PricingCalculatorPage() {
  const t = useT()
  const [customerId, setCustomerId] = React.useState<string | null>(null)
  const [orderScenarioCode, setOrderScenarioCode] = React.useState<string>('phone')
  const [deliveryZoneCode, setDeliveryZoneCode] = React.useState<string | null>(null)
  const [scenarioOptions, setScenarioOptions] = React.useState<CodedOption[] | null>(null)
  const [zoneOptions, setZoneOptions] = React.useState<CodedOption[] | null>(null)
  const [rows, setRows] = React.useState<BasketRow[]>(() => [newBasketRow(INITIAL_ROW_KEY)])
  const [result, setResult] = React.useState<QuoteResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    async function loadParameterOptions() {
      const [scenarios, zones] = await Promise.all([
        fetchCodedOptions('/api/pricing/order-scenarios?page=1&pageSize=50'),
        fetchCodedOptions('/api/pricing/delivery-zones?page=1&pageSize=50'),
      ])
      if (cancelled) return
      setScenarioOptions(scenarios)
      setZoneOptions(zones)
    }
    void loadParameterOptions()
    return () => {
      cancelled = true
    }
  }, [])

  const resolvedScenarioOptions = React.useMemo<CodedOption[]>(() => {
    if (scenarioOptions && scenarioOptions.length > 0) return scenarioOptions
    return FALLBACK_ORDER_SCENARIO_CODES.map((code) => ({
      code,
      label: t(`pricing_engine.scenarios.${toCamelCase(code)}`, code),
    }))
  }, [scenarioOptions, t])

  const loadCustomers = React.useCallback(async (query: string): Promise<LookupSelectItem[]> => {
    const params = new URLSearchParams({ page: '1', pageSize: LOOKUP_PAGE_SIZE })
    if (query.trim().length) params.set('search', query.trim())
    const [companies, people] = await Promise.all([
      apiCall<{ items?: Array<Record<string, unknown>> }>(
        `/api/customers/companies?${params.toString()}`,
        undefined,
        { fallback: { items: [] } },
      ),
      apiCall<{ items?: Array<Record<string, unknown>> }>(
        `/api/customers/people?${params.toString()}`,
        undefined,
        { fallback: { items: [] } },
      ),
    ])
    const items = [
      ...(Array.isArray(companies.result?.items) ? companies.result.items : []),
      ...(Array.isArray(people.result?.items) ? people.result.items : []),
    ]
    return items.flatMap<LookupSelectItem>((item) => {
      const id = readString(item, 'id')
      if (!id) return []
      return [
        {
          id,
          title: readString(item, 'display_name', 'name', 'primary_email') ?? id,
          subtitle: readString(item, 'primary_domain', 'primary_email'),
        },
      ]
    })
  }, [])

  const loadProducts = React.useCallback(async (query: string): Promise<LookupSelectItem[]> => {
    const params = new URLSearchParams({ page: '1', pageSize: LOOKUP_PAGE_SIZE })
    if (query.trim().length) params.set('search', query.trim())
    else params.set('sortField', 'title')
    const call = await apiCall<{ items?: Array<Record<string, unknown>> }>(
      `/api/catalog/products?${params.toString()}`,
      undefined,
      { fallback: { items: [] } },
    )
    if (!Array.isArray(call.result?.items)) return []
    return call.result.items.flatMap<LookupSelectItem>((item) => {
      const id = readString(item, 'id')
      if (!id) return []
      return [{ id, title: readString(item, 'title', 'name') ?? id, subtitle: readString(item, 'sku') }]
    })
  }, [])

  const updateRow = React.useCallback((key: string, patch: Partial<BasketRow>) => {
    setRows((previous) => previous.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }, [])

  const removeRow = React.useCallback((key: string) => {
    setRows((previous) => (previous.length <= 1 ? previous : previous.filter((row) => row.key !== key)))
  }, [])

  const simulateLines = React.useMemo<SimulateLine[]>(
    () =>
      rows.flatMap<SimulateLine>((row) =>
        row.productId && row.quantity && row.quantity > 0
          ? [{ productId: row.productId, quantity: String(row.quantity) }]
          : [],
      ),
    [rows],
  )

  const calculate = React.useCallback(async () => {
    if (simulateLines.length === 0) return
    setLoading(true)
    setError(null)
    const outcome = await simulateQuote({
      customerId,
      orderScenarioCode,
      deliveryZoneCode,
      lines: simulateLines,
    })
    if (!outcome.ok) {
      setResult(null)
      setError(t(outcome.errorKey, 'Pricing failed.'))
      setLoading(false)
      return
    }
    setResult(outcome.quote)
    setLoading(false)
  }, [customerId, deliveryZoneCode, orderScenarioCode, simulateLines, t])

  const lineFloors = React.useMemo<LineFloor[]>(
    () => (result?.lines ?? []).map((line, index) => toLineFloor(line, index)),
    [result],
  )
  const hasAnyFloor = lineFloors.some((floor) => floor.lowestUnitPrice !== null)
  // FormField clones its child and overwrites `disabled`, so the two must be driven by one value.
  const zonesUnavailable = zoneOptions === null || zoneOptions.length === 0
  const currencyCode = result?.currencyCode ?? ''

  return (
    <Page>
      <PageBody>
        <p className="text-sm text-muted-foreground">
          {t(
            'pricing_engine.calculator.description',
            'Price a basket for a customer who has not ordered yet, and see the margin and every assumption behind it.',
          )}
        </p>

        <div className="grid gap-3 md:grid-cols-3">
          <LookupField label={t('pricing_engine.calculator.field.customer', 'Customer')}>
            <LookupSelect
              value={customerId}
              onChange={setCustomerId}
              fetchItems={loadCustomers}
              placeholder={t('pricing_engine.calculator.field.customerPlaceholder', 'Any customer')}
            />
          </LookupField>

          <FormField label={t('pricing_engine.calculator.field.orderScenario', 'Order scenario')} id="calculator-scenario">
            <Select value={orderScenarioCode} onValueChange={setOrderScenarioCode}>
              <SelectTrigger id="calculator-scenario">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {resolvedScenarioOptions.map((option) => (
                  <SelectItem key={option.code} value={option.code}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField
            label={t('pricing_engine.calculator.field.deliveryZone', 'Delivery zone')}
            id="calculator-zone"
            disabled={zonesUnavailable}
            description={
              zoneOptions !== null && zoneOptions.length === 0
                ? t(
                    'pricing_engine.calculator.field.deliveryZoneEmpty',
                    'No delivery zones are available, so this price carries no delivery cost.',
                  )
                : undefined
            }
          >
            <Select
              value={deliveryZoneCode ?? ''}
              onValueChange={(value) => setDeliveryZoneCode(value || null)}
              disabled={zonesUnavailable}
            >
              <SelectTrigger id="calculator-zone">
                <SelectValue
                  placeholder={t('pricing_engine.calculator.field.deliveryZonePlaceholder', 'No delivery zone')}
                />
              </SelectTrigger>
              <SelectContent>
                {(zoneOptions ?? []).map((option) => (
                  <SelectItem key={option.code} value={option.code}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>

        <div className="space-y-3">
          <SectionHeader
            title={t('pricing_engine.calculator.basket.title', 'Basket')}
            count={rows.length}
            action={
              <Button type="button" variant="outline" size="sm" onClick={() => setRows((previous) => [...previous, newBasketRow()])}>
                <Plus className="h-4 w-4" />
                {t('pricing_engine.calculator.action.addLine', 'Add a line')}
              </Button>
            }
          />
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.key} className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
                <div className="min-w-64 flex-1">
                  <LookupField label={t('pricing_engine.calculator.field.product', 'Product')}>
                    <LookupSelect
                      value={row.productId}
                      onChange={(next) => updateRow(row.key, { productId: next })}
                      fetchItems={loadProducts}
                      placeholder={t('pricing_engine.calculator.field.productPlaceholder', 'Pick a product')}
                    />
                  </LookupField>
                </div>
                <FormField label={t('pricing_engine.calculator.field.quantity', 'Quantity')} id={`calculator-quantity-${row.key}`}>
                  <CounterInput
                    id={`calculator-quantity-${row.key}`}
                    min={1}
                    step={1}
                    value={row.quantity}
                    onChange={(next) => updateRow(row.key, { quantity: next })}
                    decrementAriaLabel={t('pricing_engine.ui.counter.decrease', 'Decrease quantity')}
                    incrementAriaLabel={t('pricing_engine.ui.counter.increase', 'Increase quantity')}
                  />
                </FormField>
                <IconButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('pricing_engine.calculator.action.removeLine', 'Remove this line')}
                  disabled={rows.length <= 1}
                  onClick={() => removeRow(row.key)}
                >
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <Button type="button" onClick={calculate} disabled={loading || simulateLines.length === 0}>
            {t('pricing_engine.calculator.action.calculate', 'Calculate the margin')}
          </Button>
        </div>

        <DocumentMarginPanel
          quote={result}
          currencyCode={currencyCode}
          loading={loading}
          error={error}
          emptyTitle={t('pricing_engine.calculator.empty.title', 'Nothing priced yet')}
          emptyDescription={t(
            'pricing_engine.calculator.empty.description',
            'Pick a product and a quantity, then calculate to see the margin and its assumptions.',
          )}
          onRetry={calculate}
        />

        {result && lineFloors.length > 0 ? (
          <div className="space-y-3">
            <SectionHeader title={t('pricing_engine.calculator.lowestPrice.title', 'How low this price can go')} />
            <p className="text-sm text-muted-foreground">
              {t(
                'pricing_engine.calculator.lowestPrice.hint',
                'The lowest unit price that still holds the guardrails this calculation applied. Below it the engine clamps the price back up.',
              )}
            </p>
            {hasAnyFloor ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('pricing_engine.calculator.lowestPrice.column.line', 'Line')}</TableHead>
                      <TableHead className="text-right">
                        {t('pricing_engine.playground.result.unitCost', 'Unit cost (net)')}
                      </TableHead>
                      <TableHead className="text-right">
                        {t('pricing_engine.playground.result.unitPrice', 'Unit price (net)')}
                      </TableHead>
                      <TableHead className="text-right">
                        {t('pricing_engine.calculator.lowestPrice.column.minMargin', 'Minimum margin')}
                      </TableHead>
                      <TableHead className="text-right">
                        {t('pricing_engine.calculator.lowestPrice.column.lowestPrice', 'Lowest price')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lineFloors.map((floor) => (
                      <TableRow key={floor.productId}>
                        <TableCell>{floor.label}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(floor.unitCostNet, currencyCode)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(floor.unitPriceNet, currencyCode)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {floor.minMarginPercent ? `${Number(floor.minMarginPercent).toFixed(2)} %` : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {floor.lowestUnitPrice ? formatMoney(floor.lowestUnitPrice, currencyCode) : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <Alert status="information" style="lighter" size="sm">
                <AlertDescription>
                  {t(
                    'pricing_engine.calculator.lowestPrice.none',
                    'No guardrail applies to this basket, so nothing stops the price from being discounted below cost.',
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : null}
      </PageBody>
    </Page>
  )
}
