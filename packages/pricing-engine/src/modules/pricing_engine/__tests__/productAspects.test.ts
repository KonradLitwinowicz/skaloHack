import {
  DEFAULT_HEAVY_FACTOR,
  DEFAULT_OVERSIZE_FACTOR,
  productAspectsComponent,
} from '../lib/components/productAspects'
import { money, mul, toDecimal, ZERO } from '../lib/decimal'
import { buildContext, buildDeps } from './fixtures'

const OVERSIZE_BOX = { width: 80, height: 60, depth: 60, unit: 'cm' }
const SMALL_BOX = { width: 20, height: 15, depth: 15, unit: 'cm' }

function args(overrides: Parameters<typeof buildDeps>[0] = {}, extra: Record<string, unknown> = {}) {
  const context = buildContext()
  return {
    context,
    lineIndex: 0,
    line: context.lines[0],
    quantity: toDecimal('24'),
    runningUnitValue: ZERO,
    unitCostNet: ZERO,
    // Required by `ComponentComputeArgs`: the values of components that already ran in this
    // pipeline pass. Empty here because these cases exercise one component in isolation — but the
    // field has to be PRESENT, or the fixture stops matching the contract it claims to test.
    componentValues: {},
    deps: buildDeps(overrides),
    ...extra,
  }
}

describe('product_aspects', () => {
  it('is registered as a line-level multiplier at position 6', () => {
    expect(productAspectsComponent.position).toBe(6)
    expect(productAspectsComponent.level).toBe('line')
    expect(productAspectsComponent.effect).toBe('mul')
    expect(productAspectsComponent.contributesToCost).toBe(true)
  })

  it('stays neutral for an ordinary product', async () => {
    const result = await productAspectsComponent.compute(
      args({ product: { weightValue: '5.2000', weightUnit: 'kg', dimensions: SMALL_BOX } }),
    )
    expect(result.value).toBe('1.0000')
    expect(result.explainKey).toBe('pricing_engine.components.productAspects.explain.none')
    expect(result.explainValues.aspectCount).toBe(0)
  })

  it('surcharges a heavy item above the weight threshold', async () => {
    const result = await productAspectsComponent.compute(
      args({ product: { weightValue: '30.0000', weightUnit: 'kg', dimensions: SMALL_BOX } }),
    )
    expect(result.value).toBe(money(toDecimal(DEFAULT_HEAVY_FACTOR)))
    expect(result.explainKey).toBe('pricing_engine.components.productAspects.explain.applied')
    expect(result.explainValues.aspects).toBe('heavy')
  })

  it('converts the catalog weight unit before comparing it to the threshold', async () => {
    const result = await productAspectsComponent.compute(
      args({ product: { weightValue: '30000.0000', weightUnit: 'g', dimensions: SMALL_BOX } }),
    )
    expect(result.inputs.weightKg).toBe('30.0000')
    expect(result.value).toBe('1.0400')
  })

  it('surcharges an oversize item from its dimensions', async () => {
    const result = await productAspectsComponent.compute(
      args({ product: { weightValue: '5.2000', weightUnit: 'kg', dimensions: OVERSIZE_BOX } }),
    )
    // 0.80 m x 0.60 m x 0.60 m = 0.2880 m3, past the 0.2500 m3 default threshold.
    expect(result.inputs.volumeM3).toBe('0.2880')
    expect(result.value).toBe(money(toDecimal(DEFAULT_OVERSIZE_FACTOR)))
    expect(result.explainValues.aspects).toBe('oversize')
  })

  it('compounds heavy and oversize multiplicatively', async () => {
    const result = await productAspectsComponent.compute(
      args({ product: { weightValue: '30.0000', weightUnit: 'kg', dimensions: OVERSIZE_BOX } }),
    )
    const expected = money(mul(toDecimal(DEFAULT_HEAVY_FACTOR), toDecimal(DEFAULT_OVERSIZE_FACTOR)))
    expect(result.value).toBe(expected)
    expect(result.value).toBe('1.1024')
    expect(result.explainValues.aspectCount).toBe(2)
  })

  it('applies a configured product-group factor', async () => {
    const result = await productAspectsComponent.compute(
      args({
        product: { weightValue: '5.2000', weightUnit: 'kg', dimensions: SMALL_BOX },
        lookup: {
          componentPayloads: { product_aspects: { productGroupFactors: { chemistry: '1.1500' } } },
        },
      }),
    )
    expect(result.value).toBe('1.1500')
    expect(result.explainValues.aspects).toBe('product_group')
    expect(result.params.paramRef).toBe('param-product_aspects')
  })

  it('ignores a product-group factor of exactly one', async () => {
    const result = await productAspectsComponent.compute(
      args({
        product: { weightValue: '5.2000', weightUnit: 'kg', dimensions: SMALL_BOX },
        lookup: {
          componentPayloads: { product_aspects: { productGroupFactors: { chemistry: '1' } } },
        },
      }),
    )
    expect(result.value).toBe('1.0000')
    expect(result.explainValues.aspectCount).toBe(0)
  })

  it('lets configured thresholds override the assumed ones and reports measured confidence', async () => {
    const result = await productAspectsComponent.compute(
      args({
        product: { weightValue: '5.2000', weightUnit: 'kg', dimensions: SMALL_BOX },
        lookup: {
          componentPayloads: {
            // Every figure the component consumes must be supplied before it may claim
            // 'measured' — a partial payload still leans on invented defaults.
            product_aspects: { heavyThresholdKg: '5', heavyFactor: '1.2000', oversizeThresholdM3: '0.5', oversizeFactor: '1.0000' },
          },
        },
      }),
    )
    expect(result.value).toBe('1.2000')
    expect(result.confidence).toBe('measured')
    expect(result.params.source).toBe('component_param')
    expect(result.warnings ?? []).not.toContain(
      'pricing_engine.warnings.productAspectsMultipliersAssumed',
    )
  })

  it('reports default confidence while the multipliers are assumed', async () => {
    const result = await productAspectsComponent.compute(
      args({ product: { weightValue: '30.0000', weightUnit: 'kg', dimensions: OVERSIZE_BOX } }),
    )
    expect(result.confidence).toBe('default')
    expect(result.warnings).toContain('pricing_engine.warnings.productAspectsMultipliersAssumed')
  })

  it('falls back to the weakest input when only one physical fact is on record', async () => {
    const result = await productAspectsComponent.compute(
      args({
        product: { weightValue: '5.2000', weightUnit: 'kg', dimensions: null },
        lookup: {
          componentPayloads: {
            product_aspects: {
              heavyThresholdKg: '25',
              heavyFactor: '1.04',
              oversizeThresholdM3: '0.5',
              oversizeFactor: '1.06',
            },
          },
        },
      }),
    )
    expect(result.confidence).toBe('estimated')
    expect(result.warnings).toContain('pricing_engine.warnings.productAspectsDimensionsMissing')
  })

  it('refuses to guess when neither weight nor dimensions are on record', async () => {
    const result = await productAspectsComponent.compute(
      args({ product: { weightValue: null, weightUnit: null, dimensions: null } }),
    )
    expect(result.value).toBe('1.0000')
    expect(result.confidence).toBe('default')
    expect(result.explainKey).toBe('pricing_engine.components.productAspects.explain.missing')
    expect(result.warnings).toContain('pricing_engine.warnings.productAspectsPhysicalDataMissing')
  })

  it('still applies a group factor when the physical facts are missing', async () => {
    const result = await productAspectsComponent.compute(
      args({
        product: { weightValue: null, weightUnit: null, dimensions: null },
        lookup: {
          componentPayloads: { product_aspects: { productGroupFactors: { chemistry: '1.1500' } } },
        },
      }),
    )
    expect(result.value).toBe('1.1500')
    expect(result.confidence).toBe('default')
    expect(result.warnings).toContain('pricing_engine.warnings.productAspectsPhysicalDataMissing')
  })

  it('warns instead of converting an unrecognised weight unit', async () => {
    const result = await productAspectsComponent.compute(
      args({ product: { weightValue: '30.0000', weightUnit: 'stones', dimensions: SMALL_BOX } }),
    )
    expect(result.value).toBe('1.0000')
    expect(result.inputs.weightKg).toBeNull()
    expect(result.warnings).toContain('pricing_engine.warnings.productAspectsWeightUnitUnknown')
  })

  it('warns instead of converting an unrecognised dimension unit', async () => {
    const result = await productAspectsComponent.compute(
      args({
        product: {
          weightValue: '5.2000',
          weightUnit: 'kg',
          dimensions: { width: 80, height: 60, depth: 60, unit: 'furlong' },
        },
      }),
    )
    expect(result.inputs.volumeM3).toBeNull()
    expect(result.warnings).toContain('pricing_engine.warnings.productAspectsDimensionUnitUnknown')
  })

  it('never renders a sentence — only keys and placeholder values', async () => {
    const result = await productAspectsComponent.compute(
      args({ product: { weightValue: '30.0000', weightUnit: 'kg', dimensions: OVERSIZE_BOX } }),
    )
    expect(result.explainKey.startsWith('pricing_engine.')).toBe(true)
    expect(result.labelKey).toBe('pricing_engine.components.productAspects.label')
    for (const warning of result.warnings ?? []) {
      expect(warning.startsWith('pricing_engine.warnings.')).toBe(true)
    }
  })

  it('refuses a partial payload the right to claim measured confidence', async () => {
    // Regression guard: a payload that merely EXISTS proves nothing. Half of it missing means the
    // other half silently fell back to invented defaults, which is exactly what confidence exists
    // to disclose.
    const result = await productAspectsComponent.compute(
      args({
        product: { weightValue: '5.2000', weightUnit: 'kg', dimensions: SMALL_BOX },
        lookup: {
          componentPayloads: { product_aspects: { heavyThresholdKg: '5', heavyFactor: '1.2000' } },
        },
      }),
    )
    expect(result.confidence).toBe('default')
  })

  it('refuses a factor that would zero or invert the price', async () => {
    for (const rogue of ['0', '-1.5', '99']) {
      const result = await productAspectsComponent.compute(
        args({
          product: { weightValue: '30.0000', weightUnit: 'kg', dimensions: SMALL_BOX },
          lookup: {
            componentPayloads: {
              product_aspects: {
                heavyThresholdKg: '5',
                heavyFactor: rogue,
                oversizeThresholdM3: '0.5',
                oversizeFactor: '1.0000',
              },
            },
          },
        }),
      )
      expect(result.value).toBe('1.0000')
      expect(result.warnings).toContain('pricing_engine.warnings.productAspectFactorRejected')
    }
  })
})
