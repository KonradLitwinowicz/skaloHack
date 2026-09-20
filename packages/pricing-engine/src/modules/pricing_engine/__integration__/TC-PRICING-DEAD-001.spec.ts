import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/modules/core/__integration__/helpers/authFixtures'
import { getTokenScope } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures'

/**
 * TC-PRICING-DEAD-001: rotation metrics, the deadstock verdict and the decision that authorises a
 * liquidation floor.
 *
 * Three things are worth stating about what this spec does and does not assert.
 *
 * It does not lean on seeded history. The reference dataset happens to contain 23 dormant products
 * and 18 that never sold, and every assertion about a SPECIFIC row would then be an assertion about
 * the seeder. So the ordering assertions are structural — the returned sequence must be monotonic
 * in whatever was sorted by — and the only row this spec makes claims about is the one it creates.
 *
 * Its own fixture is deliberately brand new, because that is the case most likely to be got wrong.
 * A product stocked five minutes ago has never sold anything, and a detector without a newness
 * suppressor would confidently call it deadstock and offer to discount it. The spec therefore
 * asserts the SUPPRESSION: `rawClass` accuses, `productClass` does not, and `markdown` is null so
 * no floor is authorised for a product nobody has had a chance to buy yet.
 *
 * The ACL split is the third: reading the list is `pricing.view`, but recording a decision removes
 * a product from everyone else's worklist and authorises a below-cost floor in the pricing engine,
 * so it needs `pricing.deadstock.decide`. A reader must get 200 on the list and 403 on the decision.
 */

export const integrationMeta = {
  description:
    'Deadstock listing: sorting, newness suppression, the operator decision and the ACL split between reading and deciding',
  requiredModules: ['pricing_engine', 'catalog', 'wms', 'auth'],
}

const LIST_API = '/api/pricing/deadstock'
const DECISIONS_API = '/api/pricing/deadstock/decisions'
const SUMMARY_API = '/api/pricing/deadstock/summary'
const UNIT_COST = '18.5000'
const RECEIVED_QUANTITY = '40'
const READER_PASSWORD = 'QaDeadstock123!'

type DeadstockWindow = { windowDays: number; unitsSold: string; revenueNet: string; orderCount: number }

type DeadstockListRow = {
  productId: string
  sku: string | null
  productClass: string
  rawClass: string
  suppression: string | null
  onHandQuantity: string
  daysSinceLastSale: number | null
  windows: DeadstockWindow[]
  carrying: { tiedCapital: string; positionPerMonth: string; confidence: string }
  markdown: { floorUnitPrice: string; stage: string } | null
  decision: { id: string; verdict: string; inForce: boolean } | null
}

type DeadstockListResponse = {
  items: DeadstockListRow[]
  totals: { tiedCapital: string; monthlyCarry: string; atRiskCount: number; stockedCount: number }
  page: number
  pageSize: number
  total: number
  totalPages: number
  currencyCode: string
  warnings: string[]
}

async function createJson(
  request: APIRequestContext,
  token: string,
  path: string,
  data: Record<string, unknown>,
): Promise<string> {
  const response = await apiRequest(request, 'POST', path, { token, data })
  expect(response.ok(), `POST ${path} should succeed: ${response.status()} ${await response.text()}`).toBe(true)
  const body = (await response.json()) as { id?: string }
  expect(typeof body.id, `POST ${path} should return an id`).toBe('string')
  return body.id as string
}

async function deleteById(
  request: APIRequestContext,
  token: string,
  path: string,
  id: string | null,
): Promise<void> {
  if (!id) return
  await apiRequest(request, 'DELETE', `${path}?id=${encodeURIComponent(id)}`, { token }).catch(() => undefined)
}

async function listDeadstock(
  request: APIRequestContext,
  token: string,
  query: Record<string, string>,
): Promise<DeadstockListResponse> {
  const params = new URLSearchParams(query).toString()
  const response = await apiRequest(request, 'GET', `${LIST_API}?${params}`, { token })
  expect(response.ok(), `GET ${LIST_API} should succeed: ${response.status()} ${await response.text()}`).toBe(true)
  return (await response.json()) as DeadstockListResponse
}

/** Monotonic in the requested direction, with unmeasured values (null) allowed only at the end. */
function expectMonotonic(values: (number | null)[], dir: 'asc' | 'desc'): void {
  const measured: number[] = []
  let seenNull = false
  for (const value of values) {
    if (value === null) {
      seenNull = true
      continue
    }
    expect(seenNull, 'unmeasured rows must sort last, never between two measured ones').toBe(false)
    measured.push(value)
  }
  for (let index = 1; index < measured.length; index += 1) {
    if (dir === 'desc') expect(measured[index]!).toBeLessThanOrEqual(measured[index - 1]!)
    else expect(measured[index]!).toBeGreaterThanOrEqual(measured[index - 1]!)
  }
}

test.describe('TC-PRICING-DEAD-001: deadstock listing and decisions', () => {
  test('ranks stocked products, withholds a verdict from new stock and gates deciding behind its own feature', async ({
    request,
  }) => {
    const token = await getAuthToken(request, 'admin')
    const { organizationId, tenantId, userId } = getTokenScope(token)
    expect(organizationId && tenantId && userId, 'admin token should carry a full scope').toBeTruthy()

    const stamp = Date.now()
    const sku = `QA-DEAD-${stamp}`
    let warehouseId: string | null = null
    let locationId: string | null = null
    let productId: string | null = null
    let variantId: string | null = null
    let profileId: string | null = null
    let purchasePositionId: string | null = null
    let readerEmail: string | null = null
    let readerRoleName: string | null = null

    try {
      // --- Fixture: one product, stocked today, never sold, with a known purchase cost ----------
      warehouseId = await createJson(request, token, '/api/wms/warehouses', {
        name: `QA Deadstock WH ${stamp}`,
        code: `QA-DEAD-WH-${stamp}`,
        isActive: true,
      })
      locationId = await createJson(request, token, '/api/wms/locations', {
        warehouseId,
        code: `QA-DEAD-LOC-${stamp}`,
        type: 'bin',
        isActive: true,
      })
      productId = await createJson(request, token, '/api/catalog/products', {
        title: `QA Deadstock ${stamp}`,
        sku,
        description:
          'Long enough description for SEO checks in QA automation flows. This text keeps the create validation satisfied.',
      })
      variantId = await createJson(request, token, '/api/catalog/variants', {
        productId,
        name: `QA Deadstock ${stamp} variant`,
        sku: `${sku}-V`,
        isDefault: true,
        isActive: true,
      })
      profileId = await createJson(request, token, '/api/wms/inventory-profiles', {
        catalogProductId: productId,
        catalogVariantId: variantId,
        defaultUom: 'pcs',
        trackLot: false,
        trackExpiration: false,
        defaultStrategy: 'fifo',
      })
      const receiveResponse = await apiRequest(request, 'POST', '/api/wms/inventory/receive', {
        token,
        data: {
          organizationId,
          tenantId,
          warehouseId,
          locationId,
          catalogVariantId: variantId,
          quantity: RECEIVED_QUANTITY,
          referenceType: 'po',
          referenceId: crypto.randomUUID(),
          performedBy: userId,
          performedAt: new Date().toISOString(),
        },
      })
      expect(
        receiveResponse.ok(),
        `receive should succeed: ${receiveResponse.status()} ${await receiveResponse.text()}`,
      ).toBe(true)
      purchasePositionId = await createJson(request, token, '/api/pricing/purchase-positions', {
        catalogProductId: productId,
        catalogVariantId: variantId,
        sku,
        lastDeliveryUnitCost: UNIT_COST,
        annualVolume: '0',
        currentTierDiscount: '0',
      })

      // --- The list answers, and its totals describe the catalogue, not the page ---------------
      const listed = await listDeadstock(request, token, { pageSize: '100' })
      expect(listed.page).toBe(1)
      expect(listed.currencyCode.length).toBeGreaterThan(0)
      expect(listed.totals.stockedCount).toBeGreaterThan(0)
      expect(listed.totals.atRiskCount).toBeGreaterThanOrEqual(0)

      // --- Sorting is real, in both directions, on a measured column and on a sparse one -------
      const byCapital = await listDeadstock(request, token, {
        sort: 'tiedCapital',
        dir: 'desc',
        pageSize: '50',
        atRiskOnly: 'true',
      })
      expectMonotonic(
        byCapital.items.map((row) => Number.parseFloat(row.carrying.tiedCapital)),
        'desc',
      )

      const byDormancy = await listDeadstock(request, token, {
        sort: 'daysSinceLastSale',
        dir: 'desc',
        pageSize: '50',
        atRiskOnly: 'true',
      })
      expectMonotonic(
        byDormancy.items.map((row) => row.daysSinceLastSale),
        'desc',
      )

      const byUnitsAscending = await listDeadstock(request, token, {
        sort: 'units365',
        dir: 'asc',
        pageSize: '50',
      })
      expectMonotonic(
        byUnitsAscending.items.map(
          (row) => Number.parseFloat(row.windows.find((window) => window.windowDays === 365)?.unitsSold ?? '0'),
        ),
        'asc',
      )

      // --- `actionableOnly` is the dashboard tile's contract, and it has to match the totals ---
      //
      // The tile's headline counts positions carrying a liquidation floor while its list used to be
      // drawn from the wider at-risk set, so a product dormant for three days appeared under a
      // heading that said "not moving". The two must stand on one basis or the tile contradicts
      // itself, and only a filter enforced server-side can guarantee that.
      const actionable = await listDeadstock(request, token, { actionableOnly: 'true', pageSize: '50' })
      for (const row of actionable.items) {
        expect(row.markdown, `${row.sku ?? row.productId} appears in the actionable list`).not.toBeNull()
        expect(['dying', 'dead', 'never_sold']).toContain(row.productClass)
        expect(row.suppression, 'a withheld verdict authorises no floor').toBeNull()
      }
      // The assertion that actually pins the contract: the filtered list and the headline count are
      // the SAME set, so a page of it holds exactly as many rows as the headline claims exist, up
      // to the page size. If these two ever diverge the tile starts lying about its own list.
      expect(actionable.items.length).toBe(Math.min(actionable.totals.atRiskCount, 50))

      // --- The summary route: same totals, no rows, and its own narrower permission -------------
      //
      // A tile showing one figure and a screen showing another, both naming the same thing, is the
      // failure the first three assertions rule out. The fourth is the point of the separate route:
      // it must be reachable by a role that has `pricing.deadstock.summary` and NOTHING else, and
      // it must be structurally incapable of returning a product-level figure to that role.
      const summaryResponse = await apiRequest(request, 'GET', SUMMARY_API, { token })
      expect(summaryResponse.ok(), `GET ${SUMMARY_API}: ${summaryResponse.status()}`).toBe(true)
      const summary = (await summaryResponse.json()) as {
        totals: DeadstockListResponse['totals']
        currencyCode: string
      }
      expect(summary.totals.tiedCapital).toBe(actionable.totals.tiedCapital)
      expect(summary.totals.monthlyCarry).toBe(actionable.totals.monthlyCarry)
      expect(summary.totals.atRiskCount).toBe(actionable.totals.atRiskCount)
      expect(
        Object.keys(summary),
        'the summary shape carries no row collection at all',
      ).not.toContain('items')

      // --- A sort key the API does not have is rejected, not silently ignored ------------------
      const badSort = await apiRequest(request, 'GET', `${LIST_API}?sort=whatever`, { token })
      expect(badSort.status(), 'an unknown sort key must be a client error').toBe(400)

      // --- The fixture: accused by the raw class, spared by the newness suppressor --------------
      const withSuppressed = await listDeadstock(request, token, {
        search: sku,
        pageSize: '10',
        atRiskOnly: 'true',
        includeSuppressed: 'true',
      })
      const row = withSuppressed.items.find((item) => item.productId === productId)
      expect(row, 'the fixture product should be visible once suppressed rows are included').toBeTruthy()
      expect(row!.onHandQuantity).toBe('40.0000')
      expect(row!.daysSinceLastSale, 'it has never sold, so there is no dormancy to measure').toBeNull()
      expect(row!.rawClass, 'stock with no sale at all is never_sold').toBe('never_sold')
      expect(row!.suppression, 'but it was stocked today, so the verdict is withheld').toBe('new_product')
      expect(row!.productClass).toBe('healthy')
      expect(row!.markdown, 'a suppressed row authorises no floor').toBeNull()
      // 40 units at 18.50: the money is reported even while the verdict is not.
      expect(row!.carrying.tiedCapital).toBe('740.0000')

      // --- Deciding is a separate permission from reading ---------------------------------------
      readerRoleName = `qa-deadstock-reader-${stamp}`
      const readerRoleId = await createRoleFixture(request, token, { name: readerRoleName })
      await setRoleAclFeatures(request, token, {
        roleId: readerRoleId,
        features: ['pricing.view', 'dashboards.view'],
      })
      readerEmail = `qa-deadstock-reader-${stamp}@example.com`
      await createUserFixture(request, token, {
        email: readerEmail,
        password: READER_PASSWORD,
        organizationId: organizationId as string,
        roles: [readerRoleName],
      })
      const readerToken = await getAuthToken(request, readerEmail, READER_PASSWORD)

      const readerList = await apiRequest(request, 'GET', `${LIST_API}?pageSize=5`, { token: readerToken })
      expect(readerList.status(), 'pricing.view is enough to read the list').toBe(200)

      // The narrow feature in both directions: this reader has `pricing.view` but NOT
      // `pricing.deadstock.summary`, so the tile endpoint refuses it even though the list does not.
      // That asymmetry is the whole reason the route is separate.
      const readerSummary = await apiRequest(request, 'GET', SUMMARY_API, { token: readerToken })
      expect(
        readerSummary.status(),
        'the summary route is gated on its own feature, not on pricing.view',
      ).toBe(403)

      const readerDecision = await apiRequest(request, 'POST', DECISIONS_API, {
        token: readerToken,
        data: { productId, verdict: 'confirmed' },
      })
      expect(
        readerDecision.status(),
        'recording a decision needs pricing.deadstock.decide, which this role does not have',
      ).toBe(403)

      // --- A decision is recorded, echoed, and visible on the row next time it is read ----------
      const confirmed = await apiRequest(request, 'POST', DECISIONS_API, {
        token,
        data: { productId, variantId, verdict: 'confirmed', reasonCode: 'qa', note: 'recorded by TC-PRICING-DEAD-001' },
      })
      expect(
        confirmed.ok(),
        `recording a decision should succeed: ${confirmed.status()} ${await confirmed.text()}`,
      ).toBe(true)
      const confirmedBody = (await confirmed.json()) as { ok: boolean; decision: { id: string; verdict: string } }
      expect(confirmedBody.ok).toBe(true)
      expect(confirmedBody.decision.verdict).toBe('confirmed')

      const afterDecision = await listDeadstock(request, token, {
        search: sku,
        pageSize: '10',
        atRiskOnly: 'true',
        includeSuppressed: 'true',
      })
      const decidedRow = afterDecision.items.find((item) => item.productId === productId)
      expect(decidedRow?.decision?.verdict).toBe('confirmed')
      expect(decidedRow?.decision?.inForce).toBe(true)

      // --- Decisions are append-only: a later dismissal revokes the confirmation ---------------
      const dismissed = await apiRequest(request, 'POST', DECISIONS_API, {
        token,
        data: { productId, verdict: 'dismissed', reviewInDays: 30 },
      })
      expect(dismissed.ok(), `dismissing should succeed: ${dismissed.status()}`).toBe(true)
      const dismissedBody = (await dismissed.json()) as { decision: { id: string; reviewAt: string | null } }
      expect(dismissedBody.decision.id, 'a dismissal is a NEW row, not an edit of the confirmation').not.toBe(
        confirmedBody.decision.id,
      )
      expect(dismissedBody.decision.reviewAt, 'a dismissal must lapse, or the list quietly empties').not.toBeNull()

      const afterDismissal = await listDeadstock(request, token, {
        search: sku,
        pageSize: '10',
        atRiskOnly: 'true',
        includeSuppressed: 'true',
      })
      const dismissedRow = afterDismissal.items.find((item) => item.productId === productId)
      expect(dismissedRow?.decision?.verdict).toBe('dismissed')

      // --- A malformed decision is rejected ----------------------------------------------------
      const badVerdict = await apiRequest(request, 'POST', DECISIONS_API, {
        token,
        data: { productId, verdict: 'maybe' },
      })
      expect(badVerdict.status(), 'an unknown verdict must be a client error').toBe(400)
    } finally {
      if (readerEmail) await deleteUserIfExists(request, token, readerEmail)
      if (readerRoleName) await deleteRoleIfExists(request, token, readerRoleName)
      await deleteById(request, token, '/api/pricing/purchase-positions', purchasePositionId)
      await deleteById(request, token, '/api/wms/inventory-profiles', profileId)
      await deleteById(request, token, '/api/catalog/variants', variantId)
      await deleteById(request, token, '/api/catalog/products', productId)
      await deleteById(request, token, '/api/wms/locations', locationId)
      await deleteById(request, token, '/api/wms/warehouses', warehouseId)
    }
  })
})
