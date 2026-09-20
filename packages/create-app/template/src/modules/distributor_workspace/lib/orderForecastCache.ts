import type { UpcomingForecastResult } from './orderForecastLoader'

/**
 * Recomputing the upcoming forecast means reading every purchase line of the organization for the
 * lookback window — on the reference dataset that is ~107k rows — and running the forecast engine
 * per customer. Nothing in that answer changes until an order, a line or a prediction note does,
 * so it is cached per scope and horizon and dropped by tag on the first write that could move it.
 *
 * The TTL is the backstop for writes that reach the database without an event (a direct import, a
 * restored dump): stale by at most this long, never stale forever.
 */
export const UPCOMING_FORECAST_CACHE_TTL_MS = 5 * 60_000

export const UPCOMING_FORECAST_CACHE_TAG = 'distributor-order-forecast'

export type ForecastCacheScope = {
  organizationId: string
  tenantId: string
}

export type ForecastCacheService = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, options?: { ttl?: number; tags?: string[] }): Promise<void>
  deleteByTags(tags: string[]): Promise<number>
}

type ResolveOnly = { resolve: <T = unknown>(name: string) => T; hasRegistration?: (name: string) => boolean }

/**
 * Returns the cache service, or null wherever one is not wired (CLI, tests, a container built
 * before `bootstrap`). Every caller must stay correct without it — the cache is an accelerator,
 * never a source of truth.
 */
export function resolveForecastCache(container: ResolveOnly): ForecastCacheService | null {
  try {
    if (container.hasRegistration && !container.hasRegistration('cache')) return null
    const candidate = container.resolve('cache')
    if (
      candidate
      && typeof (candidate as ForecastCacheService).get === 'function'
      && typeof (candidate as ForecastCacheService).set === 'function'
    ) {
      return candidate as ForecastCacheService
    }
  } catch {
    return null
  }
  return null
}

/**
 * The UTC day is part of the key because the rows carry day-relative fields — `daysUntilExpected`,
 * `overdueDays`, the overdue banding. An entry that outlived midnight would call tomorrow's
 * delivery "today"; keying on the day retires it at the boundary instead.
 */
export function upcomingForecastCacheKey(
  scope: ForecastCacheScope,
  horizonDays: number,
  minConfidence: number | undefined,
  now: Date,
): string {
  const confidence = minConfidence === undefined ? 'default' : String(minConfidence)
  const utcDay = now.toISOString().slice(0, 10)
  return `${UPCOMING_FORECAST_CACHE_TAG}:upcoming:${scope.tenantId}:${scope.organizationId}:${horizonDays}:${confidence}:${utcDay}`
}

/** Everything cached for one tenant, whatever the horizon, confidence floor or day. */
export function scopedForecastCacheTag(tenantId: string): string {
  return `${UPCOMING_FORECAST_CACHE_TAG}:${tenantId}`
}

/**
 * Drops every forecast entry of one tenant. Shared by the subscribers that watch sales writes and
 * by the prediction-feedback route, which changes the forecast without going through sales events.
 */
export async function invalidateForecastCacheForTenant(
  cache: Pick<ForecastCacheService, 'deleteByTags'> | null,
  tenantId: string,
): Promise<void> {
  if (!cache) return
  try {
    await cache.deleteByTags([scopedForecastCacheTag(tenantId)])
  } catch {
  }
}

/** What goes in the cache: the computed rows plus the instant they were computed at. */
export type CachedUpcomingForecast = {
  generatedAt: string
  result: UpcomingForecastResult
}

export async function readUpcomingForecastCache(
  cache: ForecastCacheService | null,
  key: string,
): Promise<CachedUpcomingForecast | null> {
  if (!cache) return null
  try {
    const cached = await cache.get(key)
    const entry = cached as CachedUpcomingForecast | null
    if (entry && typeof entry.generatedAt === 'string' && Array.isArray(entry.result?.rows)) {
      return entry
    }
  } catch {
    return null
  }
  return null
}

export async function writeUpcomingForecastCache(
  cache: ForecastCacheService | null,
  key: string,
  scope: ForecastCacheScope,
  value: CachedUpcomingForecast,
): Promise<void> {
  if (!cache) return
  try {
    await cache.set(key, value, {
      ttl: UPCOMING_FORECAST_CACHE_TTL_MS,
      tags: [UPCOMING_FORECAST_CACHE_TAG, scopedForecastCacheTag(scope.tenantId)],
    })
  } catch {
  }
}
