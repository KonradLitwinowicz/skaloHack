import {
  PALLET_SLOT_CAPACITY_KG,
  PALLET_SLOT_VOLUME_M3,
  warehouseCostComponent,
} from '../lib/components/warehouseCost'
import { toDecimal, ZERO } from '../lib/decimal'
import { buildContext, buildDeps, DEMO_WAREHOUSE } from './fixtures'

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

const BULKY_DIMENSIONS = { width: 60, height: 50, depth: 40, unit: 'cm' }

describe('warehouse_cost', () => {
  it('derives the slot share from weight when no dimensions are on record', async () => {
    const result = await warehouseCostComponent.compute({ ...args(), unitCostNet: toDecimal('20') })
    // 5.2 kg of 800 kg = 0.0065 of a slot x 95 PLN/month x 30/30 = 0.6175 of space,
    // plus 20 PLN x 9% x 30/365 = 0.1479 of frozen capital.
    expect(result.value).toBe('0.7654')
    expect(result.inputs.occupancySource).toBe('weight')
    expect(result.confidence).toBe('estimated')
    expect(result.warnings).toContain('pricing_engine.warnings.warehouseDimensionsMissing')
  })

  it('lets the binding ceiling win when volume beats weight', async () => {
    const result = await warehouseCostComponent.compute({
      ...args({ product: { dimensions: BULKY_DIMENSIONS } }),
      unitCostNet: toDecimal('20'),
    })
    // 0.12 m3 of a 1.728 m3 slot = 0.069444, well past the 0.0065 the weight alone implies.
    expect(result.inputs.occupancySource).toBe('dimensions')
    expect(Number(result.inputs.occupancyShare)).toBeCloseTo(0.069444, 5)
    expect(Number(result.value)).toBeCloseTo(6.7452, 4)
    expect(result.explainKey).toBe('pricing_engine.components.warehouseCost.explain.estimated')
  })

  it('prices an m2 basis off the floor footprint, ignoring weight', async () => {
    const result = await warehouseCostComponent.compute(
      args({
        product: { dimensions: BULKY_DIMENSIONS },
        lookup: {
          warehouseCost: {
            basis: 'm2',
            costPerMonth: '48.0000',
            capitalCostAnnualRate: '9.0000',
            defaultTurnoverDays: 30,
          },
        },
      }),
    )
    // 0.6 m x 0.4 m = 0.24 m2 x 48 PLN/m2/month x 30/30.
    expect(result.value).toBe('11.5200')
    expect(result.inputs.volumeM3).toBeNull()
  })

  it('charges frozen capital on the purchase cost, not on the accumulated cost', async () => {
    // Frozen capital finances the GOODS. Charging it on unitCostNet would finance the picking
    // labour and packaging that have not been paid out yet, and would grow every time a new cost
    // component is added ahead of this one. Here the accumulated cost is 100 but the goods cost
    // 80, so the 9%/year charge over a full year is 7.20, not 9.00.
    const result = await warehouseCostComponent.compute({
      ...args({
        product: { weightValue: null, dimensions: null },
        lookup: {
          warehouseCost: { ...DEMO_WAREHOUSE, costPerMonth: '0.0000', defaultTurnoverDays: 365 },
        },
      }),
      unitCostNet: toDecimal('100'),
      componentValues: { product_cost: '80.0000' },
    })
    expect(result.value).toBe('7.2000')
    expect(result.inputs.capitalCost).toBe('7.2000')
  })

  it('falls back to the accumulated cost and warns when product_cost never ran', async () => {
    const result = await warehouseCostComponent.compute({
      ...args({
        product: { weightValue: null, dimensions: null },
        lookup: {
          warehouseCost: { ...DEMO_WAREHOUSE, costPerMonth: '0.0000', defaultTurnoverDays: 365 },
        },
      }),
      unitCostNet: toDecimal('100'),
      componentValues: {},
    })
    expect(result.value).toBe('9.0000')
    expect(result.warnings).toContain('pricing_engine.warnings.capitalBaseFallback')
  })

  it('scales the space charge with the turnover assumption', async () => {
    const thirtyDays = await warehouseCostComponent.compute(args())
    const sixtyDays = await warehouseCostComponent.compute(
      args({ lookup: { warehouseCost: { ...DEMO_WAREHOUSE, defaultTurnoverDays: 60 } } }),
    )
    expect(Number(sixtyDays.value)).toBeCloseTo(Number(thirtyDays.value) * 2, 4)
  })

  it('treats dimensions without a unit as unusable rather than guessing centimetres', async () => {
    const result = await warehouseCostComponent.compute(
      args({ product: { dimensions: { width: 60, height: 50, depth: 40 } } }),
    )
    expect(result.inputs.occupancySource).toBe('weight')
    expect(result.warnings).toContain('pricing_engine.warnings.warehouseDimensionsMissing')
  })

  it('falls back to the configured occupancy share and drops to default confidence', async () => {
    const result = await warehouseCostComponent.compute(
      args({
        product: { weightValue: null, dimensions: null },
        lookup: { componentPayloads: { warehouse_cost: { occupancyShare: '0.02' } } },
      }),
    )
    expect(result.value).toBe('1.9000')
    expect(result.confidence).toBe('default')
    expect(result.explainKey).toBe('pricing_engine.components.warehouseCost.explain.fallbackShare')
    expect(result.warnings).toContain('pricing_engine.warnings.warehouseOccupancyFallback')
  })

  it('charges capital only when nothing describes how much space the unit takes', async () => {
    const result = await warehouseCostComponent.compute({
      ...args({ product: { weightValue: null, dimensions: null } }),
      unitCostNet: toDecimal('20'),
    })
    expect(result.value).toBe('0.1479')
    expect(result.confidence).toBe('default')
    expect(result.explainKey).toBe('pricing_engine.components.warehouseCost.explain.capitalOnly')
    expect(result.warnings).toContain('pricing_engine.warnings.warehouseOccupancyMissing')
  })

  it('refuses to invent a storage cost when no warehouse row is configured', async () => {
    const result = await warehouseCostComponent.compute({
      ...args({ lookup: { warehouseCost: null } }),
      unitCostNet: toDecimal('20'),
    })
    expect(result.value).toBe('0.0000')
    expect(result.confidence).toBe('default')
    expect(result.explainKey).toBe('pricing_engine.components.warehouseCost.explain.missing')
    expect(result.warnings).toContain('pricing_engine.warnings.warehouseCostMissing')
  })

  it('always says that turnover days is an assumption, never a measurement', async () => {
    const result = await warehouseCostComponent.compute({
      ...args({ product: { dimensions: BULKY_DIMENSIONS } }),
      unitCostNet: toDecimal('20'),
    })
    expect(result.warnings).toContain('pricing_engine.warnings.warehouseTurnoverAssumed')
    expect(result.confidence).not.toBe('measured')
  })

  it('reports an explainable result, never a rendered sentence', async () => {
    const result = await warehouseCostComponent.compute(args())
    expect(result.code).toBe('warehouse_cost')
    expect(result.effect).toBe('add')
    expect(result.explainKey.startsWith('pricing_engine.')).toBe(true)
    expect(result.explainValues.currency).toBe('PLN')
    expect(result.params.basis).toBe(DEMO_WAREHOUSE.basis)
  })

  it('pins the pallet slot envelope the occupancy share is measured against', () => {
    expect(PALLET_SLOT_VOLUME_M3).toBe('1.728')
    expect(PALLET_SLOT_CAPACITY_KG).toBe('800')
    expect(warehouseCostComponent.position).toBe(4)
    expect(warehouseCostComponent.contributesToCost).toBe(true)
  })
})
