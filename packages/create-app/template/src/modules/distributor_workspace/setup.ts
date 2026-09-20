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
 *
 * `defaultRoleFeatures` also hands the module's own ids (`acl.ts`) to the core roles: `admin`
 * gets the wildcard, `employee` every id, `distributor` the full bundle from `lib/roleFeatures`.
 * The sync MERGES into existing roles, so nobody who reaches a screen today loses it — the own
 * ids are required on top of the data-owning modules' ids, which every one of these roles holds.
 */
export const setup: ModuleSetupConfig = {
  seedDefaults: async (ctx) => {
    await ensureRoles(ctx.em, { tenantId: ctx.tenantId, roleNames: [...DISTRIBUTOR_ROLE_NAMES] })
  },
  defaultRoleFeatures: {
    admin: ['distributor_workspace.*'],
    employee: [
      'distributor_workspace.widgets.next-actions',
      'distributor_workspace.widgets.expiring-stock',
      'distributor_workspace.widgets.stock-gaps',
      'distributor_workspace.forecast.view',
      'distributor_workspace.forecast.feedback',
      'distributor_workspace.pricing.compare',
    ],
    [DISTRIBUTOR_ROLE]: [...DISTRIBUTOR_FEATURES],
  },
}

export default setup
