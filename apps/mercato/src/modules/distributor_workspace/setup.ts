import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { ensureRoles } from '@open-mercato/core/modules/auth/lib/setup-app'
import { DISTRIBUTOR_FEATURES, DISTRIBUTOR_ROLE, DISTRIBUTOR_ROLE_NAMES } from './lib/roleFeatures'

/**
 * This module deliberately exposes NO `seedExamples` hook.
 *
 * The HoReCa catalog and customer data it ships is demo data for one distributor. Wiring it
 * to `seedExamples` would push ~200 products and 40 companies into every tenant created from
 * here on, which is exactly what the owner asked not to happen. The seeders are reachable only
 * through `mercato distributor_workspace seed-*`, run by hand against a named tenant.
 *
 * `seedDefaults` carries the one thing that IS structural: the `distributor` role row.
 * Role ACL grants are declared below and attached by the framework's second pass
 * (`ensureCustomRoleAcls`, packages/cli/src/mercato.ts) because `ensureDefaultRoleAcls` runs
 * before `seedDefaults` and would otherwise find no role to attach them to. On a tenant that
 * already exists, finish with:
 *   yarn mercato auth sync-role-acls --tenant <tenantId>
 */
export const setup: ModuleSetupConfig = {
  seedDefaults: async (ctx) => {
    await ensureRoles(ctx.em, { tenantId: ctx.tenantId, roleNames: [...DISTRIBUTOR_ROLE_NAMES] })
  },
  defaultRoleFeatures: {
    [DISTRIBUTOR_ROLE]: [...DISTRIBUTOR_FEATURES],
  },
}

export default setup
