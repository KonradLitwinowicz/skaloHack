import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { deleteSalesEntityIfExists } from '@open-mercato/core/helpers/integration/salesFixtures'
import {
  createProductFixture,
  createVariantFixture,
  deleteCatalogProductIfExists,
} from '@open-mercato/core/helpers/integration/catalogFixtures'
import {
  createCustomerCompanyFixture,
  deleteCustomerCompanyFixture,
  uniqueSuffix,
} from '@open-mercato/core/helpers/integration/customerAccountsFixtures'

/**
 * TC-DIST-ORDER-FORECAST-001: `GET /api/distributor_workspace/customers/{id}/order-forecast`
 * and its companion `POST|DELETE .../prediction-feedback`.
 *
 * The suite builds a customer and their entire purchase history inside the test, because that is
 * the only way to assert what the forecast must REFUSE to say. A test reading an existing customer
 * could confirm that predictions appear; it could never prove that a product bought twice stays
 * out of the list, which is the property the feature is built around and the one a well-meaning
 * threshold change is most likely to break.
 *
 * Two histories are planted against one customer, in one basket per delivery, exactly as a real
 * order arrives:
 *  - a weekly staple bought on eight consecutive Mondays, which MUST be predicted;
 *  - a one-off bought twice in the same fortnight, which MUST NOT be, and must be reported under
 *    `rejected` with a reason rather than silently dropped.
 *
 * Dates are computed backwards from the day the test runs, so the fixture ages with the clock and
 * the staleness gate never turns the suite red on a Monday in six months' time.
 */

export const integrationMeta = {
  description:
    'Customer order-forecast route and the cross-customer upcoming list: auth gate, weekly pattern detection with evidence, rejection of non-repeating purchases, CSV export, and operator feedback suppressing and restoring a prediction',
  requiredModules: ['distributor_workspace', 'sales', 'customers', 'catalog'],
}

const ORDERS_API = '/api/sales/orders'
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const WEEKLY_OCCURRENCES = 8
const STAPLE_QUANTITY = 12

type ForecastPrediction = {
  productId: string | null
  productVariantId: string | null
  productName: string
  predictedQuantity: number
  nextExpectedAt: string
  confidence: number
  cadence: { kind: string; intervalDays: number; dominantWeekday: number | null }
  evidence: { occurrences: number; medianIntervalDays: number; lastOrderedAt: string }
}

type ForecastResponse = {
  customerId: string
  rhythm: { orderCount: number; medianIntervalDays: number | null; dominantWeekday: number | null }
  accuracy: { trials: number; hitRate: number | null }
  predictions: ForecastPrediction[]
  rejected: Array<{ reason: string; count: number; examples: string[] }>
  history: { orderCount: number; lineCount: number }
  thresholds: { minOccurrences: number; minSpanDays: number }
}

function forecastUrl(customerId: string, query = ''): string {
  return `/api/distributor_workspace/customers/${customerId}/order-forecast${query}`
}

function feedbackUrl(customerId: string, query = ''): string {
  return `/api/distributor_workspace/customers/${customerId}/prediction-feedback${query}`
}

const UPCOMING_API = '/api/distributor_workspace/order-forecast/upcoming'

type UpcomingResponse = {
  horizonDays: number
  customersAnalysed: number
  customersWithPredictions: number
  rows: Array<{
    customerEntityId: string
    customerName: string | null
    productVariantId: string | null
    productName: string
    predictedQuantity: number
    nextExpectedAt: string
    daysUntilNextExpected: number
    overdueDays: number
    confidence: number
  }>
}

/**
 * The most recent Monday at least `minAgeDays` in the past.
 *
 * Anchoring the whole history on a weekday keeps `dominantWeekday` assertable, and holding the
 * last delivery a week back leaves the rhythm current without making the next expected date land
 * on the day the suite happens to run.
 */
function recentAnchorMonday(minAgeDays: number): number {
  const todayMs = Math.floor(Date.now() / MILLISECONDS_PER_DAY) * MILLISECONDS_PER_DAY
  let candidate = todayMs - minAgeDays * MILLISECONDS_PER_DAY
  while (new Date(candidate).getUTCDay() !== 1) {
    candidate -= MILLISECONDS_PER_DAY
  }
  return candidate
}

async function createBackdatedOrder(
  request: APIRequestContext,
  token: string,
  customerEntityId: string,
  placedAtMs: number,
  lines: Array<{ productId: string; productVariantId: string; name: string; quantity: number }>,
): Promise<string> {
  const response = await apiRequest(request, 'POST', ORDERS_API, {
    token,
    data: {
      customerEntityId,
      currencyCode: 'PLN',
      placedAt: new Date(placedAtMs + 9 * 60 * 60 * 1000).toISOString(),
      lines: lines.map((line) => ({
        productId: line.productId,
        productVariantId: line.productVariantId,
        name: line.name,
        currencyCode: 'PLN',
        quantity: String(line.quantity),
        unitPriceNet: '10',
      })),
    },
  })
  expect(response.status(), `POST ${ORDERS_API} should create the backdated order`).toBe(201)
  const body = await readJsonSafe<{ id?: string }>(response)
  expect(typeof body?.id, 'Order creation should return an id').toBe('string')
  return body?.id as string
}

async function loadForecast(
  request: APIRequestContext,
  token: string,
  customerId: string,
): Promise<ForecastResponse> {
  const response = await apiRequest(request, 'GET', forecastUrl(customerId), { token })
  expect(response.status(), 'GET order-forecast should return 200').toBe(200)
  const body = await readJsonSafe<ForecastResponse>(response)
  expect(body, 'Forecast response should be JSON').toBeTruthy()
  return body as ForecastResponse
}

test.describe('TC-DIST-ORDER-FORECAST-001 customer order forecast', () => {
  let adminToken = ''
  let companyId: string | null = null
  let stapleProductId: string | null = null
  let stapleVariantId: string | null = null
  let oneOffProductId: string | null = null
  let oneOffVariantId: string | null = null
  const orderIds: string[] = []
  const suffix = uniqueSuffix()
  const stapleName = `QA Staple ${suffix}`
  const oneOffName = `QA One Off ${suffix}`

  test.beforeAll(async ({ request }) => {
    adminToken = await getAuthToken(request)
    companyId = await createCustomerCompanyFixture(request, adminToken, `QA Forecast Co ${suffix}`)

    stapleProductId = await createProductFixture(request, adminToken, {
      title: stapleName,
      sku: `QA-STAPLE-${suffix}`,
    })
    stapleVariantId = await createVariantFixture(request, adminToken, {
      productId: stapleProductId,
      name: `${stapleName} default`,
      sku: `QA-STAPLE-${suffix}-STD`,
      isDefault: true,
    })

    oneOffProductId = await createProductFixture(request, adminToken, {
      title: oneOffName,
      sku: `QA-ONEOFF-${suffix}`,
    })
    oneOffVariantId = await createVariantFixture(request, adminToken, {
      productId: oneOffProductId,
      name: `${oneOffName} default`,
      sku: `QA-ONEOFF-${suffix}-STD`,
      isDefault: true,
    })

    const anchorMs = recentAnchorMonday(7)
    for (let week = WEEKLY_OCCURRENCES - 1; week >= 0; week -= 1) {
      const placedAtMs = anchorMs - week * 7 * MILLISECONDS_PER_DAY
      const lines = [
        {
          productId: stapleProductId,
          productVariantId: stapleVariantId,
          name: stapleName,
          quantity: STAPLE_QUANTITY,
        },
      ]
      // The one-off rides along on two deliveries only — enough to look like the start of a
      // pattern, short of the three the engine requires before it will call one.
      if (week === 5 || week === 3) {
        lines.push({
          productId: oneOffProductId,
          productVariantId: oneOffVariantId,
          name: oneOffName,
          quantity: 2,
        })
      }
      orderIds.push(await createBackdatedOrder(request, adminToken, companyId, placedAtMs, lines))
    }
  })

  test.afterAll(async ({ request }) => {
    for (const orderId of orderIds) {
      await deleteSalesEntityIfExists(request, adminToken, ORDERS_API, orderId)
    }
    await deleteCatalogProductIfExists(request, adminToken, stapleProductId)
    await deleteCatalogProductIfExists(request, adminToken, oneOffProductId)
    await deleteCustomerCompanyFixture(request, adminToken, companyId)
  })

  test('refuses an unauthenticated request', async ({ request }) => {
    const response = await request.get(forecastUrl(companyId as string), {
      headers: { 'x-om-unauthorized-redirect': '0' },
    })
    expect(response.status(), 'An anonymous read of a customer forecast must not succeed').toBe(401)
  })

  test('predicts the weekly staple with the rhythm and evidence behind it', async ({ request }) => {
    const forecast = await loadForecast(request, adminToken, companyId as string)

    expect(forecast.history.orderCount).toBeGreaterThanOrEqual(WEEKLY_OCCURRENCES)
    expect(forecast.rhythm.medianIntervalDays).toBe(7)
    expect(forecast.rhythm.dominantWeekday).toBe(1)

    const staple = forecast.predictions.find((prediction) => prediction.productVariantId === stapleVariantId)
    expect(staple, 'Eight weekly deliveries of one product must be predicted').toBeTruthy()
    expect(staple?.cadence.kind).toBe('weekly')
    expect(staple?.cadence.intervalDays).toBe(7)
    expect(staple?.cadence.dominantWeekday).toBe(1)
    expect(staple?.predictedQuantity).toBe(STAPLE_QUANTITY)
    expect(staple?.evidence.occurrences).toBe(WEEKLY_OCCURRENCES)
    expect(staple?.confidence).toBeGreaterThan(0.5)
    expect(new Date(`${staple?.nextExpectedAt}T00:00:00.000Z`).getUTCDay()).toBe(1)
  })

  test('refuses to call two purchases a pattern, and says why', async ({ request }) => {
    const forecast = await loadForecast(request, adminToken, companyId as string)

    const oneOff = forecast.predictions.find((prediction) => prediction.productVariantId === oneOffVariantId)
    expect(oneOff, 'A product bought twice must not be predicted').toBeUndefined()

    const tooFew = forecast.rejected.find((entry) => entry.reason === 'tooFewOrders')
    expect(tooFew, 'The rejection must be reported rather than silently dropped').toBeTruthy()
    expect(tooFew?.examples).toContain(oneOffName)
    expect(forecast.thresholds.minOccurrences).toBeGreaterThan(2)
  })

  test('exports the visible predictions as CSV', async ({ request }) => {
    const response = await apiRequest(request, 'GET', forecastUrl(companyId as string, '?format=csv'), {
      token: adminToken,
    })

    expect(response.status(), 'CSV export should return 200').toBe(200)
    expect(response.headers()['content-type'] ?? '').toContain('text/csv')
    expect(response.headers()['content-disposition'] ?? '').toContain('attachment')
    const body = await response.text()
    expect(body).toContain(stapleName)
    expect(body).not.toContain(oneOffName)
  })

  test('lets the operator hide a prediction and bring it back', async ({ request }) => {
    const dismiss = await apiRequest(request, 'POST', feedbackUrl(companyId as string), {
      token: adminToken,
      data: {
        productId: stapleProductId,
        productVariantId: stapleVariantId,
        productName: stapleName,
        kind: 'dismissed',
      },
    })
    expect(dismiss.status(), 'Recording a dismissal should return 200').toBe(200)

    const hidden = await loadForecast(request, adminToken, companyId as string)
    expect(
      hidden.predictions.find((prediction) => prediction.productVariantId === stapleVariantId),
      'A dismissed product must disappear from the list',
    ).toBeUndefined()
    expect(hidden.rejected.some((entry) => entry.reason === 'dismissed')).toBe(true)

    const restore = await apiRequest(
      request,
      'DELETE',
      feedbackUrl(
        companyId as string,
        `?productId=${stapleProductId}&productVariantId=${stapleVariantId}`,
      ),
      { token: adminToken },
    )
    expect(restore.status(), 'Clearing the note should return 200').toBe(200)

    const restored = await loadForecast(request, adminToken, companyId as string)
    expect(
      restored.predictions.find((prediction) => prediction.productVariantId === stapleVariantId),
      'Clearing the note must let the raw rhythm show through again',
    ).toBeTruthy()
  })

  /**
   * The cross-customer list and the customer card must never disagree.
   *
   * They are two readings of the same engine over the same history, so a row present on one and
   * absent from the other would mean one of them is computing something else — the kind of
   * divergence that surfaces as "the system says two different things" long after the cause is
   * traceable.
   */
  test('surfaces the same prediction on the cross-customer list as on the customer card', async ({ request }) => {
    const response = await apiRequest(request, 'GET', `${UPCOMING_API}?horizonDays=30`, {
      token: adminToken,
    })
    expect(response.status(), 'GET upcoming should return 200').toBe(200)
    const body = await readJsonSafe<UpcomingResponse>(response)
    expect(body, 'Upcoming response should be JSON').toBeTruthy()

    const mine = (body as UpcomingResponse).rows.filter(
      (row) => row.customerEntityId === companyId,
    )
    const staple = mine.find((row) => row.productVariantId === stapleVariantId)
    expect(staple, 'The weekly staple must appear on the cross-customer list too').toBeTruthy()
    expect(staple?.predictedQuantity).toBe(STAPLE_QUANTITY)
    expect(staple?.customerName).toContain(suffix)

    const card = await loadForecast(request, adminToken, companyId as string)
    const fromCard = card.predictions.find((prediction) => prediction.productVariantId === stapleVariantId)
    expect(staple?.nextExpectedAt).toBe(fromCard?.nextExpectedAt)
    expect(staple?.confidence).toBe(fromCard?.confidence)

    expect(mine.some((row) => row.productVariantId === oneOffVariantId)).toBe(false)
    expect((body as UpcomingResponse).customersAnalysed).toBeGreaterThan(0)
  })

  test('narrows the cross-customer list to the requested horizon', async ({ request }) => {
    const wide = await apiRequest(request, 'GET', `${UPCOMING_API}?horizonDays=60`, { token: adminToken })
    const narrow = await apiRequest(request, 'GET', `${UPCOMING_API}?horizonDays=1`, { token: adminToken })

    const wideBody = await readJsonSafe<UpcomingResponse>(wide)
    const narrowBody = await readJsonSafe<UpcomingResponse>(narrow)

    expect((wideBody as UpcomingResponse).rows.length).toBeGreaterThanOrEqual(
      (narrowBody as UpcomingResponse).rows.length,
    )
    for (const row of (narrowBody as UpcomingResponse).rows) {
      expect(row.daysUntilNextExpected).toBeLessThanOrEqual(1)
    }
  })

  test('refuses an unauthenticated read of the cross-customer list', async ({ request }) => {
    const response = await request.get(UPCOMING_API, {
      headers: { 'x-om-unauthorized-redirect': '0' },
    })
    expect(response.status(), 'An anonymous read of every customer forecast must not succeed').toBe(401)
  })

  test('rejects a note that names no product', async ({ request }) => {
    const response = await apiRequest(request, 'POST', feedbackUrl(companyId as string), {
      token: adminToken,
      data: { kind: 'dismissed', productName: stapleName },
    })

    expect(response.status(), 'A note with no product id is not actionable').toBe(400)
  })
})
