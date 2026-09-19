import { NextResponse } from 'next/server'
import type { CustomerAuthContext } from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'

const getCustomerAuthFromRequest = jest.fn()
const requireCustomerFeature = jest.fn()
const createRequestContainer = jest.fn()

jest.mock('@open-mercato/core/modules/customer_accounts/lib/customerAuth', () => ({
  getCustomerAuthFromRequest: (...args: unknown[]) => getCustomerAuthFromRequest(...args),
  requireCustomerFeature: (...args: unknown[]) => requireCustomerFeature(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => createRequestContainer(...args),
}))

import { resolvePortalSession } from '../lib/portalSession'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333'

function buyerAuth(overrides: Partial<CustomerAuthContext> = {}): CustomerAuthContext {
  return {
    sub: '44444444-4444-4444-8444-444444444444',
    sid: 'session-1',
    type: 'customer',
    tenantId: TENANT_ID,
    orgId: ORG_ID,
    email: 'horeca-szpital-wolski@portal.example',
    displayName: 'Szpital Wolski',
    customerEntityId: CUSTOMER_ID,
    personEntityId: null,
    resolvedFeatures: ['portal.catalog.view', 'portal.quotes.request'],
    isPortalAdmin: false,
    ...overrides,
  }
}

function fakeContainer() {
  return {
    resolve: (name: string) => ({ name }),
  }
}

function portalRequest(): Request {
  return new Request('https://example.test/api/distributor_workspace/portal/catalog')
}

describe('resolvePortalSession', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    createRequestContainer.mockResolvedValue(fakeContainer())
    requireCustomerFeature.mockResolvedValue(undefined)
  })

  it('rejects an unauthenticated caller with 401 and never opens a container', async () => {
    getCustomerAuthFromRequest.mockResolvedValue(null)

    const result = await resolvePortalSession(portalRequest(), ['portal.catalog.view'])

    expect(result).toBeInstanceOf(Response)
    expect((result as NextResponse).status).toBe(401)
    expect(createRequestContainer).not.toHaveBeenCalled()
  })

  it('rejects a customer user with no company association with 403', async () => {
    getCustomerAuthFromRequest.mockResolvedValue(buyerAuth({ customerEntityId: null }))

    const result = await resolvePortalSession(portalRequest(), ['portal.catalog.view'])

    expect(result).toBeInstanceOf(Response)
    expect((result as NextResponse).status).toBe(403)
  })

  it('returns the 403 thrown by requireCustomerFeature when the feature is missing', async () => {
    getCustomerAuthFromRequest.mockResolvedValue(buyerAuth())
    requireCustomerFeature.mockRejectedValue(
      NextResponse.json({ ok: false, error: 'Insufficient permissions' }, { status: 403 }),
    )

    const result = await resolvePortalSession(portalRequest(), ['portal.orders.create'])

    expect(result).toBeInstanceOf(Response)
    expect((result as NextResponse).status).toBe(403)
  })

  it('derives every scope from the session, never from the request', async () => {
    getCustomerAuthFromRequest.mockResolvedValue(buyerAuth())

    const result = await resolvePortalSession(portalRequest(), ['portal.catalog.view'])

    expect(result).not.toBeInstanceOf(Response)
    if (result instanceof Response) throw new Error('[internal] expected a resolved portal session')
    expect(result.tenantId).toBe(TENANT_ID)
    expect(result.organizationId).toBe(ORG_ID)
    expect(result.customerEntityId).toBe(CUSTOMER_ID)
    expect(result.commandCtx.selectedOrganizationId).toBe(ORG_ID)
    expect(result.commandCtx.organizationIds).toEqual([ORG_ID])
    expect(result.commandCtx.organizationScope).toBeNull()
    expect(result.commandCtx.auth?.tenantId).toBe(TENANT_ID)
    expect(result.commandCtx.auth?.customerEntityId).toBe(CUSTOMER_ID)
    expect(requireCustomerFeature).toHaveBeenCalledWith(
      expect.objectContaining({ sub: buyerAuth().sub }),
      ['portal.catalog.view'],
      expect.anything(),
    )
  })
})
