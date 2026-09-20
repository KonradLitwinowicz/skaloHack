import type { UpcomingForecastResult } from '../lib/orderForecastLoader'
import {
  invalidateForecastCacheForTenant,
  readUpcomingForecastCache,
  resolveForecastCache,
  scopedForecastCacheTag,
  UPCOMING_FORECAST_CACHE_TAG,
  UPCOMING_FORECAST_CACHE_TTL_MS,
  upcomingForecastCacheKey,
  writeUpcomingForecastCache,
  type CachedUpcomingForecast,
} from '../lib/orderForecastCache'

const SCOPE = {
  tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}

const EMPTY_RESULT: UpcomingForecastResult = {
  rows: [],
  customersAnalysed: 0,
  customersWithPredictions: 0,
  horizonDays: 7,
}

function makeCache() {
  return {
    get: jest.fn(async () => null as unknown),
    set: jest.fn(async () => {}),
    deleteByTags: jest.fn(async () => 1),
  }
}

describe('upcomingForecastCacheKey', () => {
  it('separates horizons, confidence floors and scopes', () => {
    const now = new Date('2026-09-19T10:00:00.000Z')
    const base = upcomingForecastCacheKey(SCOPE, 7, undefined, now)

    expect(upcomingForecastCacheKey(SCOPE, 14, undefined, now)).not.toBe(base)
    expect(upcomingForecastCacheKey(SCOPE, 7, 0.6, now)).not.toBe(base)
    expect(upcomingForecastCacheKey({ ...SCOPE, organizationId: 'other' }, 7, undefined, now)).not.toBe(base)
    expect(upcomingForecastCacheKey({ ...SCOPE, tenantId: 'other' }, 7, undefined, now)).not.toBe(base)
  })

  // The rows carry `daysUntilExpected` and `overdueDays`, which are counted from the day the
  // forecast ran. An entry that survived midnight would call tomorrow's delivery "today".
  it('retires at the UTC day boundary', () => {
    const lateNight = new Date('2026-09-19T23:59:00.000Z')
    const justAfter = new Date('2026-09-20T00:01:00.000Z')

    expect(upcomingForecastCacheKey(SCOPE, 7, undefined, lateNight)).not.toBe(
      upcomingForecastCacheKey(SCOPE, 7, undefined, justAfter),
    )
  })

  it('keeps one key across a day', () => {
    expect(upcomingForecastCacheKey(SCOPE, 7, undefined, new Date('2026-09-19T00:00:00.000Z'))).toBe(
      upcomingForecastCacheKey(SCOPE, 7, undefined, new Date('2026-09-19T18:30:00.000Z')),
    )
  })
})

describe('forecast cache reads and writes', () => {
  it('writes with the TTL and both the global and the tenant tag', async () => {
    const cache = makeCache()
    const entry: CachedUpcomingForecast = { generatedAt: '2026-09-19T10:00:00.000Z', result: EMPTY_RESULT }

    await writeUpcomingForecastCache(cache, 'key', SCOPE, entry)

    expect(cache.set).toHaveBeenCalledWith('key', entry, {
      ttl: UPCOMING_FORECAST_CACHE_TTL_MS,
      tags: [UPCOMING_FORECAST_CACHE_TAG, scopedForecastCacheTag(SCOPE.tenantId)],
    })
  })

  it('returns a stored entry', async () => {
    const entry: CachedUpcomingForecast = { generatedAt: '2026-09-19T10:00:00.000Z', result: EMPTY_RESULT }
    const cache = makeCache()
    cache.get.mockResolvedValue(entry)

    expect(await readUpcomingForecastCache(cache, 'key')).toBe(entry)
  })

  // A shape change or a half-written value must send the caller to the database, never into a
  // response built from a partial object.
  it('ignores an entry that is not a forecast', async () => {
    const cache = makeCache()
    cache.get.mockResolvedValue({ rows: [] })

    expect(await readUpcomingForecastCache(cache, 'key')).toBeNull()
  })

  it('survives a cache backend that throws', async () => {
    const cache = makeCache()
    cache.get.mockRejectedValue(new Error('redis down'))
    cache.set.mockRejectedValue(new Error('redis down'))

    expect(await readUpcomingForecastCache(cache, 'key')).toBeNull()
    await expect(
      writeUpcomingForecastCache(cache, 'key', SCOPE, { generatedAt: 'now', result: EMPTY_RESULT }),
    ).resolves.toBeUndefined()
  })

  it('does nothing at all when no cache is wired', async () => {
    expect(await readUpcomingForecastCache(null, 'key')).toBeNull()
    await expect(
      writeUpcomingForecastCache(null, 'key', SCOPE, { generatedAt: 'now', result: EMPTY_RESULT }),
    ).resolves.toBeUndefined()
    await expect(invalidateForecastCacheForTenant(null, SCOPE.tenantId)).resolves.toBeUndefined()
  })

  it('drops a whole tenant on invalidation', async () => {
    const cache = makeCache()

    await invalidateForecastCacheForTenant(cache, SCOPE.tenantId)

    expect(cache.deleteByTags).toHaveBeenCalledWith([scopedForecastCacheTag(SCOPE.tenantId)])
  })
})

describe('resolveForecastCache', () => {
  it('returns null when the container has no cache registered', () => {
    const container = {
      resolve: () => { throw new Error('not registered') },
      hasRegistration: () => false,
    }

    expect(resolveForecastCache(container)).toBeNull()
  })

  it('returns null when the registered value is not a cache', () => {
    const container = {
      resolve: (() => ({ notACache: true })) as <T>(name: string) => T,
      hasRegistration: () => true,
    }

    expect(resolveForecastCache(container)).toBeNull()
  })

  it('returns the cache service when one is registered', () => {
    const cache = makeCache()
    const container = {
      resolve: (() => cache) as unknown as <T>(name: string) => T,
      hasRegistration: () => true,
    }

    expect(resolveForecastCache(container)).toBe(cache)
  })
})
