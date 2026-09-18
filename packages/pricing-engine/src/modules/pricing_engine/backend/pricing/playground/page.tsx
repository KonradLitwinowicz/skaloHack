'use client'

import * as React from 'react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PriceWaterfall } from './PriceWaterfall'
import type { QuoteResponse } from '../../../lib/frontend/quoteTypes'
import { withRunningTotals } from '../../../lib/frontend/runningTotals'

const ORDER_SCENARIOS = [
  'ideal_file',
  'nonstandard_file',
  'email',
  'sms',
  'phone',
  'rep_visit',
] as const

export default function PricingPlaygroundPage() {
  const t = useT()
  const [productId, setProductId] = React.useState('')
  const [quantity, setQuantity] = React.useState('1')
  const [customerId, setCustomerId] = React.useState('')
  const [orderScenarioCode, setOrderScenarioCode] = React.useState<string>('phone')
  const [result, setResult] = React.useState<QuoteResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const calculate = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const call = await apiCall<QuoteResponse & { error?: string }>('/api/pricing/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: customerId.trim() || null,
          orderScenarioCode,
          lines: [{ productId: productId.trim(), quantity: quantity.trim() }],
        }),
      })
      if (!call.ok || !call.result) {
        setResult(null)
        setError(t(call.result?.error ?? 'pricing_engine.errors.quoteFailed', 'Pricing failed.'))
        return
      }
      const payload = call.result
      setResult({
        ...payload,
        lines: payload.lines.map((line) => ({
          ...line,
          breakdown: withRunningTotals(line.breakdown),
        })),
      })
    } catch {
      setResult(null)
      setError(t('pricing_engine.errors.quoteFailed', 'Pricing failed.'))
    } finally {
      setLoading(false)
    }
  }, [customerId, orderScenarioCode, productId, quantity, t])

  const line = result?.lines[0] ?? null

  return (
    <Page>
      <PageBody>
        <p className="text-sm text-muted-foreground">
          {t('pricing_engine.playground.description', 'Price a basket and see every component that built the price.')}
        </p>

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <label className="flex flex-col gap-1 text-sm">
            <span>{t('pricing_engine.playground.field.productId', 'Product ID')}</span>
            <Input value={productId} onChange={(event) => setProductId(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t('pricing_engine.playground.field.quantity', 'Quantity')}</span>
            <Input value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t('pricing_engine.playground.field.customerId', 'Customer ID')}</span>
            <Input value={customerId} onChange={(event) => setCustomerId(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t('pricing_engine.playground.field.orderScenario', 'Order scenario')}</span>
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={orderScenarioCode}
              onChange={(event) => setOrderScenarioCode(event.target.value)}
            >
              {ORDER_SCENARIOS.map((code) => (
                <option key={code} value={code}>
                  {t(`pricing_engine.scenarios.${toCamelCase(code)}`, code)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-4">
          <Button type="button" onClick={calculate} disabled={loading || productId.trim() === ''}>
            {t('pricing_engine.playground.action.calculate', 'Calculate price')}
          </Button>
        </div>

        {loading ? <LoadingMessage label={t('pricing_engine.playground.action.calculate', 'Calculate price')} /> : null}
        {error ? <ErrorMessage label={error} /> : null}

        {!loading && !error && !line ? (
          <p className="mt-6 text-sm text-muted-foreground">
            {t('pricing_engine.playground.empty', 'Enter a product and quantity, then calculate a price.')}
          </p>
        ) : null}

        {line ? (
          <div className="mt-6 space-y-6">
            <div className="grid gap-3 md:grid-cols-4">
              <KpiCard
                title={t('pricing_engine.playground.result.unitPrice', 'Unit price (net)')}
                value={Number(line.unitPriceNet)}
                suffix={` ${result?.currencyCode ?? ''}`}
              />
              <KpiCard
                title={t('pricing_engine.playground.result.unitCost', 'Unit cost (net)')}
                value={Number(line.unitCostNet)}
                suffix={` ${result?.currencyCode ?? ''}`}
              />
              <KpiCard
                title={t('pricing_engine.playground.result.markup', 'Markup')}
                value={Number(line.markupPercent)}
                suffix="%"
              />
              <KpiCard
                title={t('pricing_engine.playground.result.margin', 'Margin')}
                value={Number(line.marginPercent)}
                suffix="%"
              />
            </div>

            {result && result.warnings.length > 0 ? (
              <div className="rounded-md border border-border p-3">
                <div className="text-sm font-medium">
                  {t('pricing_engine.playground.warnings.title', 'Warnings')}
                </div>
                <ul className="mt-2 space-y-1">
                  {result.warnings.map((warning) => (
                    <li key={warning}>
                      <Badge variant="secondary">{t(warning, warning)}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div>
              <h2 className="mb-2 text-base font-medium">
                {t('pricing_engine.playground.waterfall.title', 'How the price was built')}
              </h2>
              <PriceWaterfall breakdown={line.breakdown} currencyCode={result?.currencyCode ?? ''} />
            </div>
          </div>
        ) : null}
      </PageBody>
    </Page>
  )
}

function toCamelCase(code: string): string {
  return code.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}
