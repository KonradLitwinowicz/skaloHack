import { runWithCacheTenant } from '@open-mercato/cache'
import { invalidateForecastCacheForTenant } from './orderForecastCache'

type CacheService = { deleteByTags(tags: string[]): Promise<number> }

export type SubscriberContext = { resolve: <T = unknown>(name: string) => T }

/**
 * Shared body of the subscribers that retire the upcoming-order forecast.
 *
 * The whole tenant goes, not one customer: the forecast is a cross-customer ranking over one
 * horizon, so a single new order changes where every other customer sits in it.
 */
export async function invalidateForecastFromEvent(
  payload: unknown,
  context: SubscriberContext,
): Promise<void> {
  const data = (payload ?? {}) as Record<string, unknown>
  const tenantId = typeof data.tenantId === 'string' ? data.tenantId : null
  if (!tenantId) return

  let cache: CacheService
  try {
    cache = context.resolve<CacheService>('cache')
  } catch {
    return
  }

  await runWithCacheTenant(tenantId, () => invalidateForecastCacheForTenant(cache, tenantId))
}
