import type { AwilixContainer } from 'awilix'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'

export type PricingRouteContext = {
  container: AwilixContainer
  tenantId: string
  organizationId: string
  userId: string | null
  translate: (key: string, fallback?: string) => string
}

export async function resolvePricingRouteContext(req: Request): Promise<PricingRouteContext> {
  const container = await createRequestContainer()
  const auth = await getAuthFromRequest(req)
  const { translate } = await resolveTranslations()
  if (!auth || !auth.tenantId) {
    throw new CrudHttpError(401, {
      error: translate('pricing_engine.errors.unauthorized', 'Unauthorized'),
    })
  }
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
  const organizationId = scope?.selectedId ?? auth.orgId ?? null
  if (!organizationId) {
    throw new CrudHttpError(400, {
      error: translate(
        'pricing_engine.errors.organizationRequired',
        'Organization context is required',
      ),
    })
  }
  return {
    container,
    tenantId: auth.tenantId,
    organizationId,
    // `auth.sub` is `api_key:<id>` for API-key callers, which is not a uuid. The ledger column is,
    // so only a real user id is recorded and machine callers are stored as null.
    userId: asUuidOrNull(auth.userId ?? auth.sub),
    translate,
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function asUuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
}
