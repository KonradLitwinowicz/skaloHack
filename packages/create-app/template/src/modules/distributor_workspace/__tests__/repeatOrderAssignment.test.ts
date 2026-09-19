import type { EntityManager } from '@mikro-orm/postgresql'
import {
  PricingCustomerProfile,
  PricingOrderScenario,
} from '@open-mercato/pricing-engine/modules/pricing_engine/data/entities'
import { REPEAT_ORDER_SCENARIO_CODE } from '@open-mercato/pricing-engine/modules/pricing_engine/lib/seedDefaults'
import {
  HORECA_CUSTOMERS,
  REPEAT_ORDER_ELIGIBLE_CHANNELS,
  REPEAT_ORDER_MIN_MONTHLY_ORDERS,
  isRepeatOrderCustomer,
} from '../seed/horecaCustomerData'
import { HORECA_SOURCE_PREFIX, resolveOrderScenarioCode, seedHorecaCustomers } from '../seed/customerSeeder'
import type { DistributorSeedScope } from '../seed/types'

const findWithDecryptionMock = jest.fn()
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: (...args: unknown[]) => findWithDecryptionMock(...args),
  findOneWithDecryption: jest.fn(),
}))

const SCOPE: DistributorSeedScope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}

const ELIGIBLE_CHANNEL = 'ideal_file'

type Created = { type: unknown; data: Record<string, unknown> }

function recordingEm(
  options: { repeatOrderScenario?: boolean; profiles?: Array<Record<string, unknown>> } = {},
): { em: EntityManager; persisted: Created[] } {
  const persisted: Created[] = []
  const em = {
    async findOne(type: unknown) {
      if (type !== PricingOrderScenario) return null
      return options.repeatOrderScenario === false ? null : { code: REPEAT_ORDER_SCENARIO_CODE }
    },
    async find(type: unknown) {
      if (type !== PricingCustomerProfile) return []
      return options.profiles ?? []
    },
    create(type: unknown, data: Record<string, unknown>) {
      return { ...data, __type: type } as Record<string, unknown>
    },
    persist(entity: Record<string, unknown>) {
      persisted.push({ type: entity.__type, data: entity })
      return em
    },
    async flush() {
      return undefined
    },
  } as unknown as EntityManager
  return { em, persisted }
}

function profiles(persisted: Created[]): Record<string, unknown>[] {
  return persisted.filter((row) => row.type === PricingCustomerProfile).map((row) => row.data)
}

beforeEach(() => {
  findWithDecryptionMock.mockReset()
  findWithDecryptionMock.mockResolvedValue([])
})

describe('isRepeatOrderCustomer', () => {
  it('assigns the scenario above the threshold and withholds it below', () => {
    expect(
      isRepeatOrderCustomer({
        orderScenarioCode: ELIGIBLE_CHANNEL,
        monthlyOrderCount: REPEAT_ORDER_MIN_MONTHLY_ORDERS,
      }),
    ).toBe(true)
    expect(
      isRepeatOrderCustomer({
        orderScenarioCode: ELIGIBLE_CHANNEL,
        monthlyOrderCount: REPEAT_ORDER_MIN_MONTHLY_ORDERS - 1,
      }),
    ).toBe(false)
  })

  it('withholds it from every channel the defensibility guard excludes', () => {
    const rejected = ['nonstandard_file', 'email', 'sms', 'phone', 'rep_visit'] as const
    for (const channel of rejected) {
      expect(REPEAT_ORDER_ELIGIBLE_CHANNELS.has(channel)).toBe(false)
      expect(isRepeatOrderCustomer({ orderScenarioCode: channel, monthlyOrderCount: 40 })).toBe(false)
    }
  })

  it('treats a missing order count as no evidence rather than as a qualifying one', () => {
    expect(isRepeatOrderCustomer({ orderScenarioCode: ELIGIBLE_CHANNEL })).toBe(false)
    expect(isRepeatOrderCustomer({ orderScenarioCode: ELIGIBLE_CHANNEL, monthlyOrderCount: null })).toBe(
      false,
    )
    expect(
      isRepeatOrderCustomer({ orderScenarioCode: ELIGIBLE_CHANNEL, monthlyOrderCount: Number.NaN }),
    ).toBe(false)
  })

  it('selects a minority of the seeded base, all of them on the structured-file channel', () => {
    const selected = HORECA_CUSTOMERS.filter((customer) => isRepeatOrderCustomer(customer))

    expect(selected.length).toBeGreaterThan(0)
    expect(selected.length).toBeLessThan(HORECA_CUSTOMERS.length / 2)
    for (const customer of selected) {
      expect(customer.orderScenarioCode).toBe(ELIGIBLE_CHANNEL)
      expect(customer.monthlyOrderCount).toBeGreaterThanOrEqual(REPEAT_ORDER_MIN_MONTHLY_ORDERS)
    }
  })
})

describe('seedHorecaCustomers scenario assignment', () => {
  it('writes the repeat scenario for qualifying customers and the channel for the rest', async () => {
    const harness = recordingEm()
    await seedHorecaCustomers(harness.em, SCOPE)

    const written = profiles(harness.persisted)
    expect(written).toHaveLength(HORECA_CUSTOMERS.length)

    let repeatCount = 0
    for (const [index, profile] of written.entries()) {
      const seed = HORECA_CUSTOMERS[index]!
      if (isRepeatOrderCustomer(seed)) {
        expect(profile.defaultOrderScenarioCode).toBe(REPEAT_ORDER_SCENARIO_CODE)
        repeatCount += 1
      } else {
        expect(profile.defaultOrderScenarioCode).toBe(seed.orderScenarioCode)
      }
    }
    expect(repeatCount).toBeGreaterThan(0)
  })

  it('is idempotent — a second run over already-seeded handles reassigns nothing', async () => {
    findWithDecryptionMock.mockResolvedValue(
      HORECA_CUSTOMERS.map((customer) => ({ source: `${HORECA_SOURCE_PREFIX}${customer.handle}` })),
    )

    const harness = recordingEm()
    const report = await seedHorecaCustomers(harness.em, SCOPE)

    expect(report.created).toBe(0)
    expect(profiles(harness.persisted)).toHaveLength(0)
  })

  // The scenario row is the thing that makes the multiplier real. Without it
  // `operational_cost_base` reads the code as multiplier 1.00 — the dearest intake in the engine —
  // so a tenant whose pricing_engine setup has not run must keep its channel scenarios.
  it('keeps the channel scenario when the repeat_order row does not exist', async () => {
    const harness = recordingEm({ repeatOrderScenario: false })
    const report = await seedHorecaCustomers(harness.em, SCOPE)

    const written = profiles(harness.persisted)
    for (const [index, profile] of written.entries()) {
      expect(profile.defaultOrderScenarioCode).toBe(HORECA_CUSTOMERS[index]!.orderScenarioCode)
    }
    expect(report.warnings.some((warning) => warning.includes('repeat_order'))).toBe(true)
  })

  // Create-only would leave the whole feature unreachable on every tenant that has been seeded
  // once — which is every tenant it is meant for.
  it('rescores a profile written by an earlier run', async () => {
    const qualifying = HORECA_CUSTOMERS.find((customer) => isRepeatOrderCustomer(customer))
    expect(qualifying).toBeDefined()
    findWithDecryptionMock.mockResolvedValue([
      { id: 'customer-1', source: `${HORECA_SOURCE_PREFIX}${qualifying!.handle}` },
    ])
    const stale = { customerId: 'customer-1', defaultOrderScenarioCode: qualifying!.orderScenarioCode }

    const harness = recordingEm({ profiles: [stale] })
    const report = await seedHorecaCustomers(harness.em, SCOPE)

    expect(stale.defaultOrderScenarioCode).toBe(REPEAT_ORDER_SCENARIO_CODE)
    expect(report.details.pricingProfilesRescored).toBe(1)
  })

  it('resolves the same scenario for the same seed every time it is asked', () => {
    for (const customer of HORECA_CUSTOMERS) {
      expect(resolveOrderScenarioCode(customer)).toBe(resolveOrderScenarioCode(customer))
    }
  })

  it('does not fall over on a seed with no recorded order count', async () => {
    const [first] = HORECA_CUSTOMERS
    expect(first).toBeDefined()
    const withoutCount = { orderScenarioCode: first!.orderScenarioCode }
    expect(() => resolveOrderScenarioCode(withoutCount, true)).not.toThrow()
    expect(resolveOrderScenarioCode(withoutCount, true)).toBe(first!.orderScenarioCode)
  })
})
