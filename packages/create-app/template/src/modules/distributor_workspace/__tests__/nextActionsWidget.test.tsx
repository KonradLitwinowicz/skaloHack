/** @jest-environment jsdom */

// `className` is forwarded on purpose: the tone of a row is carried by the left border of the
// link itself, so a mock that dropped it would make the tone untestable at this level.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: jest.fn(),
}))

import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { z } from 'zod'
import { I18nProvider, type Dict } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import type { DashboardWidgetComponentProps, DashboardLayoutItem } from '@open-mercato/shared/modules/dashboard/widgets'
import nextActionsWidget from '../widgets/dashboard/next-actions/widget'
import NextActionsWidget from '../widgets/dashboard/next-actions/widget.client'
import {
  buildNextActions,
  EXPIRY_WATCH_DAYS,
  NEXT_ACTION_KINDS,
  type NextActionKind,
  type NextActionSignal,
  type NextActionTone,
} from '../lib/nextActions'

const apiCallMock = apiCall as jest.MockedFunction<typeof apiCall>

// jsdom exposes no global Response, and this widget never reads the raw one.
const RESPONSE_STUB = { ok: true, status: 200 } as unknown as Response

const NOW = new Date('2026-09-19T09:00:00.000Z')

/**
 * The shipped English catalogue, read from disk rather than hand-copied.
 *
 * Every label this widget shows for a next-action kind lives in a MAP
 * (`ACTION_LABEL_FALLBACK` in the widget, the i18n file in the catalogue), not in a
 * `t('key', 'fallback')` call the reader can grep for. A kind added to
 * `NEXT_ACTION_KINDS` without touching either map renders silently as the raw key.
 * Rendering against the real file is what makes that visible here.
 */
const EN_DICT: Dict = z
  .record(z.string(), z.string())
  .parse(JSON.parse(readFileSync(path.join(__dirname, '../i18n/en.json'), 'utf8')))

function actionLabelKey(kind: NextActionKind): string {
  return `distributor_workspace.widgets.nextActions.action.${kind}`
}

const DESCRIPTION_KEY = 'distributor_workspace.dashboard.nextActions.description'

/** The row label lives in a `<span className="... font-medium ...">`; there is no role or test id
 *  to hang on to, and matching on the text would defeat the point of reading it. */
function labelText(listRow: HTMLElement): string {
  const label = within(listRow).getByText(
    (_, element) => element?.tagName === 'SPAN' && element.className.includes('font-medium'),
  )
  return (label.textContent ?? '').trim()
}

function countCell(listRow: HTMLElement): HTMLElement {
  return within(listRow).getByText(
    (_, element) => element?.tagName === 'SPAN' && element.className.includes('tabular-nums'),
  )
}

/** The deep link each kind promises. Restated here on purpose: a test that imported the
 *  map it verifies would agree with any mapping, including a wrong one. */
const EXPECTED_HREF: Record<NextActionKind, string> = {
  expiringStock: '/backend/wms/lots?expiryWindow=expiringSoon',
  quoteRequestsToAnswer: '/backend/sales/quotes',
  quotesAwaitingReply: '/backend/sales/quotes',
  ordersToFulfil: '/backend/sales/orders',
  criticalStock: '/backend/wms/inventory?lowStock=belowSafety',
}

const TONE_COUNT_CLASS: Record<NextActionTone, string> = {
  error: 'text-status-error-text',
  warning: 'text-status-warning-text',
  info: 'text-status-info-text',
}

const TONE_ACCENT_CLASS: Record<NextActionTone, string> = {
  error: 'border-l-status-error-border',
  warning: 'border-l-status-warning-border',
  info: 'border-l-status-info-border',
}

type ActionRow = {
  kind: NextActionKind
  count: number
  href: string
  tone: NextActionTone
  deadlineAt: string | null
  daysUntilDeadline: number | null
  amount: number | null
  currencyCode: string | null
}

function row(kind: NextActionKind, overrides: Partial<ActionRow> = {}): ActionRow {
  return {
    kind,
    count: 3,
    href: EXPECTED_HREF[kind],
    tone: 'info',
    deadlineAt: null,
    daysUntilDeadline: null,
    amount: null,
    currencyCode: null,
    ...overrides,
  }
}

function signal(kind: NextActionKind, overrides: Partial<NextActionSignal> = {}): NextActionSignal {
  return { kind, count: 4, deadlineAt: null, amount: null, currencyCode: null, ...overrides }
}

function mockActions(actions: readonly ActionRow[]): void {
  mockPayload({ generatedAt: NOW.toISOString(), actions })
}

function mockPayload(payload: unknown): void {
  apiCallMock.mockResolvedValue({
    ok: true,
    status: 200,
    result: payload,
    response: RESPONSE_STUB,
    cacheStatus: null,
  })
}

const LAYOUT: DashboardLayoutItem = { id: 'layout-1', widgetId: 'test', order: 0 }

function widgetProps(): DashboardWidgetComponentProps {
  return {
    mode: 'view',
    layout: LAYOUT,
    settings: {},
    context: {
      userId: 'user-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      userName: null,
      userEmail: null,
      userLabel: null,
    },
    onSettingsChange: () => {},
    refreshToken: 0,
  }
}

function renderWidget(dict: Dict = EN_DICT): ReturnType<typeof render> {
  return render(
    <I18nProvider locale="en" dict={dict}>
      <NextActionsWidget {...widgetProps()} />
    </I18nProvider>,
  )
}

/** `Intl` separates a currency code from its amount with a non-breaking space, and
 *  testing-library normalizes the DOM text but not the expected string. Normalizing both
 *  sides keeps the assertion about the wording rather than about which space character
 *  the ICU build chose. */
function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** The widget formats through `Intl` with the browser locale, so the expectation has to be
 *  built the same way — a hard-coded '19 Sep 2026' would pass or fail by machine. */
function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(navigator.language, { dateStyle: 'medium' }).format(new Date(iso))
}

function formatCurrency(amount: number, currencyCode: string): string {
  return new Intl.NumberFormat(navigator.language, { style: 'currency', currency: currencyCode }).format(amount)
}

function formatNumber(amount: number): string {
  return new Intl.NumberFormat(navigator.language).format(amount)
}

beforeEach(() => {
  apiCallMock.mockReset()
})

describe('next actions widget states', () => {
  it('says what it is checking while the request is still in flight', () => {
    apiCallMock.mockReturnValue(new Promise(() => {}))

    renderWidget()

    expect(screen.getByText('Checking what needs you today…')).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('reports a failed request instead of rendering an empty box', async () => {
    apiCallMock.mockResolvedValue({
      ok: false,
      status: 500,
      result: null,
      response: RESPONSE_STUB,
      cacheStatus: null,
    })

    renderWidget()

    expect(await screen.findByText('Could not load today’s to-do list')).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('reports a malformed payload rather than rendering a partial to-do list', async () => {
    mockPayload({ generatedAt: NOW.toISOString(), actions: [{ kind: 'notAKind', count: 1 }] })

    renderWidget()

    await waitFor(() => {
      expect(screen.getByText('Could not load today’s to-do list')).toBeInTheDocument()
    })
  })

  it('reads an empty action list as good news, not as a failure', async () => {
    mockActions([])

    renderWidget()

    expect(await screen.findByText('Nothing urgent today')).toBeInTheDocument()
    expect(
      screen.getByText(
        'No stock is close to its expiry date, every quote has an answer and every order is on its way.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('explains in settings mode that the order is not configurable', () => {
    apiCallMock.mockReturnValue(new Promise(() => {}))

    render(
      <I18nProvider locale="en" dict={EN_DICT}>
        <NextActionsWidget {...widgetProps()} mode="settings" />
      </I18nProvider>,
    )

    expect(
      screen.getByText(
        'Nothing to configure — the order follows how irreversible each item is and how close its deadline sits.',
      ),
    ).toBeInTheDocument()
  })
})

describe('next actions list rendering', () => {
  it('keeps the order the route returned and never re-ranks it client-side', async () => {
    // Deliberately the reverse of the server ranking: if the widget sorted anything of its own,
    // the operator would read a different first item than the one the route decided on.
    mockActions([
      row('criticalStock', { count: 1 }),
      row('ordersToFulfil', { count: 2 }),
      row('quotesAwaitingReply', { count: 3 }),
      row('quoteRequestsToAnswer', { count: 4 }),
      row('expiringStock', { count: 5 }),
    ])

    renderWidget()

    const rows = await screen.findAllByRole('listitem')
    expect(rows).toHaveLength(5)
    expect(rows.map((entry) => within(entry).getByRole('link').getAttribute('href'))).toEqual([
      EXPECTED_HREF.criticalStock,
      EXPECTED_HREF.ordersToFulfil,
      EXPECTED_HREF.quotesAwaitingReply,
      EXPECTED_HREF.quoteRequestsToAnswer,
      EXPECTED_HREF.expiringStock,
    ])
  })

  // The count and the value sit on the same row, a couple of centimetres apart. A grouped
  // "PLN 12,450.50" next to a bare "1234" reads as two different kinds of number.
  it('groups the count the same way it groups the value on the same row', async () => {
    mockActions([row('ordersToFulfil', { count: 1234, amount: 12450.5, currencyCode: 'PLN' })])

    renderWidget()

    const listRow = await screen.findByRole('listitem')
    expect(countCell(listRow).textContent).toBe(formatNumber(1234))
    expect(countCell(listRow).textContent).not.toBe('1234')
    expect(normalizeSpaces(listRow.textContent ?? '')).toContain(
      normalizeSpaces(`Value: ${formatCurrency(12450.5, 'PLN')}`),
    )
  })

  // jsdom computes no layout, so the guard is the class: a fixed width at `text-2xl` cropped a
  // four-digit count, a minimum width keeps the column aligned and still lets it grow.
  it('lets a four-digit count widen its column instead of cropping it', async () => {
    mockActions([row('expiringStock', { count: 4821, tone: 'warning' })])

    renderWidget()

    const listRow = await screen.findByRole('listitem')
    const cell = countCell(listRow)
    expect(cell.textContent).toBe(formatNumber(4821))
    expect(cell.className).toContain('min-w-14')
    expect(cell.className).not.toMatch(/(^|\s)w-\d+(\s|$)/)
  })

  it('shows every count and paints it in the tone the route assigned', async () => {
    mockActions([
      row('expiringStock', { count: 12, tone: 'error' }),
      row('quoteRequestsToAnswer', { count: 7, tone: 'warning' }),
      row('ordersToFulfil', { count: 4, tone: 'info' }),
    ])

    renderWidget()

    const rows = await screen.findAllByRole('listitem')
    expect(within(rows[0]).getByText('12')).toHaveClass(TONE_COUNT_CLASS.error)
    expect(within(rows[1]).getByText('7')).toHaveClass(TONE_COUNT_CLASS.warning)
    expect(within(rows[2]).getByText('4')).toHaveClass(TONE_COUNT_CLASS.info)

    expect(within(rows[0]).getByRole('link')).toHaveClass(TONE_ACCENT_CLASS.error)
    expect(within(rows[1]).getByRole('link')).toHaveClass(TONE_ACCENT_CLASS.warning)
    expect(within(rows[2]).getByRole('link')).toHaveClass(TONE_ACCENT_CLASS.info)
  })
})

describe('next actions detail line', () => {
  it('names the nearest deadline while it is still ahead', async () => {
    const deadlineAt = '2026-09-24T00:00:00.000Z'
    mockActions([row('expiringStock', { count: 6, tone: 'warning', deadlineAt, daysUntilDeadline: 4 })])

    renderWidget()

    expect(
      await screen.findByText(normalizeSpaces(`Nearest deadline: ${formatDate(deadlineAt)}`)),
    ).toBeInTheDocument()
  })

  it('says the deadline has passed instead of quietly showing a date in the past', async () => {
    const deadlineAt = '2026-09-17T00:00:00.000Z'
    mockActions([
      row('quoteRequestsToAnswer', { count: 2, tone: 'error', deadlineAt, daysUntilDeadline: -2 }),
    ])

    renderWidget()

    expect(
      await screen.findByText(normalizeSpaces(`Deadline passed: ${formatDate(deadlineAt)}`)),
    ).toBeInTheDocument()
  })

  it('formats the value in the currency the route named', async () => {
    mockActions([row('quotesAwaitingReply', { count: 3, amount: 12450.5, currencyCode: 'PLN' })])

    renderWidget()

    expect(
      await screen.findByText(normalizeSpaces(`Value: ${formatCurrency(12450.5, 'PLN')}`)),
    ).toBeInTheDocument()
  })

  it('shows a bare number when the bucket mixed currencies and the route sent none', async () => {
    mockActions([row('ordersToFulfil', { count: 5, amount: 9800, currencyCode: null })])

    renderWidget()

    const detail = await screen.findByText(normalizeSpaces(`Value: ${formatNumber(9800)}`))
    expect(detail).toBeInTheDocument()
    // A currency symbol here would attribute the sum to one currency it is not in.
    expect(detail.textContent).not.toMatch(/[A-Z]{3}|[€$£zł]/)
  })

  it('joins the deadline and the value into one detail line', async () => {
    const deadlineAt = '2026-09-22T00:00:00.000Z'
    mockActions([
      row('quotesAwaitingReply', {
        count: 8,
        deadlineAt,
        daysUntilDeadline: 3,
        amount: 500,
        currencyCode: 'EUR',
      }),
    ])

    renderWidget()

    expect(
      await screen.findByText(
        normalizeSpaces(`Nearest deadline: ${formatDate(deadlineAt)} — Value: ${formatCurrency(500, 'EUR')}`),
      ),
    ).toBeInTheDocument()
  })

  // `.ai/ds-rules.md`, Content & Copy: NEVER use the middot as a separator in UI text — em dash
  // or restructure. This widget is new code and has no licence to add to that debt.
  it('separates the detail parts with an em dash and never with a middot', async () => {
    mockActions([
      row('ordersToFulfil', {
        count: 8,
        deadlineAt: '2026-09-22T00:00:00.000Z',
        daysUntilDeadline: 3,
        amount: 500,
        currencyCode: 'EUR',
      }),
    ])

    renderWidget()

    const listRow = await screen.findByRole('listitem')
    const detail = normalizeSpaces(listRow.textContent ?? '')
    expect(detail).toContain(' — ')
    expect(detail).not.toContain('·')
  })

  it('leaves the detail line out entirely when there is neither a deadline nor a value', async () => {
    mockActions([row('criticalStock', { count: 9 })])

    renderWidget()

    const listRow = await screen.findByRole('listitem')
    expect(within(listRow).getByText('9')).toBeInTheDocument()
    expect(screen.queryByText(/deadline/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Value:/)).not.toBeInTheDocument()
  })
})

/**
 * The trap this widget has already fallen into once.
 *
 * A next-action kind reaches the screen through two maps and one catalogue entry, none of
 * which the compiler or a `grep 't('` can vouch for together:
 *   1. `ACTION_HREF` / `BASE_TONE` in `lib/nextActions.ts` (typed, so the compiler helps),
 *   2. `ACTION_LABEL_FALLBACK` in `widget.client.tsx` (typed too),
 *   3. the `...action.<kind>` key in `i18n/en.json` (NOT typed — nothing fails to build).
 * Miss (3) and the row silently shows the dotted key to the operator. These tests assert
 * all three for every member of `NEXT_ACTION_KINDS`, so adding a kind breaks them here
 * rather than in production.
 */
describe('next actions kind coverage', () => {
  it.each(NEXT_ACTION_KINDS.map((kind) => [kind] as const))(
    '%s renders with a real fallback label even when nothing is translated',
    async (kind) => {
      mockActions([row(kind, { count: 1 })])

      renderWidget({})

      const listRow = await screen.findByRole('listitem')
      const label = labelText(listRow)
      expect(label).not.toBe(actionLabelKey(kind))
      expect(label.length).toBeGreaterThan(0)
    },
  )

  /**
   * The hard-coded fallback and the catalogue entry are two copies of one product text, and only
   * one of them is reviewed as copy. When they drift, whoever loses the catalogue (SSR with no
   * dict, a failed `resolveTranslations`) reads a sentence nobody signed off on — and it drifted
   * exactly that way: "Stock is running out of shelf life this week" against a 30-day window, and
   * a "critical level" the rest of the product calls the safety level.
   */
  it.each(NEXT_ACTION_KINDS.map((kind) => [kind] as const))(
    '%s falls back to the very words of the English catalogue',
    async (kind) => {
      mockActions([row(kind, { count: 1 })])

      renderWidget({})

      const listRow = await screen.findByRole('listitem')
      expect(labelText(listRow)).toBe(EN_DICT[actionLabelKey(kind)])
    },
  )

  // The expiry row links to a list built on EXPIRING_SOON_DAYS. A label naming any other window
  // makes the operator skip batches the list does show — the one failure mode the ranking library
  // was written to avoid.
  it.each([[EN_DICT[actionLabelKey('expiringStock')]], [undefined]] as const)(
    'the expiring-stock label promises no window narrower than the real one (catalogue: %s)',
    async (catalogueLabel) => {
      mockActions([row('expiringStock', { count: 1, tone: 'warning' })])

      renderWidget(catalogueLabel === undefined ? {} : EN_DICT)

      const label = labelText(await screen.findByRole('listitem'))
      expect(label).not.toMatch(/\b(today|tomorrow|week|fortnight|month)\b/i)
      const daysPromised = /(\d+)\s*days?\b/.exec(label)
      if (daysPromised) expect(Number(daysPromised[1])).toBe(EXPIRY_WATCH_DAYS)
    },
  )

  it('has an English catalogue entry for every kind', () => {
    const missing = NEXT_ACTION_KINDS.filter(
      (kind) => typeof EN_DICT[actionLabelKey(kind)] !== 'string' || EN_DICT[actionLabelKey(kind)].trim().length === 0,
    )
    expect(missing).toEqual([])
  })

  it.each(NEXT_ACTION_KINDS.map((kind) => [kind] as const))(
    '%s takes its label from the i18n catalogue and links to its own screen',
    async (kind) => {
      const actions = buildNextActions([signal(kind, { count: 2 })], NOW)
      expect(actions).toHaveLength(1)
      mockActions(actions as ActionRow[])

      renderWidget()

      const listRow = await screen.findByRole('listitem')
      expect(within(listRow).getByText(EN_DICT[actionLabelKey(kind)])).toBeInTheDocument()
      expect(within(listRow).getByRole('link')).toHaveAttribute('href', EXPECTED_HREF[kind])
    },
  )
})

describe('next actions widget metadata', () => {
  it('is enabled by default, sorted first and gated on every feature its route requires', () => {
    expect(nextActionsWidget.metadata.id).toBe('distributor_workspace.dashboard.nextActions')
    expect(nextActionsWidget.metadata.defaultEnabled).toBe(true)
    expect(nextActionsWidget.metadata.supportsRefresh).toBe(true)
    // Mirrors metadata.GET.requireFeatures in api/dashboard/next-actions/route.ts: a widget
    // offered to someone the route will refuse renders as an error tile on their dashboard.
    expect(nextActionsWidget.metadata.features).toEqual([
      'dashboards.view',
      'wms.view',
      'sales.quotes.view',
      'sales.orders.view',
    ])
    expect(nextActionsWidget.metadata.defaultPriority).toBe(100)
  })

  /**
   * The description is the header tooltip and the edit-mode subtitle, so it is a promise about
   * what the list contains. It enumerated four kinds while the route returned five: the missing
   * one was `quoteRequestsToAnswer`, the second-heaviest weight — the kind most likely to be the
   * row the operator finds on top and cannot find in the description.
   */
  it('enumerates one clause per action kind the route can return', () => {
    const enumerated = nextActionsWidget.metadata.description.split(':')[1] ?? ''
    const clauses = enumerated
      .replace(/\.$/, '')
      .split(',')
      .map((clause) => clause.replace(/^\s*and\s+/, '').trim())
      .filter((clause) => clause.length > 0)

    expect(clauses).toHaveLength(NEXT_ACTION_KINDS.length)
    expect(nextActionsWidget.metadata.description).toMatch(/quote requests/i)
    expect(nextActionsWidget.metadata.description).not.toMatch(/critical level/i)
  })

  // The catalogue entry the dashboard actually renders (`<widget id>.description`) is a copy of
  // the metadata string; the operator sees whichever of the two is loaded.
  it('has an English catalogue description matching the metadata copy', () => {
    expect(EN_DICT[DESCRIPTION_KEY]).toBe(nextActionsWidget.metadata.description)
  })
})
