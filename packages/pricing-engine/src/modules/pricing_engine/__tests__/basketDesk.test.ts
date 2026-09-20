import {
  applySuggestion,
  buildDeskHref,
  deriveMarginTargets,
  mergeLineFloors,
  parseDeskSearch,
  toLineFloor,
  type DeskLine,
} from '../lib/frontend/basketDesk'
import type { AdviseResponse, AdvisorSuggestion } from '../lib/frontend/advisorTypes'
import type { QuoteBreakdownComponent, QuoteLine, QuoteResponse } from '../lib/frontend/quoteTypes'

const PRODUCT_A = '11111111-1111-1111-1111-111111111111'
const PRODUCT_B = '22222222-2222-2222-2222-222222222222'
const PRODUCT_C = '33333333-3333-3333-3333-333333333333'
const CUSTOMER = '44444444-4444-4444-4444-444444444444'

function line(productId: string, quantity: number): DeskLine {
  return { key: productId, productId, title: `Product ${productId.slice(0, 2)}`, sku: null, quantity }
}

function component(overrides: Partial<QuoteBreakdownComponent>): QuoteBreakdownComponent {
  return {
    code: 'product_cost',
    labelKey: 'pricing_engine.components.productCost.label',
    effect: 'add',
    value: '10.0000',
    inputs: {},
    params: {},
    explainKey: 'pricing_engine.components.productCost.explain.fresh',
    explainValues: {},
    confidence: 'measured',
    ...overrides,
  }
}

function quoteLine(productId: string, breakdown: QuoteBreakdownComponent[]): QuoteLine {
  return {
    productId,
    sku: null,
    quantity: '1',
    unitPriceNet: '20.0000',
    totalPriceNet: '20.0000',
    unitCostNet: '10.0000',
    markupPercent: '100.0000',
    marginPercent: '50.0000',
    breakdown,
    warnings: [],
  }
}

function quote(lines: QuoteLine[]): QuoteResponse {
  return {
    calculationId: null,
    currencyCode: 'PLN',
    mode: 'shadow',
    parameterSetVersion: 1,
    lines,
    totalNet: '20.0000',
    totalCostNet: '10.0000',
    totalMarkupPercent: '100.0000',
    totalMarginPercent: '50.0000',
    warnings: [],
    durationMs: 1,
  }
}

function suggestion(overrides: Partial<AdvisorSuggestion>): AdvisorSuggestion {
  return {
    code: 'volume_threshold',
    titleKey: 'pricing_engine.advisor.suggestion.volumeThreshold.title',
    subject: { productId: PRODUCT_A, sku: 'A-1', title: 'Product A' },
    explainKey: 'pricing_engine.advisor.suggestion.volumeThreshold.explain',
    explainValues: {},
    breakEvenConditionKey: 'pricing_engine.advisor.suggestion.volumeThreshold.breakEven',
    change: {},
    customerUnitPriceBefore: '20.0000',
    customerUnitPriceAfter: '18.0000',
    supplierProfitBefore: '10.0000',
    supplierProfitAfter: '9.0000',
    basketProfitBefore: '10.0000',
    basketProfitAfter: '18.0000',
    supplierMarginPercentBefore: '50.0000',
    supplierMarginPercentAfter: '50.0000',
    profitNeutralUnitPrice: '18.0000',
    guardrailFloorUnitPrice: null,
    confidence: 'measured',
    raisesCustomerPrice: false,
    objectiveScore: null,
    ...overrides,
  }
}

describe('desk URL contract', () => {
  it('round-trips customer, channel, zone and lines', () => {
    const href = buildDeskHref({
      customerId: CUSTOMER,
      orderScenarioCode: 'ideal_file',
      deliveryZoneCode: 'warszawa',
      lines: [
        { productId: PRODUCT_A, quantity: '12' },
        { productId: PRODUCT_B, quantity: '3.5' },
      ],
    })
    expect(href.startsWith('/backend/pricing/calculator?')).toBe(true)
    const parsed = parseDeskSearch(href.slice(href.indexOf('?') + 1))
    expect(parsed).toEqual({
      customerId: CUSTOMER,
      orderScenarioCode: 'ideal_file',
      deliveryZoneCode: 'warszawa',
      lines: [
        { productId: PRODUCT_A, quantity: '12' },
        { productId: PRODUCT_B, quantity: '3.5' },
      ],
    })
  })

  it('returns the bare path when there is nothing to carry', () => {
    expect(buildDeskHref({})).toBe('/backend/pricing/calculator')
    expect(buildDeskHref({ lines: [{ productId: PRODUCT_A, quantity: '0' }] })).toBe('/backend/pricing/calculator')
  })

  it('skips malformed and duplicate lines but keeps the rest', () => {
    const parsed = parseDeskSearch(
      new URLSearchParams({ lines: `${PRODUCT_A}:2,:5,${PRODUCT_B}:abc,${PRODUCT_A}:9,${PRODUCT_C}` }),
    )
    expect(parsed.lines).toEqual([
      { productId: PRODUCT_A, quantity: '2' },
      { productId: PRODUCT_C, quantity: '1' },
    ])
    expect(parsed.customerId).toBeNull()
  })
})

describe('applySuggestion', () => {
  const basket = [line(PRODUCT_A, 2), line(PRODUCT_B, 1)]

  it('moves the subject line to the suggested quantity', () => {
    const outcome = applySuggestion(basket, suggestion({ change: { productId: PRODUCT_A, fromQuantity: '2', toQuantity: '12' } }))
    expect(outcome.kind).toBe('quantity')
    if (outcome.kind !== 'quantity') return
    expect(outcome.lines.map((entry) => entry.quantity)).toEqual([12, 1])
  })

  it('rounds a pack with the subject taken from the suggestion when change omits it', () => {
    const outcome = applySuggestion(
      basket,
      suggestion({ code: 'full_pack_rounding', change: { toQuantity: '6' } }),
    )
    expect(outcome.kind).toBe('quantity')
    if (outcome.kind !== 'quantity') return
    expect(outcome.lines[0].quantity).toBe(6)
    expect(outcome.lines[1].quantity).toBe(1)
  })

  it('swaps the product and labels it with the sku until the title arrives', () => {
    const outcome = applySuggestion(
      basket,
      suggestion({
        code: 'cheaper_equivalent',
        change: { productId: PRODUCT_A, toProductId: PRODUCT_C },
        explainValues: { fromSku: 'A-1', toSku: 'C-1' },
      }),
    )
    expect(outcome.kind).toBe('product')
    if (outcome.kind !== 'product') return
    expect(outcome.productId).toBe(PRODUCT_C)
    expect(outcome.lines[0]).toMatchObject({ productId: PRODUCT_C, sku: 'C-1', title: 'C-1', quantity: 2 })
  })

  it('refuses a swap onto a product already in the basket', () => {
    const outcome = applySuggestion(
      basket,
      suggestion({ code: 'cheaper_equivalent', change: { productId: PRODUCT_A, toProductId: PRODUCT_B } }),
    )
    expect(outcome.kind).toBe('none')
  })

  it('switches the channel without touching the lines', () => {
    const outcome = applySuggestion(
      basket,
      suggestion({ code: 'order_channel_change', subject: null, change: { toOrderScenarioCode: 'ideal_file' } }),
    )
    expect(outcome).toEqual({ kind: 'channel', orderScenarioCode: 'ideal_file' })
  })

  it('has nothing to apply for a consolidation or a line that left the basket', () => {
    expect(applySuggestion(basket, suggestion({ code: 'basket_consolidation', subject: null })).kind).toBe('none')
    expect(
      applySuggestion(basket, suggestion({ change: { productId: PRODUCT_C, toQuantity: '4' } })).kind,
    ).toBe('none')
  })
})

describe('margin targets and floors', () => {
  it('reads the target margin and the strictest guardrail off the breakdown', () => {
    const targets = deriveMarginTargets(
      quote([
        quoteLine(PRODUCT_A, [
          component({ code: 'target_margin', effect: 'mul', params: { targetMarkupPercent: '66.0000' } }),
          component({ code: 'guardrails', params: { minMarginPercent: '20.0000' } }),
        ]),
        quoteLine(PRODUCT_B, [component({ code: 'guardrails', params: { minMarginPercent: '25' } })]),
      ]),
    )
    expect(targets.targetMarginPercent).toBe('39.7590')
    expect(targets.floorMarginPercent).toBe('25')
  })

  it('prefers an explicit target margin over a markup', () => {
    const targets = deriveMarginTargets(
      quote([
        quoteLine(PRODUCT_A, [
          component({
            code: 'target_margin',
            effect: 'mul',
            params: { targetMarginPercent: '30', targetMarkupPercent: '66' },
          }),
        ]),
      ]),
    )
    expect(targets).toEqual({ targetMarginPercent: '30', floorMarginPercent: null })
  })

  it('computes the floor price from the guardrail margin and reports headroom', () => {
    const floor = toLineFloor(quoteLine(PRODUCT_A, [component({ code: 'guardrails', params: { minMarginPercent: '20' } })]))
    expect(floor.lowestUnitPrice).toBe('12.5000')
    expect(floor.discountHeadroomPercent).toBe('37.50')
    expect(floor.source).toBe('guardrail')
  })

  it('lets advisor floors override the simulate floors per product', () => {
    const simulated = quote([
      quoteLine(PRODUCT_A, [component({ code: 'guardrails', params: { minMarginPercent: '20' } })]),
      quoteLine(PRODUCT_B, []),
    ])
    const advice = {
      marginFloors: [
        {
          productId: PRODUCT_A,
          sku: null,
          minMarginPercent: '35',
          unitCostNet: '10.0000',
          currentUnitPriceNet: '20.0000',
          lowestUnitPriceNet: '15.3846',
          discountHeadroomPercent: '23.08',
          source: 'requested' as const,
        },
      ],
    } as unknown as AdviseResponse
    const floors = mergeLineFloors(simulated, advice)
    expect(floors.get(PRODUCT_A)).toMatchObject({ lowestUnitPrice: '15.3846', source: 'requested' })
    expect(floors.get(PRODUCT_B)).toMatchObject({ lowestUnitPrice: null, source: null })
  })
})
