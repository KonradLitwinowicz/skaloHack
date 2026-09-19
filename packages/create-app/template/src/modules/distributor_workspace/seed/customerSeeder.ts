import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerAddress, CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import {
  PricingCustomerProfile,
  PricingOrderScenario,
} from '@open-mercato/pricing-engine/modules/pricing_engine/data/entities'
import { REPEAT_ORDER_SCENARIO_CODE } from '@open-mercato/pricing-engine/modules/pricing_engine/lib/seedDefaults'
import { HORECA_CUSTOMERS, isRepeatOrderCustomer, type RepeatOrderCandidate } from './horecaCustomerData'
import { bump, emptyReport, type DistributorSeedScope, type SeedReport, type SeedRunOptions } from './types'

/**
 * The scenario the pricing profile is opened with.
 *
 * `repeat_order` is a behaviour, not a channel, but `pricing_customer_profiles` holds exactly one
 * `default_order_scenario_code`, so assigning it REPLACES the channel. That is only defensible
 * where the replaced channel is the cheap structured file — the eligibility rule enforces it.
 */
export function resolveOrderScenarioCode(
  seed: RepeatOrderCandidate,
  repeatOrderAvailable: boolean,
): string {
  if (!repeatOrderAvailable) return seed.orderScenarioCode
  return isRepeatOrderCustomer(seed) ? REPEAT_ORDER_SCENARIO_CODE : seed.orderScenarioCode
}

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
  const existingByCustomerId = new Map(existing.map((row) => [row.id, row.source ?? '']))

  // The scenario has to EXIST before a profile may point at it. `operational_cost_base` reads an
  // unresolved scenario code as multiplier 1.00 — the most expensive intake in the engine — so
  // stamping `repeat_order` on a tenant whose scenario rows were never seeded would make exactly
  // the customers this feature exists to make cheaper into the dearest in the book.
  const repeatOrderScenario = await em.findOne(PricingOrderScenario, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    code: REPEAT_ORDER_SCENARIO_CODE,
    deletedAt: null,
  })
  const repeatOrderAvailable = repeatOrderScenario !== null
  if (!repeatOrderAvailable) {
    report.warnings.push(
      '[internal] repeat_order scenario is absent — run the pricing_engine setup first; profiles keep their channel scenario',
    )
  }

  if (options.dryRun) {
    report.skipped = existingSources.size
    report.created = customers.length - existingSources.size
    report.warnings.push('[internal] dry run: nothing was written')
    return report
  }

  const now = new Date()

  // Profiles this seeder already wrote on an earlier run. Without this the whole repeat-order
  // assignment would be unreachable on every tenant that has been seeded once — which is every
  // tenant it is meant for.
  const existingProfiles = existingByCustomerId.size
    ? await em.find(PricingCustomerProfile, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        customerId: { $in: [...existingByCustomerId.keys()] },
        isDemo: true,
        deletedAt: null,
      })
    : []
  const seedBySource = new Map(customers.map((seed) => [sourceFor(seed.handle), seed]))

  for (const profile of existingProfiles) {
    const seed = seedBySource.get(existingByCustomerId.get(profile.customerId) ?? '')
    if (!seed) continue
    const desired = resolveOrderScenarioCode(seed, repeatOrderAvailable)
    if (profile.defaultOrderScenarioCode === desired) continue
    profile.defaultOrderScenarioCode = desired
    bump(report, 'pricingProfilesRescored')
  }

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
        defaultOrderScenarioCode: resolveOrderScenarioCode(seed, repeatOrderAvailable),
        negotiatedPrices: null,
        negotiatedPriceExpiresAt: null,
      }),
    )
    bump(report, 'pricingProfiles')
  }

  await em.flush()
  return report
}
