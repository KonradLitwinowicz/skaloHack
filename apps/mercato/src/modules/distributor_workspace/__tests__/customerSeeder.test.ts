import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerAddress, CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { PricingCustomerProfile } from '@open-mercato/pricing-engine/modules/pricing_engine/data/entities'
import { HORECA_CUSTOMERS } from '../seed/horecaCustomerData'
import { HORECA_SOURCE_PREFIX, seedHorecaCustomers } from '../seed/customerSeeder'
import type { DistributorSeedScope } from '../seed/types'

/**
 * The encryption read helper is mocked, not exercised: what is under test is the seeder's own
 * behaviour — the idempotency probe, the field mapping and the scoping — not the framework's
 * decryption layer, which has its own tests and would need a live KMS here.
 */
const findWithDecryptionMock = jest.fn()
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: (...args: unknown[]) => findWithDecryptionMock(...args),
  findOneWithDecryption: jest.fn(),
}))

const SCOPE: DistributorSeedScope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}

type Created = { type: unknown; data: Record<string, unknown> }

function recordingEm(): { em: EntityManager; created: Created[]; persisted: Created[]; flushes: number } {
  const created: Created[] = []
  const persisted: Created[] = []
  let flushes = 0
  const em = {
    create(type: unknown, data: Record<string, unknown>) {
      const entity = { ...data, __type: type } as Record<string, unknown>
      if (!entity.id) entity.id = `generated-${created.length}`
      created.push({ type, data: entity })
      return entity
    },
    persist(entity: Record<string, unknown>) {
      persisted.push({ type: entity.__type, data: entity })
      return em
    },
    async flush() {
      flushes += 1
    },
  } as unknown as EntityManager
  return {
    em,
    created,
    persisted,
    get flushes() {
      return flushes
    },
  } as { em: EntityManager; created: Created[]; persisted: Created[]; flushes: number }
}

function ofType(rows: Created[], type: unknown): Created[] {
  return rows.filter((row) => row.type === type)
}

beforeEach(() => {
  findWithDecryptionMock.mockReset()
  findWithDecryptionMock.mockResolvedValue([])
})

describe('seedHorecaCustomers', () => {
  it('creates a company, its addresses and a pricing profile for every seed', async () => {
    const harness = recordingEm()
    const report = await seedHorecaCustomers(harness.em, SCOPE, { limit: 3 })

    expect(report.created).toBe(3)
    expect(report.skipped).toBe(0)
    expect(ofType(harness.persisted, CustomerEntity)).toHaveLength(3)
    expect(ofType(harness.persisted, PricingCustomerProfile)).toHaveLength(3)

    const expectedAddresses = HORECA_CUSTOMERS.slice(0, 3).reduce(
      (total, customer) => total + customer.addresses.length,
      0,
    )
    expect(ofType(harness.persisted, CustomerAddress)).toHaveLength(expectedAddresses)
  })

  it('is idempotent — a second run over already-seeded handles writes nothing', async () => {
    const seeded = HORECA_CUSTOMERS.slice(0, 3).map((customer) => ({
      source: `${HORECA_SOURCE_PREFIX}${customer.handle}`,
    }))
    findWithDecryptionMock.mockResolvedValue(seeded)

    const harness = recordingEm()
    const report = await seedHorecaCustomers(harness.em, SCOPE, { limit: 3 })

    expect(report.created).toBe(0)
    expect(report.skipped).toBe(3)
    expect(harness.persisted).toHaveLength(0)
  })

  it('writes nothing at all on a dry run', async () => {
    const harness = recordingEm()
    const report = await seedHorecaCustomers(harness.em, SCOPE, { limit: 5, dryRun: true })

    expect(harness.persisted).toHaveLength(0)
    expect(harness.created).toHaveLength(0)
    expect(report.created).toBe(5)
    expect(report.warnings.join(' ')).toContain('dry run')
  })

  it('scopes every written row to the tenant and organization', async () => {
    const harness = recordingEm()
    await seedHorecaCustomers(harness.em, SCOPE, { limit: 4 })

    const unscoped = harness.persisted.filter(
      (row) => row.data.tenantId !== SCOPE.tenantId || row.data.organizationId !== SCOPE.organizationId,
    )
    expect(unscoped).toHaveLength(0)
  })

  it('stamps the stable handle into the unencrypted source field so the probe can find it again', async () => {
    const harness = recordingEm()
    await seedHorecaCustomers(harness.em, SCOPE, { limit: 2 })

    const companies = ofType(harness.persisted, CustomerEntity)
    const sources = companies.map((row) => row.data.source)
    expect(sources).toEqual(
      HORECA_CUSTOMERS.slice(0, 2).map((customer) => `${HORECA_SOURCE_PREFIX}${customer.handle}`),
    )
  })

  it('carries delivery coordinates through as numbers, because the column is a float', async () => {
    const harness = recordingEm()
    await seedHorecaCustomers(harness.em, SCOPE, { limit: 6 })

    const addresses = ofType(harness.persisted, CustomerAddress)
    expect(addresses.length).toBeGreaterThan(0)
    for (const address of addresses) {
      expect(typeof address.data.latitude).toBe('number')
      expect(typeof address.data.longitude).toBe('number')
      expect(Number.isFinite(address.data.latitude as number)).toBe(true)
      expect(address.data.purpose).toBe('delivery')
    }
  })

  it('marks pricing profiles as demo data and carries the zone and scenario', async () => {
    const harness = recordingEm()
    await seedHorecaCustomers(harness.em, SCOPE, { limit: 4 })

    const profiles = ofType(harness.persisted, PricingCustomerProfile)
    expect(profiles).toHaveLength(4)
    for (const [index, profile] of profiles.entries()) {
      const seed = HORECA_CUSTOMERS[index]!
      expect(profile.data.isDemo).toBe(true)
      expect(profile.data.deliveryZoneCode).toBe(seed.deliveryZoneCode)
      expect(profile.data.defaultOrderScenarioCode).toBe(seed.orderScenarioCode)
      expect(profile.data.customerGroupCode).toBe(seed.segment)
    }
  })
})
