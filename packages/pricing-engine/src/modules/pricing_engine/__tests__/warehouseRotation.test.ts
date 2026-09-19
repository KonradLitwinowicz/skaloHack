import { warehouseCostComponent } from '../lib/components/warehouseCost'
import { toDecimal, ZERO } from '../lib/decimal'
import type { InventoryRotationSource } from '../lib/types'
import { buildContext, buildDeps, buildInventory } from './fixtures'

const MEASURED_ROTATION = {
  source: 'movements' as InventoryRotationSource,
  onHandQuantity: '120.0000',
  issuedQuantity: '60.0000',
  observedDays: 90,
  dailyIssueRate: '0.6667',
}

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

describe('warehouse_cost rotation', () => {
  it('prices exactly as before when no inventory snapshot is supplied', async () => {
    const result = await warehouseCostComponent.compute({ ...args(), unitCostNet: toDecimal('20') })
    expect(result.value).toBe('0.7654')
    expect(result.confidence).toBe('estimated')
    expect(result.inputs.turnoverDays).toBe('30.0000')
    expect(result.inputs.turnoverSource).toBe('unavailable')
    expect(result.explainKey).toBe('pricing_engine.components.warehouseCost.explain.estimated')
    expect(result.warnings).toContain('pricing_engine.warnings.warehouseTurnoverAssumed')
    expect(result.warnings).toContain('pricing_engine.warnings.warehouseRotationUnavailable')
  })

  it('doubles the storage charge when the measured cover doubles', async () => {
    // Capital is pinned to zero so the comparison is the space charge alone and the doubling is
    // exact rather than close — frozen capital rounds at the money scale and would blur it.
    const thirty = await warehouseCostComponent.compute({
      ...args({ inventory: buildInventory({ rotation: { ...MEASURED_ROTATION, coverDays: '30.0000' } }) }),
      componentValues: { product_cost: '0.0000' },
    })
    const sixty = await warehouseCostComponent.compute({
      ...args({ inventory: buildInventory({ rotation: { ...MEASURED_ROTATION, coverDays: '60.0000' } }) }),
      componentValues: { product_cost: '0.0000' },
    })
    expect(thirty.value).toBe('0.6175')
    expect(sixty.value).toBe('1.2350')
    expect(Number(sixty.value)).toBe(Number(thirty.value) * 2)
  })

  it('stops calling turnover an assumption once it is measured', async () => {
    const result = await warehouseCostComponent.compute({
      ...args({ inventory: buildInventory({ rotation: { ...MEASURED_ROTATION, coverDays: '60.0000' } }) }),
      unitCostNet: toDecimal('20'),
    })
    expect(result.warnings).not.toContain('pricing_engine.warnings.warehouseTurnoverAssumed')
    expect(result.inputs.turnoverSource).toBe('movements')
    expect(result.inputs.turnoverDays).toBe('60.0000')
    expect(result.inputs.observedDays).toBe(90)
    expect(result.inputs.dailyIssueRate).toBe('0.6667')
    expect(result.inputs.onHandQuantity).toBe('120.0000')
    expect(result.inputs.issuedQuantity).toBe('60.0000')
    expect(result.explainKey).toBe('pricing_engine.components.warehouseCost.explain.estimatedMeasured')
    expect(result.explainValues.turnoverDays).toBe('60.0')
  })

  it('does not let a measured rotation lift confidence past the assumed slot geometry', async () => {
    const result = await warehouseCostComponent.compute({
      ...args({ inventory: buildInventory({ rotation: { ...MEASURED_ROTATION, coverDays: '60.0000' } }) }),
      unitCostNet: toDecimal('20'),
    })
    expect(result.confidence).toBe('estimated')
    expect(result.confidence).not.toBe('measured')
  })

  it('keeps the lower of the two dimensions when occupancy itself is a fallback', async () => {
    const result = await warehouseCostComponent.compute({
      ...args({
        product: { weightValue: null, dimensions: null },
        lookup: { componentPayloads: { warehouse_cost: { occupancyShare: '0.02' } } },
        inventory: buildInventory({ rotation: { ...MEASURED_ROTATION, coverDays: '60.0000' } }),
      }),
      unitCostNet: toDecimal('20'),
    })
    expect(result.confidence).toBe('default')
    expect(result.explainKey).toBe('pricing_engine.components.warehouseCost.explain.fallbackShareMeasured')
  })

  it('names the reason whenever it falls back to the configured turnover', async () => {
    const expected: Record<Exclude<InventoryRotationSource, 'movements'>, string> = {
      no_movements: 'pricing_engine.warnings.warehouseRotationNoMovements',
      no_issues: 'pricing_engine.warnings.warehouseRotationNoIssues',
      no_stock: 'pricing_engine.warnings.warehouseRotationNoStock',
      short_history: 'pricing_engine.warnings.warehouseRotationShortHistory',
      unavailable: 'pricing_engine.warnings.warehouseRotationUnavailable',
    }
    for (const [source, key] of Object.entries(expected)) {
      const result = await warehouseCostComponent.compute({
        ...args({
          inventory: buildInventory({
            rotation: { source: source as InventoryRotationSource, coverDays: null },
          }),
        }),
        unitCostNet: toDecimal('20'),
      })
      expect(result.warnings).toContain(key)
      expect(result.warnings).toContain('pricing_engine.warnings.warehouseTurnoverAssumed')
      expect(result.inputs.turnoverDays).toBe('30.0000')
      expect(result.value).toBe('0.7654')
    }
  })

  it('refuses to treat a movements label without a cover figure as a measurement', async () => {
    const result = await warehouseCostComponent.compute({
      ...args({ inventory: buildInventory({ rotation: { ...MEASURED_ROTATION, coverDays: null } }) }),
      unitCostNet: toDecimal('20'),
    })
    expect(result.inputs.turnoverDays).toBe('30.0000')
    expect(result.warnings).toContain('pricing_engine.warnings.warehouseTurnoverAssumed')
    expect(result.explainKey).toBe('pricing_engine.components.warehouseCost.explain.estimated')
  })
})
