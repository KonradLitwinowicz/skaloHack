'use client'

import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { withRunningTotals } from './runningTotals'
import type { QuoteResponse } from './quoteTypes'

const SIMULATE_PATH = '/api/pricing/simulate'
const QUOTE_FAILED_KEY = 'pricing_engine.errors.quoteFailed'

export type SimulateLine = {
  productId: string
  quantity: string
}

export type SimulateBody = {
  customerId?: string | null
  customerGroupCode?: string | null
  orderScenarioCode?: string | null
  deliveryZoneCode?: string | null
  currencyCode?: string
  date?: string
  lines: SimulateLine[]
}

export type SimulateOutcome =
  | { ok: true; quote: QuoteResponse }
  | { ok: false; errorKey: string }

/**
 * POSTs `/api/pricing/simulate` — never `/api/pricing/quote`. A margin panel re-prices every time
 * it is opened, and `/quote` persists a calculation record per call, so using it here would write
 * a ledger row for every glance at a document.
 *
 * Every line's breakdown is piped through `withRunningTotals` because `PriceWaterfall` reads
 * `component.runningTotal`, which the API does not send.
 */
export async function simulateQuote(body: SimulateBody): Promise<SimulateOutcome> {
  try {
    const call = await apiCall<QuoteResponse & { error?: string }>(SIMULATE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!call.ok || !call.result) {
      return { ok: false, errorKey: call.result?.error ?? QUOTE_FAILED_KEY }
    }
    const payload = call.result
    if (!Array.isArray(payload.lines)) return { ok: false, errorKey: QUOTE_FAILED_KEY }
    return {
      ok: true,
      quote: {
        ...payload,
        lines: payload.lines.map((line) => ({
          ...line,
          breakdown: withRunningTotals(Array.isArray(line.breakdown) ? line.breakdown : []),
        })),
      },
    }
  } catch {
    return { ok: false, errorKey: QUOTE_FAILED_KEY }
  }
}
