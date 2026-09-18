import { createPricingService } from '../services/pricingService'
import { buildContext, PRODUCT_ID } from './fixtures'
import {
  DEMO_LABOR_RATES,
  DEMO_ORDER_SCENARIOS,
  DEMO_OVERHEAD_RATE,
  DEMO_PROCESS_STEPS,
} from '../lib/seedDefaults'

type Created = { entity: string; data: Record<string, unknown> }

// A fake EntityManager that records what the service asks to persist. Postgres generates the
// calculation's primary key, so `em.create(...)` leaves `id` undefined until flush — a real
// database rejects the ledger lines with "calculationId is required" while every in-memory test
// that never inspects the persisted rows passes happily. This harness closes that gap.
function createRecordingEm(rows: Record<string, unknown[]>) {
  const created: Created[] = []
  const nameOf = (entity: unknown): string =>
    typeof entity === 'function' ? (entity as { name: string }).name : String(entity)
  return {
    created,
    em: {
      async findOne(entity: unknown) {
        return (rows[nameOf(entity)] ?? [])[0] ?? null
      },
      async find(entity: unknown) {
        return rows[nameOf(entity)] ?? []
      },
      create(entity: unknown, data: Record<string, unknown>) {
        const record = { ...data }
        created.push({ entity: nameOf(entity), data: record })
        return record
      },
      persist() {},
      async flush() {},
    },
  }
}

const EPOCH = new Date('2000-01-01T00:00:00.000Z')

function seedRows(): Record<string, unknown[]> {
  return {
    PricingSupplierProfile: [
      {
        id: 'supplier-1',
        slug: 'demo-horeca',
        currencyCode: 'PLN',
        defaultTargetMarkup: '66.0000',
        mode: 'shadow',
        roundingPolicy: { step: '0.01' },
        parameterSetVersion: 7,
      },
    ],
    PricingLaborRate: DEMO_LABOR_RATES.map((rate) => ({
      ...rate,
      overheadRate: DEMO_OVERHEAD_RATE,
      validFrom: EPOCH,
      validTo: null,
    })),
    PricingProcessStep: DEMO_PROCESS_STEPS.map((step) => ({ ...step, validFrom: EPOCH, validTo: null })),
    PricingOrderScenario: DEMO_ORDER_SCENARIOS.map((scenario) => ({
      ...scenario,
      stepMultipliers: { ...scenario.stepMultipliers },
      extraStepCodes: [...scenario.extraStepCodes],
      validFrom: EPOCH,
      validTo: null,
    })),
    PricingComponentParam: [],
    PricingGuardrail: [],
    PricingPackagingCost: [],
    PricingWarehouseCost: [],
    PricingVehicle: [],
    PricingDeliveryZone: [],
    PricingFuelPrice: [],
    PricingPurchasePosition: [],
    PricingCustomerIndicator: [],
  }
}

describe('pricingService ledger persistence', () => {
  it('gives every ledger line a defined calculationId that matches the calculation', async () => {
    const { em, created } = createRecordingEm(seedRows())
    const service = createPricingService({
      em: em as never,
      container: { resolve: () => { throw new Error('[internal] catalog absent in this test') } },
    })

    const result = await service.quote(buildContext({ customerId: null }))

    const calculations = created.filter((row) => row.entity === 'PricingCalculation')
    const lines = created.filter((row) => row.entity === 'PricingCalculationLine')
    expect(calculations).toHaveLength(1)
    expect(lines.length).toBeGreaterThan(0)

    const calculationId = calculations[0].data.id
    expect(typeof calculationId).toBe('string')
    expect(calculationId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(result.calculationId).toBe(calculationId)

    for (const line of lines) {
      expect(line.data.calculationId).toBe(calculationId)
    }
  })

  it('writes one ledger line per component, in pipeline order', async () => {
    const { em, created } = createRecordingEm(seedRows())
    const service = createPricingService({
      em: em as never,
      container: { resolve: () => { throw new Error('[internal] catalog absent in this test') } },
    })
    const result = await service.quote(buildContext({ customerId: null }))
    const lines = created.filter((row) => row.entity === 'PricingCalculationLine')
    expect(lines).toHaveLength(result.lines[0].breakdown.length)
    expect(lines.map((line) => line.data.position)).toEqual(lines.map((_line, index) => index))
  })

  it('persists nothing when persistence is disabled', async () => {
    const { em, created } = createRecordingEm(seedRows())
    const service = createPricingService({
      em: em as never,
      container: { resolve: () => { throw new Error('[internal] catalog absent in this test') } },
    })
    const result = await service.quote(buildContext({ customerId: null }), { persist: false })
    expect(created.filter((row) => row.entity === 'PricingCalculation')).toHaveLength(0)
    expect(created.filter((row) => row.entity === 'PricingCalculationLine')).toHaveLength(0)
    expect(result.calculationId).toBeNull()
  })
})
