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
import { render, screen, waitFor, within } from '@testing-library/react'
import { z } from 'zod'
import { I18nProvider, type Dict } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import type { DashboardWidgetComponentProps, DashboardLayoutItem } from '@open-mercato/shared/modules/dashboard/widgets'
import stockGapsWidget from '../widgets/dashboard/stock-gaps/widget'
import StockGapsWidget, {
  readGapKpi,
  resolveGapBreakdown,
  type StockGapKpi,
  type StockGapsSettings,
} from '../widgets/dashboard/stock-gaps/widget.client'

const apiCallMock = apiCall as jest.MockedFunction<typeof apiCall>

// jsdom exposes no global Response, and this widget never reads the raw one.
const RESPONSE_STUB = { ok: true, status: 200 } as unknown as Response

/**
 * The shipped catalogues, read from disk instead of stubbed with `{}`.
 *
 * `t(key, fallback)` resolves to `dict[key] ?? fallback`, so a test that rendered with an
 * empty dictionary asserted the English literal baked into the component and stayed green
 * with the whole translation folder deleted. Rendering against the real files is what makes
 * a missing or renamed key visible here.
 */
function readShippedDict(fileName: string): Dict {
  const filePath = path.join(__dirname, '../i18n', fileName)
  return z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(filePath, 'utf8')))
}

const EN_DICT = readShippedDict('en.json')
const PL_DICT = readShippedDict('pl.json')

function key(suffix: string): string {
  return `distributor_workspace.widgets.stockGaps.${suffix}`
}

/** Every key this widget can render. */
const RENDERED_KEYS = [
  key('error'),
  key('settings.none'),
  key('empty'),
  key('unit'),
  key('total.label'),
  key('total.hint'),
  key('meter'),
  key('belowSafety.subsetLabel'),
  key('belowSafety.hint'),
  key('onlyBelowReorder.label'),
  key('onlyBelowReorder.hint'),
  key('allCritical'),
  key('noneCritical'),
  key('independentCounts'),
  key('belowSafety.standaloneLabel'),
]

/**
 * Keys this widget already renders while the shipped catalogues still owe a translation.
 * The coverage test below compares the untranslated set against this list in BOTH
 * directions, so it turns red the moment a key here lands in the catalogues — which is the
 * signal to delete it from this list rather than let the exemption rot.
 */
const PENDING_I18N_KEYS: string[] = []

/**
 * The English wording restated on purpose. Reading the expectation out of the same file it
 * verifies would agree with any value, including a regressed one; pinning it here makes an
 * edited or deleted entry fail instead.
 */
const PINNED_EN: Dict = {
  [key('error')]: 'Could not load stock levels',
  [key('settings.none')]:
    'This widget has no options. Reorder points and safety stock are set per product variant.',
  [key('empty')]: 'Every stock position is above its reorder point.',
  [key('unit')]: 'low stock positions (variant × warehouse)',
  [key('total.label')]: 'At or below reorder point',
  [key('total.hint')]: 'Everything here needs ordering — the critical part is inside it',
  [key('meter')]: '{critical} of {total} low stock positions are below safety stock',
  [key('belowSafety.subsetLabel')]: 'of which below safety stock',
  [key('belowSafety.hint')]: 'The next order may go unfilled',
  [key('onlyBelowReorder.label')]: 'and only below reorder point',
  [key('onlyBelowReorder.hint')]: 'Still sellable — order before the buffer is gone',
  [key('allCritical')]: 'Every one of them is below safety stock',
}

function isTranslated(dict: Dict, translationKey: string): boolean {
  const value = dict[translationKey]
  return typeof value === 'string' && value.trim().length > 0
}

/** The English text the widget shows for a key, falling back only for keys still pending. */
function englishText(translationKey: string, pendingFallback: string): string {
  if (isTranslated(EN_DICT, translationKey)) return EN_DICT[translationKey] as string
  if (!PENDING_I18N_KEYS.includes(translationKey)) {
    throw new Error(`[internal] ${translationKey} is missing from en.json and is not listed as pending`)
  }
  return pendingFallback
}

/**
 * Maps every rendered key to a marker that exists in no component fallback, so an assertion
 * on a marker proves the widget reads that key instead of its hardcoded English default.
 */
const SENTINEL_DICT: Dict = Object.fromEntries(
  RENDERED_KEYS.map((translationKey) => [translationKey, `[[${translationKey}]]`]),
)

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

function widgetProps(): DashboardWidgetComponentProps<StockGapsSettings> {
  return {
    mode: 'view',
    layout: LAYOUT,
    settings: {} as StockGapsSettings,
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

function renderWidget(dict: Dict = EN_DICT, locale: 'en' | 'pl' = 'en'): ReturnType<typeof render> {
  return render(
    <I18nProvider locale={locale} dict={dict}>
      <StockGapsWidget {...widgetProps()} />
    </I18nProvider>,
  )
}

function kpi(id: string, count: number, overrides: Partial<StockGapKpi> = {}): StockGapKpi {
  return { id, count, deltaSinceYesterday: null, sparkline: [], ...overrides }
}

/**
 * Carries the trend fields the operational dashboard actually sends, precisely so the
 * assertions below can prove the widget draws none of them.
 */
const LIVE_PAYLOAD = {
  kpis: [
    kpi('lowStock', 42, { deltaSinceYesterday: 3, sparkline: [38, 39, 40, 40, 41, 41, 42] }),
    kpi('reorderCritical', 16, { deltaSinceYesterday: -2, sparkline: [18, 18, 17, 17, 16, 16, 16] }),
  ],
}

beforeEach(() => {
  apiCallMock.mockReset()
})

describe('resolveGapBreakdown', () => {
  it('derives the reorder-only remainder as total minus the critical subset', () => {
    expect(resolveGapBreakdown(42, 16)).toEqual({
      total: 42,
      critical: 16,
      reportedCritical: 16,
      onlyBelowReorder: 26,
      allCritical: false,
      noneCritical: false,
      notNested: false,
      criticalShare: (16 / 42) * 100,
    })
  })

  it('flags the equality case instead of reporting an empty remainder', () => {
    const breakdown = resolveGapBreakdown(16, 16)
    expect(breakdown.onlyBelowReorder).toBe(0)
    expect(breakdown.allCritical).toBe(true)
    expect(breakdown.noneCritical).toBe(false)
    expect(breakdown.criticalShare).toBe(100)
  })

  it('flags an empty critical subset so the remainder is not restated as a second total', () => {
    const breakdown = resolveGapBreakdown(42, 0)
    expect(breakdown.noneCritical).toBe(true)
    expect(breakdown.allCritical).toBe(false)
    expect(breakdown.onlyBelowReorder).toBe(42)
    expect(breakdown.criticalShare).toBe(0)
  })

  it('never reports a negative remainder when the payload breaks containment', () => {
    const breakdown = resolveGapBreakdown(10, 14)
    expect(breakdown.critical).toBe(10)
    expect(breakdown.reportedCritical).toBe(14)
    expect(breakdown.onlyBelowReorder).toBe(0)
    expect(breakdown.notNested).toBe(true)
  })

  it('treats critical positions with an empty total as notNested, not as calm', () => {
    const breakdown = resolveGapBreakdown(0, 14)
    expect(breakdown.notNested).toBe(true)
    expect(breakdown.reportedCritical).toBe(14)
    expect(breakdown.noneCritical).toBe(false)
  })

  it('reports no share when there is nothing to split', () => {
    const breakdown = resolveGapBreakdown(0, 0)
    expect(breakdown.criticalShare).toBe(0)
    expect(breakdown.notNested).toBe(false)
    expect(breakdown.noneCritical).toBe(false)
  })
})

describe('readGapKpi', () => {
  it('falls back to a zeroed KPI when the payload omits one', () => {
    expect(readGapKpi([kpi('lowStock', 42)], 'reorderCritical')).toEqual({
      id: 'reorderCritical',
      count: 0,
      deltaSinceYesterday: null,
      sparkline: [],
    })
  })
})

describe('shipped translations', () => {
  it('ships every rendered key in English and Polish, except the ones still pending', () => {
    const untranslated = RENDERED_KEYS.filter(
      (translationKey) => !isTranslated(EN_DICT, translationKey) || !isTranslated(PL_DICT, translationKey),
    )
    expect(untranslated.slice().sort()).toEqual(PENDING_I18N_KEYS.slice().sort())
  })

  it('keeps the English wording this widget was designed around', () => {
    for (const [translationKey, expected] of Object.entries(PINNED_EN)) {
      expect(EN_DICT[translationKey]).toBe(expected)
    }
  })

  it('no longer ships a key for a trend or a daily delta it cannot compute', () => {
    expect(RENDERED_KEYS).not.toContain(key('delta'))
    expect(RENDERED_KEYS).not.toContain(key('belowReorder.trend'))
    expect(RENDERED_KEYS).not.toContain(key('belowSafety.trend'))
  })
})

describe('stock gaps widget containment', () => {
  it('shows the critical count as a subset of one primary total, not as a second equal tile', async () => {
    mockPayload(LIVE_PAYLOAD)
    renderWidget()

    const meter = await screen.findByRole('meter')
    expect(meter).toHaveAttribute('aria-valuemin', '0')
    expect(meter).toHaveAttribute('aria-valuemax', '42')
    expect(meter).toHaveAttribute('aria-valuenow', '16')
    expect(meter).toHaveAttribute(
      'aria-label',
      englishText(key('meter'), '{critical} of {total} low stock positions are below safety stock')
        .replace('{critical}', '16')
        .replace('{total}', '42'),
    )

    const subsetRow = screen.getByText(EN_DICT[key('belowSafety.subsetLabel')] as string).closest('a')
    expect(subsetRow).not.toBeNull()
    expect(within(subsetRow as HTMLElement).getByText('16')).toBeInTheDocument()
  })

  it('states the derived reorder-only remainder without promising it behind a link', async () => {
    mockPayload(LIVE_PAYLOAD)
    renderWidget()

    const remainderLabel = await screen.findByText(EN_DICT[key('onlyBelowReorder.label')] as string)
    expect(remainderLabel.closest('a')).toBeNull()

    const remainderRow = remainderLabel.parentElement as HTMLElement
    expect(within(remainderRow).getByText('26')).toBeInTheDocument()
  })

  it('names the counting unit as stock positions, not products', async () => {
    mockPayload(LIVE_PAYLOAD)
    renderWidget()

    expect(await screen.findByText(EN_DICT[key('unit')] as string)).toBeInTheDocument()
    expect(screen.queryByText(/products?/i)).not.toBeInTheDocument()
  })

  it('keeps both inventory filter links and labels the primary one as the whole set', async () => {
    mockPayload(LIVE_PAYLOAD)
    renderWidget()

    const totalLink = (await screen.findByText(EN_DICT[key('total.label')] as string)).closest('a')
    expect(totalLink).toHaveAttribute('href', '/backend/wms/inventory?lowStock=belowReorder')
    expect(within(totalLink as HTMLElement).getByText('42')).toBeInTheDocument()

    const subsetLink = screen.getByText(EN_DICT[key('belowSafety.subsetLabel')] as string).closest('a')
    expect(subsetLink).toHaveAttribute('href', '/backend/wms/inventory?lowStock=belowSafety')
  })

  it('renders the shipped keys rather than the English fallbacks compiled into the component', async () => {
    mockPayload(LIVE_PAYLOAD)
    renderWidget(SENTINEL_DICT)

    for (const suffix of [
      'total.label',
      'unit',
      'total.hint',
      'belowSafety.subsetLabel',
      'belowSafety.hint',
      'onlyBelowReorder.label',
      'onlyBelowReorder.hint',
    ]) {
      expect(await screen.findByText(SENTINEL_DICT[key(suffix)] as string)).toBeInTheDocument()
    }
  })

  it('reads a fully critical set as a full subset instead of an empty remainder', async () => {
    mockPayload({ kpis: [kpi('lowStock', 16), kpi('reorderCritical', 16)] })
    renderWidget()

    const meter = await screen.findByRole('meter')
    expect(meter).toHaveAttribute('aria-valuenow', '16')
    expect(meter).toHaveAttribute('aria-valuemax', '16')

    expect(screen.getByText(EN_DICT[key('allCritical')] as string)).toBeInTheDocument()
    expect(screen.queryByText(EN_DICT[key('onlyBelowReorder.label')] as string)).not.toBeInTheDocument()
  })
})

describe('stock gaps widget with nothing critical', () => {
  it('prints the primary number once instead of repeating it as the remainder', async () => {
    mockPayload({ kpis: [kpi('lowStock', 42), kpi('reorderCritical', 0)] })
    const { container } = renderWidget()

    await screen.findByRole('meter')
    expect(screen.getAllByText('42')).toHaveLength(1)
    expect(container.textContent?.match(/42/g)).toHaveLength(1)
    expect(screen.queryByText(EN_DICT[key('onlyBelowReorder.label')] as string)).not.toBeInTheDocument()
    expect(screen.queryByText(EN_DICT[key('total.hint')] as string)).not.toBeInTheDocument()
  })

  it('says in words how much of the total is critical', async () => {
    mockPayload({ kpis: [kpi('lowStock', 42), kpi('reorderCritical', 0)] })
    renderWidget()

    expect(
      await screen.findByText(
        englishText(key('noneCritical'), 'All of them are only below their reorder point'),
      ),
    ).toBeInTheDocument()
  })

  it('keeps an empty critical subset in the neutral tone instead of alarming on a zero', async () => {
    mockPayload({ kpis: [kpi('lowStock', 42), kpi('reorderCritical', 0)] })
    renderWidget()

    const zero = await screen.findByText('0')
    expect(zero).toHaveClass('text-foreground')
    expect(zero).not.toHaveClass('text-status-error-text')
    expect(screen.queryByText(EN_DICT[key('belowSafety.hint')] as string)).not.toBeInTheDocument()
  })
})

describe('stock gaps widget trend claims', () => {
  it('draws no trend chart, because both payload series are the same unrelated movement count', async () => {
    mockPayload(LIVE_PAYLOAD)
    renderWidget()

    await screen.findByRole('meter')
    expect(screen.queryByLabelText(/last 7 days/i)).not.toBeInTheDocument()
    expect(document.querySelector('svg')).toBeNull()
  })

  it('states no day-over-day change, because the payload never carries one for these KPIs', async () => {
    mockPayload(LIVE_PAYLOAD)
    renderWidget()

    await screen.findByRole('meter')
    expect(screen.queryByText(/since yesterday/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/\+3/)).not.toBeInTheDocument()
    expect(screen.queryByText(/-2/)).not.toBeInTheDocument()
  })
})

describe('stock gaps widget notNested payload', () => {
  it('refuses to report an empty total next to critical positions as good news', async () => {
    mockPayload({ kpis: [kpi('lowStock', 0), kpi('reorderCritical', 14)] })
    renderWidget()

    expect(await screen.findByText(EN_DICT[key('independentCounts')] as string)).toBeInTheDocument()
    expect(screen.getByText('14')).toBeInTheDocument()

    expect(screen.queryByText(EN_DICT[key('empty')] as string)).not.toBeInTheDocument()
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  })

  it('keeps both lists reachable and never nests one count inside the other', async () => {
    mockPayload({ kpis: [kpi('lowStock', 3), kpi('reorderCritical', 14)] })
    renderWidget()

    expect(await screen.findByText(EN_DICT[key('independentCounts')] as string)).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('14')).toBeInTheDocument()

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'))
    expect(hrefs).toEqual([
      '/backend/wms/inventory?lowStock=belowReorder',
      '/backend/wms/inventory?lowStock=belowSafety',
    ])

    // The derived remainder only means something while one set sits inside the other.
    expect(screen.queryByText(EN_DICT[key('onlyBelowReorder.label')] as string)).not.toBeInTheDocument()
    expect(screen.queryByText(EN_DICT[key('belowSafety.subsetLabel')] as string)).not.toBeInTheDocument()
  })

  it('states the reason in words instead of accusing the data of being broken', () => {
    const wording = EN_DICT[key('independentCounts')] as string
    expect(wording).toMatch(/two separate checks/i)
    expect(wording).not.toMatch(/contradict/i)
  })
})

describe('stock gaps widget states', () => {
  it('keeps the empty state when nothing is low', async () => {
    mockPayload({ kpis: [kpi('lowStock', 0), kpi('reorderCritical', 0)] })
    renderWidget()

    expect(await screen.findByText(EN_DICT[key('empty')] as string)).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  })

  it('shows the shared dashboard skeleton while the first payload is in flight', () => {
    apiCallMock.mockReturnValue(new Promise(() => {}) as ReturnType<typeof apiCall>)
    const { container } = renderWidget()

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it('reports a malformed payload through the shared dashboard error box', async () => {
    mockPayload({ kpis: 'nope' })
    const { container } = renderWidget()

    await waitFor(() => {
      expect(screen.getByText(EN_DICT[key('error')] as string)).toBeInTheDocument()
    })
    expect(container.querySelector('.bg-status-error-bg')).not.toBeNull()
  })
})

describe('stock gaps widget in Polish', () => {
  it('shows the Polish catalogue instead of leaking the English fallback', async () => {
    mockPayload(LIVE_PAYLOAD)
    renderWidget(PL_DICT, 'pl')

    await screen.findByRole('meter')
    for (const suffix of [
      'total.label',
      'unit',
      'total.hint',
      'belowSafety.subsetLabel',
      'belowSafety.hint',
      'onlyBelowReorder.label',
      'onlyBelowReorder.hint',
    ]) {
      expect(screen.getByText(PL_DICT[key(suffix)] as string)).toBeInTheDocument()
      expect(screen.queryByText(EN_DICT[key(suffix)] as string)).not.toBeInTheDocument()
    }
  })
})

describe('stock gaps widget metadata', () => {
  it('describes one nested set of stock positions, not two disjoint product lists with a trend', () => {
    const { description } = stockGapsWidget.metadata
    expect(description).toContain('stock positions')
    expect(description).not.toMatch(/products/i)
    expect(description).not.toMatch(/trend/i)
    expect(description).toMatch(/how many of those/i)
  })
})
