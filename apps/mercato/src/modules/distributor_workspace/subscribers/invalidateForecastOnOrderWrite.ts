import { invalidateForecastFromEvent } from '../lib/forecastCacheInvalidation'

export const metadata = {
  event: 'sales.order.*',
  persistent: false,
  id: 'distributor_workspace:invalidate-order-forecast-on-order-write',
}

export default invalidateForecastFromEvent
