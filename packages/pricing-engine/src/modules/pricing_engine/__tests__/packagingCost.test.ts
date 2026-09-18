import { packagingCostComponent, PACKAGING_COST_CODE } from '../lib/components/packagingCost'
import { toDecimal, ZERO } from '../lib/decimal'
import { buildContext, buildDeps, PRODUCT_ID } from './fixtures'

function args(
  overrides: Parameters<typeof buildDeps>[0] = {},
  extra: { quantity?: string } = {},
) {
  const context = buildContext()
  return {
    context,
    lineIndex: 0,
    line: context.lines[0],
    quantity: toDecimal(extra.quantity ?? '24'),
    runningUnitValue: ZERO,
    unitCostNet: ZERO,
    deps: buildDeps(overrides),
  }
}

function packUnit(result: Awaited<ReturnType<typeof packagingCostComponent.compute>>, unitCode: string) {
  const units = result.inputs.packUnits as Array<{ unitCode: string; count: string; cost: string }>
  return units.find((unit) => unit.unitCode === unitCode) ?? null
}

describe('packaging_cost', () => {
  // Warehouse role: 48.00 PLN/h x 1.22 overhead = 58.56 PLN/h loaded.
  // Per piece: 0.12 material + 0.2 min / 60 x 58.56 = 0.3152 PLN.
  it('prices per-item packaging from the pc row when no carton conversion exists', async () => {
    const result = await packagingCostComponent.compute(args())
    expect(result.code).toBe(PACKAGING_COST_CODE)
    expect(result.value).toBe('0.3152')
    expect(result.explainKey).toBe('pricing_engine.components.packagingCost.explain.perItemOnly')
    expect(result.warnings).toContain('pricing_engine.warnings.packagingConversionsMissing')
    expect(result.confidence).toBe('default')
  })

  // 24 pieces in boxes of 12 = 2 boxes at 1.85 material + 1.5 min / 60 x 58.56 = 3.314 each,
  // on top of per-item packaging for all 24 pieces: (7.5648 + 6.628) / 24 = 0.5914 PLN per unit.
  it('adds whole pack units once catalog unit conversions arrive', async () => {
    const result = await packagingCostComponent.compute(
      args({ product: { unitConversions: { box: '12' } } }),
    )
    expect(result.value).toBe('0.5914')
    expect(result.explainValues.lineCost).toBe('14.1928')
    expect(result.explainKey).toBe('pricing_engine.components.packagingCost.explain.packed')
    expect(result.confidence).toBe('measured')
    expect(result.warnings ?? []).toEqual([])
    expect(packUnit(result, 'box')?.count).toBe('2.0000')
  })

  it('charges only the packs a line actually fills', async () => {
    const result = await packagingCostComponent.compute(
      args({ product: { unitConversions: { box: '12' } } }, { quantity: '25' }),
    )
    expect(packUnit(result, 'box')?.count).toBe('2.0000')
    expect(result.explainValues.lineCost).toBe('14.5080')
  })

  it('ignores a pack unit the line is far too small to fill', async () => {
    const result = await packagingCostComponent.compute(
      args({ product: { unitConversions: { pallet: '240' } } }),
    )
    expect(packUnit(result, 'pallet')).toBeNull()
    expect(result.value).toBe('0.3152')
    expect(result.confidence).toBe('measured')
  })

  it('warns when a conversion unit has no packaging cost row', async () => {
    const result = await packagingCostComponent.compute(
      args({ product: { unitConversions: { crate: '6' } } }),
    )
    expect(result.warnings).toContain('pricing_engine.warnings.packagingUnitCostMissing')
    expect(result.confidence).toBe('estimated')
    expect(result.value).toBe('0.3152')
  })

  it('drops the labour term and warns when the pack role has no rate', async () => {
    const result = await packagingCostComponent.compute(
      args({ product: { unitConversions: { box: '12' } }, lookup: { laborRates: [] } }),
    )
    // Material only: 24 x 0.12 + 2 x 1.85 = 6.58 on the line, 0.2742 per unit.
    expect(result.value).toBe('0.2742')
    expect(result.warnings).toContain('pricing_engine.warnings.laborRateMissing')
    expect(result.confidence).toBe('default')
  })

  it('refuses to invent a packaging cost when nothing is configured', async () => {
    const result = await packagingCostComponent.compute(args({ lookup: { packagingCosts: [] } }))
    expect(result.value).toBe('0.0000')
    expect(result.confidence).toBe('default')
    expect(result.warnings).toContain('pricing_engine.warnings.packagingCostMissing')
    expect(result.explainKey).toBe('pricing_engine.components.packagingCost.explain.missing')
    expect(result.explainValues.sku).toBe('CHEM-014')
  })

  it('reports zero rather than dividing by an empty line', async () => {
    const result = await packagingCostComponent.compute(args({}, { quantity: '0' }))
    expect(result.value).toBe('0.0000')
  })

  it('falls back to the line product id when the catalog has no snapshot', async () => {
    const deps = buildDeps({ lookup: { packagingCosts: [] } })
    deps.catalog.byProductId.delete(PRODUCT_ID)
    const result = await packagingCostComponent.compute({ ...args({ lookup: { packagingCosts: [] } }), deps })
    expect(result.value).toBe('0.0000')
    expect(result.warnings).toContain('pricing_engine.warnings.packagingConversionsMissing')
  })

  it('is registered as an additive line-level cost component at position 3', () => {
    expect(packagingCostComponent.position).toBe(3)
    expect(packagingCostComponent.level).toBe('line')
    expect(packagingCostComponent.effect).toBe('add')
    expect(packagingCostComponent.contributesToCost).toBe(true)
    expect(packagingCostComponent.labelKey).toBe('pricing_engine.components.packagingCost.label')
  })
})
