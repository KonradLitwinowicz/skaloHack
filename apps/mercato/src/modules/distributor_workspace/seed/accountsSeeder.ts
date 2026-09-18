import { randomUUID } from 'node:crypto'
import { hash } from 'bcryptjs'
import type { EntityManager } from '@mikro-orm/postgresql'
import { Role, User, UserRole } from '@open-mercato/core/modules/auth/data/entities'
import { ensureRoles } from '@open-mercato/core/modules/auth/lib/setup-app'
import { computeEmailHash } from '@open-mercato/core/modules/auth/lib/emailHash'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  CustomerRole,
  CustomerUser,
  CustomerUserRole,
} from '@open-mercato/core/modules/customer_accounts/data/entities'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { DISTRIBUTOR_ROLE } from '../lib/roleFeatures'
import { HORECA_SOURCE_PREFIX } from './customerSeeder'
import { bump, emptyReport, type DistributorSeedScope, type SeedReport, type SeedRunOptions } from './types'

/**
 * bcrypt cost is 10 everywhere in this repo (auth/lib/setup-app.ts, auth/cli.ts,
 * auth/commands/users.ts, customer_accounts/setup.ts). Do not diverge.
 */
const BCRYPT_COST = 10

/**
 * Accounts are written with `em.create`, never through the HTTP API.
 *
 * `POST /api/customer_accounts/signup` sends a verification email, and the staff admin route
 * emits `customer_accounts.user.created`, whose notification type declares an `email` channel —
 * so seeding through either would attempt one outbound email per account. Direct persistence
 * emits nothing. Set OM_DISABLE_EMAIL_DELIVERY=1 as a second line of defence when seeding in
 * an environment that has a real mail provider configured.
 */
export type SeededAccount = {
  email: string
  password: string
  displayName: string
}

export const DISTRIBUTOR_BACKEND_ACCOUNT: SeededAccount = {
  email: 'dystrybutor@acme.com',
  password: 'Dystrybutor123!',
  displayName: 'Operator dystrybutora',
}

async function seedBackendDistributor(
  em: EntityManager,
  scope: DistributorSeedScope,
  report: SeedReport,
): Promise<void> {
  const emailHash = computeEmailHash(DISTRIBUTOR_BACKEND_ACCOUNT.email)
  const existing = await findOneWithDecryption(
    em,
    User,
    { emailHash, tenantId: scope.tenantId, deletedAt: null },
    {},
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  if (existing) {
    report.skipped += 1
    bump(report, 'backendUsersSkipped')
    return
  }

  // The role normally arrives through this module's `seedDefaults`, but that hook only fires on
  // `mercato init` and on tenant creation. On a tenant that already exists there is no global
  // seed-defaults command, so the seeder ensures the row itself — idempotently, the same call the
  // hook makes. The ACL grants still need `mercato auth sync-role-acls --tenant <id>` afterwards,
  // because `ensureCustomRoleAcls` is what attaches `defaultRoleFeatures` to a custom role.
  await ensureRoles(em, { tenantId: scope.tenantId, roleNames: [DISTRIBUTOR_ROLE] })
  const role = await em.findOne(Role, { name: DISTRIBUTOR_ROLE, tenantId: scope.tenantId })
  if (!role) {
    report.warnings.push(`[internal] role "${DISTRIBUTOR_ROLE}" could not be ensured for this tenant`)
    return
  }

  const now = new Date()
  const user = em.create(User, {
    id: randomUUID(),
    email: DISTRIBUTOR_BACKEND_ACCOUNT.email,
    emailHash,
    name: DISTRIBUTOR_BACKEND_ACCOUNT.displayName,
    passwordHash: await hash(DISTRIBUTOR_BACKEND_ACCOUNT.password, BCRYPT_COST),
    isConfirmed: true,
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    createdAt: now,
    updatedAt: now,
  })
  em.persist(user)
  em.persist(em.create(UserRole, { id: randomUUID(), user, role, createdAt: now }))
  report.created += 1
  bump(report, 'backendUsers')
}

/**
 * Portal accounts reuse the tenant's existing default `buyer` role rather than minting a
 * parallel one — `buyer` already carries exactly the customer-facing grants
 * (customer_accounts/setup.ts) and is flagged `isDefault`.
 */
async function seedPortalBuyers(
  em: EntityManager,
  scope: DistributorSeedScope,
  report: SeedReport,
  limit: number,
): Promise<void> {
  const buyerRole = await em.findOne(CustomerRole, {
    tenantId: scope.tenantId,
    slug: 'buyer',
    deletedAt: null,
  })
  if (!buyerRole) {
    report.warnings.push('[internal] portal role "buyer" is missing — customer_accounts seedDefaults has not run')
    return
  }

  const companies = await findWithDecryption(
    em,
    CustomerEntity,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      kind: 'company',
      source: { $like: `${HORECA_SOURCE_PREFIX}%` },
      deletedAt: null,
    },
    { limit, orderBy: { createdAt: 'ASC' } },
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )

  if (!companies.length) {
    report.warnings.push('[internal] no HoReCa customers found — run seed-horeca-customers first')
    return
  }

  const now = new Date()
  for (const company of companies) {
    const handle = (company.source ?? '').slice(HORECA_SOURCE_PREFIX.length)
    if (!handle) continue
    const email = `${handle}@portal.example`
    const emailHash = hashForLookup(email)
    const existing = await em.findOne(CustomerUser, { emailHash, tenantId: scope.tenantId, deletedAt: null })
    if (existing) {
      report.skipped += 1
      bump(report, 'portalUsersSkipped')
      continue
    }

    const portalUser = em.create(CustomerUser, {
      id: randomUUID(),
      email,
      emailHash,
      passwordHash: await hash('Klient123!', BCRYPT_COST),
      displayName: company.displayName,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      customerEntityId: company.id,
      isActive: true,
      failedLoginAttempts: 0,
      emailVerifiedAt: now,
      createdAt: now,
    })
    em.persist(portalUser)
    em.persist(em.create(CustomerUserRole, { id: randomUUID(), user: portalUser, role: buyerRole, createdAt: now }))
    report.created += 1
    bump(report, 'portalUsers')
  }
}

export async function seedDistributorAccounts(
  em: EntityManager,
  scope: DistributorSeedScope,
  options: SeedRunOptions = {},
): Promise<SeedReport> {
  const report = emptyReport()
  if (options.dryRun) {
    report.warnings.push('[internal] dry run: nothing was written')
    return report
  }
  await seedBackendDistributor(em, scope, report)
  await seedPortalBuyers(em, scope, report, options.limit ?? 5)
  await em.flush()
  return report
}
