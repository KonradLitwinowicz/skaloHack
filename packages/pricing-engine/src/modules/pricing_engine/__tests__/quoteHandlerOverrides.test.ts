import { createPricingService, type QuoteOptions } from '../services/pricingService'
import { simulateRequestSchema } from '../data/validators'
import { buildContext, PRODUCT_ID } from './fixtures'
import {
  DEMO_LABOR_RATES,
  DEMO_ORDER_SCENARIOS,
  DEMO_OVERHEAD_RATE,
  DEMO_PROCESS_STEPS,
} from '../lib/seedDefaults'
import type { PricingContext } from '../lib/types'

// `NextResponse.json` and the request-scoped DI container both want a Next.js runtime this package's
// node test environment does not provide. The handler's own logic — which schema it parses with and
// what it threads into the service — is what this file is guarding, so both are stubbed.
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}))

type CapturedQuote = { context: PricingContext; options: QuoteOptions | undefined }
const captured: CapturedQuote[] = []

jest.mock('../lib/api/context', () => ({
  resolvePricingRouteContext: async () => ({
    container: {
      resolve: () => ({
        async quote(context: PricingContext, options?: QuoteOptions) {
          captured.push({ context, options })
          return {
            calculationId: null,
            currencyCode: 'PLN',
            mode: 'shadow' as const,
            parameterSetVersion: 1,
            lines: [],
            totalNet: '0.0000',
            totalCostNet: '0.0000',
            totalMarkupPercent: '0.0000',
            totalMarginPercent: '0.0000',
            warnings: [],
            durationMs: 0,
          }
        },
      }),
    },
    tenantId: '33333333-3333-4333-8333-333333333333',
    organizationId: '44444444-4444-4444-8444-444444444444',
    userId: null,
    translate: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handleQuoteRequest } = require('../lib/api/quoteHandler') as typeof import('../lib/api/quoteHandler')

function requestWith(body: Record<string, unknown>): Request {
  return new Request('https://example.test/api/pricing/simulate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const BODY = {
  lines: [{ productId: PRODUCT_ID, quantity: '24' }],
  overrides: { targetMarkupPercent: '45', orderScenarioCode: 'ideal_file' },
}

describe('simulate overrides reach the engine', () => {
  beforeEach(() => {
    captured.length = 0
  })

  it('threads overrides through when the caller passes the simulate schema', async () => {
    await handleQuoteRequest(requestWith(BODY), {
      persist: false,
      triggeredBy: 'simulate',
      schema: simulateRequestSchema,
    })

    expect(captured).toHaveLength(1)
    expect(captured[0].options?.overrides).toEqual({
      targetMarkupPercent: '45',
      orderScenarioCode: 'ideal_file',
    })
  })

  it('drops them on the quote path, whose schema does not declare them', async () => {
    await handleQuoteRequest(requestWith(BODY), { persist: true, triggeredBy: 'api' })

    expect(captured).toHaveLength(1)
    expect(captured[0].options?.overrides).toBeUndefined()
  })
})

type Created = { entity: string; data: Record<string, unknown> }

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

describe('a markup override changes the price', () => {
  it('prices the same basket differently at 45% than at the supplier default of 66%', async () => {
    const { em } = createRecordingEm(seedRows())
    const service = createPricingService({
      em: em as never,
      container: { resolve: () => { throw new Error('[internal] catalog absent in this test') } },
    })
    const context = buildContext({ customerId: null })

    const asConfigured = await service.quote(context, { persist: false })
    const overridden = await service.quote(context, {
      persist: false,
      overrides: { targetMarkupPercent: '45' },
    })

    expect(Number(asConfigured.lines[0].unitPriceNet)).toBeGreaterThan(0)
    expect(overridden.lines[0].unitPriceNet).not.toBe(asConfigured.lines[0].unitPriceNet)
    expect(Number(overridden.lines[0].unitPriceNet)).toBeLessThan(
      Number(asConfigured.lines[0].unitPriceNet),
    )
    // The markup override must move only the price, never the measured cost underneath it.
    expect(overridden.lines[0].unitCostNet).toBe(asConfigured.lines[0].unitCostNet)
    // `rounding` runs after `target_margin`, so the realised markup sits close to the requested
    // figure rather than exactly on it — the cost base here is a few zloty, which makes the
    // half-grosz rounding step visible in the percentage.
    expect(Number(overridden.lines[0].markupPercent)).toBeCloseTo(45, 0)
    expect(Number(asConfigured.lines[0].markupPercent)).toBeCloseTo(66, 0)
  })

  it('reprices through a cheaper ordering channel when the override names one', async () => {
    const { em } = createRecordingEm(seedRows())
    const service = createPricingService({
      em: em as never,
      container: { resolve: () => { throw new Error('[internal] catalog absent in this test') } },
    })
    const context = buildContext({ customerId: null, orderScenarioCode: 'phone' })

    const onThePhone = await service.quote(context, { persist: false })
    const onAFile = await service.quote(context, {
      persist: false,
      overrides: { orderScenarioCode: 'ideal_file' },
    })

    expect(Number(onAFile.lines[0].unitCostNet)).toBeLessThan(Number(onThePhone.lines[0].unitCostNet))
  })
})
