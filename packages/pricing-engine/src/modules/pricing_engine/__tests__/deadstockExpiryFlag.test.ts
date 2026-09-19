import { EXPIRING_SOON_DAYS } from '@open-mercato/core/modules/wms/lib/expiry'
import { resolveExpiryFlag } from '../lib/frontend/deadstockTypes'

// Deliberately mid-afternoon: a same-day comparison made on raw timestamps rather than whole UTC
// days gives a different answer depending on the hour the page was opened.
const NOW = new Date('2026-09-19T14:37:11.000Z')

function inDays(days: number, hour = '00:00:00'): string {
  const date = new Date(Date.UTC(2026, 8, 19 + days))
  return `${date.toISOString().slice(0, 10)}T${hour}.000Z`
}

describe('resolveExpiryFlag', () => {
  it('has nothing to say when the position carries no dated lot', () => {
    expect(resolveExpiryFlag(null, NOW)).toBeNull()
    expect(resolveExpiryFlag('not a date', NOW)).toBeNull()
  })

  it('flags stock inside the shared window', () => {
    expect(resolveExpiryFlag(inDays(6), NOW)).toEqual({ kind: 'expiringSoon', days: 6 })
  })

  // The boundary itself. An open interval here against the closed one in `wms/lib/expiry.ts` is
  // exactly what produced two different answers for one lot on one dashboard.
  it('includes the last day of the window, because the owning module does', () => {
    expect(resolveExpiryFlag(inDays(EXPIRING_SOON_DAYS), NOW)).toEqual({
      kind: 'expiringSoon',
      days: EXPIRING_SOON_DAYS,
    })
  })

  it('says nothing one day past the window', () => {
    expect(resolveExpiryFlag(inDays(EXPIRING_SOON_DAYS + 1), NOW)).toBeNull()
  })

  // "expires in -10 d" is not a sentence. Stock already over its date needs a different word.
  it('reports stock past its date as past due, with a positive count', () => {
    expect(resolveExpiryFlag(inDays(-10), NOW)).toEqual({ kind: 'pastDue', days: 10 })
  })

  it('treats today as expiring, not as past due', () => {
    expect(resolveExpiryFlag(inDays(0), NOW)).toEqual({ kind: 'expiringSoon', days: 0 })
  })

  // Whole UTC days on both sides: the hour the page is opened must not move the count.
  it('gives the same answer whatever time of day the lot expires', () => {
    const morning = resolveExpiryFlag(inDays(3, '00:00:01'), NOW)
    const midnight = resolveExpiryFlag(inDays(3, '23:59:59'), NOW)

    expect(morning).toEqual({ kind: 'expiringSoon', days: 3 })
    expect(midnight).toEqual(morning)
  })
})

describe('the reference instant', () => {
  // The caller passes the response's `asOf`, so this must be honoured rather than quietly ignored
  // in favour of the clock. A page open over a long shift would otherwise drift away from the rest
  // of the row, which was computed server-side at one instant.
  it('counts from the instant it is given, not from now', () => {
    const asOf = new Date('2026-09-19T14:37:11.000Z')
    const expiry = '2026-09-25T00:00:00.000Z'

    expect(resolveExpiryFlag(expiry, asOf)).toEqual({ kind: 'expiringSoon', days: 6 })
    // Same lot, a reference instant a week later: now it is past due, and the badge says so.
    expect(resolveExpiryFlag(expiry, new Date('2026-10-02T09:00:00.000Z'))).toEqual({
      kind: 'pastDue',
      days: 7,
    })
  })
})
