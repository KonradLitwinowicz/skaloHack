import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerAddress, CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { PricingCustomerProfile } from '@open-mercato/pricing-engine/modules/pricing_engine/data/entities'
import { HORECA_CUSTOMERS } from './horecaCustomerData'
import { bump, emptyReport, type DistributorSeedScope, type SeedReport, type SeedRunOptions } from './types'

/**
 * Idempotency probe.
 *
 * `display_name`, `primary_email`, `description` and every address line are encrypted at rest
 * (customers/encryption.ts), so none of them can be used as a lookup key — a WHERE on an
 * encrypted column matches ciphertext, not the value. `source` is NOT encrypted and is a
 * provenance field by definition, so the seeder stamps the stable handle there and probes on it.
 */
export const HORECA_SOURCE_PREFIX = 'horeca:'

function sourceFor(handle: string): string {
  return `${HORECA_SOURCE_PREFIX}${handle}`
}

export async function seedHorecaCustomers(
  em: EntityManager,
  scope: DistributorSeedScope,
  options: SeedRunOptions = {},
): Promise<SeedReport> {
  const report = emptyReport()
  const customers =
    typeof options.limit === 'number' ? HORECA_CUSTOMERS.slice(0, options.limit) : HORECA_CUSTOMERS

  const sources = customers.map((seed) => sourceFor(seed.handle))
  const existing = await findWithDecryption(
    em,
    CustomerEntity,
    { tenantId: scope.tenantId, organizationId: scope.organizationId, source: { $in: sources } },
    {},
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  const existingSources = new Set(existing.map((row) => row.source ?? ''))

  if (options.dryRun) {
    report.skipped = existingSources.size
    report.created = customers.length - existingSources.size
    report.warnings.push('[internal] dry run: nothing was written')
    return report
  }

  const now = new Date()

  for (const seed of customers) {
    if (existingSources.has(sourceFor(seed.handle))) {
      report.skipped += 1
      continue
    }

    const entity = em.create(CustomerEntity, {
      id: randomUUID(),
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      kind: 'company',
      displayName: seed.companyName,
      description: `${seed.segment} · NIP ${seed.taxId}`,
      primaryEmail: seed.email,
      primaryPhone: seed.phone,
      status: 'customer',
      lifecycleStage: 'customer',
      source: sourceFor(seed.handle),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    em.persist(entity)
    report.created += 1
    bump(report, 'customers')

    for (const address of seed.addresses) {
      em.persist(
        em.create(CustomerAddress, {
          id: randomUUID(),
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          entity,
          name: address.label,
          purpose: 'delivery',
          companyName: seed.companyName,
          addressLine1: address.line1,
          addressLine2: address.line2 ?? null,
          city: address.city,
          region: address.region,
          postalCode: address.postalCode,
          country: address.countryCode,
          latitude: Number(address.latitude),
          longitude: Number(address.longitude),
          isPrimary: address.isDefault ?? false,
          createdAt: now,
          updatedAt: now,
        }),
      )
      bump(report, 'addresses')
    }

    em.persist(
      em.create(PricingCustomerProfile, {
        id: randomUUID(),
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        isDemo: true,
        // No `code` column on this entity — the profile is keyed by `customerId`, and the customer
        // row it points at is itself created idempotently, so the profile inherits that guarantee.
        customerId: entity.id,
        customerGroupCode: seed.segment,
        deliveryZoneCode: seed.deliveryZoneCode,
        defaultOrderScenarioCode: seed.orderScenarioCode,
        negotiatedPrices: null,
        negotiatedPriceExpiresAt: null,
      }),
    )
    bump(report, 'pricingProfiles')
  }

  await em.flush()
  return report
}
