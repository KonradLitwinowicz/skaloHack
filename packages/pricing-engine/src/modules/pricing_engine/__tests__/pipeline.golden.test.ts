import { implementedComponents } from '../lib/components'
import { add, money, mul, quantizeMoney, toDecimal, ZERO } from '../lib/decimal'
import { buildAllocation, runPipeline } from '../lib/pipeline'
import { buildContext, buildDeps, PRODUCT_ID, QUOTE_DATE } from './fixtures'

// Golden cases. A price change here must be deliberate and visible in the diff — that is the
// whole point of pinning them.
describe('pricing pipeline golden cases', () => {
  it('prices a structured-file order for a healthy position', async () => {
    const context = buildContext({ orderScenarioCode: 'ideal_file' })
    const result = await runPipeline(context, implementedComponents, buildDeps())
    const line = result.lines[0]

    // Verified by hand, component by component:
    //   product_cost          20.0000  purchase cost, no rebate tier on this fixture
    //   operational_cost_base  0.6672  16.0125 on the line (intake 3.6295 + dispatch 3.9040 +
    //                                  invoicing 4.5750 + picking 2.4400 + packing 1.4640) / 24
    //   packaging_cost         0.3152  0.12 material + 0.2/60 x 58.56 loaded warehouse rate
    //   warehouse_cost         0.7654  space 0.6175 (5.2 kg / 800 kg slot x 95.00 x 30/30)
    //                                  + capital 0.1479 (20.0000 x 9%/yr x 30/365)
    //                                  NOTE the capital base is the 20.0000 purchase cost, NOT the
    //                                  21.08 accumulated so far — frozen capital finances goods.
    //   logistics_cost         0.0000  this fixture carries no delivery zone, so the engine
    //                                  refuses to invent a distance and warns instead
    //   product_aspects        1.0000  5.2 kg is under the threshold and no dimensions on record
    //   target_margin         x1.6600  cost 21.7478 x 1.66 = 36.1013
    //   rounding              -0.0013  down to the grosz
    expect(line.unitCostNet).toBe('21.7478')
    expect(line.unitPriceNet).toBe('36.1000')
    expect(line.totalPriceNet).toBe('866.4000')
    // A hair under the configured 66% because rounding moved the price down, not up.
    expect(line.markupPercent).toBe('65.9938')
    expect(line.marginPercent).toBe('39.7568')
    expect(line.breakdown.map((component) => component.code)).toEqual([
      'product_cost',
      'operational_cost_base',
      'packaging_cost',
      'warehouse_cost',
      'logistics_cost',
      'product_aspects',
      'target_margin',
      'guardrails',
      'rounding',
    ])
    // Every gap is disclosed rather than silently defaulted.
    expect(line.warnings).toEqual(
      expect.arrayContaining([
        'pricing_engine.warnings.packagingConversionsMissing',
        'pricing_engine.warnings.warehouseTurnoverAssumed',
        'pricing_engine.warnings.deliveryZoneMissing',
      ]),
    )
  })

  it('charges more for the same line ordered by phone', async () => {
    const structured = await runPipeline(
      buildContext({ orderScenarioCode: 'ideal_file' }),
      implementedComponents,
      buildDeps(),
    )
    const phone = await runPipeline(
      buildContext({ orderScenarioCode: 'phone' }),
      implementedComponents,
      buildDeps(),
    )
    expect(Number(phone.lines[0].unitPriceNet)).toBeGreaterThan(
      Number(structured.lines[0].unitPriceNet),
    )
  })

  it('holds the minimum margin no matter how small the markup is configured', async () => {
    const deps = buildDeps({ lookup: { componentPayloads: { target_margin: { targetMarkupPercent: '0' } } } })
    const result = await runPipeline(buildContext(), implementedComponents, deps)
    const line = result.lines[0]
    expect(Number(line.marginPercent)).toBeGreaterThanOrEqual(8)
    expect(result.warnings).toContain('pricing_engine.warnings.minMarginEnforced')
  })

  it('keeps unit price x quantity equal to the line total', async () => {
    // A ledger whose printed unit price does not reproduce its printed total is not auditable.
    for (const scenario of ['ideal_file', 'phone', 'rep_visit']) {
      const result = await runPipeline(
        buildContext({ orderScenarioCode: scenario }),
        implementedComponents,
        buildDeps(),
      )
      const line = result.lines[0]
      // The oracle uses the same decimal helpers as the implementation on purpose. A float
      // oracle (Number(a) * Number(b)) can round differently from quantizeMoney, which would
      // either invent a failure or hide a real one.
      const expected = money(quantizeMoney(mul(toDecimal(line.unitPriceNet), toDecimal(line.line.quantity))))
      expect(line.totalPriceNet).toBe(expected)
    }
  })

  it('makes the waterfall add up to the final price', async () => {
    const result = await runPipeline(buildContext(), implementedComponents, buildDeps())
    const line = result.lines[0]
    let running = ZERO
    for (const component of line.breakdown) {
      const value = toDecimal(component.value)
      running = quantizeMoney(component.effect === 'add' ? add(running, value) : mul(running, value))
    }
    expect(money(running)).toBe(line.unitPriceNet)
  })

  it('is deterministic for the same context and date', async () => {
    const first = await runPipeline(buildContext(), implementedComponents, buildDeps())
    const second = await runPipeline(buildContext({ date: new Date(QUOTE_DATE) }), implementedComponents, buildDeps())
    expect(second.lines[0].unitPriceNet).toBe(first.lines[0].unitPriceNet)
    expect(second.totalNet).toBe(first.totalNet)
  })

  it('prices a position with no purchase cost without inventing one', async () => {
    const result = await runPipeline(
      buildContext(),
      implementedComponents,
      buildDeps({ product: { purchase: null } }),
    )
    expect(result.warnings).toContain('pricing_engine.warnings.purchaseCostMissing')
    expect(Number(result.lines[0].unitCostNet)).toBeGreaterThan(0) // handling cost only
  })
})

describe('basket allocation', () => {
  it('splits per-order costs by line net value', () => {
    const context = buildContext({
      lines: [
        { productId: PRODUCT_ID, quantity: '10' },
        { productId: PRODUCT_ID, quantity: '30' },
      ],
    })
    const shares = buildAllocation(context, ['20.0000', '20.0000'])
    expect(shares).toEqual(['0.2500', '0.7500'])
  })

  it('falls back to an equal split when no cost is known', () => {
    const context = buildContext({
      lines: [
        { productId: PRODUCT_ID, quantity: '10' },
        { productId: PRODUCT_ID, quantity: '30' },
      ],
    })
    expect(buildAllocation(context, ['0', '0'])).toEqual(['0.5000', '0.5000'])
  })
})
