import { guardrailsComponent, maxDiscountFloor } from '../lib/components/guardrails'
import { roundingComponent } from '../lib/components/rounding'
import { productAspectsComponent } from '../lib/components/productAspects'
import { toDecimal, ZERO } from '../lib/decimal'
import type { ComponentResult } from '../lib/types'
import { buildContext, buildDeps, PRODUCT_ID } from './fixtures'

function args(overrides: Parameters<typeof buildDeps>[0] = {}, extra: Record<string, unknown> = {}) {
  const context = buildContext()
  return {
    context,
    lineIndex: 0,
    line: context.lines[0],
    quantity: toDecimal('24'),
    runningUnitValue: ZERO,
    unitCostNet: ZERO,
    componentValues: {},
    deps: buildDeps(overrides),
    ...extra,
  }
}

const DEFAULT_GUARDRAIL = {
  code: 'default',
  minMarginPercent: '8.0000',
  maxDiscountPercent: '25.0000',
  floorPrice: null,
  rounding: null,
  negotiatedPricePrecedence: 'negotiated_wins' as const,
}

function guardrailWithFloor(roundingFloorUnitPrice: string): ComponentResult {
  return {
    code: 'guardrails',
    labelKey: 'pricing_engine.components.guardrails.label',
    effect: 'mul',
    value: '1.0000',
    inputs: {},
    params: { roundingFloorUnitPrice },
    explainKey: 'pricing_engine.components.guardrails.explain.min_margin',
    explainValues: {},
    confidence: 'measured',
  }
}

describe('maximum discount on a negotiated price', () => {
  it('computes the floor as the target less the cap', () => {
    expect(maxDiscountFloor(toDecimal('166'), '25.0000')).toBe(toDecimal('124.5'))
    expect(maxDiscountFloor(toDecimal('166'), null)).toBeNull()
    expect(maxDiscountFloor(toDecimal('166'), '0')).toBeNull()
    expect(maxDiscountFloor(toDecimal('166'), '100')).toBeNull()
  })

  it('raises a negotiated price that undercuts the target by more than the cap', async () => {
    const result = await guardrailsComponent.compute({
      ...args({ lookup: { negotiatedPrices: { [PRODUCT_ID]: '100.0000' } } }),
      runningUnitValue: toDecimal('166'),
      unitCostNet: toDecimal('50'),
    })
    expect(result.explainKey).toBe('pricing_engine.components.guardrails.explain.max_discount')
    expect(result.explainValues.priceAfter).toBe('124.5000')
    expect(result.warnings).toContain('pricing_engine.warnings.maxDiscountEnforced')
    expect(result.params.maxDiscountFloorUnitPrice).toBe('124.5000')
    expect(result.params.effectiveFloorSource).toBe('max_discount')
  })

  it('leaves a negotiated price inside the cap untouched', async () => {
    const result = await guardrailsComponent.compute({
      ...args({ lookup: { negotiatedPrices: { [PRODUCT_ID]: '150.0000' } } }),
      runningUnitValue: toDecimal('166'),
      unitCostNet: toDecimal('50'),
    })
    expect(result.explainKey).toBe('pricing_engine.components.guardrails.explain.negotiated_price')
    expect(result.explainValues.priceAfter).toBe('150.0000')
    expect(result.warnings).not.toContain('pricing_engine.warnings.maxDiscountEnforced')
  })

  it('still lets the minimum margin win when it sits above the discount floor', async () => {
    const result = await guardrailsComponent.compute({
      ...args({ lookup: { negotiatedPrices: { [PRODUCT_ID]: '100.0000' } } }),
      runningUnitValue: toDecimal('166'),
      unitCostNet: toDecimal('120'),
    })
    // discount floor 124.50 < min-margin floor 120 / 0.92 = 130.4348
    expect(result.explainKey).toBe('pricing_engine.components.guardrails.explain.min_margin')
    expect(Number(result.explainValues.priceAfter)).toBeCloseTo(130.4348, 3)
  })

  it('does not cap a negotiated price when no maximum discount is configured', async () => {
    const result = await guardrailsComponent.compute({
      ...args({
        lookup: {
          guardrail: { ...DEFAULT_GUARDRAIL, maxDiscountPercent: null },
          negotiatedPrices: { [PRODUCT_ID]: '100.0000' },
        },
      }),
      runningUnitValue: toDecimal('166'),
      unitCostNet: toDecimal('50'),
    })
    expect(result.explainValues.priceAfter).toBe('100.0000')
  })

  it('does not cap the engine’s own price when nothing was negotiated', async () => {
    const result = await guardrailsComponent.compute({
      ...args(),
      runningUnitValue: toDecimal('166'),
      unitCostNet: toDecimal('100'),
    })
    expect(result.params.maxDiscountFloorUnitPrice).toBeUndefined()
    expect(result.value).toBe('1.0000')
  })

  it('reports the binding floor for rounding even when no floor moved the price', async () => {
    const result = await guardrailsComponent.compute({
      ...args(),
      runningUnitValue: toDecimal('166'),
      unitCostNet: toDecimal('100'),
    })
    // min-margin floor 100 / 0.92 = 108.6957; the price is above it, so nothing clamps
    expect(Number(result.params.roundingFloorUnitPrice)).toBeCloseTo(108.6957, 3)
  })
})

describe('rounding never undercuts a guardrail floor', () => {
  it('rounds up onto the grid when ordinary rounding would go below the floor', async () => {
    const result = await roundingComponent.compute({
      ...args(),
      runningUnitValue: toDecimal('108.6949'),
      priorResults: [guardrailWithFloor('108.6949')],
    })
    expect(result.inputs.priceAfter).toBe('108.7000')
    expect(result.explainKey).toBe('pricing_engine.components.rounding.explainKeptAboveFloor')
  })

  it('rounds normally when the result stays at or above the floor', async () => {
    const result = await roundingComponent.compute({
      ...args(),
      runningUnitValue: toDecimal('108.6957'),
      priorResults: [guardrailWithFloor('108.6957')],
    })
    expect(result.inputs.priceAfter).toBe('108.7000')
    expect(result.explainKey).toBe('pricing_engine.components.rounding.explain')
  })

  it('lifts a price the 4dp guardrail factor left a fraction under the floor', async () => {
    const result = await roundingComponent.compute({
      ...args(),
      runningUnitValue: toDecimal('112.6000'),
      priorResults: [guardrailWithFloor('112.6001')],
    })
    expect(result.inputs.priceAfter).toBe('112.6100')
  })

  it('keeps a charm ending above the floor', async () => {
    const result = await roundingComponent.compute({
      ...args({ supplier: { roundingPolicy: { step: '0.01', endingCharm: '0.99' } } }),
      runningUnitValue: toDecimal('109.1000'),
      priorResults: [guardrailWithFloor('109.1000')],
    })
    // Plain charm rounding would give 108.99, below the floor; the next charm price is 109.99.
    expect(result.inputs.priceAfter).toBe('109.9900')
  })

  it('behaves exactly as before when no guardrail result is available', async () => {
    const result = await roundingComponent.compute({ ...args(), runningUnitValue: toDecimal('18.4267') })
    expect(result.value).toBe('0.0033')
  })
})

describe('product_aspects reads dimensions like warehouse_cost', () => {
  it('treats dimensions without a unit as unknown instead of assuming centimetres', async () => {
    const result = await productAspectsComponent.compute(
      args({ product: { weightValue: '5.0000', weightUnit: 'kg', dimensions: { width: 80, height: 60, depth: 60 } } }),
    )
    expect(result.value).toBe('1.0000')
    expect(result.warnings).toContain('pricing_engine.warnings.productAspectsDimensionUnitUnknown')
  })

  it('accepts `length` in place of `depth`', async () => {
    const result = await productAspectsComponent.compute(
      args({ product: { weightValue: '5.0000', weightUnit: 'kg', dimensions: { width: 80, height: 60, length: 60, unit: 'cm' } } }),
    )
    expect(result.explainValues.aspects).toBe('oversize')
  })
})
