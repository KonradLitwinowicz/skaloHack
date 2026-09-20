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
import { render, screen, within } from '@testing-library/react'
import { z } from 'zod'
import { I18nProvider, type Dict } from '@open-mercato/shared/lib/i18n/context'
import type { Locale } from '@open-mercato/shared/lib/i18n/config'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { clearSharedApiGetCache } from '@open-mercato/ui/backend/utils/sharedApiGet'
import type { DashboardWidgetComponentProps, DashboardLayoutItem } from '@open-mercato/shared/modules/dashboard/widgets'
import expiringStockWidget from '../widgets/dashboard/expiring-stock/widget'
import stockGapsWidget from '../widgets/dashboard/stock-gaps/widget'
import ExpiringStockWidget, {
  daysUntilExpiry,
  sortLotsByUrgency,
  type ExpiringStockLot,
  type ExpiringStockSettings,
} from '../widgets/dashboard/expiring-stock/widget.client'

const apiCallMock = apiCall as jest.MockedFunction<typeof apiCall>

const REFERENCE = '2026-09-19T09:00:00.000Z'

// jsdom exposes no global Response, and these widgets never read the raw one.
const RESPONSE_STUB = { ok: true, status: 200 } as unknown as Response

/**
 * The shipped catalogues, read from disk rather than hand-copied.
 *
 * `t(key, fallback)` resolves `dict[key] ?? fallback ?? key`
 * (packages/shared/src/lib/i18n/context.tsx), so rendering against `dict={{}}` only ever
 * asserted the string hard-coded in the component: every text expectation stayed green with
 * the whole translation directory deleted. Rendering against the real files is what makes a
 * changed, renamed or untranslated catalogue entry fail here.
 */
function loadDict(locale: Locale): Dict {
  return z
    .record(z.string(), z.string())
    .parse(JSON.parse(readFileSync(path.join(__dirname, `../i18n/${locale}.json`), 'utf8')))
}

const EN_DICT: Dict = loadDict('en')
const PL_DICT: Dict = loadDict('pl')

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

function widgetProps<TSettings>(settings: TSettings): DashboardWidgetComponentProps<TSettings> {
  return {
    mode: 'view',
    layout: LAYOUT,
    settings,
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

function renderWidget(
  node: React.ReactElement,
  locale: Locale = 'en',
  dict: Dict = EN_DICT,
): ReturnType<typeof render> {
  return render(
    <I18nProvider locale={locale} dict={dict}>
      {node}
    </I18nProvider>,
  )
}

const EMPTY_SETTINGS = {} as ExpiringStockSettings

function lot(overrides: Partial<ExpiringStockLot> & Pick<ExpiringStockLot, 'id' | 'lotNumber' | 'expiresAt'>): ExpiringStockLot {
  return {
    sku: `SKU-${overrides.id}`,
    availableQuantity: 10,
    category: 'expiringSoon',
    ...overrides,
  }
}

beforeEach(() => {
  apiCallMock.mockReset()
  // The two operational-dashboard widgets share one cached GET at runtime; without this
  // the response mocked by the previous test would still be serving the next one.
  clearSharedApiGetCache()
})

describe('expiring stock helpers', () => {
  it('counts whole days against the supplied reference instant, not the wall clock', () => {
    expect(daysUntilExpiry('2026-09-19T23:00:00.000Z', REFERENCE)).toBe(0)
    expect(daysUntilExpiry('2026-09-20T01:00:00.000Z', REFERENCE)).toBe(1)
    expect(daysUntilExpiry('2026-09-24T09:00:00.000Z', REFERENCE)).toBe(5)
    expect(daysUntilExpiry('2026-09-16T09:00:00.000Z', REFERENCE)).toBe(-3)
  })

  it('treats an unparsable date as unknown rather than as an urgent zero', () => {
    expect(daysUntilExpiry('not-a-date', REFERENCE)).toBeNull()
    expect(daysUntilExpiry(REFERENCE, 'not-a-date')).toBeNull()
  })

  it('orders past-date lots ahead of soon-to-expire ones and sorts undated lots last', () => {
    const sorted = sortLotsByUrgency([
      lot({ id: 'c', lotNumber: 'LOT-C', expiresAt: '2026-09-25T00:00:00.000Z' }),
      lot({ id: 'x', lotNumber: 'LOT-X', expiresAt: 'not-a-date' }),
      lot({ id: 'a', lotNumber: 'LOT-A', expiresAt: '2026-09-15T00:00:00.000Z', category: 'pastDue' }),
      lot({ id: 'b', lotNumber: 'LOT-B', expiresAt: '2026-09-21T00:00:00.000Z' }),
    ])
    expect(sorted.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'x'])
  })

  it('does not mutate the source list', () => {
    const source = [
      lot({ id: 'b', lotNumber: 'LOT-B', expiresAt: '2026-09-21T00:00:00.000Z' }),
      lot({ id: 'a', lotNumber: 'LOT-A', expiresAt: '2026-09-15T00:00:00.000Z' }),
    ]
    sortLotsByUrgency(source)
    expect(source.map((entry) => entry.id)).toEqual(['b', 'a'])
  })
})

describe('expiring stock widget', () => {
  it('lists lots from most urgent to least, with day counts relative to lastUpdatedAt', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 12 }, { id: 'pastDue', count: 1 }],
      expiryLots: [
        lot({ id: 'soon', lotNumber: 'LOT-SOON', expiresAt: '2026-09-24T00:00:00.000Z', availableQuantity: 40 }),
        lot({ id: 'over', lotNumber: 'LOT-OVER', expiresAt: '2026-09-17T00:00:00.000Z', category: 'pastDue', availableQuantity: 7 }),
        lot({ id: 'today', lotNumber: 'LOT-TODAY', expiresAt: '2026-09-19T22:00:00.000Z', availableQuantity: 3 }),
      ],
    })

    renderWidget(<ExpiringStockWidget {...widgetProps(EMPTY_SETTINGS)} />)

    const rows = await screen.findAllByRole('listitem')
    expect(rows.map((row) => within(row).getByText(/^SKU-/).textContent)).toEqual([
      'SKU-over',
      'SKU-today',
      'SKU-soon',
    ])
    expect(within(rows[0]).getByText('2 days past date')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Expires today')).toBeInTheDocument()
    expect(within(rows[2]).getByText('In 5 days')).toBeInTheDocument()
    expect(within(rows[0]).getByRole('link')).toHaveAttribute('href', '/backend/wms/lot/over')
  })

  it('shows both headline counts as links into the lot list', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 12 }, { id: 'pastDue', count: 0 }],
      expiryLots: [lot({ id: 'soon', lotNumber: 'LOT-SOON', expiresAt: '2026-09-24T00:00:00.000Z' })],
    })

    renderWidget(<ExpiringStockWidget {...widgetProps(EMPTY_SETTINGS)} />)

    const losing = await screen.findByText('Losing date')
    expect(losing.closest('a')).toHaveAttribute('href', '/backend/wms/lots?expiryWindow=expiringSoon')
    expect(screen.getByText('Past date').closest('a')).toHaveAttribute('href', '/backend/wms/lots?expiryWindow=pastDue')
  })

  it('reads an empty expiry watch list as good news, not as a failure', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 0 }, { id: 'pastDue', count: 0 }],
      expiryLots: [],
    })

    renderWidget(<ExpiringStockWidget {...widgetProps(EMPTY_SETTINGS)} />)

    // "Good news" is the claim, so the DS success tone is part of what is asserted here.
    const message = await screen.findByText('Nothing is close to its expiry date.')
    expect(message).toHaveClass('text-status-success-text')
    expect(message.parentElement).toHaveClass('bg-status-success-bg')
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('reports a failed request instead of rendering an empty box', async () => {
    apiCallMock.mockResolvedValue({
      ok: false,
      status: 403,
      result: null,
      response: RESPONSE_STUB,
      cacheStatus: null,
    })

    renderWidget(<ExpiringStockWidget {...widgetProps(EMPTY_SETTINGS)} />)

    expect(await screen.findByText('Could not load the expiry watch list')).toBeInTheDocument()
  })

  it('reads the urgency-ordered list through the Polish catalogue', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 12 }, { id: 'pastDue', count: 1 }],
      expiryLots: [
        lot({ id: 'soon', lotNumber: 'LOT-SOON', expiresAt: '2026-09-24T00:00:00.000Z', availableQuantity: 40 }),
        lot({ id: 'over', lotNumber: 'LOT-OVER', expiresAt: '2026-09-17T00:00:00.000Z', category: 'pastDue', availableQuantity: 7 }),
      ],
    })

    renderWidget(<ExpiringStockWidget {...widgetProps(EMPTY_SETTINGS)} />, 'pl', PL_DICT)

    const rows = await screen.findAllByRole('listitem')
    expect(within(rows[0]).getByText('2 dni po terminie')).toBeInTheDocument()
    expect(within(rows[0]).getByText('7 szt.')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Za 5 dni')).toBeInTheDocument()
    expect(screen.getByText('Traci termin')).toBeInTheDocument()
    expect(screen.getByText('Po terminie')).toBeInTheDocument()
  })
})

/**
 * The stock-gaps trend assertions that used to live here are GONE, not moved.
 *
 * The widget no longer draws a seven-day sparkline or a "since yesterday" delta — both were
 * removed in this round because the operational dashboard feeds them a series that is not a
 * low-stock history at all (see the removal note in
 * `widgets/dashboard/stock-gaps/widget.client.tsx`). The guard that the widget must not draw
 * them again lives in `stockGapsWidget.test.tsx`, which owns that widget; re-asserting a label
 * that no longer exists would have required restoring the element to keep a test green.
 */
describe('widget metadata', () => {
  it.each([
    ['distributor_workspace.dashboard.expiringStock', expiringStockWidget, 'distributor_workspace.widgets.expiring-stock'],
    ['distributor_workspace.dashboard.stockGaps', stockGapsWidget, 'distributor_workspace.widgets.stock-gaps'],
  ])('%s is enabled by default and gated on the features its data route requires plus its own id', (id, widget, ownFeature) => {
    expect(widget.metadata.id).toBe(id)
    expect(widget.metadata.defaultEnabled).toBe(true)
    expect(widget.metadata.features).toEqual(['dashboards.view', 'wms.view', ownFeature])
    expect(widget.metadata.supportsRefresh).toBe(true)
  })

  /**
   * `DashboardScreen` resolves `<widget id>.title` / `.description` from the catalogue and
   * falls back to `metadata` only when the key is absent
   * (packages/ui/src/backend/dashboard/DashboardScreen.tsx lines 214-228), so the catalogue
   * entry — not the metadata string — is what the operator reads. The title is pinned against
   * the metadata here because the two must say the same thing.
   *
   * The DESCRIPTION is deliberately not pinned in this file: `i18n/*.json` is merged by a
   * separate step, so a description this round rewrote in `widget.ts` lands in the catalogue
   * later. `stockGapsWidget.test.tsx` pins the wording of that widget's metadata description;
   * the catalogue side of the same claim is reported as a finding instead of asserted here,
   * because an assertion that fails on unmerged translation files reports the merge, not a
   * defect in the widget.
   */
  it.each([
    ['distributor_workspace.dashboard.expiringStock', expiringStockWidget],
    ['distributor_workspace.dashboard.stockGaps', stockGapsWidget],
  ])('%s has its title and description in both shipped catalogues', (id, widget) => {
    for (const dict of [EN_DICT, PL_DICT]) {
      expect((dict[`${id}.title`] ?? '').trim().length).toBeGreaterThan(0)
      expect((dict[`${id}.description`] ?? '').trim().length).toBeGreaterThan(0)
    }
    expect(EN_DICT[`${id}.title`]).toBe(widget.metadata.title)
  })
})
