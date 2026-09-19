import { z } from 'zod'
import {
  addUtcDays,
  buildExpiryWindowDateFilter,
  EXPIRING_SOON_DAYS,
  startOfUtcDay,
} from '@open-mercato/core/modules/wms/lib/expiry'
import {
  buildNextActions,
  daysUntil,
  EXPIRY_WATCH_DAYS,
  NEXT_ACTION_KINDS,
  resolveExpiryWatchWindow,
  type NextActionKind,
  type NextActionSignal,
} from '../lib/nextActions'

const NOW = new Date('2026-09-19T09:00:00.000Z')

function signal(overrides: Partial<NextActionSignal> & { kind: NextActionKind }): NextActionSignal {
  return {
    count: 1,
    deadlineAt: null,
    amount: null,
    currencyCode: null,
    ...overrides,
  }
}

function kindsOf(signals: NextActionSignal[]): NextActionKind[] {
  return buildNextActions(signals, NOW).map((action) => action.kind)
}

const wmsExpiringSoonBoundsSchema = z.object({
  expires_at: z.object({
    $gte: z.date(),
    $lte: z.date(),
  }),
})

function wmsExpiringSoonBounds(now: Date): { from: Date; toInclusive: Date } {
  const parsed = wmsExpiringSoonBoundsSchema.parse(buildExpiryWindowDateFilter('expiringSoon', now))
  return { from: parsed.expires_at.$gte, toInclusive: parsed.expires_at.$lte }
}

function isInsideClosedWindow(expiresAt: Date, bounds: { from: Date; toInclusive: Date }): boolean {
  return expiresAt.getTime() >= bounds.from.getTime() && expiresAt.getTime() <= bounds.toInclusive.getTime()
}

describe('resolveExpiryWatchWindow', () => {
  it('uses the day count the WMS module owns', () => {
    expect(EXPIRY_WATCH_DAYS).toBe(EXPIRING_SOON_DAYS)
  })

  it('returns exactly the bounds the WMS expiry filter carries', () => {
    const window = resolveExpiryWatchWindow(NOW)
    const wms = wmsExpiringSoonBounds(NOW)

    expect(window.from.toISOString()).toBe(wms.from.toISOString())
    expect(window.toInclusive.toISOString()).toBe(wms.toInclusive.toISOString())
  })

  it('starts at the start of the UTC day whatever time of day it is asked', () => {
    const window = resolveExpiryWatchWindow(new Date('2026-09-19T23:59:59.999Z'))

    expect(window.from.toISOString()).toBe('2026-09-19T00:00:00.000Z')
    expect(window.toInclusive.toISOString()).toBe('2026-10-19T00:00:00.000Z')
  })

  it('counts a lot expiring exactly at midnight of the last day, like the WMS card and lot list do', () => {
    const boundaryExpiry = addUtcDays(startOfUtcDay(NOW), EXPIRING_SOON_DAYS)

    expect(isInsideClosedWindow(boundaryExpiry, resolveExpiryWatchWindow(NOW))).toBe(true)
    expect(isInsideClosedWindow(boundaryExpiry, wmsExpiringSoonBounds(NOW))).toBe(true)
  })

  it('leaves out the first moment past the window, again like WMS', () => {
    const justOutside = new Date(addUtcDays(startOfUtcDay(NOW), EXPIRING_SOON_DAYS).getTime() + 1)

    expect(isInsideClosedWindow(justOutside, resolveExpiryWatchWindow(NOW))).toBe(false)
    expect(isInsideClosedWindow(justOutside, wmsExpiringSoonBounds(NOW))).toBe(false)
  })
})

describe('daysUntil', () => {
  it('floors partial days so a deadline later today reads as zero days left', () => {
    expect(daysUntil('2026-09-19T23:59:00.000Z', NOW)).toBe(0)
  })

  it('returns negative days for a deadline that already passed', () => {
    expect(daysUntil('2026-09-18T09:00:00.000Z', NOW)).toBe(-1)
  })

  it('returns null for a missing or unparsable deadline', () => {
    expect(daysUntil(null, NOW)).toBeNull()
    expect(daysUntil('not-a-date', NOW)).toBeNull()
  })
})

describe('buildNextActions ordering', () => {
  it('puts stock expiring in three days above a quote that has been silent for a week', () => {
    const ordered = kindsOf([
      signal({ kind: 'quotesAwaitingReply', count: 4, deadlineAt: '2026-09-26T12:00:00.000Z' }),
      signal({ kind: 'expiringStock', count: 2, deadlineAt: '2026-09-22T12:00:00.000Z' }),
    ])

    expect(ordered).toEqual(['expiringStock', 'quotesAwaitingReply'])
  })

  it('lets an overdue lighter action overtake a heavier one whose deadline is still far off', () => {
    const ordered = kindsOf([
      signal({ kind: 'expiringStock', count: 9, deadlineAt: '2026-10-09T12:00:00.000Z' }),
      signal({ kind: 'quotesAwaitingReply', count: 1, deadlineAt: '2026-09-18T09:00:00.000Z' }),
    ])

    expect(ordered).toEqual(['quotesAwaitingReply', 'expiringStock'])
  })

  it('ranks a deadline-free action below every action with a running clock', () => {
    const ordered = kindsOf([
      signal({ kind: 'criticalStock', count: 16 }),
      signal({ kind: 'ordersToFulfil', count: 4, deadlineAt: '2026-09-26T12:00:00.000Z' }),
      signal({ kind: 'expiringStock', count: 2, deadlineAt: '2026-09-22T12:00:00.000Z' }),
    ])

    expect(ordered).toEqual(['expiringStock', 'ordersToFulfil', 'criticalStock'])
  })

  it('orders every kind by irreversibility when they all share one deadline', () => {
    const deadlineAt = '2026-09-26T12:00:00.000Z'
    const ordered = kindsOf([
      signal({ kind: 'criticalStock', count: 5, deadlineAt }),
      signal({ kind: 'quotesAwaitingReply', count: 5, deadlineAt }),
      signal({ kind: 'expiringStock', count: 5, deadlineAt }),
      signal({ kind: 'quoteRequestsToAnswer', count: 5, deadlineAt }),
      signal({ kind: 'ordersToFulfil', count: 5, deadlineAt }),
    ])

    expect(ordered).toEqual([
      'expiringStock',
      'quoteRequestsToAnswer',
      'quotesAwaitingReply',
      'ordersToFulfil',
      'criticalStock',
    ])
  })

  it('puts a quote request the customer is still waiting on above a quote we already sent', () => {
    const ordered = kindsOf([
      signal({ kind: 'quotesAwaitingReply', count: 3, deadlineAt: '2026-09-25T12:00:00.000Z' }),
      signal({ kind: 'quoteRequestsToAnswer', count: 1, deadlineAt: '2026-09-26T12:00:00.000Z' }),
    ])

    expect(ordered).toEqual(['quoteRequestsToAnswer', 'quotesAwaitingReply'])
  })

  it('lets a quote expiring in two days overtake a quote request due in a week', () => {
    const ordered = kindsOf([
      signal({ kind: 'quoteRequestsToAnswer', count: 1, deadlineAt: '2026-09-26T12:00:00.000Z' }),
      signal({ kind: 'quotesAwaitingReply', count: 3, deadlineAt: '2026-09-21T12:00:00.000Z' }),
    ])

    expect(ordered).toEqual(['quotesAwaitingReply', 'quoteRequestsToAnswer'])
  })

  it('lets an unanswered quote request overtake stock whose expiry is still two weeks out', () => {
    const ordered = kindsOf([
      signal({ kind: 'expiringStock', count: 9, deadlineAt: '2026-10-09T12:00:00.000Z' }),
      signal({ kind: 'quoteRequestsToAnswer', count: 1, deadlineAt: '2026-09-18T18:00:00.000Z' }),
    ])

    expect(ordered).toEqual(['quoteRequestsToAnswer', 'expiringStock'])
  })

  it('keeps expiring goods above an overdue quote request, because the expiry date cannot be undone', () => {
    const ordered = kindsOf([
      signal({ kind: 'quoteRequestsToAnswer', count: 1, deadlineAt: '2026-09-18T18:00:00.000Z' }),
      signal({ kind: 'expiringStock', count: 2, deadlineAt: '2026-09-22T12:00:00.000Z' }),
    ])

    expect(ordered).toEqual(['expiringStock', 'quoteRequestsToAnswer'])
  })

  it('leaves a deadline-free quote request ahead of the heavier-clocked work it outweighs', () => {
    const ordered = kindsOf([
      signal({ kind: 'criticalStock', count: 16 }),
      signal({ kind: 'quoteRequestsToAnswer', count: 1 }),
      signal({ kind: 'ordersToFulfil', count: 4 }),
    ])

    expect(ordered).toEqual(['quoteRequestsToAnswer', 'ordersToFulfil', 'criticalStock'])
  })

  it('ignores the order the signals arrive in', () => {
    const collected = [
      signal({ kind: 'criticalStock', count: 16 }),
      signal({ kind: 'expiringStock', count: 2, deadlineAt: '2026-09-22T12:00:00.000Z' }),
      signal({ kind: 'ordersToFulfil', count: 4, deadlineAt: '2026-09-26T12:00:00.000Z' }),
    ]

    expect(kindsOf(collected)).toEqual(kindsOf([...collected].reverse()))
  })
})

describe('buildNextActions tie-breaks', () => {
  const tiedQuotes = signal({ kind: 'quotesAwaitingReply', deadlineAt: '2026-10-02T12:00:00.000Z' })
  const tiedOrders = signal({ kind: 'ordersToFulfil', deadlineAt: '2026-09-26T12:00:00.000Z' })

  it('breaks an exact urgency tie by the larger amount', () => {
    const ordered = kindsOf([
      { ...tiedQuotes, amount: 100 },
      { ...tiedOrders, amount: 900 },
    ])

    expect(ordered).toEqual(['ordersToFulfil', 'quotesAwaitingReply'])
  })

  it('breaks a tie by count when the amounts match', () => {
    const ordered = kindsOf([
      { ...tiedOrders, amount: 500, count: 1 },
      { ...tiedQuotes, amount: 500, count: 7 },
    ])

    expect(ordered).toEqual(['quotesAwaitingReply', 'ordersToFulfil'])
  })

  it('stays deterministic when urgency, amount and count all tie', () => {
    const first = kindsOf([{ ...tiedQuotes, amount: 500, count: 3 }, { ...tiedOrders, amount: 500, count: 3 }])
    const second = kindsOf([{ ...tiedOrders, amount: 500, count: 3 }, { ...tiedQuotes, amount: 500, count: 3 }])

    expect(first).toEqual(['ordersToFulfil', 'quotesAwaitingReply'])
    expect(second).toEqual(first)
  })
})

describe('buildNextActions filtering', () => {
  it('returns nothing when there are no signals at all', () => {
    expect(buildNextActions([], NOW)).toEqual([])
  })

  it('drops signals that have nothing to act on', () => {
    const ordered = kindsOf([
      signal({ kind: 'criticalStock', count: 0 }),
      signal({ kind: 'ordersToFulfil', count: -3 }),
      signal({ kind: 'quotesAwaitingReply', count: Number.NaN }),
      signal({ kind: 'expiringStock', count: 2, deadlineAt: '2026-09-22T12:00:00.000Z' }),
    ])

    expect(ordered).toEqual(['expiringStock'])
  })

  it('returns an empty list when every candidate is empty', () => {
    expect(
      buildNextActions(
        [signal({ kind: 'criticalStock', count: 0 }), signal({ kind: 'ordersToFulfil', count: 0 })],
        NOW,
      ),
    ).toEqual([])
  })
})

describe('buildNextActions payload', () => {
  it('escalates the tone to error once the deadline is two days out or closer', () => {
    const [action] = buildNextActions(
      [signal({ kind: 'ordersToFulfil', count: 4, deadlineAt: '2026-09-21T08:00:00.000Z' })],
      NOW,
    )

    expect(action.tone).toBe('error')
    expect(action.daysUntilDeadline).toBe(1)
  })

  it('keeps a deadline-free action on its own baseline tone', () => {
    const [action] = buildNextActions([signal({ kind: 'criticalStock', count: 16 })], NOW)

    expect(action.tone).toBe('warning')
    expect(action.deadlineAt).toBeNull()
    expect(action.daysUntilDeadline).toBeNull()
  })

  it('carries a deep link and a tone for every kind it knows about', () => {
    const actions = buildNextActions(
      NEXT_ACTION_KINDS.map((kind) => signal({ kind, count: 2, deadlineAt: '2026-09-26T12:00:00.000Z' })),
      NOW,
    )

    expect(actions).toHaveLength(NEXT_ACTION_KINDS.length)
    for (const action of actions) {
      expect(action.href.startsWith('/backend/')).toBe(true)
      expect(['error', 'warning', 'info']).toContain(action.tone)
    }
  })

  it('treats an unanswered quote request as a warning until its answer window nearly closes', () => {
    const [relaxed] = buildNextActions(
      [signal({ kind: 'quoteRequestsToAnswer', count: 1, deadlineAt: '2026-09-26T12:00:00.000Z' })],
      NOW,
    )
    const [pressing] = buildNextActions(
      [signal({ kind: 'quoteRequestsToAnswer', count: 1, deadlineAt: '2026-09-20T12:00:00.000Z' })],
      NOW,
    )

    expect(relaxed.tone).toBe('warning')
    expect(pressing.tone).toBe('error')
  })

  it('drops a deadline it could not parse instead of reporting a broken date', () => {
    const [action] = buildNextActions(
      [signal({ kind: 'expiringStock', count: 2, deadlineAt: 'not-a-date' })],
      NOW,
    )

    expect(action.deadlineAt).toBeNull()
    expect(action.daysUntilDeadline).toBeNull()
  })
})
