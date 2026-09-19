'use client'

import * as React from 'react'
import Link from 'next/link'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { Button } from '@open-mercato/ui/primitives/button'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@open-mercato/ui/primitives/card'
import { CounterInput } from '@open-mercato/ui/primitives/counter-input'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Input } from '@open-mercato/ui/primitives/input'
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
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { LookupSelect, type LookupSelectItem } from '@open-mercato/ui/backend/inputs'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { MarginSummary } from '../../../components/MarginSummary'
import { basketMargin, formatMoney } from '../../../lib/frontend/marginMath'
import type { AdviseResponse } from '../../../lib/frontend/advisorTypes'
import { SuggestionCard } from './SuggestionCard'

const ADVISE_PATH = '/api/pricing/advise'
const OBJECTIVES_HREF = '/backend/pricing/params/objectives'

const ORDER_SCENARIOS = [
  'ideal_file',
  'nonstandard_file',
  'email',
  'sms',
  'phone',
  'rep_visit',
] as const

type ProductListResponse = { items?: Array<Record<string, unknown>> }

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toCamelCase(code: string): string {
  return code.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

async function searchProducts(query: string): Promise<LookupSelectItem[]> {
  const params = new URLSearchParams({ page: '1', pageSize: '20' })
  if (query.trim().length > 0) params.set('search', query.trim())
  const call = await apiCall<ProductListResponse>(`/api/catalog/products?${params.toString()}`)
  const items = Array.isArray(call.result?.items) ? call.result.items : []
  return items.flatMap((item) => {
    const id = readString(item, 'id')
    if (!id) return []
    return [
      {
        id,
        title: readString(item, 'title') ?? readString(item, 'name') ?? id,
        subtitle: readString(item, 'sku'),
      },
    ]
  })
}

async function searchCustomers(query: string): Promise<LookupSelectItem[]> {
  const params = new URLSearchParams({ page: '1', pageSize: '20' })
  if (query.trim().length > 0) params.set('search', query.trim())
  const call = await apiCall<ProductListResponse>(`/api/customers/companies?${params.toString()}`)
  const items = Array.isArray(call.result?.items) ? call.result.items : []
  return items.flatMap((item) => {
    const id = readString(item, 'id')
    if (!id) return []
    return [
      {
        id,
        title: readString(item, 'display_name') ?? readString(item, 'name') ?? id,
        subtitle: readString(item, 'primary_domain') ?? readString(item, 'primary_email'),
      },
    ]
  })
}

export default function PricingAdvisorPage() {
  const t = useT()
  const [productId, setProductId] = React.useState<string | null>(null)
  const [customerId, setCustomerId] = React.useState<string | null>(null)
  const [quantity, setQuantity] = React.useState<number | null>(24)
  const [orderScenarioCode, setOrderScenarioCode] = React.useState<string>('phone')
  const [minMarginPercent, setMinMarginPercent] = React.useState('')
  const [result, setResult] = React.useState<AdviseResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // `/pricing/advise` persists nothing — it scores hypothetical baskets and writes no record — so
  // this is a read expressed as a POST and does not go through `useGuardedMutation`.
  const runAdvisor = React.useCallback(async () => {
    if (!productId || !quantity) return
    setLoading(true)
    setError(null)
    try {
      const call = await apiCall<AdviseResponse & { error?: string }>(ADVISE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId,
          orderScenarioCode,
          lines: [{ productId, quantity: String(quantity) }],
          advisor: {
            maxPerKind: 2,
            ...(minMarginPercent.trim() ? { minMarginPercent: minMarginPercent.trim() } : {}),
          },
        }),
      })
      if (!call.ok || !call.result?.baseline) {
        setResult(null)
        setError(t(call.result?.error ?? 'pricing_engine.advisor.errors.adviseFailed', 'Could not build advice.'))
        return
      }
      setResult(call.result)
    } catch {
      setResult(null)
      setError(t('pricing_engine.advisor.errors.adviseFailed', 'Could not build advice.'))
    } finally {
      setLoading(false)
    }
  }, [customerId, minMarginPercent, orderScenarioCode, productId, quantity, t])

  const baseline = result?.baseline ?? null
  const currencyCode = baseline?.currencyCode ?? ''
  // The list is ordered by the operator's own objectives whenever any are configured for this
  // scope; saying so is the difference between a ranking and an unexplained order.
  const isObjectiveRanked = (result?.suggestions ?? []).some(
    (suggestion) => suggestion.objectiveScore !== null,
  )
  const basket = React.useMemo(
    () =>
      basketMargin(
        (baseline?.lines ?? []).map((line) => ({
          unitPriceNet: line.unitPriceNet,
          unitCostNet: line.unitCostNet,
          quantity: line.quantity,
        })),
      ),
    [baseline],
  )

  return (
    <Page>
      <PageBody>
        <p className="text-sm text-muted-foreground">
          {t(
            'pricing_engine.advisor.description',
            'Find the best price for the customer without giving away margin. Every suggestion is priced twice — once as it stands and once with the change applied — so both the customer price and your profit are measured, not asserted.',
          )}
        </p>

        <div className="mt-4 grid gap-3 md:grid-cols-5">
          <FormField label={t('pricing_engine.advisor.field.product', 'Product')} required>
            <LookupSelect
              value={productId}
              onChange={setProductId}
              fetchItems={searchProducts}
              placeholder={t('pricing_engine.advisor.field.productPlaceholder', 'Search the catalogue')}
            />
          </FormField>
          <FormField label={t('pricing_engine.advisor.field.quantity', 'Quantity')} required>
            <CounterInput
              min={1}
              step={1}
              value={quantity}
              onChange={setQuantity}
              decrementAriaLabel={t('pricing_engine.advisor.field.quantityDecrement', 'Decrease quantity')}
              incrementAriaLabel={t('pricing_engine.advisor.field.quantityIncrement', 'Increase quantity')}
            />
          </FormField>
          <FormField label={t('pricing_engine.advisor.field.customer', 'Customer')}>
            <LookupSelect
              value={customerId}
              onChange={setCustomerId}
              fetchItems={searchCustomers}
              placeholder={t('pricing_engine.advisor.field.customerPlaceholder', 'Search customers')}
            />
          </FormField>
          <FormField label={t('pricing_engine.advisor.field.orderScenario', 'Order channel')}>
            <Select value={orderScenarioCode} onValueChange={setOrderScenarioCode}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORDER_SCENARIOS.map((code) => (
                  <SelectItem key={code} value={code}>
                    {t(`pricing_engine.scenarios.${toCamelCase(code)}`, code)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t('pricing_engine.advisor.field.minMargin', 'Hold margin at least (%)')}
            description={t(
              'pricing_engine.advisor.field.minMarginHint',
              'Leave empty to use the configured guardrail.',
            )}
          >
            <Input
              value={minMarginPercent}
              inputMode="decimal"
              onChange={(event) => setMinMarginPercent(event.target.value)}
            />
          </FormField>
        </div>

        <div className="mt-4">
          <Button type="button" onClick={runAdvisor} disabled={loading || !productId || !quantity}>
            {t('pricing_engine.advisor.action.run', 'Find a better price')}
          </Button>
        </div>

        {loading ? (
          <LoadingMessage label={t('pricing_engine.advisor.action.run', 'Find a better price')} />
        ) : null}
        {error ? <ErrorMessage label={error} /> : null}

        {!loading && !error && !baseline ? (
          <div className="mt-6">
            <EmptyState
              title={t('pricing_engine.advisor.empty', 'Nothing priced yet')}
              description={t(
                'pricing_engine.advisor.emptyHint',
                'Pick a product and a quantity, then run the advisor.',
              )}
            />
          </div>
        ) : null}

        {baseline ? (
          <div className="mt-6 space-y-8">
            <section className="space-y-3">
              <SectionHeader title={t('pricing_engine.advisor.section.baseline', 'This order as it stands')} />
              <MarginSummary currencyCode={currencyCode} {...basket} />
            </section>

            <section className="space-y-3">
              <SectionHeader
                title={t('pricing_engine.advisor.section.suggestions', 'Ways to give a better price')}
                count={result?.suggestions.length ?? 0}
              />
              <p className="text-sm text-muted-foreground">
                {isObjectiveRanked
                  ? t(
                      'pricing_engine.advisor.section.suggestionsRankedByObjectives',
                      'Ordered by your objectives and weights. Each card shows what every objective contributed.',
                    )
                  : t(
                      'pricing_engine.advisor.section.suggestionsUnranked',
                      'No objectives are configured for this customer or product, so the suggestions are listed in the order they were found. Set objectives and weights to rank them.',
                    )}{' '}
                <Link className="underline" href={OBJECTIVES_HREF}>
                  {t('pricing_engine.advisor.action.manageObjectives', 'Objectives and weights')}
                </Link>
              </p>
              {(result?.suggestions.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t(
                    'pricing_engine.advisor.noSuggestions',
                    'Nothing here beats the current price without costing you money.',
                  )}
                </p>
              ) : (
                <div className="grid gap-4 xl:grid-cols-2">
                  {result?.suggestions.map((suggestion, index) => (
                    <SuggestionCard
                      key={`${suggestion.code}-${index}`}
                      suggestion={suggestion}
                      currencyCode={currencyCode}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-3">
              <SectionHeader
                title={t('pricing_engine.advisor.section.marginFloor', 'Lowest price you can still hold the margin at')}
              />
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('pricing_engine.advisor.column.product', 'Product')}</TableHead>
                      <TableHead>{t('pricing_engine.advisor.column.minMargin', 'Minimum margin')}</TableHead>
                      <TableHead>{t('pricing_engine.advisor.column.unitCost', 'Unit cost')}</TableHead>
                      <TableHead>{t('pricing_engine.advisor.column.currentPrice', 'Current price')}</TableHead>
                      <TableHead>{t('pricing_engine.advisor.column.lowestPrice', 'Lowest price')}</TableHead>
                      <TableHead>{t('pricing_engine.advisor.column.headroom', 'Discount headroom')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(result?.marginFloors ?? []).map((floor) => (
                      <TableRow key={floor.productId}>
                        <TableCell>{floor.sku ?? floor.productId}</TableCell>
                        <TableCell>
                          {floor.minMarginPercent}%{' '}
                          <Badge variant={floor.source === 'guardrail' ? 'neutral' : 'info'} size="sm">
                            {floor.source === 'guardrail'
                              ? t('pricing_engine.advisor.label.fromGuardrail', 'Guardrail')
                              : t('pricing_engine.advisor.label.requested', 'Your figure')}
                          </Badge>
                        </TableCell>
                        <TableCell>{formatMoney(floor.unitCostNet, currencyCode)}</TableCell>
                        <TableCell>{formatMoney(floor.currentUnitPriceNet, currencyCode)}</TableCell>
                        <TableCell className="font-medium">
                          {floor.lowestUnitPriceNet
                            ? formatMoney(floor.lowestUnitPriceNet, currencyCode)
                            : t('pricing_engine.advisor.label.noFloor', 'No minimum margin configured')}
                        </TableCell>
                        <TableCell>
                          {floor.discountHeadroomPercent ? `${floor.discountHeadroomPercent}%` : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>

            {(result?.volumeSensitivity ?? []).map((sensitivity) => (
              <section key={sensitivity.productId} className="space-y-3">
                <SectionHeader
                  title={t('pricing_engine.advisor.section.sensitivity', 'How the price moves with quantity')}
                  action={
                    <span className="text-sm text-muted-foreground">
                      {sensitivity.sku ?? sensitivity.productId}
                    </span>
                  }
                />
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('pricing_engine.advisor.column.quantity', 'Quantity')}</TableHead>
                        <TableHead>{t('pricing_engine.advisor.column.unitPrice', 'Unit price')}</TableHead>
                        <TableHead>{t('pricing_engine.advisor.column.unitCost', 'Unit cost')}</TableHead>
                        <TableHead>{t('pricing_engine.advisor.column.margin', 'Margin on price')}</TableHead>
                        <TableHead>{t('pricing_engine.advisor.column.lineProfit', 'Profit on the line')}</TableHead>
                        <TableHead>{t('pricing_engine.advisor.column.markers', 'Notes')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sensitivity.points.map((point) => (
                        <TableRow key={point.quantity}>
                          <TableCell>{point.quantity}</TableCell>
                          <TableCell>{formatMoney(point.unitPriceNet, sensitivity.currencyCode)}</TableCell>
                          <TableCell>{formatMoney(point.unitCostNet, sensitivity.currencyCode)}</TableCell>
                          <TableCell>{point.marginPercent}%</TableCell>
                          <TableCell className="font-medium">
                            {formatMoney(point.lineProfitNet, sensitivity.currencyCode)}
                          </TableCell>
                          <TableCell className="space-x-1">
                            {point.packBoundaryUnitCode ? (
                              <Badge variant="info" size="sm">
                                {t('pricing_engine.advisor.label.packBoundary', 'Whole {unit}', {
                                  unit: point.packBoundaryUnitCode,
                                })}
                              </Badge>
                            ) : null}
                            {point.crossesNextTierVolume ? (
                              <Badge variant="success" size="sm">
                                {t('pricing_engine.advisor.label.nextTierReached', 'Reaches the next purchase tier')}
                              </Badge>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            ))}

            {(result?.purchasingInsights.length ?? 0) > 0 ? (
              <section className="space-y-3">
                <SectionHeader
                  title={t('pricing_engine.advisor.purchasing.nextTier.title', 'Your own supplier tiers')}
                />
                <div className="grid gap-4 xl:grid-cols-2">
                  {result?.purchasingInsights.map((insight) => (
                    <Card key={insight.productId}>
                      <CardHeader>
                        <CardTitle>{insight.sku ?? insight.productId}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm text-muted-foreground">
                          {t(
                            'pricing_engine.advisor.purchasing.nextTier.explain',
                            'You are {unitsToNextTier} units a year short of the {nextTierDiscount}% tier (you are on {currentTierDiscount}% today). Closing that gap takes {unitCostSaving} {currency} off every future unit, worth about {annualSavingAtNextTier} {currency} a year.',
                            {
                              unitsToNextTier: insight.unitsToNextTier,
                              nextTierDiscount: insight.nextTierDiscount,
                              currentTierDiscount: insight.currentTierDiscount,
                              unitCostSaving: insight.unitCostSaving,
                              annualSavingAtNextTier: insight.annualSavingAtNextTier,
                              currency: currencyCode,
                            },
                          )}
                        </p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </PageBody>
    </Page>
  )
}
