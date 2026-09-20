import { createPricingAdvisorService } from '../services/pricingAdvisorService'
import { createPricingService } from '../services/pricingService'
import { buildContext } from './fixtures'
import {
  DEMO_LABOR_RATES,
  DEMO_ORDER_SCENARIOS,
  DEMO_OVERHEAD_RATE,
  DEMO_PROCESS_STEPS,
} from '../lib/seedDefaults'

// The whole point of splitting `quote()` into `loadPricingInputs` + a pure `priceWithInputs` is that
// scoring N hypothetical baskets stays O(1) in database round trips. Without a counter that claim
// rots the first time somebody reaches for the EntityManager inside a generator.
function createCountingEm(rows: Record<string, unknown[]>) {
  const queries: string[] = []
  const nameOf = (entity: unknown): string =>
    typeof entity === 'function' ? (entity as { name: string }).name : String(entity)
  return {
    queries,
    em: {
      async findOne(entity: unknown) {
        queries.push(`findOne:${nameOf(entity)}`)
        return (rows[nameOf(entity)] ?? [])[0] ?? null
      },
      async find(entity: unknown) {
        queries.push(`find:${nameOf(entity)}`)
        return rows[nameOf(entity)] ?? []
      },
      create(_entity: unknown, data: Record<string, unknown>) {
        return { ...data }
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
        parameterSetVersion: 1,
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

const NO_CATALOG = {
  resolve: () => {
    throw new Error('[internal] catalog absent in this test')
  },
}

describe('advisory run query budget', () => {
  it('scores every perturbation on ONE prefetch', async () => {
    const { em, queries } = createCountingEm(seedRows())
    const advisor = createPricingAdvisorService({ em: em as never, container: NO_CATALOG })

    await advisor.advise(buildContext({ customerId: null }), { advisor: { maxPerKind: 3 } })

    // 1 sibling-group lookup (the follow-up is skipped because no group came back) + 1 supplier
    // profile + 10 parameter queries (no customer, so the profile lookup is not issued) + 1 purchase
    // position — `loadCatalogSnapshot` falls back to that single query with catalog absent —
    // + 1 scenario list + 1 authorised deadstock floor lookup. Every perturbation after that is
    // priced in process.
    //
    // The deadstock lookup is the one addition since this budget was first fixed. It is a single
    // scope-filtered read of `pricing_deadstock_decisions` keyed by the basket's product ids, flat
    // in basket size like everything else here, and it is issued unconditionally because whether a
    // floor was authorised cannot be known without asking.
    expect(queries).toHaveLength(15)
    expect(queries.filter((entry) => entry.endsWith('PricingSupplierProfile'))).toHaveLength(1)
  })

  it('adds exactly the customer profile and indicator lookups when a customer is named', async () => {
    const { em, queries } = createCountingEm(seedRows())
    const advisor = createPricingAdvisorService({ em: em as never, container: NO_CATALOG })

    await advisor.advise(buildContext(), { advisor: { maxPerKind: 3 } })

    expect(queries).toHaveLength(17)
    expect(queries).toContain('find:PricingCustomerIndicator')
  })

  it('costs the same whether one suggestion kind is asked for or all five', async () => {
    const one = createCountingEm(seedRows())
    const all = createCountingEm(seedRows())

    await createPricingAdvisorService({ em: one.em as never, container: NO_CATALOG }).advise(
      buildContext({ customerId: null }),
      { advisor: { kinds: ['cheaper_equivalent'] } },
    )
    await createPricingAdvisorService({ em: all.em as never, container: NO_CATALOG }).advise(
      buildContext({ customerId: null }),
      { advisor: { maxPerKind: 5 } },
    )

    expect(all.queries).toHaveLength(one.queries.length)
  })

  /**
   * The price-comparison screen quotes one basket eight times over — the WZ as it happened, the
   * selected volume, the offer channel and a five-step volume ladder — and the desk re-quotes on
   * every keystroke. The inputs are identical every time: same tenant, same products, same day.
   * They are therefore loaded once per EntityManager, which is forked per request, so the saving
   * never spans two requests.
   */
  it('re-quotes the same basket without loading its inputs a second time', async () => {
    const { em, queries } = createCountingEm(seedRows())
    const service = createPricingService({ em: em as never, container: NO_CATALOG })
    const context = buildContext({ customerId: null })

    await service.quote(context, { persist: false })
    const afterFirst = queries.length
    await service.quote(context, { persist: false })

    expect(queries.length).toBe(afterFirst)
  })

  it('reloads for a different basket, and for the same basket on another EntityManager', async () => {
    const { em, queries } = createCountingEm(seedRows())
    const service = createPricingService({ em: em as never, container: NO_CATALOG })
    const context = buildContext({ customerId: null })

    await service.quote(context, { persist: false })
    const afterFirst = queries.length

    // Another customer is another set of customer-scoped parameters.
    await service.quote(buildContext({ customerId: 'customer-2' }), { persist: false })
    expect(queries.length).toBeGreaterThan(afterFirst)

    // A second request gets its own fork and must see whatever was configured in between.
    const second = createCountingEm(seedRows())
    await createPricingService({ em: second.em as never, container: NO_CATALOG }).quote(context, {
      persist: false,
    })
    expect(second.queries.length).toBe(afterFirst)
  })
})
