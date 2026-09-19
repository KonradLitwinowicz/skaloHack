import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { createRequestContainer, type AppContainer } from '@open-mercato/shared/lib/di/container'
import {
  getCustomerAuthFromRequest,
  requireCustomerFeature,
  type CustomerAuthContext,
} from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import type { CustomerRbacService } from '@open-mercato/core/modules/customer_accounts/services/customerRbacService'

export const PORTAL_CATALOG_FEATURE = 'portal.catalog.view'
export const PORTAL_QUOTE_REQUEST_FEATURE = 'portal.quotes.request'
export const PORTAL_ORDER_CREATE_FEATURE = 'portal.orders.create'

export type PortalSession = {
  auth: CustomerAuthContext
  container: AppContainer
  em: EntityManager
  tenantId: string
  organizationId: string
  /** The customers-module company this portal user buys for. Every scope below derives from it. */
  customerEntityId: string
  commandCtx: CommandRuntimeContext
}

/**
 * The auth spine for every portal route in this module.
 *
 * Staff auth cannot be reused here: `getAuthFromRequest` rejects customer JWTs outright
 * (`packages/shared/src/lib/auth/server.ts`), and the API dispatcher only ever consults
 * `rbacService`, never `customerRbacService`. Portal routes therefore declare
 * `metadata = { <METHOD>: { requireAuth: false } }` and authenticate here instead.
 *
 * Returns a `NextResponse` (401/403) rather than throwing, so callers can `instanceof Response`
 * and return it directly.
 */
export async function resolvePortalSession(
  req: Request,
  features: string[],
): Promise<PortalSession | NextResponse> {
  const auth = await getCustomerAuthFromRequest(req)
  if (!auth) {
    return NextResponse.json(
      { ok: false, error: 'distributor_workspace.portal.errors.unauthorized' },
      { status: 401 },
    )
  }
  if (!auth.customerEntityId) {
    return NextResponse.json(
      { ok: false, error: 'distributor_workspace.portal.errors.noCompany' },
      { status: 403 },
    )
  }

  const container = await createRequestContainer()
  const customerRbacService = container.resolve('customerRbacService') as CustomerRbacService
  try {
    await requireCustomerFeature(auth, features, customerRbacService)
  } catch (response) {
    // `requireCustomerFeature` throws the 403 NextResponse rather than an Error.
    return response as NextResponse
  }

  const commandAuth: NonNullable<AuthContext> = {
    sub: auth.sub,
    sid: auth.sid,
    tenantId: auth.tenantId,
    orgId: auth.orgId,
    email: auth.email,
    customerEntityId: auth.customerEntityId,
    personEntityId: auth.personEntityId ?? null,
  }

  return {
    auth,
    container,
    em: container.resolve('em') as EntityManager,
    tenantId: auth.tenantId,
    organizationId: auth.orgId,
    customerEntityId: auth.customerEntityId,
    commandCtx: {
      container,
      auth: commandAuth,
      // `organizationScope: null` makes `ensureOrderScope` fall back to the session's own org,
      // which is what pins a portal write to the caller's tenant.
      organizationScope: null,
      selectedOrganizationId: auth.orgId,
      organizationIds: [auth.orgId],
      request: req,
    },
  }
}

/**
 * Second-stage authorization for routes whose required feature depends on the request body
 * (submitting a quote request versus placing an order). Returns the 403 response, or `null`
 * when the caller is entitled.
 */
export async function assertPortalFeature(
  session: PortalSession,
  features: string[],
): Promise<NextResponse | null> {
  const customerRbacService = session.container.resolve('customerRbacService') as CustomerRbacService
  try {
    await requireCustomerFeature(session.auth, features, customerRbacService)
    return null
  } catch (response) {
    return response as NextResponse
  }
}
