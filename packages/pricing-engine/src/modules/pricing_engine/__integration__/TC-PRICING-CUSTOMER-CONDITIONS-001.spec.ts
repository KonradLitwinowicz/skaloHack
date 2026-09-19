import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/modules/core/__integration__/helpers/authFixtures'
import {
  createCompanyFixture,
  deleteEntityIfExists,
} from '@open-mercato/core/modules/core/__integration__/helpers/crmFixtures'
import { getTokenContext } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures'
import {
  expectConflictBody,
  putWithLock,
  readUpdatedAt,
} from '@open-mercato/core/modules/core/__integration__/helpers/optimisticLockUi'
import { OPTIMISTIC_LOCK_CONFLICT_ERROR } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'

/**
 * TC-PRICING-CUSTOMER-CONDITIONS-001: the write channel for a customer's pricing terms.
 *
 * `pricing_customer_profiles` holds the six fields that steer every quote for one customer, and
 * until `/api/pricing/customer-profiles` existed the only way to change any of them was SQL — a
 * sales rep who negotiated a price had nowhere to put it. This spec covers that route end to end
 * plus the preview that goes with it, `/api/pricing/customer-pricing-impact`.
 *
 * The decisive assertion is the one about the negotiated price and the minimum-margin floor. The
 * engine does NOT reject a price below the floor: `lib/components/guardrails.ts` takes the
 * negotiated price as the target and then `applyNormalFloors` RAISES it, adding
 * `pricing_engine.warnings.minMarginEnforced`. So neither the route nor the preview may refuse a
 * cheap price — they have to report what the engine will actually quote. A test that asserted a
 * 400 here would be pinning a behaviour the engine does not have.
 *
 * Every fixture is created through the API and removed in `finally`; nothing here reads a seeded
 * or demo row, and the 40 profiles that exist in the reference dataset all carry
 * `negotiated_prices = NULL`, so no assertion could have leaned on them anyway.
 */

export const integrationMeta = {
  description:
    'Customer pricing terms: profile CRUD, negotiated-price validation, optimistic lock and the engine-impact preview',
  requiredModules: ['pricing_engine', 'catalog', 'customers', 'auth'],
}

const PROFILES_API = '/api/pricing/customer-profiles'
const IMPACT_API = '/api/pricing/customer-pricing-impact'
const GUARDRAILS_API = '/api/pricing/guardrails'
const MIN_MARGIN_ENFORCED_WARNING = 'pricing_engine.warnings.minMarginEnforced'
const DUPLICATE_PROFILE_CODE = 'pricing_customer_profile_exists'

const UNIT_COST = '20.0000'
const TARGET_MARKUP = '80.0000'
const MIN_MARGIN_PERCENT = '25'
/** Far under any floor a cost of 20 with a 25% minimum margin can produce. */
const CHEAP_PRICE = '5'
/** Far over it, so the engine has no reason to touch the number. */
const RICH_PRICE = '500'
const VALID_FROM = '2020-01-01T00:00:00.000Z'

type ProfileRow = {
  id: string
  organizationId: string
  tenantId: string
  createdAt: string | null
  updatedAt: string | null
  customerId: string
  customerGroupCode: string | null
  deliveryZoneCode: string | null
  defaultOrderScenarioCode: string | null
  negotiatedPrices: Record<string, string>
  negotiatedPriceCount: number
  negotiatedPriceExpiresAt: string | null
  negotiatedPricesInForce: boolean
}

type ProfileListBody = { items?: ProfileRow[]; total?: number; page?: number; pageSize?: number }

type ValidationIssue = { path?: unknown[]; message?: string; code?: string }

type ValidationBody = { error?: string; details?: ValidationIssue[] }

type DuplicateBody = { error?: string; code?: string; existingId?: string; deleted?: boolean }

type PriceFacet = {
  unitPriceNet: string
  marginOnPricePercent: string
  markupOnCostPercent: string
}

type ImpactBody = {
  available: boolean
  unavailableReasonKeys: string[]
  currencyCode: string
  amountsAreNetOfVat: boolean
  unitCostNet: string | null
  negotiatedPrice: {
    proposedUnitPriceNet: string
    appliesToQuote: boolean
    precedence: string | null
    ignoredReasonKey: string | null
    storedUnitPriceNet: string | null
  }
  enginePrice: PriceFacet | null
  proposedPrice: PriceFacet | null
  appliedPrice: (PriceFacet & { raisedFromProposedPrice: boolean }) | null
  floor: {
    unitPriceNet: string | null
    marginOnPricePercent: string | null
    unavailableReasonKey: string | null
    guardrailCode: string | null
    minMarginPercent: string | null
    floorPriceParam: string | null
  } | null
  warnings: string[]
  engineWarnings: string[]
}

type ProfileInput = {
  customerId: string
  customerGroupCode?: string | null
  deliveryZoneCode?: string | null
  defaultOrderScenarioCode?: string | null
  negotiatedPrices?: Record<string, unknown> | null
  negotiatedPriceExpiresAt?: string | null
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

/**
 * The tab on a customer card asks exactly this question — one customer, one profile — so it is the
 * access pattern worth pinning rather than an unfiltered listing.
 */
async function readProfileByCustomer(
  request: APIRequestContext,
  token: string,
  customerId: string,
): Promise<ProfileRow | null> {
  const response = await apiRequest(
    request,
    'GET',
    `${PROFILES_API}?customerId=${encodeURIComponent(customerId)}&pageSize=1`,
    { token },
  )
  expect(response.status(), `GET ${PROFILES_API}?customerId= should be 200`).toBe(200)
  const body = (await response.json()) as ProfileListBody
  return (body.items ?? [])[0] ?? null
}

async function readImpact(
  request: APIRequestContext,
  token: string,
  params: Record<string, string>,
): Promise<ImpactBody> {
  const query = new URLSearchParams(params).toString()
  const response = await apiRequest(request, 'GET', `${IMPACT_API}?${query}`, { token })
  expect(response.status(), `GET ${IMPACT_API} should be 200: ${await response.text()}`).toBe(200)
  return (await response.json()) as ImpactBody
}

/**
 * Asserts a malformed price book is refused with an issue that names the offending ENTRY, not just
 * the field — a rep pricing thirty products has to be told which row is wrong.
 *
 * `message` is only asserted where the module actually controls it. For a bad map KEY zod 4.4.3
 * raises `invalid_key` and discards the key schema's own message, so the issue carries zod's
 * built-in English text rather than the module's i18n key; pinning that string here would freeze a
 * defect (see the spec risks), and pinning the i18n key would fail against today's behaviour.
 */
async function expectProfileRejected(
  request: APIRequestContext,
  token: string,
  data: ProfileInput,
  expectation: { path: string; message?: string; code?: string },
): Promise<void> {
  const response = await apiRequest(request, 'POST', PROFILES_API, { token, data })
  expect(response.status(), `POST ${PROFILES_API} should reject ${expectation.path}`).toBe(400)
  const body = (await response.json()) as ValidationBody
  expect(body.error).toBe('Invalid input')
  const issues = body.details ?? []
  const matching = issues.find((issue) => (issue.path ?? []).join('.') === expectation.path)
  expect(
    matching,
    `the rejection should name the offending entry at ${expectation.path}, got ${JSON.stringify(issues)}`,
  ).toBeTruthy()
  if (expectation.code) expect(matching?.code).toBe(expectation.code)
  // Where the module owns the message it ships an i18n KEY, so the screen can translate it; a
  // ready-made sentence there would be a regression, not a cosmetic difference.
  if (expectation.message) expect(matching?.message).toBe(expectation.message)
}

/**
 * Gate on the OLDEST pipeline route, not on the one under test.
 *
 * Two environment conditions make a pricing preview impossible for reasons that have nothing to do
 * with customer terms, and both have to be told apart from a defect in this feature:
 *
 *  - 409: the engine refuses to price without a `pricing_supplier_profile` for the tenant. That row
 *    comes from the module's own tenant setup, `mercato pricing_engine purge-demo` deletes it, and
 *    this spec has no API to create one.
 *  - 500: everything the pipeline needs is loaded by one shared `loadPricingInputs`, so a single
 *    broken loader takes down quote, simulate, advise and the preview together.
 *
 * `POST /api/pricing/quote` is the control. If IT cannot price a line, no assertion about the
 * preview would be measuring this feature; if it CAN and the preview still fails, that is a real
 * defect and this test must report it rather than skip.
 */
async function skipUnlessPricingPipelineWorks(
  request: APIRequestContext,
  token: string,
  customerId: string,
  productId: string,
): Promise<void> {
  const response = await apiRequest(request, 'POST', '/api/pricing/quote', {
    token,
    data: { customerId, lines: [{ productId, quantity: '1' }] },
  })
  if (response.ok()) return
  if (response.status() === 409) {
    test.skip(
      true,
      'pricing_engine is not initialised for this tenant (no supplier profile). Run: yarn mercato pricing_engine seed --tenant <t> --org <o>',
    )
    return
  }
  test.skip(
    true,
    `the shared pricing pipeline is unavailable in this environment: POST /api/pricing/quote answered ${response.status()} ${await response.text()}. Every pipeline route fails together, so this is not about customer pricing terms.`,
  )
}

/**
 * `updated_at` has millisecond resolution and MikroORM only issues an UPDATE when a column
 * actually changes, so a bump has to change a field AND be checked for having moved the token.
 * Asserting a conflict against a token that never advanced would be a no-op dressed as a test.
 */
async function bumpUntilChanged(
  request: APIRequestContext,
  token: string,
  id: string,
  customerId: string,
  previous: string,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await apiRequest(request, 'PUT', PROFILES_API, {
      token,
      data: { id, customerId, customerGroupCode: `qa-bump-${attempt}` },
    })
    expect(response.status(), 'a header-less PUT takes the additive path and must succeed').toBe(200)
    const current = await readUpdatedAt(request, token, PROFILES_API, id)
    if (current !== previous) return current
  }
  throw new Error('[internal] customer profile updated_at did not advance across five writes')
}

test.describe('TC-PRICING-CUSTOMER-CONDITIONS-001: customer pricing terms', () => {
  test('refuses an anonymous call and separates pricing.params.read from pricing.params.write', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const { organizationId, tenantId } = getTokenContext(adminToken)
    expect(organizationId, 'admin token should carry an organization id').toBeTruthy()

    const stamp = Date.now()
    const password = 'Secret123!'
    const viewerEmail = `qa.pricing.terms.view.${stamp}@example.com`
    const readerEmail = `qa.pricing.terms.read.${stamp}@example.com`
    let viewerRoleId: string | null = null
    let readerRoleId: string | null = null
    let viewerUserId: string | null = null
    let readerUserId: string | null = null

    try {
      // A context of its own, deliberately: `getAuthToken` above logs in through the shared
      // `request` fixture and the session COOKIE it receives stays in that fixture's jar, so a
      // header-less call on it is not anonymous at all — it authenticates by cookie and returns
      // 200. Asserting 401 on the shared fixture would have looked like a passing auth test
      // measuring nothing.
      const anonymousContext = await playwright.request.newContext({ baseURL })
      try {
        const anonymous = await anonymousContext.get(`${PROFILES_API}?pageSize=1`)
        expect(anonymous.status(), 'a call with no session at all must be 401').toBe(401)
      } finally {
        await anonymousContext.dispose()
      }

      viewerRoleId = await createRoleFixture(request, adminToken, {
        name: `QA Pricing Terms Viewer ${stamp}`,
        tenantId,
      })
      // Someone who may open the pricing module but was never granted the parameters. The profile
      // carries a customer's commercial terms, so "can see the module" must not be enough.
      await setRoleAclFeatures(request, adminToken, { roleId: viewerRoleId, features: ['pricing.view'] })
      viewerUserId = await createUserFixture(request, adminToken, {
        email: viewerEmail,
        password,
        organizationId,
        roles: [viewerRoleId],
        name: `QA Pricing Terms Viewer ${stamp}`,
      })

      const viewerToken = await getAuthToken(request, viewerEmail, password)
      const viewerList = await apiRequest(request, 'GET', `${PROFILES_API}?pageSize=1`, { token: viewerToken })
      expect(viewerList.status(), 'a session without pricing.params.read must not list pricing terms').toBe(403)
      const viewerDenial = (await viewerList.json()) as { requiredFeatures?: string[] }
      expect(viewerDenial.requiredFeatures).toContain('pricing.params.read')

      readerRoleId = await createRoleFixture(request, adminToken, {
        name: `QA Pricing Terms Reader ${stamp}`,
        tenantId,
      })
      await setRoleAclFeatures(request, adminToken, {
        roleId: readerRoleId,
        features: ['pricing.params.read'],
      })
      readerUserId = await createUserFixture(request, adminToken, {
        email: readerEmail,
        password,
        organizationId,
        roles: [readerRoleId],
        name: `QA Pricing Terms Reader ${stamp}`,
      })

      const readerToken = await getAuthToken(request, readerEmail, password)
      const readerList = await apiRequest(request, 'GET', `${PROFILES_API}?pageSize=1`, { token: readerToken })
      expect(readerList.status(), 'pricing.params.read should allow the list').toBe(200)

      const readerWrite = await apiRequest(request, 'POST', PROFILES_API, {
        token: readerToken,
        data: { customerId: crypto.randomUUID() },
      })
      expect(readerWrite.status(), 'a reader must not be able to agree a price').toBe(403)
      const writeDenial = (await readerWrite.json()) as { requiredFeatures?: string[] }
      expect(writeDenial.requiredFeatures).toContain('pricing.params.write')

      const readerPreview = await apiRequest(
        request,
        'GET',
        `${IMPACT_API}?customerId=${crypto.randomUUID()}&productId=${crypto.randomUUID()}&proposedUnitPriceNet=1`,
        { token: readerToken },
      )
      expect(
        readerPreview.status(),
        'the preview persists nothing, so pricing.params.read is enough to ask it',
      ).not.toBe(403)
    } finally {
      await deleteUserIfExists(request, adminToken, viewerUserId)
      await deleteUserIfExists(request, adminToken, readerUserId)
      await deleteRoleIfExists(request, adminToken, viewerRoleId)
      await deleteRoleIfExists(request, adminToken, readerRoleId)
    }
  })

  test('stores a negotiated price book, expires it as one, and refuses a malformed one', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const { organizationId, tenantId } = getTokenContext(token)
    const stamp = Date.now()
    let customerId: string | null = null
    let productId: string | null = null
    let profileId: string | null = null

    try {
      customerId = await createCompanyFixture(request, token, `QA Pricing Terms ${stamp}`)
      productId = await createJson(request, token, '/api/catalog/products', {
        title: `QA Pricing Terms product ${stamp}`,
        sku: `QA-TERMS-${stamp}`,
        description:
          'Long enough description for SEO checks in QA automation flows. This text keeps the create validation satisfied.',
      })

      profileId = await createJson(request, token, PROFILES_API, {
        customerId,
        customerGroupCode: `qa-group-${stamp}`,
      })

      const created = await readProfileByCustomer(request, token, customerId)
      expect(created, 'the new profile should be reachable by customerId').toBeTruthy()
      const row = created as ProfileRow
      expect(row.id).toBe(profileId)
      expect(row.customerId).toBe(customerId)
      expect(row.organizationId).toBe(organizationId)
      expect(row.tenantId).toBe(tenantId)
      expect(row.customerGroupCode).toBe(`qa-group-${stamp}`)
      expect(row.deliveryZoneCode).toBeNull()
      expect(row.defaultOrderScenarioCode).toBeNull()
      // Responses always carry an object, never null, so a form never has to null-check the map.
      expect(row.negotiatedPrices).toEqual({})
      expect(row.negotiatedPriceCount).toBe(0)
      expect(row.negotiatedPriceExpiresAt).toBeNull()
      expect(row.negotiatedPricesInForce).toBe(false)
      // CrudForm derives the optimistic-lock header from this field; without it every edit and
      // every delete on this screen would be unguarded.
      expect(typeof row.updatedAt, 'the row must expose updatedAt for the lock header').toBe('string')

      const secondProfile = await apiRequest(request, 'POST', PROFILES_API, {
        token,
        data: { customerId },
      })
      expect(secondProfile.status(), 'a customer may hold only one set of pricing terms').toBe(409)
      const duplicate = (await secondProfile.json()) as DuplicateBody
      expect(duplicate.code).toBe(DUPLICATE_PROFILE_CODE)
      expect(duplicate.existingId).toBe(profileId)
      expect(duplicate.deleted).toBe(false)

      const updateResponse = await apiRequest(request, 'PUT', PROFILES_API, {
        token,
        data: {
          id: profileId,
          customerId,
          customerGroupCode: `qa-group-${stamp}`,
          negotiatedPrices: { [productId]: '25.00' },
        },
      })
      expect(updateResponse.status(), `saving a negotiated price should be 200: ${await updateResponse.text()}`).toBe(200)
      expect(await updateResponse.json()).toEqual({ ok: true })

      const withPrice = await readProfileByCustomer(request, token, customerId)
      expect(withPrice?.negotiatedPrices).toEqual({ [productId]: '25.00' })
      expect(withPrice?.negotiatedPriceCount).toBe(1)
      expect(withPrice?.negotiatedPriceExpiresAt).toBeNull()
      expect(
        withPrice?.negotiatedPricesInForce,
        'a book with no expiry date is open-ended and must read as live',
      ).toBe(true)

      // One date wipes the WHOLE map — there is no per-product term — and an expired book is
      // otherwise invisibly inert, which is exactly the state a rep must be able to see.
      const expiredResponse = await apiRequest(request, 'PUT', PROFILES_API, {
        token,
        data: {
          id: profileId,
          customerId,
          negotiatedPrices: { [productId]: '25.00' },
          negotiatedPriceExpiresAt: '2020-06-01T00:00:00.000Z',
        },
      })
      expect(expiredResponse.status(), 'setting an expiry date should be 200').toBe(200)

      const expired = await readProfileByCustomer(request, token, customerId)
      expect(expired?.negotiatedPriceCount).toBe(1)
      expect(expired?.negotiatedPriceExpiresAt).toBe('2020-06-01T00:00:00.000Z')
      expect(expired?.negotiatedPricesInForce, 'a past expiry date must retire the whole book').toBe(false)

      await expectProfileRejected(
        request,
        token,
        { customerId: crypto.randomUUID(), negotiatedPrices: { 'not-a-product': '25.00' } },
        {
          // The offending KEY is the path, so a screen can point at the row the rep typed. Until
          // this route existed the column was written by hand in SQL, so a key that is not a
          // catalog product id shipped to the engine on every quote and could never be hit.
          path: 'negotiatedPrices.not-a-product',
          code: 'invalid_key',
        },
      )

      await expectProfileRejected(
        request,
        token,
        { customerId: crypto.randomUUID(), negotiatedPrices: { [productId]: 'dwadzieścia pięć' } },
        {
          path: `negotiatedPrices.${productId}`,
          message: 'pricing_engine.params.errors.negotiatedPriceInvalid',
        },
      )

      await expectProfileRejected(
        request,
        token,
        { customerId: crypto.randomUUID(), negotiatedPrices: { [productId]: '-1' } },
        {
          path: `negotiatedPrices.${productId}`,
          message: 'pricing_engine.params.errors.negotiatedPriceInvalid',
        },
      )

      await deleteById(request, token, PROFILES_API, profileId)
      expect(
        await readProfileByCustomer(request, token, customerId),
        'a deleted profile should leave the listing',
      ).toBeNull()
      profileId = null
    } finally {
      await deleteById(request, token, PROFILES_API, profileId)
      await deleteById(request, token, '/api/catalog/products', productId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', customerId)
    }
  })

  test('refuses a second write carrying a stale updated_at', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const stamp = Date.now()
    let customerId: string | null = null
    let profileId: string | null = null

    try {
      customerId = await createCompanyFixture(request, token, `QA Pricing Lock ${stamp}`)
      profileId = await createJson(request, token, PROFILES_API, { customerId })

      const originalUpdatedAt = await readUpdatedAt(request, token, PROFILES_API, profileId)
      const bumpedUpdatedAt = await bumpUntilChanged(
        request,
        token,
        profileId,
        customerId,
        originalUpdatedAt,
      )
      expect(bumpedUpdatedAt).not.toBe(originalUpdatedAt)

      const staleUpdate = await putWithLock(
        request,
        token,
        PROFILES_API,
        { id: profileId, customerId, customerGroupCode: 'qa-stale' },
        originalUpdatedAt,
      )
      const conflict = await expectConflictBody(staleUpdate)
      // The shared helper checks the status and the machine-readable `code`; `error` is not in its
      // return type, and it is the field the conflict bar keys its message off, so it is read here
      // from the same cached response body.
      const conflictError = (await staleUpdate.json()) as { error?: string }
      expect(conflictError.error).toBe(OPTIMISTIC_LOCK_CONFLICT_ERROR)
      expect(conflict.expectedUpdatedAt).toBe(originalUpdatedAt)
      expect(conflict.currentUpdatedAt).toBe(bumpedUpdatedAt)

      const stale = await readProfileByCustomer(request, token, customerId)
      expect(
        stale?.customerGroupCode,
        'a refused write must not have reached the row',
      ).not.toBe('qa-stale')

      const freshUpdate = await putWithLock(
        request,
        token,
        PROFILES_API,
        { id: profileId, customerId, customerGroupCode: 'qa-fresh' },
        bumpedUpdatedAt,
      )
      expect(freshUpdate.status(), 'a write carrying the current token must pass').toBe(200)
      const fresh = await readProfileByCustomer(request, token, customerId)
      expect(fresh?.customerGroupCode).toBe('qa-fresh')
    } finally {
      await deleteById(request, token, PROFILES_API, profileId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', customerId)
    }
  })

  test('previews what the engine will do with a negotiated price instead of rejecting it', async ({
    request,
  }) => {
    const token = await getAuthToken(request, 'admin')
    const stamp = Date.now()
    let customerId: string | null = null
    let productId: string | null = null
    let barrenProductId: string | null = null
    let deliveryZoneId: string | null = null
    let purchasePositionId: string | null = null
    let marginRuleId: string | null = null
    let guardrailId: string | null = null
    let profileId: string | null = null
    const guardrailCode = `qa-terms-${stamp}`
    const deliveryZoneCode = `qa-terms-zone-${stamp}`

    try {
      customerId = await createCompanyFixture(request, token, `QA Pricing Impact ${stamp}`)
      productId = await createJson(request, token, '/api/catalog/products', {
        title: `QA Pricing Impact product ${stamp}`,
        sku: `QA-IMPACT-${stamp}`,
        description:
          'Long enough description for SEO checks in QA automation flows. This text keeps the create validation satisfied.',
      })
      // Deliberately left without a purchase position, so the "no data" case is a real gap in the
      // configuration rather than a mocked failure.
      barrenProductId = await createJson(request, token, '/api/catalog/products', {
        title: `QA Pricing Impact barren ${stamp}`,
        sku: `QA-IMPACT-BARREN-${stamp}`,
        description:
          'Long enough description for SEO checks in QA automation flows. This text keeps the create validation satisfied.',
      })

      // Without a resolvable zone the logistics component contributes nothing and the preview
      // refuses to show margins at all — delivery is a real cost and a margin computed without it
      // would be flattered by the whole of it.
      deliveryZoneId = await createJson(request, token, '/api/pricing/delivery-zones', {
        code: deliveryZoneCode,
        label: `QA terms zone ${stamp}`,
        avgDistanceKm: '12',
        avgDriveMinutes: '30',
        typicalStops: 1,
        defaultVehicleCode: null,
      })
      purchasePositionId = await createJson(request, token, '/api/pricing/purchase-positions', {
        catalogProductId: productId,
        sku: `QA-IMPACT-${stamp}`,
        lastDeliveryUnitCost: UNIT_COST,
        annualVolume: '0',
        currentTierDiscount: '0',
      })
      marginRuleId = await createJson(request, token, '/api/pricing/margin-rules', {
        scope: 'product',
        scopeRefId: productId,
        targetMarkupPercent: TARGET_MARKUP,
        changeNote: `QA TC-PRICING-CUSTOMER-CONDITIONS-001 ${stamp}`,
        validFrom: VALID_FROM,
      })
      // Product-scoped, so it outranks whatever global guardrail the tenant happens to carry and
      // the floor under test is the one this spec configured.
      guardrailId = await createJson(request, token, '/api/pricing/guardrails', {
        code: guardrailCode,
        scope: 'product',
        scopeRefId: productId,
        minMarginPercent: MIN_MARGIN_PERCENT,
        floorPrice: null,
        negotiatedPricePrecedence: 'negotiated_wins',
        validFrom: VALID_FROM,
      })
      profileId = await createJson(request, token, PROFILES_API, {
        customerId,
        deliveryZoneCode,
      })

      await skipUnlessPricingPipelineWorks(request, token, customerId, productId)

      const cheap = await readImpact(request, token, {
        customerId,
        productId,
        proposedUnitPriceNet: CHEAP_PRICE,
        quantity: '10',
      })

      expect(cheap.available, `the preview should be computable: ${cheap.unavailableReasonKeys.join(', ')}`).toBe(true)
      expect(cheap.unavailableReasonKeys).toEqual([])
      expect(cheap.amountsAreNetOfVat, 'the engine has no VAT model; the flag says so').toBe(true)
      expect(cheap.negotiatedPrice.precedence).toBe('negotiated_wins')
      expect(cheap.negotiatedPrice.appliesToQuote).toBe(true)
      expect(cheap.negotiatedPrice.ignoredReasonKey).toBeNull()
      expect(cheap.floor?.guardrailCode).toBe(guardrailCode)

      const cheapFloor = Number(cheap.floor?.unitPriceNet)
      expect(
        Number.isFinite(cheapFloor),
        `a configured minimum margin must produce a floor, got ${String(cheap.floor?.unitPriceNet)}`,
      ).toBe(true)
      expect(
        cheapFloor,
        'the floor has to sit above the price the operator proposed, or this case proves nothing',
      ).toBeGreaterThan(Number(CHEAP_PRICE))

      // The heart of the whole feature: the engine does NOT refuse the cheap price. It raises it
      // and flags the quote, and the preview reports exactly that.
      expect(cheap.appliedPrice?.raisedFromProposedPrice).toBe(true)
      expect(cheap.appliedPrice?.unitPriceNet).toBe(cheap.floor?.unitPriceNet)
      expect(cheap.warnings).toContain(MIN_MARGIN_ENFORCED_WARNING)
      expect(
        cheap.engineWarnings,
        'the run without a negotiated price was never below the floor, so it must not carry the warning',
      ).not.toContain(MIN_MARGIN_ENFORCED_WARNING)
      // Margin is measured against the price and markup against the cost; the two fields are
      // deliberately not interchangeable and a screen must not collapse them into one "%".
      expect(Number(cheap.proposedPrice?.marginOnPricePercent)).toBeLessThan(0)
      expect(Number(cheap.appliedPrice?.marginOnPricePercent)).toBeGreaterThan(0)
      expect(Number(cheap.unitCostNet)).toBeGreaterThanOrEqual(Number(UNIT_COST))

      const rich = await readImpact(request, token, {
        customerId,
        productId,
        proposedUnitPriceNet: RICH_PRICE,
        quantity: '10',
      })
      expect(rich.available).toBe(true)
      expect(rich.appliedPrice?.raisedFromProposedPrice).toBe(false)
      expect(rich.warnings).not.toContain(MIN_MARGIN_ENFORCED_WARNING)
      expect(
        Math.abs(Number(rich.appliedPrice?.unitPriceNet) - Number(RICH_PRICE)),
        'a price above the floor may only move by the tenant rounding policy, never by a clamp',
      ).toBeLessThan(1)
      expect(
        Number(rich.appliedPrice?.unitPriceNet),
        'the negotiated price should have displaced the price the engine would have quoted',
      ).toBeGreaterThan(Number(rich.enginePrice?.unitPriceNet))

      // A price saved on the profile is reported back by the preview, which is how a screen shows
      // "currently agreed: X" next to the field being edited.
      const saved = await apiRequest(request, 'PUT', PROFILES_API, {
        token,
        data: {
          id: profileId,
          customerId,
          deliveryZoneCode,
          negotiatedPrices: { [productId]: '30.00' },
        },
      })
      expect(saved.status(), `saving a negotiated price should be 200: ${await saved.text()}`).toBe(200)
      const withStored = await readImpact(request, token, {
        customerId,
        productId,
        proposedUnitPriceNet: RICH_PRICE,
        quantity: '10',
      })
      expect(withStored.negotiatedPrice.storedUnitPriceNet).toBe('30.00')

      // Flipping the guardrail to "rules win" takes the negotiated price out of play entirely
      // (`lib/components/guardrails.ts`), so the preview has to say the number will never reach a
      // quote rather than showing figures that would never happen.
      const flipped = await apiRequest(request, 'PUT', GUARDRAILS_API, {
        token,
        data: {
          id: guardrailId,
          code: guardrailCode,
          scope: 'product',
          scopeRefId: productId,
          minMarginPercent: MIN_MARGIN_PERCENT,
          floorPrice: null,
          negotiatedPricePrecedence: 'rules_win',
          validFrom: VALID_FROM,
        },
      })
      expect(flipped.status(), `flipping precedence should be 200: ${await flipped.text()}`).toBe(200)

      const ignored = await readImpact(request, token, {
        customerId,
        productId,
        proposedUnitPriceNet: RICH_PRICE,
        quantity: '10',
      })
      expect(ignored.negotiatedPrice.precedence).toBe('rules_win')
      expect(ignored.negotiatedPrice.appliesToQuote).toBe(false)
      expect(ignored.negotiatedPrice.ignoredReasonKey).toBe(
        'pricing_engine.customerPricingImpact.negotiatedPrice.ignoredByPrecedence',
      )
      expect(ignored.appliedPrice?.raisedFromProposedPrice).toBe(false)
      expect(
        ignored.appliedPrice?.unitPriceNet,
        'with the rules winning, the quote is the engine price and nothing else',
      ).toBe(ignored.enginePrice?.unitPriceNet)

      // Missing configuration is reported as a reason, never as zeros: a zero cost reads as a 100%
      // margin, which is the opposite of the answer the rep asked for.
      const barren = await readImpact(request, token, {
        customerId,
        productId: barrenProductId,
        proposedUnitPriceNet: CHEAP_PRICE,
      })
      expect(barren.available).toBe(false)
      expect(barren.unavailableReasonKeys.length, 'an unavailable preview must say why').toBeGreaterThan(0)
      expect(
        barren.unavailableReasonKeys.some((key) =>
          [
            'pricing_engine.customerPricingImpact.unavailable.purchaseCostMissing',
            'pricing_engine.customerPricingImpact.unavailable.productMissing',
          ].includes(key),
        ),
        `an uncosted product should report a missing cost or a missing product, got ${barren.unavailableReasonKeys.join(', ')}`,
      ).toBe(true)
      expect(barren.unitCostNet).toBeNull()
      expect(barren.enginePrice).toBeNull()
      expect(barren.proposedPrice).toBeNull()
      expect(barren.appliedPrice).toBeNull()
      expect(barren.floor).toBeNull()

      const noProfile = await readImpact(request, token, {
        customerId: crypto.randomUUID(),
        productId,
        proposedUnitPriceNet: CHEAP_PRICE,
      })
      expect(noProfile.available).toBe(false)
      expect(noProfile.unavailableReasonKeys).toContain(
        'pricing_engine.customerPricingImpact.unavailable.customerProfileMissing',
      )
      expect(noProfile.appliedPrice).toBeNull()
    } finally {
      await deleteById(request, token, PROFILES_API, profileId)
      await deleteById(request, token, GUARDRAILS_API, guardrailId)
      await deleteById(request, token, '/api/pricing/margin-rules', marginRuleId)
      await deleteById(request, token, '/api/pricing/purchase-positions', purchasePositionId)
      await deleteById(request, token, '/api/pricing/delivery-zones', deliveryZoneId)
      await deleteById(request, token, '/api/catalog/products', productId)
      await deleteById(request, token, '/api/catalog/products', barrenProductId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', customerId)
    }
  })
})
