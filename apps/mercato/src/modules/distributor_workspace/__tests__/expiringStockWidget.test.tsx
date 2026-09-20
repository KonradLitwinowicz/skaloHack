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
import ExpiringStockWidget, {
  countRemainingLots,
  resolveLotPrimaryLabel,
  type ExpiringStockLot,
  type ExpiringStockSettings,
} from '../widgets/dashboard/expiring-stock/widget.client'

const apiCallMock = apiCall as jest.MockedFunction<typeof apiCall>

const REFERENCE = '2026-09-19T09:00:00.000Z'

// jsdom exposes no global Response, and this widget never reads the raw one.
const RESPONSE_STUB = { ok: true, status: 200 } as unknown as Response

/**
 * The shipped catalogues, read from disk rather than hand-copied.
 *
 * `t(key, fallback)` resolves `dict[key] ?? fallback ?? key`
 * (packages/shared/src/lib/i18n/context.tsx), so rendering against `dict={{}}` asserts the
 * string hard-coded in the component and nothing else: a typo in `i18n/en.json`, a deleted
 * key or a reverted value all stay green. Every assertion below therefore runs against the
 * real file, and the Polish block runs against `i18n/pl.json` so a missing translation fails
 * here rather than on the operator's screen.
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

function widgetProps(): DashboardWidgetComponentProps<ExpiringStockSettings> {
  return {
    mode: 'view',
    layout: LAYOUT,
    settings: {} as ExpiringStockSettings,
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

function renderWidget(locale: Locale = 'en', dict: Dict = EN_DICT): ReturnType<typeof render> {
  return render(
    <I18nProvider locale={locale} dict={dict}>
      <ExpiringStockWidget {...widgetProps()} />
    </I18nProvider>,
  )
}

function lot(
  overrides: Partial<ExpiringStockLot> & Pick<ExpiringStockLot, 'id' | 'lotNumber' | 'expiresAt'>,
): ExpiringStockLot {
  return {
    sku: `SKU-${overrides.id}`,
    availableQuantity: 10,
    category: 'expiringSoon',
    ...overrides,
  }
}

function buildLots(count: number): ExpiringStockLot[] {
  return Array.from({ length: count }, (_, index) =>
    lot({
      id: `lot-${index}`,
      lotNumber: `LOT-${index}`,
      expiresAt: `2026-09-${String(20 + index).padStart(2, '0')}T00:00:00.000Z`,
    }),
  )
}

beforeEach(() => {
  apiCallMock.mockReset()
  // The two operational-dashboard widgets share one cached GET at runtime; without this
  // the response mocked by the previous test would still be serving the next one.
  clearSharedApiGetCache()
})

describe('expiring stock row identity', () => {
  it('names the product on the headline and demotes SKU and lot number to the detail line', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 1 }, { id: 'pastDue', count: 0 }],
      expiryLots: [
        lot({
          id: 'named',
          lotNumber: 'LOT-77',
          expiresAt: '2026-09-24T00:00:00.000Z',
          productTitle: 'Mozzarella di Bufala Campana DOP 125 g',
        }),
      ],
    })

    renderWidget()

    const row = await screen.findByRole('listitem')
    const headline = within(row).getByText('Mozzarella di Bufala Campana DOP 125 g')
    expect(headline).toHaveClass('text-sm')
    expect(headline).toHaveClass('text-foreground')
    // The demotion is the point: both identifiers sit on the smaller, muted second line.
    const detailLine = within(row).getByText('SKU-named').parentElement
    expect(detailLine).toHaveClass('text-xs')
    expect(detailLine).toHaveClass('text-muted-foreground')
    expect(within(row).getByText('LOT-77').parentElement).toBe(detailLine)
  })

  it('keeps the full product name in the DOM and leaves shortening to CSS', async () => {
    const longTitle = 'Pomidory krojone w puszce 2500 g, karton 6 sztuk, rocznik 2026, partia importowa'
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 1 }, { id: 'pastDue', count: 0 }],
      expiryLots: [
        lot({ id: 'long', lotNumber: 'LOT-LONG', expiresAt: '2026-09-24T00:00:00.000Z', productTitle: longTitle }),
      ],
    })

    renderWidget()

    const headline = await screen.findByText(longTitle)
    expect(headline).toHaveClass('truncate')
  })

  it('falls back to the SKU headline when the payload carries no product title', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 2 }, { id: 'pastDue', count: 0 }],
      expiryLots: [
        lot({ id: 'null-title', lotNumber: 'LOT-A', expiresAt: '2026-09-24T00:00:00.000Z', productTitle: null }),
        lot({ id: 'blank-title', lotNumber: 'LOT-B', expiresAt: '2026-09-25T00:00:00.000Z', productTitle: '   ' }),
      ],
    })

    renderWidget()

    const rows = await screen.findAllByRole('listitem')
    expect(within(rows[0]).getByText('SKU-null-title')).toHaveClass('text-sm')
    expect(within(rows[0]).getByText('LOT-A')).toBeInTheDocument()
    expect(within(rows[1]).getByText('SKU-blank-title')).toHaveClass('text-sm')
  })

  it('renders the SKU headline when the payload omits the productTitle field entirely', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 1 }, { id: 'pastDue', count: 0 }],
      expiryLots: [lot({ id: 'legacy', lotNumber: 'LOT-LEGACY', expiresAt: '2026-09-24T00:00:00.000Z' })],
    })

    renderWidget()

    const row = await screen.findByRole('listitem')
    expect(within(row).getByText('SKU-legacy')).toHaveClass('text-sm')
    expect(within(row).getByText('LOT-LEGACY')).toBeInTheDocument()
  })

  it('resolveLotPrimaryLabel treats a missing, null or blank title as no title at all', () => {
    const base = lot({ id: 'x', lotNumber: 'LOT-X', expiresAt: REFERENCE })
    expect(resolveLotPrimaryLabel(base)).toEqual({ primary: 'SKU-x', showSku: false })
    expect(resolveLotPrimaryLabel({ ...base, productTitle: null })).toEqual({ primary: 'SKU-x', showSku: false })
    expect(resolveLotPrimaryLabel({ ...base, productTitle: '  ' })).toEqual({ primary: 'SKU-x', showSku: false })
    expect(resolveLotPrimaryLabel({ ...base, productTitle: ' Feta 400 g ' })).toEqual({
      primary: 'Feta 400 g',
      showSku: true,
    })
  })
})

describe('expiring stock remaining-lot arithmetic', () => {
  it('derives the remainder from the tile totals, never from the row count alone', () => {
    expect(countRemainingLots(13, 5)).toBe(8)
    expect(countRemainingLots(5, 5)).toBe(0)
    expect(countRemainingLots(2, 5)).toBe(0)
    expect(countRemainingLots(0, 0)).toBe(0)
  })

  it('accounts for the lots the tiles count but the payload never sent', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 12 }, { id: 'pastDue', count: 3 }],
      expiryLots: buildLots(5),
    })

    renderWidget()

    const more = await screen.findByText('See 10 more lots in the full lot list')
    expect(more.closest('a')).toHaveAttribute('href', '/backend/wms/lots')
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
  })

  it('stays silent when every counted lot is already on screen', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 3 }, { id: 'pastDue', count: 2 }],
      expiryLots: buildLots(5),
    })

    renderWidget()

    expect(await screen.findAllByRole('listitem')).toHaveLength(5)
    expect(screen.queryByText(/more lots in the full lot list/)).not.toBeInTheDocument()
  })

  it('never advertises a negative remainder when the rows outrun the tiles', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 1 }, { id: 'pastDue', count: 0 }],
      expiryLots: buildLots(4),
    })

    renderWidget()

    expect(await screen.findAllByRole('listitem')).toHaveLength(4)
    expect(screen.queryByText(/more lots in the full lot list/)).not.toBeInTheDocument()
  })

  it('renders every row a payload can carry and counts only the truly missing ones', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 40 }, { id: 'pastDue', count: 2 }],
      expiryLots: buildLots(10),
    })

    renderWidget()

    expect(await screen.findAllByRole('listitem')).toHaveLength(10)
    expect(screen.getByText('See 32 more lots in the full lot list')).toBeInTheDocument()
  })
})

describe('expiring stock tile units', () => {
  it('states what each headline number counts, and reads it as one phrase', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 12 }, { id: 'pastDue', count: 3 }],
      expiryLots: buildLots(2),
    })

    renderWidget()

    const losingTile = (await screen.findByText('Losing date')).closest('a') as HTMLElement
    expect(within(losingTile).getByText('12')).toBeInTheDocument()
    expect(within(losingTile).getByText('lots')).toBeInTheDocument()
    expect(within(losingTile).getByText('12 lots')).toBeInTheDocument()

    const pastDueTile = screen.getByText('Past date').closest('a') as HTMLElement
    expect(within(pastDueTile).getByText('3 lots')).toBeInTheDocument()
  })

  it('hides the split number and unit from assistive technology in favour of the phrase', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 12 }, { id: 'pastDue', count: 0 }],
      expiryLots: buildLots(1),
    })

    renderWidget()

    const losingTile = (await screen.findByText('Losing date')).closest('a') as HTMLElement
    expect(within(losingTile).getByText('12')).toHaveAttribute('aria-hidden', 'true')
    expect(within(losingTile).getByText('12 lots')).toHaveClass('sr-only')
  })
})

/**
 * The same screen read through `i18n/pl.json`.
 *
 * Every string below is a catalogue VALUE, not a component fallback, so a Polish key that is
 * missing, renamed or left in English fails here. This is the block that would have caught the
 * whole widget rendering in English next to a fully translated file.
 */
describe('expiring stock rendered from the Polish catalogue', () => {
  it('translates both tiles, their unit phrase and the remaining-lot link', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 12 }, { id: 'pastDue', count: 3 }],
      expiryLots: buildLots(5),
    })

    renderWidget('pl', PL_DICT)

    const losingTile = (await screen.findByText('Traci termin')).closest('a') as HTMLElement
    expect(within(losingTile).getByText('12 partii')).toHaveClass('sr-only')
    const pastDueTile = screen.getByText('Po terminie').closest('a') as HTMLElement
    expect(within(pastDueTile).getByText('3 partii')).toBeInTheDocument()
    expect(screen.getByText('Zobacz pozostałe 10 partii na pełnej liście')).toBeInTheDocument()
  })

  it('translates the deadline wording for a lot before, on and after its date', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 3 }, { id: 'pastDue', count: 1 }],
      expiryLots: [
        lot({ id: 'over', lotNumber: 'LOT-OVER', expiresAt: '2026-09-16T00:00:00.000Z', category: 'pastDue' }),
        lot({ id: 'today', lotNumber: 'LOT-TODAY', expiresAt: '2026-09-19T22:00:00.000Z' }),
        lot({ id: 'tomorrow', lotNumber: 'LOT-TOMORROW', expiresAt: '2026-09-20T06:00:00.000Z' }),
        lot({ id: 'later', lotNumber: 'LOT-LATER', expiresAt: '2026-09-24T00:00:00.000Z' }),
      ],
    })

    renderWidget('pl', PL_DICT)

    const rows = await screen.findAllByRole('listitem')
    expect(within(rows[0]).getByText('3 dni po terminie')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Termin dzisiaj')).toBeInTheDocument()
    expect(within(rows[2]).getByText('Termin jutro')).toBeInTheDocument()
    expect(within(rows[3]).getByText('Za 5 dni')).toBeInTheDocument()
    expect(within(rows[0]).getByText('10 szt.')).toBeInTheDocument()
  })

  it('translates the good-news empty state', async () => {
    mockPayload({
      lastUpdatedAt: REFERENCE,
      kpis: [{ id: 'expiringSoon', count: 0 }, { id: 'pastDue', count: 0 }],
      expiryLots: [],
    })

    renderWidget('pl', PL_DICT)

    expect(await screen.findByText('Nic nie zbliża się do terminu ważności.')).toBeInTheDocument()
  })

  it('translates the failed-request message', async () => {
    apiCallMock.mockResolvedValue({
      ok: false,
      status: 403,
      result: null,
      response: RESPONSE_STUB,
      cacheStatus: null,
    })

    renderWidget('pl', PL_DICT)

    expect(await screen.findByText('Nie udało się wczytać listy terminów')).toBeInTheDocument()
  })
})

/**
 * The one hole the rendering assertions above cannot close.
 *
 * An English key DELETED from `en.json` still renders correctly, because the component's own
 * fallback carries the same wording — so no text assertion can see it, and the next locale
 * added inherits a key that is not there to translate. Only a direct look at the catalogue
 * files shows it. The key list is restated rather than derived from the component: a list read
 * out of the code it checks would agree with any set of keys, including an emptied one.
 */
describe('expiring stock catalogue coverage', () => {
  const RENDERED_KEYS = [
    'distributor_workspace.widgets.expiringStock.deadline.inDays',
    'distributor_workspace.widgets.expiringStock.deadline.overdue',
    'distributor_workspace.widgets.expiringStock.deadline.today',
    'distributor_workspace.widgets.expiringStock.deadline.tomorrow',
    'distributor_workspace.widgets.expiringStock.deadline.unknown',
    'distributor_workspace.widgets.expiringStock.empty',
    'distributor_workspace.widgets.expiringStock.error',
    'distributor_workspace.widgets.expiringStock.kpi.expiringSoon',
    'distributor_workspace.widgets.expiringStock.kpi.lotsUnit',
    'distributor_workspace.widgets.expiringStock.kpi.lotsValue',
    'distributor_workspace.widgets.expiringStock.kpi.pastDue',
    'distributor_workspace.widgets.expiringStock.more',
    'distributor_workspace.widgets.expiringStock.noLotDetail',
    'distributor_workspace.widgets.expiringStock.settings.none',
    'distributor_workspace.widgets.expiringStock.units',
  ] as const

  function missingFrom(dict: Dict): string[] {
    return RENDERED_KEYS.filter((key) => (dict[key] ?? '').trim().length === 0)
  }

  it.each([
    ['en', EN_DICT],
    ['pl', PL_DICT],
  ] as const)('%s.json carries a non-empty value for every key this widget renders', (_locale, dict) => {
    expect(missingFrom(dict)).toEqual([])
  })

  it('keeps the placeholders the widget substitutes into', () => {
    for (const dict of [EN_DICT, PL_DICT]) {
      expect(dict['distributor_workspace.widgets.expiringStock.deadline.inDays']).toContain('{days}')
      expect(dict['distributor_workspace.widgets.expiringStock.deadline.overdue']).toContain('{days}')
      expect(dict['distributor_workspace.widgets.expiringStock.kpi.lotsValue']).toContain('{count}')
      expect(dict['distributor_workspace.widgets.expiringStock.more']).toContain('{count}')
      expect(dict['distributor_workspace.widgets.expiringStock.units']).toContain('{count}')
    }
  })
})
