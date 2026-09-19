import {
  DEFAULT_DEAD_AFTER_DAYS,
  DEFAULT_DYING_AFTER_DAYS,
  defaultDeadstockPolicy,
  readDeadstockPolicy,
} from '../lib/deadstock/policy'
import { money } from '../lib/decimal'

describe('readDeadstockPolicy', () => {
  it('returns the defaults for an absent payload and does not claim they were supplied', () => {
    const policy = readDeadstockPolicy(null)

    expect(policy.deadAfterDays).toBe(DEFAULT_DEAD_AFTER_DAYS)
    expect(policy.supplied).toBe(false)
    expect(policy.rejected).toEqual([])
  })

  it('takes every figure the operator supplied', () => {
    const policy = readDeadstockPolicy({
      deadAfterDays: 150,
      dyingAfterDays: 60,
      dyingRatio: '0.4',
      slowCoverDays: 200,
      minObservationDays: 45,
      seasonalRatio: '0.6',
      dyingMarginPercent: '8',
      clearHorizonMonths: '3',
      neverSoldHorizonMonths: '18',
    })

    expect(policy.deadAfterDays).toBe(150)
    expect(policy.dyingAfterDays).toBe(60)
    expect(money(policy.dyingRatio)).toBe('0.4000')
    expect(money(policy.clearHorizonMonths)).toBe('3.0000')
    expect(policy.dyingMarginPercent).toBe('8')
    expect(policy.supplied).toBe(true)
    expect(policy.rejected).toEqual([])
  })

  it('names a ratio entered as a percentage instead of quietly computing from the default', () => {
    // 25 is not a fraction. Accepting it would make every product's trend collapse.
    const policy = readDeadstockPolicy({ dyingRatio: '25' })

    expect(policy.rejected).toContain('dyingRatio')
    expect(money(policy.dyingRatio)).toBe(money(defaultDeadstockPolicy().dyingRatio))
    expect(policy.supplied).toBe(false)
  })

  it('rejects a margin the floor equation cannot solve', () => {
    expect(readDeadstockPolicy({ dyingMarginPercent: '100' }).rejected).toContain('dyingMarginPercent')
  })

  it('rejects a horizon long enough to swallow any floor', () => {
    expect(readDeadstockPolicy({ clearHorizonMonths: '600' }).rejected).toContain('clearHorizonMonths')
  })

  it('restores both dormancy thresholds when they are configured out of order', () => {
    // Dying at 200 and dead at 100 would classify everything dormant as dead.
    const policy = readDeadstockPolicy({ dyingAfterDays: 200, deadAfterDays: 100 })

    expect(policy.dyingAfterDays).toBe(DEFAULT_DYING_AFTER_DAYS)
    expect(policy.deadAfterDays).toBe(DEFAULT_DEAD_AFTER_DAYS)
    expect(policy.rejected).toEqual(expect.arrayContaining(['dyingAfterDays', 'deadAfterDays']))
  })

  it('ignores keys it does not consume without rejecting anything', () => {
    const policy = readDeadstockPolicy({ deadAfterDays: 150, note: 'agreed with the owner' })

    expect(policy.deadAfterDays).toBe(150)
    expect(policy.rejected).toEqual([])
  })
})
