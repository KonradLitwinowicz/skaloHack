import { invalidateForecastFromEvent } from '../lib/forecastCacheInvalidation'

// A separate file from the order subscriber because `matchEventPattern` treats `*` as exactly one
// segment: `sales.*` would not reach `sales.line.created`.
export const metadata = {
  event: 'sales.line.*',
  persistent: false,
  id: 'distributor_workspace:invalidate-order-forecast-on-line-write',
}

export default invalidateForecastFromEvent
