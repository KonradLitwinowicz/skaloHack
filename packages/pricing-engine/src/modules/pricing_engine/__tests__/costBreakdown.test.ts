import { summariseBasketCost } from '../lib/frontend/costBreakdown'
import type { QuoteResponse } from '../lib/frontend/quoteTypes'

function component(overrides: Record<string, unknown> = {}) {
  return {
    code: 'product_cost',
    labelKey: 'pricing_engine.components.productCost.label',
    effect: 'add' as const,
    value: '10.0000',
    inputs: {},
    params: {},
    explainKey: 'x',
    explainValues: {},
    confidence: 'measured' as const,
    ...overrides,
  }
}

function quote(lines: Array<{ quantity: string; breakdown: ReturnType<typeof component>[] }>): QuoteResponse {
  return {
    calculationId: null,
    currencyCode: 'PLN',
    mode: 'shadow',
    parameterSetVersion: 1,
    lines: lines.map((line, index) => ({
      productId: `p-${index}`,
      sku: null,
      quantity: line.quantity,
      unitPriceNet: '0',
      totalPriceNet: '0',
      unitCostNet: '0',
      markupPercent: '0',
      marginPercent: '0',
      breakdown: line.breakdown,
      warnings: [],
    })),
    totalNet: '0',
    totalCostNet: '0',
    totalMarkupPercent: '0',
    totalMarginPercent: '0',
    warnings: [],
  } as unknown as QuoteResponse
}

describe('summariseBasketCost', () => {
  it('multiplies the per-unit component by the line quantity', () => {
    const summary = summariseBasketCost(
      quote([{ quantity: '3', breakdown: [component({ value: '10.0000' })] }]),
    )

    expect(summary?.goods).toBeCloseTo(30)
    expect(summary?.total).toBeCloseTo(30)
  })

  it('separates the goods from everything else the basket costs to serve', () => {
    const summary = summariseBasketCost(
      quote([
        {
          quantity: '2',
          breakdown: [
            component({ value: '10.0000' }),
            component({ code: 'picking', labelKey: 'picking', value: '2.0000' }),
            component({ code: 'delivery', labelKey: 'delivery', value: '3.0000' }),
          ],
        },
      ]),
    )

    expect(summary?.goods).toBeCloseTo(20)
    expect(summary?.handling).toBeCloseTo(10)
    expect(summary?.total).toBeCloseTo(30)
  })

  it('adds the same component across lines', () => {
    const summary = summariseBasketCost(
      quote([
        { quantity: '1', breakdown: [component({ value: '10.0000' })] },
        { quantity: '2', breakdown: [component({ value: '5.0000' })] },
      ]),
    )

    expect(summary?.goods).toBeCloseTo(20)
  })

  /**
   * A `mul` component scales the running total rather than contributing an amount of its own, so
   * summing it next to the others would count the same money twice.
   */
  it('ignores multiplying components', () => {
    const summary = summariseBasketCost(
      quote([
        {
          quantity: '1',
          breakdown: [component({ value: '10.0000' }), component({ code: 'markup', effect: 'mul', value: '1.6' })],
        },
      ]),
    )

    expect(summary?.total).toBeCloseTo(10)
    expect(summary?.components.map((entry) => entry.code)).toEqual(['product_cost'])
  })

  it('ranks the components by what they cost, biggest first', () => {
    const summary = summariseBasketCost(
      quote([
        {
          quantity: '1',
          breakdown: [
            component({ code: 'picking', labelKey: 'picking', value: '2.0000' }),
            component({ value: '10.0000' }),
            component({ code: 'delivery', labelKey: 'delivery', value: '5.0000' }),
          ],
        },
      ]),
    )

    expect(summary?.components.map((entry) => entry.code)).toEqual(['product_cost', 'delivery', 'picking'])
  })

  // A basket is only as trustworthy as its weakest input, so the summary reports the floor.
  it('keeps the weakest confidence a component reported on any line', () => {
    const summary = summariseBasketCost(
      quote([
        { quantity: '1', breakdown: [component({ confidence: 'measured' })] },
        { quantity: '1', breakdown: [component({ confidence: 'default' })] },
      ]),
    )

    expect(summary?.components[0].confidence).toBe('default')
  })

  it('has nothing to say about an empty or missing quote', () => {
    expect(summariseBasketCost(null)).toBeNull()
    expect(summariseBasketCost(quote([]))).toBeNull()
    expect(summariseBasketCost(quote([{ quantity: '1', breakdown: [] }]))).toBeNull()
  })
})
