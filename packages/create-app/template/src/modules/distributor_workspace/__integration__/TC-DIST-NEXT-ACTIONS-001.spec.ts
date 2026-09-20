import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteGeneralEntityIfExists, getTokenScope, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import {
  createSalesOrderFixture,
  createSalesQuoteFixture,
  deleteSalesEntityIfExists,
} from '@open-mercato/core/helpers/integration/salesFixtures'
import {
  createProductFixture,
  createVariantFixture,
  deleteCatalogProductIfExists,
} from '@open-mercato/core/helpers/integration/catalogFixtures'
import {
  createCustomerCompanyFixture,
  createCustomerRoleFixture,
  createCustomerUserFixture,
  customerTestPassword,
  deleteCustomerCompanyFixture,
  deleteCustomerRoleFixture,
  deleteCustomerUserFixture,
  portalCookieHeaders,
  portalLogin,
  uniqueSuffix,
  type PortalSession as PortalCustomerSession,
} from '@open-mercato/core/helpers/integration/customerAccountsFixtures'
import { DISTRIBUTOR_FEATURES } from '../lib/roleFeatures'

/**
 * TC-DIST-NEXT-ACTIONS-001: `GET /api/distributor_workspace/dashboard/next-actions`.
 *
 * Every test here builds the rows it asserts on. That is not tidiness: this route aggregates
 * whatever the tenant happens to hold, so a test that only read it would assert the shape of
 * one machine's demo database and would pass on a fresh install by verifying HTTP 200 against
 * `{ actions: [] }` (.ai/qa/AGENTS.md — never rely on seeded data being present). The counts
 * are therefore always read before and after a fixture and compared as a DELTA, which is what
 * makes the assertions hold on a database that already holds other quotes and orders.
 *
 * The two decisive tests are the last two:
 *  - a quote that carries no status at all, the shape a portal request used to land in, must
 *    still reach the operator's list; every bucket reading `sales_quotes` by an exact status
 *    value used to skip such a row forever while the customer waited;
 *  - a request submitted through the customer PORTAL must arrive with a status assigned and
 *    show up in the same bucket. That is the path a customer actually takes, and nothing
 *    covered it before.
 *
 * The staff sessions are built here rather than borrowed from the seeded demo accounts: a
 * throwaway role carrying `DISTRIBUTOR_FEATURES` is the same authorization surface the
 * `distributor` role grants, minus the dependency on `mercato distributor_workspace seed-*`.
 */

export const integrationMeta = {
  description:
    'Distributor next-actions dashboard route: auth, payload shape, ranking against self-made fixtures, statusless quote requests, and a quote request submitted through the customer portal',
  requiredModules: ['distributor_workspace', 'sales', 'wms', 'dashboards', 'customer_accounts', 'catalog', 'pricing_engine'],
}

const NEXT_ACTIONS_API = '/api/distributor_workspace/dashboard/next-actions'
const PORTAL_REQUESTS_API = '/api/distributor_workspace/portal/requests'
const QUOTES_API = '/api/sales/quotes'
const ORDERS_API = '/api/sales/orders'
const VARIANTS_API = '/api/catalog/variants'
const PURCHASE_POSITIONS_API = '/api/pricing/purchase-positions'
const FIXTURE_PASSWORD = 'StrongSecret123!'

/** Restated, not imported: a test that read the route's own metadata would agree with any
 *  gate, including one that had quietly dropped a feature. */
const REQUIRED_FEATURES = [
  'dashboards.view',
  'wms.view',
  'sales.quotes.view',
  'sales.orders.view',
  'distributor_workspace.widgets.next-actions',
]

const TONES = ['error', 'warning', 'info']

/** The kinds the route may emit, and the screen each one promises. */
const KIND_HREF: Record<string, string> = {
  expiringStock: '/backend/wms/lots?expiryWindow=expiringSoon',
  quoteRequestsToAnswer: '/backend/sales/quotes',
  quotesAwaitingReply: '/backend/sales/quotes',
  ordersToFulfil: '/backend/sales/orders',
  criticalStock: '/backend/wms/inventory?lowStock=belowSafety',
}

const QUOTE_REQUESTS_KIND = 'quoteRequestsToAnswer'
const ORDERS_KIND = 'ordersToFulfil'

/**
 * The ranking rule, restated from `lib/nextActions.ts` rather than imported.
 *
 * Importing the table would make this agree with any ranking, including an inverted one. The
 * numbers below are the contract the widget's whole purpose rests on: score = irreversibility
 * weight * (horizon + deadline pressure), pressure capped at the horizon.
 */
const IRREVERSIBILITY_WEIGHT: Record<string, number> = {
  expiringStock: 100,
  quoteRequestsToAnswer: 85,
  quotesAwaitingReply: 70,
  ordersToFulfil: 50,
  criticalStock: 40,
}

const URGENCY_HORIZON_DAYS = 14

/** The status a portal submission must arrive with, restated from `api/portal/requests/route.ts`. */
const PORTAL_INITIAL_STATUS = 'pending_approval'

type NextAction = {
  kind: string
  count: number
  href: string
  tone: string
  deadlineAt: string | null
  daysUntilDeadline: number | null
  amount: number | null
  currencyCode: string | null
}

type NextActionsPayload = { generatedAt: string; actions: NextAction[] }

type SessionFixture = {
  token: string
  roleId: string | null
  userId: string | null
}

type PortalActorFixture = {
  session: PortalCustomerSession
  userId: string | null
  roleId: string | null
  companyEntityId: string | null
}

async function createSession(
  request: APIRequestContext,
  adminToken: string,
  input: { slug: string; features: string[] },
): Promise<SessionFixture> {
  const scope = getTokenScope(adminToken)
  expect(scope.tenantId && scope.organizationId, 'admin token should carry a tenant and an organization').toBeTruthy()
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const fixture: SessionFixture = { token: '', roleId: null, userId: null }
  fixture.roleId = await createRoleFixture(request, adminToken, {
    name: `TC-DIST-NEXT-ACTIONS-001 ${input.slug} ${suffix}`,
    tenantId: scope.tenantId,
  })
  await setRoleAclFeatures(request, adminToken, {
    roleId: fixture.roleId,
    features: input.features,
    organizations: [scope.organizationId],
  })
  const email = `tc-dist-next-actions-001-${input.slug}-${suffix}@example.com`
  fixture.userId = await createUserFixture(request, adminToken, {
    email,
    password: FIXTURE_PASSWORD,
    organizationId: scope.organizationId,
    roles: [fixture.roleId],
    name: `TC DIST NEXT ACTIONS 001 ${input.slug}`,
  })
  fixture.token = await getAuthToken(request, email, FIXTURE_PASSWORD)
  return fixture
}

async function destroySession(
  request: APIRequestContext,
  adminToken: string,
  fixture: SessionFixture | null,
): Promise<void> {
  if (!fixture) return
  await deleteUserIfExists(request, adminToken, fixture.userId)
  await deleteRoleIfExists(request, adminToken, fixture.roleId)
}

async function describeFailure(response: APIResponse): Promise<string> {
  return `${response.status()} ${(await response.text()).slice(0, 500)}`
}

async function readActions(request: APIRequestContext, token: string): Promise<NextActionsPayload> {
  const response = await apiRequest(request, 'GET', NEXT_ACTIONS_API, { token })
  expect(response.ok(), `GET ${NEXT_ACTIONS_API} should succeed: ${await describeFailure(response)}`).toBe(true)
  const body = await readJsonSafe<NextActionsPayload>(response)
  expect(body, 'the route should answer with a JSON object').not.toBeNull()
  const payload = body as NextActionsPayload
  expect(Number.isFinite(Date.parse(payload.generatedAt)), `generatedAt should be an instant, got ${payload.generatedAt}`).toBe(true)
  expect(Array.isArray(payload.actions), 'actions should be an array, even when there is nothing to do').toBe(true)
  return payload
}

function findAction(payload: NextActionsPayload, kind: string): NextAction | null {
  return payload.actions.find((action) => action.kind === kind) ?? null
}

function countFor(payload: NextActionsPayload, kind: string): number {
  return findAction(payload, kind)?.count ?? 0
}

function deadlinePressure(daysUntilDeadline: number | null): number {
  if (daysUntilDeadline === null) return 0
  if (daysUntilDeadline < 0) return URGENCY_HORIZON_DAYS
  if (daysUntilDeadline >= URGENCY_HORIZON_DAYS) return 0
  return URGENCY_HORIZON_DAYS - daysUntilDeadline
}

function urgencyScore(action: NextAction): number {
  return IRREVERSIBILITY_WEIGHT[action.kind] * (URGENCY_HORIZON_DAYS + deadlinePressure(action.daysUntilDeadline))
}

function describeAction(action: NextAction): string {
  return `${action.kind}(count=${action.count}, days=${action.daysUntilDeadline}, amount=${action.amount}, score=${urgencyScore(action)})`
}

function assertActionInvariants(payload: NextActionsPayload): void {
  const kinds = payload.actions.map((action) => action.kind)
  expect(new Set(kinds).size, `each kind may appear at most once, got ${kinds.join(', ')}`).toBe(kinds.length)

  for (const action of payload.actions) {
    expect(Object.keys(KIND_HREF), `unknown action kind ${action.kind}`).toContain(action.kind)
    expect(action.href, `${action.kind} should link to its own screen`).toBe(KIND_HREF[action.kind])
    expect(TONES, `${action.kind} tone should be a design-system tone, got ${action.tone}`).toContain(action.tone)
    // A zero here would put a row on the operator's list with nothing behind it.
    expect(Number.isInteger(action.count) && action.count > 0, `${action.kind} count should be a positive integer, got ${action.count}`).toBe(true)
    // The widget only renders the deadline when it has both halves, so the route must never
    // send one without the other.
    expect(
      action.deadlineAt === null,
      `${action.kind}: deadlineAt and daysUntilDeadline must be present or absent together`,
    ).toBe(action.daysUntilDeadline === null)
    if (action.deadlineAt !== null) {
      expect(Number.isFinite(Date.parse(action.deadlineAt)), `${action.kind} deadlineAt should be an instant`).toBe(true)
      expect(Number.isInteger(action.daysUntilDeadline), `${action.kind} daysUntilDeadline should be a whole number of days`).toBe(true)
    }
    if (action.amount !== null) {
      expect(Number.isFinite(action.amount), `${action.kind} amount should be a finite number`).toBe(true)
    }
    // A summed amount with no currency is the mixed-currency case and is allowed; a currency
    // code with no amount would label nothing.
    if (action.currencyCode !== null) {
      expect(action.amount, `${action.kind} carries a currency with no amount to label`).not.toBeNull()
    }
  }
}

/**
 * The list must be ordered by the rule above: score descending, then value, then count. The
 * operator reads it top-down and opens the first row, so an inverted sort is the one defect
 * that makes the whole widget lie while every individual row stays correct.
 */
function assertRankedOrder(payload: NextActionsPayload): void {
  for (let index = 1; index < payload.actions.length; index += 1) {
    const before = payload.actions[index - 1]
    const after = payload.actions[index]
    const beforeScore = urgencyScore(before)
    const afterScore = urgencyScore(after)
    expect(
      beforeScore,
      `${describeAction(before)} is listed above ${describeAction(after)} but scores lower`,
    ).toBeGreaterThanOrEqual(afterScore)
    if (beforeScore !== afterScore) continue
    const beforeAmount = before.amount ?? 0
    const afterAmount = after.amount ?? 0
    expect(
      beforeAmount,
      `${describeAction(before)} and ${describeAction(after)} score alike, so the larger value comes first`,
    ).toBeGreaterThanOrEqual(afterAmount)
    if (beforeAmount !== afterAmount) continue
    expect(
      before.count,
      `${describeAction(before)} and ${describeAction(after)} tie on score and value, so the larger count comes first`,
    ).toBeGreaterThanOrEqual(after.count)
  }
}

/**
 * A customer able to submit a basket through the portal, built from nothing.
 *
 * The portal authenticates with its own cookie pair, authorizes against `customerRbacService`
 * and prices every basket server-side, so the fixture needs all three: an owned company to buy
 * for, a customer role carrying the portal features, and a product the pricing engine has a
 * cost basis for (`PricingPurchasePosition` — a product without one is not in the portal
 * catalog at all, see `lib/portalCatalog.ts`).
 */
async function createPortalActor(
  request: APIRequestContext,
  adminToken: string,
): Promise<PortalActorFixture> {
  const scope = getTokenScope(adminToken)
  const companyEntityId = await createCustomerCompanyFixture(
    request,
    adminToken,
    `TC-DIST-NEXT-ACTIONS-001 Buyer ${uniqueSuffix()}`,
  )
  const role = await createCustomerRoleFixture(request, adminToken, {
    features: ['portal.catalog.view', 'portal.quotes.request'],
  })
  const user = await createCustomerUserFixture(request, adminToken, {
    password: customerTestPassword(),
    roleIds: [role.id],
    customerEntityId: companyEntityId,
  })
  const session = await portalLogin(request, {
    email: user.email,
    password: user.password,
    tenantId: scope.tenantId,
  })
  return { session, userId: user.id, roleId: role.id, companyEntityId }
}

async function destroyPortalActor(
  request: APIRequestContext,
  adminToken: string,
  actor: PortalActorFixture | null,
): Promise<void> {
  if (!actor) return
  await deleteCustomerUserFixture(request, adminToken, actor.userId)
  await deleteCustomerRoleFixture(request, adminToken, actor.roleId)
  await deleteCustomerCompanyFixture(request, adminToken, actor.companyEntityId)
}

async function readQuoteStatus(
  request: APIRequestContext,
  token: string,
  quoteId: string,
): Promise<string | null> {
  const response = await apiRequest(request, 'GET', `${QUOTES_API}?ids=${encodeURIComponent(quoteId)}`, { token })
  expect(response.ok(), `GET ${QUOTES_API} should succeed: ${await describeFailure(response)}`).toBe(true)
  const body = await readJsonSafe<{ items?: Array<{ id: string; status?: string | null }> }>(response)
  const row = body?.items?.find((item) => item.id === quoteId) ?? null
  expect(row, `the created quote ${quoteId} should be readable by staff`).not.toBeNull()
  return row?.status ?? null
}

test.describe('TC-DIST-NEXT-ACTIONS-001: distributor next actions route', () => {
  test('refuses a request that carries no session', async ({ request }) => {
    const response = await request.get(NEXT_ACTIONS_API)

    expect(response.status(), `an anonymous caller must not read the operator's to-do list: ${await describeFailure(response)}`).toBe(401)
    const body = await readJsonSafe<{ error?: string; actions?: unknown }>(response)
    expect(typeof body?.error, 'the 401 should name the failure').toBe('string')
    expect(body?.actions, 'a refused request must not leak any action data').toBeUndefined()
  })

  test('refuses a session that lacks the features the route reads with', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    let session: SessionFixture | null = null

    try {
      // `dashboards.view` alone: enough to open the dashboard, not enough to read stock or
      // sales documents through it.
      session = await createSession(request, adminToken, { slug: 'nofeat', features: ['dashboards.view'] })

      const response = await apiRequest(request, 'GET', NEXT_ACTIONS_API, { token: session.token })

      expect(response.status(), `a dashboards-only session must be refused: ${await describeFailure(response)}`).toBe(403)
      const body = await readJsonSafe<{ error?: string; requiredFeatures?: string[]; actions?: unknown }>(response)
      expect(typeof body?.error, 'the 403 should name the failure').toBe('string')
      expect(body?.requiredFeatures?.slice().sort(), 'the 403 should name every feature the route needs').toEqual(
        REQUIRED_FEATURES.slice().sort(),
      )
      expect(body?.actions, 'a refused request must not leak any action data').toBeUndefined()
    } finally {
      await destroySession(request, adminToken, session)
    }
  })

  /**
   * Two buckets of different weight, both created here, so the ranking is asserted rather
   * than observed.
   *
   * `quoteRequestsToAnswer` carries weight 85 and its deadline is the oldest submission plus
   * the one-day response window, which for a quote created inside this test is already today
   * — so its pressure is at the cap and its score is 85 * (14 + 14) = 2380. `ordersToFulfil`
   * carries weight 50, so its score cannot exceed 50 * 28 = 1400 no matter what the rest of
   * the database holds. The expected order is therefore fixed, not a property of this machine.
   */
  test('ranks a waiting quote request above an order to fulfil, on fixtures it creates itself', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    let session: SessionFixture | null = null
    let quoteId: string | null = null
    let orderId: string | null = null

    try {
      session = await createSession(request, adminToken, { slug: 'dist', features: [...DISTRIBUTOR_FEATURES] })

      const before = await readActions(request, session.token)
      const quoteBaseline = countFor(before, QUOTE_REQUESTS_KIND)
      const orderBaseline = countFor(before, ORDERS_KIND)

      quoteId = await createSalesQuoteFixture(request, session.token, 'USD')
      orderId = await createSalesOrderFixture(request, session.token, 'USD')

      const payload = await readActions(request, session.token)
      assertActionInvariants(payload)
      assertRankedOrder(payload)

      expect(
        payload.actions.length,
        `the list must not be empty once this test has created work: ${JSON.stringify(payload.actions)}`,
      ).toBeGreaterThanOrEqual(2)
      expect(countFor(payload, QUOTE_REQUESTS_KIND), 'the new quote request should add one to its bucket').toBe(
        quoteBaseline + 1,
      )
      expect(countFor(payload, ORDERS_KIND), 'the new order should add one to its bucket').toBe(orderBaseline + 1)

      const kinds = payload.actions.map((action) => action.kind)
      expect(
        kinds.indexOf(QUOTE_REQUESTS_KIND),
        `a customer waiting for an answer outranks picking an order that is already paid for: ${kinds.join(' > ')}`,
      ).toBeLessThan(kinds.indexOf(ORDERS_KIND))
    } finally {
      await deleteSalesEntityIfExists(request, session?.token ?? adminToken, ORDERS_API, orderId)
      await deleteSalesEntityIfExists(request, session?.token ?? adminToken, QUOTES_API, quoteId)
      await destroySession(request, adminToken, session)
    }
  })

  test('counts a quote request that carries no status, the way a portal submission used to arrive', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    let session: SessionFixture | null = null
    let quoteId: string | null = null

    try {
      session = await createSession(request, adminToken, { slug: 'quote', features: [...DISTRIBUTOR_FEATURES] })

      const before = await readActions(request, session.token)
      const baseline = countFor(before, QUOTE_REQUESTS_KIND)

      // `POST /api/sales/quotes` without a `statusEntryId` leaves `status` NULL — exactly the
      // row the customer portal used to create. Nothing else about the fixture matters.
      quoteId = await createSalesQuoteFixture(request, session.token, 'USD')
      expect(await readQuoteStatus(request, session.token, quoteId), 'this fixture is the statusless shape').toBeNull()

      const after = await readActions(request, session.token)
      assertActionInvariants(after)

      const action = findAction(after, QUOTE_REQUESTS_KIND)
      expect(action, 'a quote request with no status must reach the operator as an action').not.toBeNull()
      expect(countFor(after, QUOTE_REQUESTS_KIND), 'the new request should add exactly one to the bucket').toBe(baseline + 1)
      expect((action as NextAction).href).toBe(KIND_HREF[QUOTE_REQUESTS_KIND])
      // The clock on an unanswered request is the submission plus the response window, so the
      // bucket always carries a deadline once it holds a row.
      expect((action as NextAction).deadlineAt, 'an unanswered request must come with a deadline').not.toBeNull()

      // The quote we created is a request to answer, not a quote gone quiet: a row must never
      // be counted by both buckets at once.
      const silent = findAction(after, 'quotesAwaitingReply')
      expect(silent?.count ?? 0, 'a statusless quote must not also count as awaiting a customer reply').toBe(
        findAction(before, 'quotesAwaitingReply')?.count ?? 0,
      )
    } finally {
      await deleteSalesEntityIfExists(request, session?.token ?? adminToken, QUOTES_API, quoteId)
      await destroySession(request, adminToken, session)
    }
  })

  /**
   * The path a customer actually takes, end to end.
   *
   * `POST /api/distributor_workspace/portal/requests` assigns `pending_approval` because a
   * NULL status is invisible to every screen that filters sales documents by status value.
   * Asserting the status on the created document AND the resulting row on the operator's list
   * is what pins both halves: the write that assigns it, and the query that reads it back.
   */
  test('turns a basket submitted in the portal into a statused quote on the operator list', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    let session: SessionFixture | null = null
    let actor: PortalActorFixture | null = null
    let productId: string | null = null
    let variantId: string | null = null
    let purchasePositionId: string | null = null
    let quoteId: string | null = null

    try {
      session = await createSession(request, adminToken, { slug: 'portal', features: [...DISTRIBUTOR_FEATURES] })

      const suffix = uniqueSuffix()
      const sku = `TC-DIST-NA-001-${suffix}`.slice(0, 32)
      productId = await createProductFixture(request, session.token, {
        title: `TC-DIST-NEXT-ACTIONS-001 Sellable ${suffix}`,
        sku,
      })
      variantId = await createVariantFixture(request, session.token, {
        productId,
        name: 'Default',
        sku: `${sku}-V`,
        isDefault: true,
      })

      // Without a purchase position the product has no cost basis, so it is not in the portal
      // catalog and the basket would be refused as an unknown product.
      const positionResponse = await apiRequest(request, 'POST', PURCHASE_POSITIONS_API, {
        token: session.token,
        data: {
          catalogProductId: productId,
          catalogVariantId: variantId,
          sku,
          annualVolume: '1200',
          lastDeliveryUnitCost: '18.5000',
          lastDeliveryQuantity: '100',
          lastDeliveryAt: new Date().toISOString(),
        },
      })
      expect(
        positionResponse.ok(),
        `POST ${PURCHASE_POSITIONS_API} should succeed: ${await describeFailure(positionResponse)}`,
      ).toBe(true)
      const positionBody = await readJsonSafe<{ id?: string }>(positionResponse)
      purchasePositionId = positionBody?.id ?? null
      expect(purchasePositionId, 'the purchase position should come back with an id').not.toBeNull()

      actor = await createPortalActor(request, adminToken)

      const before = await readActions(request, session.token)
      const baseline = countFor(before, QUOTE_REQUESTS_KIND)

      const submission = await request.post(PORTAL_REQUESTS_API, {
        headers: portalCookieHeaders(actor.session, { 'Content-Type': 'application/json' }),
        data: { kind: 'quote', lines: [{ productId, quantity: 4 }] },
      })
      expect(
        submission.status(),
        `the portal must accept a priced basket: ${await describeFailure(submission)}`,
      ).toBe(201)
      const submissionBody = await readJsonSafe<{ ok?: boolean; kind?: string; documentId?: string }>(submission)
      expect(submissionBody?.ok, 'the portal should report success').toBe(true)
      expect(submissionBody?.kind, 'a quote request must not be turned into an order').toBe('quote')
      quoteId = submissionBody?.documentId ?? null
      expect(quoteId, 'the portal should answer with the created document id').not.toBeNull()

      expect(
        await readQuoteStatus(request, session.token, quoteId as string),
        'a portal submission must arrive with a status, or no status filter will ever show it',
      ).toBe(PORTAL_INITIAL_STATUS)

      const after = await readActions(request, session.token)
      assertActionInvariants(after)
      assertRankedOrder(after)

      const action = findAction(after, QUOTE_REQUESTS_KIND)
      expect(action, 'a portal request must reach the operator as an action').not.toBeNull()
      expect(
        countFor(after, QUOTE_REQUESTS_KIND),
        'the portal request should add exactly one to the bucket',
      ).toBe(baseline + 1)
      expect((action as NextAction).deadlineAt, 'an unanswered portal request must come with a deadline').not.toBeNull()
    } finally {
      await deleteSalesEntityIfExists(request, session?.token ?? adminToken, QUOTES_API, quoteId)
      await destroyPortalActor(request, adminToken, actor)
      await deleteGeneralEntityIfExists(request, session?.token ?? adminToken, PURCHASE_POSITIONS_API, purchasePositionId)
      await deleteGeneralEntityIfExists(request, session?.token ?? adminToken, VARIANTS_API, variantId)
      await deleteCatalogProductIfExists(request, session?.token ?? adminToken, productId)
      await destroySession(request, adminToken, session)
    }
  })
})
