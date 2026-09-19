import { toDecimal } from '../lib/decimal'
import type { GuardrailSnapshot, InventorySnapshot } from '../lib/types'
// `PricingInputs` lives in the service, not in lib/types. Importing it from the wrong module left
// the annotation resolving to an error type that transpilation strips, so this fixture was never
// checked against the engine's real input shape — a new required field would have kept the test
// green on an incomplete fixture.
import type { PricingInputs } from '../services/pricingService'
import type { CustomerPricingImpactResponse } from '../api/customer-pricing-impact/route'
import type { PricingCustomerProfile } from '../data/entities'
import { buildDeps, buildInventory, buildLot, CUSTOMER_ID, PRODUCT_ID, QUOTE_DATE } from './fixtures'

// `NextResponse.json` wants a Next.js runtime this package's node test environment does not
// provide, and the request-scoped DI container wants a database. The pipeline itself does not: the
// route is exercised against the real `priceWithInputs`, with only the two edges stubbed.
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}))

jest.mock('../lib/api/context', () => ({
  resolvePricingRouteContext: async () => ({
    container: { resolve: () => ({}) },
    tenantId: '33333333-3333-4333-8333-333333333333',
    organizationId: '44444444-4444-4444-8444-444444444444',
    userId: null,
    translate: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

const CUSTOMER_PROFILE = { id: 'profile-1', customerId: CUSTOMER_ID } as unknown as PricingCustomerProfile

let pricingInputs: PricingInputs

jest.mock('../services/pricingService', () => {
  const actual = jest.requireActual('../services/pricingService') as typeof import('../services/pricingService')
  return {
    ...actual,
    loadPricingInputs: async () => pricingInputs,
  }
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require('../api/customer-pricing-impact/route') as typeof import('../api/customer-pricing-impact/route')

type DepsOverrides = Parameters<typeof buildDeps>[0]

function setInputs(
  overrides: DepsOverrides = {},
  profile: PricingCustomerProfile | null = CUSTOMER_PROFILE,
): void {
  const deps = buildDeps(overrides)
  pricingInputs = {
    supplier: deps.supplier,
    params: deps.params,
    catalog: deps.catalog,
    indicators: deps.indicators,
    customerProfile: profile,
    orderScenarioCodes: ['ideal_file'],
    inventory: deps.inventory,
  }
}

type ResponseEnvelope = { status: number; body: CustomerPricingImpactResponse }

async function callRoute(params: Record<string, string>): Promise<ResponseEnvelope> {
  const search = new URLSearchParams({
    customerId: CUSTOMER_ID,
    productId: PRODUCT_ID,
    quantity: '24',
    orderScenarioCode: 'ideal_file',
    deliveryZoneCode: 'warszawa_poludnie',
    date: QUOTE_DATE.toISOString(),
    ...params,
  })
  const response = await route.GET(
    new Request(`https://example.test/api/pricing/customer-pricing-impact?${search.toString()}`),
  )
  return response as unknown as ResponseEnvelope
}

const RULES_WIN_GUARDRAIL: GuardrailSnapshot = {
  code: 'default',
  minMarginPercent: '8.0000',
  maxDiscountPercent: '25.0000',
  floorPrice: null,
  rounding: null,
  negotiatedPricePrecedence: 'rules_win',
}

// Nothing but a floor price: the only guardrail shape where the floor the engine enforces is a
// configured amount rather than a figure derived from cost.
const FLOOR_PRICE_GUARDRAIL: GuardrailSnapshot = {
  code: 'floor-only',
  minMarginPercent: null,
  maxDiscountPercent: null,
  floorPrice: '99.0000',
  rounding: null,
  negotiatedPricePrecedence: 'negotiated_wins',
}

const MS_PER_DAY = 86_400_000
const MARGIN_UNDEFINED = 'pricing_engine.customerPricingImpact.margin.undefinedAtNonPositivePrice'

function daysFromQuote(days: number): Date {
  return new Date(QUOTE_DATE.getTime() + days * MS_PER_DAY)
}

/**
 * Six days left of a 365-day life: below the 5% salvage threshold, so the ladder's floor for the
 * whole ordered quantity is minus the cost of destroying it — 5.2 kg at the assumed 2.50/kg.
 */
function salvageStockInventory(): InventorySnapshot {
  return buildInventory({
    lots: [
      buildLot({
        lotNumber: 'L-CHEM-0091',
        manufacturedAt: daysFromQuote(6 - 365),
        expiresAt: daysFromQuote(6),
        quantityAvailable: '60.0000',
      }),
    ],
  })
}

describe('customer pricing impact preview', () => {
  beforeEach(() => {
    setInputs()
  })

  it('shows a below-floor price being raised, with the engine warning that says so', async () => {
    const { status, body } = await callRoute({ proposedUnitPriceNet: '5' })

    expect(status).toBe(200)
    expect(body.available).toBe(true)
    expect(body.negotiatedPrice.appliesToQuote).toBe(true)
    expect(body.appliedPrice?.raisedFromProposedPrice).toBe(true)
    expect(body.warnings).toContain('pricing_engine.warnings.minMarginEnforced')

    const proposed = toDecimal('5')
    const applied = toDecimal(body.appliedPrice?.unitPriceNet ?? '0')
    const floor = toDecimal(body.floor?.unitPriceNet ?? '0')
    expect(applied > proposed).toBe(true)
    // The number the operator typed is NOT the number the engine will quote, and the floor is
    // exactly where it lands.
    expect(body.appliedPrice?.unitPriceNet).toBe(body.floor?.unitPriceNet)
    expect(floor > proposed).toBe(true)
    expect(body.floor?.minMarginPercent).toBe('8.0000')
    expect(body.floor?.unavailableReasonKey).toBeNull()
  })

  it('reports the margin at the typed price and the margin at the price actually applied', async () => {
    const { body } = await callRoute({ proposedUnitPriceNet: '5' })

    const cost = toDecimal(body.unitCostNet ?? '0')
    expect(cost > toDecimal('5')).toBe(true)
    // Below cost, so the operator's own margin is negative while the applied one holds the floor.
    expect(toDecimal(body.proposedPrice?.marginOnPricePercent ?? '0') < toDecimal('0')).toBe(true)
    // 7.9952, not 8.0000: the `rounding` component runs AFTER the guardrail and snaps the floor
    // price down to the nearest grosz, so the quoted price sits a fraction under the configured
    // minimum. The preview reports what the engine will really quote, not the setting.
    expect(body.appliedPrice?.marginOnPricePercent).toBe('7.9952')
    // Margin is on the price, markup is on the cost, and they must not be equal at a real price.
    expect(body.appliedPrice?.markupOnCostPercent).not.toBe(body.appliedPrice?.marginOnPricePercent)
    expect(body.amountsAreNetOfVat).toBe(true)
    expect(body.currencyCode).toBe('PLN')
  })

  it('lets a price above the floor through untouched', async () => {
    const { body } = await callRoute({ proposedUnitPriceNet: '500' })

    expect(body.available).toBe(true)
    expect(body.appliedPrice?.raisedFromProposedPrice).toBe(false)
    expect(body.appliedPrice?.unitPriceNet).toBe('500.0000')
    expect(body.warnings).not.toContain('pricing_engine.warnings.minMarginEnforced')
    // The engine's own price is what the customer would pay without the negotiation, and it must
    // be reported beside the negotiated one rather than replaced by it.
    expect(body.enginePrice?.unitPriceNet).not.toBe('500.0000')
    expect(toDecimal(body.enginePrice?.unitPriceNet ?? '0') > toDecimal('0')).toBe(true)
  })

  it('says outright that the negotiated price will never be used when precedence is not negotiated_wins', async () => {
    setInputs({ lookup: { guardrail: RULES_WIN_GUARDRAIL } })

    const { body } = await callRoute({ proposedUnitPriceNet: '500' })

    expect(body.negotiatedPrice.appliesToQuote).toBe(false)
    expect(body.negotiatedPrice.precedence).toBe('rules_win')
    expect(body.negotiatedPrice.ignoredReasonKey).toBe(
      'pricing_engine.customerPricingImpact.negotiatedPrice.ignoredByPrecedence',
    )
    expect(body.appliedPrice?.raisedFromProposedPrice).toBe(false)
    // The quote is the engine's price, exactly as if nothing had been negotiated.
    expect(body.appliedPrice?.unitPriceNet).toBe(body.enginePrice?.unitPriceNet)
  })

  it('reports an absent floor as absent rather than as a number', async () => {
    setInputs({ lookup: { guardrail: null } })

    const { body } = await callRoute({ proposedUnitPriceNet: '5' })

    expect(body.available).toBe(true)
    expect(body.floor?.unitPriceNet).toBeNull()
    expect(body.floor?.marginOnPricePercent).toBeNull()
    expect(body.floor?.unavailableReasonKey).toBe(
      'pricing_engine.customerPricingImpact.floor.notConfigured',
    )
    // Nothing raises it, so the operator's price is the quote — including below cost.
    expect(body.appliedPrice?.unitPriceNet).toBe('5.0000')
    expect(body.appliedPrice?.raisedFromProposedPrice).toBe(false)
  })

  it('prices a single unit when the caller names no quantity', async () => {
    const search = new URLSearchParams({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      proposedUnitPriceNet: '500',
      orderScenarioCode: 'ideal_file',
      deliveryZoneCode: 'warszawa_poludnie',
      date: QUOTE_DATE.toISOString(),
    })
    const response = (await route.GET(
      new Request(`https://example.test/api/pricing/customer-pricing-impact?${search.toString()}`),
    )) as unknown as ResponseEnvelope

    expect(response.body.quantity).toBe('1')
    expect(response.body.available).toBe(true)
  })

  it('refuses to invent figures when the product has no purchase cost', async () => {
    setInputs({ product: { purchase: null } })

    const { status, body } = await callRoute({ proposedUnitPriceNet: '25' })

    expect(status).toBe(200)
    expect(body.available).toBe(false)
    expect(body.unavailableReasonKeys).toEqual([
      'pricing_engine.customerPricingImpact.unavailable.purchaseCostMissing',
    ])
    expect(body.enginePrice).toBeNull()
    expect(body.proposedPrice).toBeNull()
    expect(body.appliedPrice).toBeNull()
    expect(body.floor).toBeNull()
    expect(body.unitCostNet).toBeNull()
  })

  it('refuses to invent figures when the quote carries no delivery zone', async () => {
    const { body } = await callRoute({
      proposedUnitPriceNet: '25',
      deliveryZoneCode: 'nieznana_strefa',
    })

    expect(body.available).toBe(false)
    expect(body.unavailableReasonKeys).toEqual([
      'pricing_engine.customerPricingImpact.unavailable.deliveryZoneMissing',
    ])
    expect(body.appliedPrice).toBeNull()
  })

  it('measures the real floor when the guardrail lets the rules win, instead of echoing the engine price', async () => {
    setInputs({ lookup: { guardrail: RULES_WIN_GUARDRAIL } })
    const rulesWin = await callRoute({ proposedUnitPriceNet: '500' })

    // The quote is the engine's own price, and the floor is a long way underneath it. Reporting
    // the engine price under the name "floor" beside a minimum margin of 8% was the defect: two
    // numbers that cannot both be true.
    expect(rulesWin.body.appliedPrice?.unitPriceNet).toBe(rulesWin.body.enginePrice?.unitPriceNet)
    expect(rulesWin.body.floor?.unitPriceNet).not.toBe(rulesWin.body.enginePrice?.unitPriceNet)
    expect(
      toDecimal(rulesWin.body.floor?.unitPriceNet ?? '0') <
        toDecimal(rulesWin.body.enginePrice?.unitPriceNet ?? '0'),
    ).toBe(true)
    expect(rulesWin.body.floor?.source).toBe('min_margin')
    expect(rulesWin.body.floor?.marginOnPricePercent).toBe('7.9952')

    // The same guardrail with the opposite precedence has the same floor: precedence decides whose
    // price reaches the guardrail, not where the guardrail stops.
    setInputs({ lookup: { guardrail: { ...RULES_WIN_GUARDRAIL, negotiatedPricePrecedence: 'negotiated_wins' } } })
    const negotiatedWins = await callRoute({ proposedUnitPriceNet: '500' })
    expect(rulesWin.body.floor?.unitPriceNet).toBe(negotiatedWins.body.floor?.unitPriceNet)
  })

  it('names the floor it measured, so the screen does not have to guess which one bound the price', async () => {
    const minMargin = await callRoute({ proposedUnitPriceNet: '5' })
    expect(minMargin.body.floor?.source).toBe('min_margin')

    setInputs({ lookup: { guardrail: FLOOR_PRICE_GUARDRAIL } })
    const floorPrice = await callRoute({ proposedUnitPriceNet: '5' })
    expect(floorPrice.body.floor?.source).toBe('floor_price')
    expect(floorPrice.body.floor?.unitPriceNet).toBe('99.0000')

    setInputs({ lookup: { guardrail: null } })
    const none = await callRoute({ proposedUnitPriceNet: '5' })
    expect(none.body.floor?.source).toBeNull()
  })

  it('refuses to call a margin zero at a price that is not positive', async () => {
    const { body } = await callRoute({ proposedUnitPriceNet: '-5' })

    expect(body.proposedPrice?.unitPriceNet).toBe('-5.0000')
    // Zero would read as break-even on a price five zloty BELOW zero and a long way below cost.
    expect(body.proposedPrice?.marginOnPricePercent).toBeNull()
    expect(body.proposedPrice?.marginUnavailableReasonKey).toBe(MARGIN_UNDEFINED)
    // Markup divides by the cost, which is positive, so it stays a number — and a damning one.
    expect(body.proposedPrice?.markupUnavailableReasonKey).toBeNull()
    expect(toDecimal(body.proposedPrice?.markupOnCostPercent ?? '0') < toDecimal('-100.0000')).toBe(true)
    // The engine's own price is unaffected and keeps reporting both ratios.
    expect(body.enginePrice?.marginOnPricePercent).not.toBeNull()
  })

  it('reports a salvage floor below zero as a price with no margin, not as a break-even margin', async () => {
    setInputs({ inventory: salvageStockInventory() })

    const { body } = await callRoute({ proposedUnitPriceNet: '25' })

    expect(body.floor?.source).toBe('shelf_life')
    // 5.2 kg at the assumed 2.50/kg disposal rate: selling at -13.00 still beats destroying it.
    expect(body.floor?.unitPriceNet).toBe('-13.0000')
    expect(body.floor?.unavailableReasonKey).toBeNull()
    expect(body.floor?.marginOnPricePercent).toBeNull()
    expect(body.floor?.marginUnavailableReasonKey).toBe(MARGIN_UNDEFINED)
    expect(body.floor?.markupOnCostPercent).not.toBeNull()
    // The ladder lowers the floor; it does not set the price, so the operator's own number stands.
    expect(body.appliedPrice?.unitPriceNet).toBe('25.0000')
  })

  it('names the missing customer profile instead of pricing without one', async () => {
    setInputs({}, null)

    const { body } = await callRoute({ proposedUnitPriceNet: '25' })

    expect(body.available).toBe(false)
    expect(body.unavailableReasonKeys).toEqual([
      'pricing_engine.customerPricingImpact.unavailable.customerProfileMissing',
    ])
    expect(body.appliedPrice).toBeNull()
    // Still enough context for the screen to name the currency it would have priced in.
    expect(body.currencyCode).toBe('PLN')
  })
})
