import { implementedComponents } from '../lib/components'
import { productCostComponent, STALE_PURCHASE_COST_DAYS } from '../lib/components/productCost'
import { operationalCostBaseComponent } from '../lib/components/operationalCostBase'
import { targetMarginComponent } from '../lib/components/targetMargin'
import { guardrailsComponent } from '../lib/components/guardrails'
import { roundingComponent } from '../lib/components/rounding'
import { toDecimal, ZERO } from '../lib/decimal'
import { buildContext, buildDeps, PRODUCT_ID, QUOTE_DATE } from './fixtures'

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

describe('product_cost', () => {
  it('applies the current rebate tier to the last delivery cost', async () => {
    const result = await productCostComponent.compute(
      args({ product: { purchase: { ...buildDeps().catalog.byProductId.get(PRODUCT_ID)!.purchase!, currentTierDiscount: '6.0000' } } }),
    )
    expect(result.value).toBe('18.8000')
    expect(result.confidence).toBe('measured')
    expect(result.warnings ?? []).not.toContain('pricing_engine.warnings.purchaseCostStale')
  })

  it('downgrades confidence and warns when the delivery is stale', async () => {
    const stale = new Date(QUOTE_DATE.getTime() - (STALE_PURCHASE_COST_DAYS + 5) * 86_400_000)
    const base = buildDeps().catalog.byProductId.get(PRODUCT_ID)!.purchase!
    const result = await productCostComponent.compute(
      args({ product: { purchase: { ...base, lastDeliveryAt: stale } } }),
    )
    expect(result.confidence).toBe('estimated')
    expect(result.warnings).toContain('pricing_engine.warnings.purchaseCostStale')
  })

  it('warns when bought and sold quantities diverge by more than 30%', async () => {
    const base = buildDeps().catalog.byProductId.get(PRODUCT_ID)!.purchase!
    const result = await productCostComponent.compute(
      args({ product: { purchase: { ...base, lastDeliveryQuantity: '120', soldQuantityPeriod: '20' } } }),
    )
    expect(result.warnings).toContain('pricing_engine.warnings.purchaseQuantityDivergence')
  })

  it('refuses to invent a cost when no purchase position exists', async () => {
    const result = await productCostComponent.compute(args({ product: { purchase: null } }))
    expect(result.value).toBe('0.0000')
    expect(result.confidence).toBe('default')
    expect(result.warnings).toContain('pricing_engine.warnings.purchaseCostMissing')
  })
})

describe('operational_cost_base', () => {
  // Order intake: 6 min x 85 PLN/h x 1.22 overhead = 10.37 PLN at multiplier 1.
  // The distributor measured roughly 3.60 PLN on a structured file and 25.60 PLN by phone.
  it('reproduces the measured channel cost spread', async () => {
    const context = buildContext({ orderScenarioCode: 'ideal_file' })
    const onlyIntake = {
      lookup: {
        steps: [
          {
            code: 'order_intake',
            labelKey: 'pricing_engine.steps.orderIntake',
            roleCode: 'sales_rep',
            durationMinutes: '6.0000',
            isPerLine: false,
            isPerOrder: true,
          },
        ],
      },
    }

    const ideal = await operationalCostBaseComponent.compute({
      ...args(onlyIntake),
      context,
      quantity: toDecimal('1'),
    })
    const phone = await operationalCostBaseComponent.compute({
      ...args(onlyIntake),
      context: buildContext({ orderScenarioCode: 'phone' }),
      quantity: toDecimal('1'),
    })

    expect(Number(ideal.value)).toBeCloseTo(3.63, 1)
    expect(Number(phone.value)).toBeCloseTo(25.61, 1)
  })

  it('spreads the line cost across the ordered units', async () => {
    const one = await operationalCostBaseComponent.compute({ ...args(), quantity: toDecimal('1') })
    const many = await operationalCostBaseComponent.compute({ ...args(), quantity: toDecimal('10') })
    // Tolerance is 3dp, not 4: the per-unit amount is rounded to the money scale, so a tenth of
    // 16.0125 is reported as 1.6013 rather than 1.60125. That rounding is the intended behaviour.
    expect(Number(many.value)).toBeCloseTo(Number(one.value) / 10, 3)
  })

  it('warns instead of guessing when no scenario matches', async () => {
    const result = await operationalCostBaseComponent.compute({
      ...args(),
      context: buildContext({ orderScenarioCode: 'does_not_exist' }),
    })
    expect(result.warnings).toContain('pricing_engine.warnings.orderScenarioMissing')
    expect(result.confidence).toBe('default')
  })
})

describe('target_margin', () => {
  it('applies the configured markup and reports the derived margin', async () => {
    const result = await targetMarginComponent.compute({
      ...args(),
      runningUnitValue: toDecimal('100'),
    })
    expect(result.value).toBe('1.6600')
    expect(result.explainValues.markupPercent).toBe('66.0000')
    expect(result.explainValues.marginPercent).toBe('39.7590')
  })

  it('prefers a component parameter over the supplier default', async () => {
    const result = await targetMarginComponent.compute({
      ...args({ lookup: { componentPayloads: { target_margin: { targetMarkupPercent: '40' } } } }),
      runningUnitValue: toDecimal('100'),
    })
    expect(result.value).toBe('1.4000')
    expect(result.confidence).toBe('measured')
  })
})

describe('guardrails', () => {
  it('leaves a healthy price untouched', async () => {
    const result = await guardrailsComponent.compute({
      ...args(),
      runningUnitValue: toDecimal('166'),
      unitCostNet: toDecimal('100'),
    })
    expect(result.value).toBe('1.0000')
    expect(result.explainKey).toBe('pricing_engine.components.guardrails.explain.none')
  })

  it('raises a price that would breach the minimum margin', async () => {
    const result = await guardrailsComponent.compute({
      ...args(),
      runningUnitValue: toDecimal('101'),
      unitCostNet: toDecimal('100'),
    })
    // price_min = cost / (1 - 0.08) = 108.6957
    expect(Number(result.explainValues.priceAfter)).toBeCloseTo(108.6957, 3)
    expect(result.warnings).toContain('pricing_engine.warnings.minMarginEnforced')
  })

  it('lets a negotiated price win', async () => {
    const result = await guardrailsComponent.compute({
      ...args({ lookup: { negotiatedPrices: { [PRODUCT_ID]: '150.0000' } } }),
      runningUnitValue: toDecimal('166'),
      unitCostNet: toDecimal('100'),
    })
    expect(result.explainKey).toBe('pricing_engine.components.guardrails.explain.negotiated_price')
    expect(result.explainValues.priceAfter).toBe('150.0000')
  })
})

describe('rounding', () => {
  it('reports the signed delta to the nearest step', async () => {
    const result = await roundingComponent.compute({ ...args(), runningUnitValue: toDecimal('18.4267') })
    expect(result.value).toBe('0.0033')
  })
})

describe('pipeline registry', () => {
  it('keeps component positions unique and ordered', () => {
    const positions = implementedComponents.map((component) => component.position)
    expect(new Set(positions).size).toBe(positions.length)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions.slice().sort((a, b) => a - b))
  })
})
