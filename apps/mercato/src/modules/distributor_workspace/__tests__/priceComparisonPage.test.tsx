/** @jest-environment jsdom */

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: jest.fn(),
}))

import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { z } from 'zod'
import { I18nProvider, type Dict } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import PriceComparisonPage from '../backend/pricing/comparison/page'

const apiCallMock = apiCall as jest.MockedFunction<typeof apiCall>
const RESPONSE_STUB = { ok: true, status: 200 } as unknown as Response

const PL_DICT: Dict = z
  .record(z.string(), z.string())
  .parse(JSON.parse(readFileSync(path.join(__dirname, '../i18n/pl.json'), 'utf8')))

const ORDERS = {
  items: [
    { id: '11111111-1111-4111-8111-111111111111', orderNumber: 'FV/171/2026/09', customerReference: 'Sake Izakaya', placedAt: '2026-09-18T00:00:00.000Z' },
    { id: '22222222-2222-4222-8222-222222222222', orderNumber: 'FV/159/2026/09', customerReference: 'TABLES', placedAt: '2026-09-17T00:00:00.000Z' },
  ],
}

const COMPARISON = {
  order: {
    orderNumber: 'FV/171/2026/09',
    placedAt: '2026-09-18T00:00:00.000Z',
    currencyCode: 'PLN',
    customerReference: 'Sake Izakaya',
    sourceFirm: null,
    salespeople: [],
    deliveries: [],
    dataComplete: true,
  },
  baseline: {
    revenue: 100,
    theirCost: 70,
    theirProfit: 30,
    theirMarginPercent: 30,
    ourCost: 80,
    ops: 10,
    realProfit: 20,
    realMarginPercent: 20,
  },
  totals: {
    mode: 'full' as const,
    multiplier: 1,
    lineCount: 1,
    pricedLineCount: 1,
    revenue: 100,
    simulatedRevenue: 100,
    theirCost: 70,
    theirTotalCost: 80,
    theirProfit: 30,
    theirMarginPercent: 30,
    ourCost: 80,
    scenarioCost: 0,
    linesCheaper: 0,
    linesBelowOurCost: 0,
  },
  components: { theirs: [], ours: [], scenario: [] },
  scenario: null,
  channels: [],
  ladder: [],
  delivery: { model: null, distanceKm: null, zoneCode: null, total: 0, rates: null, courierFlat: null, legs: [] },
  sourceCosting: null,
  warnings: [],
  lines: [],
  engineError: null,
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="pl" dict={PL_DICT}>
        <PriceComparisonPage />
      </I18nProvider>
    </QueryClientProvider>,
  )
}

/**
 * The document an operator opens this screen for is almost always the one that just came in, and
 * the list is already newest-first — so making them click it before anything is computed is a step
 * that answers nothing.
 */
describe('price comparison page — the document it opens on', () => {
  beforeEach(() => {
    apiCallMock.mockReset()
    apiCallMock.mockImplementation((async (url: string) => {
      if (url.startsWith('/api/sales/orders')) {
        return { ok: true, status: 200, result: ORDERS, response: RESPONSE_STUB }
      }
      return { ok: true, status: 200, result: COMPARISON, response: RESPONSE_STUB }
    }) as never)
  })

  it('asks the API for the newest documents first', async () => {
    renderPage()

    await waitFor(() => expect(apiCallMock).toHaveBeenCalled())
    const listUrl = String(apiCallMock.mock.calls[0]?.[0] ?? '')
    expect(listUrl).toContain('sortField=placedAt')
    expect(listUrl).toContain('sortDir=desc')
  })

  it('prices the newest document without waiting to be told which one', async () => {
    renderPage()

    await waitFor(() => {
      const comparisonCall = apiCallMock.mock.calls.find((call) =>
        String(call[0]).startsWith('/api/distributor_workspace/price-comparison'),
      )
      expect(String(comparisonCall?.[0] ?? '')).toContain(ORDERS.items[0]!.id)
    })
    expect(await screen.findByRole('heading', { name: 'FV/171/2026/09' })).toBeTruthy()
  })

  it('dates every document in the picker, so "newest" is something the reader can check', async () => {
    renderPage()

    expect(await screen.findByText('18.09.2026')).toBeTruthy()
    expect(screen.getByText('17.09.2026')).toBeTruthy()
  })
})
