/**
 * Synthetic purchasing habits for the HoReCa customer base.
 *
 * This file exists to give the forecast engine something to find; it is NOT what the engine reads.
 * `lib/orderForecast.ts` never imports anything from here — it reads `sales_orders` — so replacing
 * the seeded history with a real ERP import changes the predictions and nothing else. Deleting
 * this file would leave the feature working on real data.
 *
 * What the profiles encode is the structure of a wholesale relationship, not a list of answers:
 *
 * - a customer has ONE delivery rhythm (their van slot), and products ride on it at multiples of
 *   that rhythm — weekly towels, fortnightly dishwasher chemicals, monthly gloves. That is what
 *   makes a product-level interval an exact multiple of the order interval, which is how real
 *   standing orders behave and what the weekday detector is built to recognise.
 * - a rhythm is never clean: deliveries slip by a day, a cycle gets skipped, quantities move with
 *   the season.
 * - real baskets carry noise. `noiseCategorySlugs` seeds one-off purchases that look exactly like
 *   the start of a pattern and must never be predicted — they are the negative control for the
 *   whole feature, and `seedOrderHistory` reports how many it planted so a run can be checked.
 *
 * Per-customer variety (which weekday, how often, which lines) is derived from the customer handle
 * in `orderHistorySeeder.ts`, so the forty customers do not come out as forty copies of a segment.
 */

import type { HorecaCustomerSegment } from './horecaCustomerData'

export type StandingLineSeed = {
  categorySlug: string
  /** 1 = every delivery, 2 = every second, 4 = roughly monthly for a weekly customer. */
  everyNthOrder: number
  quantityBase: number
  /** Fraction of `quantityBase` the seeded quantity may wander by, e.g. 0.25 = ±25%. */
  quantityJitter: number
  skipProbability: number
}

/**
 * Two product lifecycles the standing-order model alone cannot express, both reserved GLOBALLY
 * rather than per customer.
 *
 * A product one customer stopped buying is not dead — somebody else still orders it weekly. To
 * produce a genuinely dead product the seeder has to take it off EVERY customer's list at the same
 * point in the window, which is why these pools are carved out of the catalog once and excluded
 * from the ordinary standing and noise pools.
 *
 * They are negative controls for two different detectors. `DISCONTINUED_*` products sold steadily
 * and then stopped: the recurrence detector must reject them as `abandoned` despite a textbook
 * rhythm, and a dead-stock detector must tell them apart from a product that never sold at all.
 * `SEASONAL_*` products sell hard for a few months and vanish: the recurrence detector must not
 * project them into the off-season, and a dead-stock detector must NOT flag them in January.
 */
export const DISCONTINUED_POOL_CATEGORIES = [
  'horeca-chemia-do-powierzchni-i-sanitariatow',
  'horeca-czysciwa-i-sciereczki',
  'horeca-dozowniki-i-akcesoria-papiernicze',
  'horeca-srodki-do-podlog',
] as const

export const SEASONAL_POOL_CATEGORIES = [
  'horeca-opakowania-na-wynos',
  'horeca-kubki-i-wieczka',
  'horeca-opakowania-do-pizzy-i-cateringu',
] as const

/** Products per category pulled into each reserved pool, counted from the end of the title order. */
export const RESERVED_POOL_SIZE = 3

/** Fraction of the history window after which nothing in the discontinued pool is ordered again. */
export const DISCONTINUED_WINDOW_FRACTION = 0.55

/** Calendar months (0-based) each seasonal pool slot sells in; slots alternate across the pool. */
export const SEASONAL_MONTH_SETS: number[][] = [
  [4, 5, 6, 7],
  [10, 11, 0],
]

export const DISCONTINUED_ORDER_PROBABILITY = 0.45
export const SEASONAL_ORDER_PROBABILITY = 0.55

export type HorecaSegmentOrderProfile = {
  segment: HorecaCustomerSegment
  orderIntervalDays: number
  preferredWeekday: number
  orderDayJitterDays: number
  skipOrderProbability: number
  standingLines: StandingLineSeed[]
  noiseCategorySlugs: string[]
  noiseOrderProbability: number
  maxNoiseLinesPerOrder: number
}

/**
 * Alternatives the seeder picks between using a hash of the customer handle.
 *
 * Without this every restaurant would order on the same weekday at the same interval, and the
 * forecast would look convincing for the wrong reason — a demo that proves only that the seeder
 * and the detector agree on one hard-coded rhythm.
 */
export const ORDER_INTERVAL_VARIANTS = [7, 7, 7, 10, 14] as const
export const WEEKDAY_OFFSETS = [0, 0, 1, 2, -1] as const

export const HORECA_SEGMENT_ORDER_PROFILES: HorecaSegmentOrderProfile[] = [
  {
    segment: 'restauracja',
    orderIntervalDays: 7,
    preferredWeekday: 1,
    orderDayJitterDays: 1,
    skipOrderProbability: 0.06,
    standingLines: [
      { categorySlug: 'horeca-chemia-myjaca-do-naczyn', everyNthOrder: 1, quantityBase: 6, quantityJitter: 0.25, skipProbability: 0.05 },
      { categorySlug: 'horeca-chemia-do-zmywarek', everyNthOrder: 1, quantityBase: 4, quantityJitter: 0.2, skipProbability: 0.05 },
      { categorySlug: 'horeca-reczniki-papierowe', everyNthOrder: 1, quantityBase: 12, quantityJitter: 0.3, skipProbability: 0.04 },
      { categorySlug: 'horeca-folie-i-worki', everyNthOrder: 1, quantityBase: 10, quantityJitter: 0.3, skipProbability: 0.06 },
      { categorySlug: 'horeca-srodki-dezynfekcyjne', everyNthOrder: 2, quantityBase: 5, quantityJitter: 0.2, skipProbability: 0.06 },
      { categorySlug: 'horeca-chemia-kuchenna-specjalistyczna', everyNthOrder: 4, quantityBase: 3, quantityJitter: 0.25, skipProbability: 0.08 },
      { categorySlug: 'horeca-kosmetyki-i-higiena-rak', everyNthOrder: 4, quantityBase: 8, quantityJitter: 0.25, skipProbability: 0.08 },
    ],
    noiseCategorySlugs: ['horeca-sztucce-i-naczynia-jednorazowe', 'horeca-kubki-i-wieczka', 'horeca-opakowania-na-wynos'],
    noiseOrderProbability: 0.18,
    maxNoiseLinesPerOrder: 2,
  },
  {
    segment: 'hotel',
    orderIntervalDays: 7,
    preferredWeekday: 2,
    orderDayJitterDays: 1,
    skipOrderProbability: 0.05,
    standingLines: [
      { categorySlug: 'horeca-papier-toaletowy', everyNthOrder: 1, quantityBase: 20, quantityJitter: 0.25, skipProbability: 0.04 },
      { categorySlug: 'horeca-reczniki-papierowe', everyNthOrder: 1, quantityBase: 18, quantityJitter: 0.25, skipProbability: 0.04 },
      { categorySlug: 'horeca-chemia-do-powierzchni-i-sanitariatow', everyNthOrder: 1, quantityBase: 8, quantityJitter: 0.2, skipProbability: 0.05 },
      { categorySlug: 'horeca-chemia-do-prania', everyNthOrder: 2, quantityBase: 12, quantityJitter: 0.3, skipProbability: 0.06 },
      { categorySlug: 'horeca-kosmetyki-i-higiena-rak', everyNthOrder: 2, quantityBase: 24, quantityJitter: 0.25, skipProbability: 0.05 },
      { categorySlug: 'horeca-srodki-do-podlog', everyNthOrder: 4, quantityBase: 6, quantityJitter: 0.2, skipProbability: 0.08 },
      { categorySlug: 'horeca-serwetki-i-obrusy', everyNthOrder: 4, quantityBase: 15, quantityJitter: 0.35, skipProbability: 0.1 },
    ],
    noiseCategorySlugs: ['horeca-czysciwa-i-sciereczki', 'horeca-dozowniki-i-akcesoria-papiernicze', 'horeca-pojemniki-i-tacki'],
    noiseOrderProbability: 0.15,
    maxNoiseLinesPerOrder: 2,
  },
  {
    segment: 'stolowka',
    orderIntervalDays: 14,
    preferredWeekday: 3,
    orderDayJitterDays: 1,
    skipOrderProbability: 0.07,
    standingLines: [
      { categorySlug: 'horeca-chemia-do-zmywarek', everyNthOrder: 1, quantityBase: 8, quantityJitter: 0.2, skipProbability: 0.05 },
      { categorySlug: 'horeca-reczniki-papierowe', everyNthOrder: 1, quantityBase: 16, quantityJitter: 0.25, skipProbability: 0.04 },
      { categorySlug: 'horeca-folie-i-worki', everyNthOrder: 1, quantityBase: 14, quantityJitter: 0.3, skipProbability: 0.06 },
      { categorySlug: 'horeca-srodki-dezynfekcyjne', everyNthOrder: 2, quantityBase: 6, quantityJitter: 0.2, skipProbability: 0.07 },
      { categorySlug: 'horeca-sztucce-i-naczynia-jednorazowe', everyNthOrder: 2, quantityBase: 20, quantityJitter: 0.35, skipProbability: 0.08 },
    ],
    noiseCategorySlugs: ['horeca-serwetki-i-obrusy', 'horeca-kubki-i-wieczka', 'horeca-czysciwa-i-sciereczki'],
    noiseOrderProbability: 0.2,
    maxNoiseLinesPerOrder: 2,
  },
  {
    segment: 'kawiarnia',
    orderIntervalDays: 7,
    preferredWeekday: 4,
    orderDayJitterDays: 1,
    skipOrderProbability: 0.08,
    standingLines: [
      { categorySlug: 'horeca-kubki-i-wieczka', everyNthOrder: 1, quantityBase: 25, quantityJitter: 0.3, skipProbability: 0.04 },
      { categorySlug: 'horeca-serwetki-i-obrusy', everyNthOrder: 1, quantityBase: 12, quantityJitter: 0.3, skipProbability: 0.05 },
      { categorySlug: 'horeca-chemia-myjaca-do-naczyn', everyNthOrder: 2, quantityBase: 4, quantityJitter: 0.2, skipProbability: 0.06 },
      { categorySlug: 'horeca-reczniki-papierowe', everyNthOrder: 2, quantityBase: 8, quantityJitter: 0.25, skipProbability: 0.05 },
      { categorySlug: 'horeca-sztucce-i-naczynia-jednorazowe', everyNthOrder: 4, quantityBase: 10, quantityJitter: 0.35, skipProbability: 0.1 },
    ],
    noiseCategorySlugs: ['horeca-opakowania-na-wynos', 'horeca-pojemniki-i-tacki', 'horeca-srodki-dezynfekcyjne'],
    noiseOrderProbability: 0.22,
    maxNoiseLinesPerOrder: 2,
  },
  {
    segment: 'catering',
    orderIntervalDays: 7,
    preferredWeekday: 5,
    orderDayJitterDays: 2,
    skipOrderProbability: 0.1,
    standingLines: [
      { categorySlug: 'horeca-opakowania-na-wynos', everyNthOrder: 1, quantityBase: 30, quantityJitter: 0.4, skipProbability: 0.05 },
      { categorySlug: 'horeca-pojemniki-i-tacki', everyNthOrder: 1, quantityBase: 22, quantityJitter: 0.4, skipProbability: 0.06 },
      { categorySlug: 'horeca-sztucce-i-naczynia-jednorazowe', everyNthOrder: 1, quantityBase: 28, quantityJitter: 0.4, skipProbability: 0.06 },
      { categorySlug: 'horeca-folie-i-worki', everyNthOrder: 2, quantityBase: 12, quantityJitter: 0.3, skipProbability: 0.07 },
      { categorySlug: 'horeca-serwetki-i-obrusy', everyNthOrder: 2, quantityBase: 18, quantityJitter: 0.35, skipProbability: 0.08 },
      { categorySlug: 'horeca-chemia-myjaca-do-naczyn', everyNthOrder: 4, quantityBase: 5, quantityJitter: 0.2, skipProbability: 0.08 },
    ],
    noiseCategorySlugs: ['horeca-opakowania-do-pizzy-i-cateringu', 'horeca-kubki-i-wieczka', 'horeca-kosmetyki-i-higiena-rak'],
    noiseOrderProbability: 0.28,
    maxNoiseLinesPerOrder: 3,
  },
  {
    segment: 'piekarnia',
    orderIntervalDays: 7,
    preferredWeekday: 3,
    orderDayJitterDays: 1,
    skipOrderProbability: 0.06,
    standingLines: [
      { categorySlug: 'horeca-folie-i-worki', everyNthOrder: 1, quantityBase: 18, quantityJitter: 0.3, skipProbability: 0.04 },
      { categorySlug: 'horeca-opakowania-do-pizzy-i-cateringu', everyNthOrder: 1, quantityBase: 14, quantityJitter: 0.35, skipProbability: 0.06 },
      { categorySlug: 'horeca-czysciwa-i-sciereczki', everyNthOrder: 2, quantityBase: 9, quantityJitter: 0.25, skipProbability: 0.06 },
      { categorySlug: 'horeca-chemia-kuchenna-specjalistyczna', everyNthOrder: 2, quantityBase: 4, quantityJitter: 0.2, skipProbability: 0.07 },
      { categorySlug: 'horeca-reczniki-papierowe', everyNthOrder: 4, quantityBase: 10, quantityJitter: 0.25, skipProbability: 0.08 },
    ],
    noiseCategorySlugs: ['horeca-serwetki-i-obrusy', 'horeca-pojemniki-i-tacki', 'horeca-chemia-do-zmywarek'],
    noiseOrderProbability: 0.16,
    maxNoiseLinesPerOrder: 2,
  },
  {
    segment: 'szpital',
    orderIntervalDays: 7,
    preferredWeekday: 1,
    orderDayJitterDays: 0,
    skipOrderProbability: 0.03,
    standingLines: [
      { categorySlug: 'horeca-srodki-dezynfekcyjne', everyNthOrder: 1, quantityBase: 30, quantityJitter: 0.15, skipProbability: 0.02 },
      { categorySlug: 'horeca-kosmetyki-i-higiena-rak', everyNthOrder: 1, quantityBase: 36, quantityJitter: 0.15, skipProbability: 0.02 },
      { categorySlug: 'horeca-papier-toaletowy', everyNthOrder: 1, quantityBase: 40, quantityJitter: 0.2, skipProbability: 0.03 },
      { categorySlug: 'horeca-reczniki-papierowe', everyNthOrder: 1, quantityBase: 45, quantityJitter: 0.2, skipProbability: 0.03 },
      { categorySlug: 'horeca-chemia-do-powierzchni-i-sanitariatow', everyNthOrder: 2, quantityBase: 16, quantityJitter: 0.2, skipProbability: 0.04 },
      { categorySlug: 'horeca-chemia-do-prania', everyNthOrder: 2, quantityBase: 20, quantityJitter: 0.2, skipProbability: 0.04 },
      { categorySlug: 'horeca-srodki-do-podlog', everyNthOrder: 4, quantityBase: 12, quantityJitter: 0.2, skipProbability: 0.06 },
    ],
    noiseCategorySlugs: ['horeca-czysciwa-i-sciereczki', 'horeca-dozowniki-i-akcesoria-papiernicze'],
    noiseOrderProbability: 0.08,
    maxNoiseLinesPerOrder: 1,
  },
  {
    segment: 'szkola',
    orderIntervalDays: 14,
    preferredWeekday: 2,
    orderDayJitterDays: 1,
    skipOrderProbability: 0.09,
    standingLines: [
      { categorySlug: 'horeca-papier-toaletowy', everyNthOrder: 1, quantityBase: 24, quantityJitter: 0.2, skipProbability: 0.04 },
      { categorySlug: 'horeca-reczniki-papierowe', everyNthOrder: 1, quantityBase: 20, quantityJitter: 0.2, skipProbability: 0.04 },
      { categorySlug: 'horeca-srodki-do-podlog', everyNthOrder: 2, quantityBase: 10, quantityJitter: 0.2, skipProbability: 0.06 },
      { categorySlug: 'horeca-chemia-do-powierzchni-i-sanitariatow', everyNthOrder: 2, quantityBase: 9, quantityJitter: 0.2, skipProbability: 0.06 },
      { categorySlug: 'horeca-srodki-dezynfekcyjne', everyNthOrder: 4, quantityBase: 8, quantityJitter: 0.2, skipProbability: 0.08 },
    ],
    noiseCategorySlugs: ['horeca-sztucce-i-naczynia-jednorazowe', 'horeca-kubki-i-wieczka'],
    noiseOrderProbability: 0.12,
    maxNoiseLinesPerOrder: 1,
  },
]

const PROFILES_BY_SEGMENT = new Map(
  HORECA_SEGMENT_ORDER_PROFILES.map((profile) => [profile.segment, profile]),
)

export function orderProfileFor(segment: HorecaCustomerSegment): HorecaSegmentOrderProfile {
  const profile = PROFILES_BY_SEGMENT.get(segment)
  if (!profile) {
    throw new Error(`[internal] No HoReCa order profile declared for segment "${segment}"`)
  }
  return profile
}

/**
 * Seasonal demand, as a multiplier on every quantity in a given calendar month.
 *
 * Present so the seeded quantities are not a flat line: the median-based quantity prediction should
 * be demonstrably robust to a December catering spike and a July school collapse, and a dataset
 * with no seasonality would never show whether it is.
 */
export const MONTHLY_DEMAND_INDEX: Record<HorecaCustomerSegment, number[]> = {
  restauracja: [0.9, 0.9, 1.0, 1.0, 1.1, 1.15, 1.2, 1.2, 1.05, 1.0, 1.0, 1.25],
  hotel: [0.8, 0.85, 0.95, 1.0, 1.1, 1.25, 1.35, 1.35, 1.1, 0.95, 0.85, 1.05],
  stolowka: [1.05, 1.1, 1.1, 1.05, 1.05, 0.7, 0.5, 0.6, 1.1, 1.15, 1.1, 0.8],
  kawiarnia: [0.95, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2, 1.2, 1.05, 1.0, 1.0, 1.1],
  catering: [0.85, 0.9, 1.0, 1.05, 1.25, 1.35, 1.2, 1.15, 1.1, 1.05, 1.1, 1.4],
  piekarnia: [0.95, 1.0, 1.15, 1.2, 1.0, 1.0, 1.05, 1.05, 1.0, 1.0, 1.05, 1.3],
  szpital: [1.05, 1.05, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.05, 1.05, 1.05],
  szkola: [1.05, 1.1, 1.1, 1.05, 1.05, 0.6, 0.3, 0.5, 1.15, 1.15, 1.1, 0.75],
}
