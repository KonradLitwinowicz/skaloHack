/** @jest-environment jsdom */

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: jest.fn(),
}))

import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { z } from 'zod'
import { I18nProvider, type Dict } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import PredictedOrdersPage from '../backend/predicted-orders/page'

const apiCallMock = apiCall as jest.MockedFunction<typeof apiCall>
const RESPONSE_STUB = { ok: true, status: 200 } as unknown as Response

/** The shipped catalogue, so a renamed or missing key shows up here rather than as a silent fallback. */
const PL_DICT: Dict = z
  .record(z.string(), z.string())
  .parse(JSON.parse(readFileSync(path.join(__dirname, '../i18n/pl.json'), 'utf8')))

type BasketLine = {
  productKey: string
  productName: string
  sku: string | null
  predictedQuantity: number
  quantityUnit: string | null
  predictedLineNetAmount: number | null
  confidence: number
  confidenceBand: 'high' | 'medium' | 'low'
  acknowledged: boolean
  cadenceDays: number
  dominantWeekday: number | null
  weekdayHits: number
  occurrences: number
  lastOrderedAt: string
  history: Array<{ orderedAt: string; quantity: number; orderIds: string[] }>
}

function line(overrides: Partial<BasketLine> = {}): BasketLine {
  return {
    productKey: 'variant:towels',
    productName: 'Ręczniki papierowe',
    sku: 'TOW-1',
    predictedQuantity: 12,
    quantityUnit: 'szt',
    predictedLineNetAmount: 120,
    confidence: 0.82,
    confidenceBand: 'high',
    acknowledged: false,
    cadenceDays: 7,
    dominantWeekday: 2,
    weekdayHits: 4,
    occurrences: 5,
    lastOrderedAt: '2026-09-08',
    history: [
      { orderedAt: '2026-09-08', quantity: 12, orderIds: ['order-1'] },
      { orderedAt: '2026-09-01', quantity: 12, orderIds: ['order-2'] },
    ],
    ...overrides,
  }
}

/** Two Tuesday deliveries and one Thursday one, so a weekday filter has something to separate. */
const RESPONSE = {
  generatedAt: '2026-09-19T08:00:00.000Z',
  horizonDays: 7,
  customersAnalysed: 12,
  customersWithPredictions: 2,
  totalValueNet: 360,
  currencyCode: 'PLN',
  rows: [
    {
      customerEntityId: 'cust-1',
      customerName: 'Bar Wtorkowy',
      expectedAt: '2026-09-22',
      weekday: 2,
      daysUntilExpected: 3,
      overdueDays: 0,
      lineCount: 1,
      totalNetAmount: 120,
      currencyCode: 'PLN',
      confidence: 0.82,
      confidenceBand: 'high' as const,
      acknowledgedLines: 0,
      onRhythm: true,
      lines: [line()],
    },
    {
      customerEntityId: 'cust-2',
      customerName: 'Hotel Czwartkowy',
      expectedAt: '2026-09-24',
      weekday: 4,
      daysUntilExpected: 5,
      overdueDays: 0,
      lineCount: 1,
      totalNetAmount: 120,
      currencyCode: 'PLN',
      confidence: 0.7,
      confidenceBand: 'medium' as const,
      acknowledgedLines: 0,
      onRhythm: true,
      lines: [line({ productKey: 'variant:gloves', productName: 'Rękawice', dominantWeekday: 4 })],
    },
    {
      customerEntityId: 'cust-1',
      customerName: 'Bar Wtorkowy',
      expectedAt: '2026-09-29',
      weekday: 2,
      daysUntilExpected: 10,
      overdueDays: 0,
      lineCount: 1,
      totalNetAmount: 120,
      currencyCode: 'PLN',
      confidence: 0.75,
      confidenceBand: 'high' as const,
      acknowledgedLines: 0,
      onRhythm: true,
      lines: [line()],
    },
  ],
}

type BasketRow = {
  customerEntityId: string
  customerName: string
  expectedAt: string
  weekday: number
  daysUntilExpected: number
  overdueDays: number
  lineCount: number
  totalNetAmount: number | null
  currencyCode: string | null
  confidence: number
  confidenceBand: 'high' | 'medium' | 'low'
  acknowledgedLines: number
  onRhythm: boolean
  lines: BasketLine[]
}

function basket(overrides: Partial<BasketRow> = {}): BasketRow {
  return {
    customerEntityId: 'cust-1',
    customerName: 'Bar Wtorkowy',
    expectedAt: '2026-09-22',
    weekday: 2,
    daysUntilExpected: 3,
    overdueDays: 0,
    lineCount: 1,
    totalNetAmount: 120,
    currencyCode: 'PLN',
    confidence: 0.82,
    confidenceBand: 'high',
    acknowledgedLines: 0,
    onRhythm: true,
    lines: [line()],
    ...overrides,
  }
}

function responseOf(rows: BasketRow[]) {
  return {
    generatedAt: '2026-09-19T08:00:00.000Z',
    horizonDays: 14,
    customersAnalysed: 12,
    customersWithPredictions: rows.length,
    totalValueNet: null,
    currencyCode: 'PLN',
    rows,
  }
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="pl" dict={PL_DICT}>
        <PredictedOrdersPage />
      </I18nProvider>
    </QueryClientProvider>,
  )
}

describe('predicted orders page — the weekday an operator plans against', () => {
  beforeEach(() => {
    apiCallMock.mockReset()
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: RESPONSE, response: RESPONSE_STUB } as never)
  })

  it('offers one filter chip per delivery weekday, counting the deliveries behind it', async () => {
    renderPage()

    const tuesday = await screen.findByTitle('wtorek')
    expect(tuesday).toHaveTextContent('2')
    expect(await screen.findByTitle('czwartek')).toHaveTextContent('1')
    expect(screen.queryByTitle('poniedziałek')).toBeNull()
  })

  it('shows only the chosen weekday once a chip is pressed, and restores the rest', async () => {
    renderPage()

    fireEvent.click(await screen.findByTitle('czwartek'))

    await waitFor(() => expect(screen.queryByText('Bar Wtorkowy')).toBeNull())
    expect(screen.getByText('Hotel Czwartkowy')).toBeTruthy()
    // The chip keeps its count while the day is filtered out: otherwise switching Tuesday on would
    // be the only way to learn whether Tuesday is worth switching on.
    expect(screen.getByTitle('wtorek')).toHaveTextContent('2')

    fireEvent.click(screen.getByText('Wszystkie'))
    await waitFor(() => expect(screen.getAllByText('Bar Wtorkowy').length).toBeGreaterThan(0))
  })

  it('names the habitual weekday and the weekday of every past purchase', async () => {
    renderPage()

    const showBasket = await screen.findAllByText('Pokaż koszyk')
    fireEvent.click(showBasket[0] as HTMLElement)

    expect(await screen.findByText(/najczęściej we wtorek \(4\/5\)/)).toBeTruthy()

    const history = await screen.findByText('Kupowane:')
    const dates = within(history.parentElement as HTMLElement).getAllByRole('link')
    // Every history entry reads "<weekday> <date> (<quantity>)" rather than a bare date.
    expect(dates.length).toBeGreaterThan(0)
    for (const entry of dates) {
      expect(entry.textContent ?? '').toMatch(/^\D+\s\d/)
    }
  })
})


/**
 * A list nobody scrolls to the bottom of has to put the rows worth acting on at the top, and
 * "soonest" is not that ranking — a delivery due tomorrow that the history barely supports is a
 * worse call than a certain one due next week.
 */
describe('predicted orders page — the order the list is read in', () => {
  const ROWS = [
    basket({
      customerEntityId: 'cust-soon',
      customerName: 'Niepewny Bistro',
      expectedAt: '2026-09-21',
      weekday: 1,
      daysUntilExpected: 2,
      confidence: 0.4,
      confidenceBand: 'low',
      lines: [line({ confidence: 0.4, confidenceBand: 'low' })],
    }),
    basket({
      customerEntityId: 'cust-sure',
      customerName: 'Pewna Stolowka',
      expectedAt: '2026-09-28',
      weekday: 1,
      daysUntilExpected: 9,
      confidence: 0.95,
      confidenceBand: 'high',
      lines: [line({ confidence: 0.95, confidenceBand: 'high' })],
    }),
  ]

  beforeEach(() => {
    apiCallMock.mockReset()
    apiCallMock.mockResolvedValue({
      ok: true,
      status: 200,
      result: responseOf(ROWS),
      response: RESPONSE_STUB,
    } as never)
  })

  it('leads with the most certain delivery, whatever the calendar says', async () => {
    renderPage()

    const links = await screen.findAllByRole('link')
    expect(links[0]).toHaveTextContent('Pewna Stolowka')
  })

  it('gives the calendar back to whoever is loading a van', async () => {
    renderPage()

    fireEvent.click(await screen.findByText('Najbliższe'))

    await waitFor(() => {
      expect(screen.getAllByRole('link')[0]).toHaveTextContent('Niepewny Bistro')
    })
  })

  it('asks for the whole window, so the client-side order is not ranking a truncated slice', async () => {
    renderPage()

    await screen.findAllByRole('link')
    expect(apiCallMock.mock.calls[0]?.[0]).toContain('limit=500')
  })
})

/**
 * The buy and the pick do not happen customer by customer, so the same predictions have to be
 * readable down the product axis with the quantities already added up.
 */
describe('predicted orders page — the product view', () => {
  const ROWS = [
    basket({
      customerEntityId: 'cust-1',
      customerName: 'Bar Wtorkowy',
      lines: [line({ predictedQuantity: 12, predictedLineNetAmount: 120 })],
    }),
    basket({
      customerEntityId: 'cust-2',
      customerName: 'Hotel Czwartkowy',
      expectedAt: '2026-09-24',
      weekday: 2,
      daysUntilExpected: 5,
      confidence: 0.7,
      confidenceBand: 'medium',
      lines: [
        line({ predictedQuantity: 8, predictedLineNetAmount: 80, confidence: 0.7, confidenceBand: 'medium' }),
        line({
          productKey: 'variant:gloves',
          productName: 'Rękawice',
          sku: 'REK-1',
          predictedQuantity: 3,
          predictedLineNetAmount: 30,
        }),
      ],
    }),
  ]

  beforeEach(() => {
    apiCallMock.mockReset()
    apiCallMock.mockResolvedValue({
      ok: true,
      status: 200,
      result: responseOf(ROWS),
      response: RESPONSE_STUB,
    } as never)
  })

  it('sums one product across every customer that is about to want it', async () => {
    renderPage()

    fireEvent.click(await screen.findByText('Produkty'))

    // 12 for one customer and 8 for the other, on two separate deliveries.
    expect(await screen.findByText('20 szt')).toBeTruthy()
    expect(screen.getByText(/2 klienci · 2 dostawy/)).toBeTruthy()
    expect(screen.getByText('3 szt')).toBeTruthy()
    expect(screen.getByText(/1 klient · 1 dostawa/)).toBeTruthy()
  })

  it('names the customers and dates the quantity was added up from', async () => {
    renderPage()

    fireEvent.click(await screen.findByText('Produkty'))
    const card = (await screen.findByText('Ręczniki papierowe')).closest('div.rounded-lg') as HTMLElement
    fireEvent.click(within(card).getByText('Pokaż klientów'))

    const panel = await within(card).findByRole('table')
    expect(within(panel).getByText('Bar Wtorkowy')).toBeTruthy()
    expect(within(panel).getByText('Hotel Czwartkowy')).toBeTruthy()
  })


  it('keeps the delivery list reachable from the product view', async () => {
    renderPage()

    fireEvent.click(await screen.findByText('Produkty'))
    await screen.findAllByText('Pokaż klientów')

    fireEvent.click(screen.getByText('Dostawy'))
    await waitFor(() => expect(screen.getAllByText('Pokaż koszyk').length).toBeGreaterThan(0))
  })
})

describe('predicted orders page — how much is mounted', () => {
  beforeEach(() => {
    apiCallMock.mockReset()
  })

  /**
   * The endpoint hands over the whole window. Mounting 40 customers' worth of expandable baskets
   * to answer a question that lives in the first few rows is the cost this cap removes.
   */
  it('mounts the first 25 customers and offers the rest behind one control', async () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      basket({
        customerEntityId: `cust-${index}`,
        customerName: `Klient ${index}`,
        daysUntilExpected: index,
      }),
    )
    apiCallMock.mockResolvedValue({
      ok: true,
      status: 200,
      result: responseOf(rows),
      response: RESPONSE_STUB,
    } as never)

    renderPage()

    expect(await screen.findByText('Klient 0')).toBeInTheDocument()
    expect(screen.queryByText('Klient 30')).not.toBeInTheDocument()

    // The heading still counts every row: what is hidden is markup, not the number.
    expect(screen.getByText(/Nadchodzące \(40\)/)).toBeInTheDocument()

    const showMore = screen.getByRole('button', { name: /Pokaż więcej \(15\)/ })
    fireEvent.click(showMore)

    expect(await screen.findByText('Klient 30')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Pokaż więcej/ })).not.toBeInTheDocument()
  })

  it('restarts the reveal when the list is reordered', async () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      basket({
        customerEntityId: `cust-${index}`,
        customerName: `Klient ${index}`,
        daysUntilExpected: index,
        confidence: 0.9 - index / 100,
      }),
    )
    apiCallMock.mockResolvedValue({
      ok: true,
      status: 200,
      result: responseOf(rows),
      response: RESPONSE_STUB,
    } as never)

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /Pokaż więcej/ }))
    expect(await screen.findByText('Klient 30')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Najbliższe' }))

    await waitFor(() => {
      expect(screen.queryByText('Klient 30')).not.toBeInTheDocument()
    })
  })
})
