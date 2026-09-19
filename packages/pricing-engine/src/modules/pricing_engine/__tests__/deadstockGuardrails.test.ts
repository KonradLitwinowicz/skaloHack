import { guardrailsComponent } from '../lib/components/guardrails'
import { money, toDecimal } from '../lib/decimal'
import type { AuthorisedDeadstockFloors } from '../lib/deadstock/authorisedFloor'
import type { ProductLotSnapshot } from '../lib/types'
import { buildContext, buildDeps, buildInventory, buildLot, PRODUCT_ID, QUOTE_DATE } from './fixtures'

const MS_PER_DAY = 86_400_000

function authorised(floorUnitPrice: string, stage: 'dying' | 'dead' | 'never_sold' = 'dead'): AuthorisedDeadstockFloors {
  return {
    byProductId: new Map([
      [
        PRODUCT_ID,
        {
          decisionId: '55555555-5555-4555-8555-555555555555',
          productId: PRODUCT_ID,
          floorUnitPrice: toDecimal(floorUnitPrice),
          stage,
          decidedAt: QUOTE_DATE,
          purchaseUnitCost: toDecimal('20'),
        },
      ],
    ]),
  }
}

function expiringLot(remainingDays: number, totalDays: number): ProductLotSnapshot {
  return buildLot({
    lotNumber: 'L-CHEM-0070',
    manufacturedAt: new Date(QUOTE_DATE.getTime() + (remainingDays - totalDays) * MS_PER_DAY),
    expiresAt: new Date(QUOTE_DATE.getTime() + remainingDays * MS_PER_DAY),
    quantityAvailable: '100.0000',
  })
}

function args(
  overrides: Parameters<typeof buildDeps>[0] = {},
  extra: { quantity?: string; runningUnitValue?: string; unitCostNet?: string } = {},
) {
  const context = buildContext()
  return {
    context,
    lineIndex: 0,
    line: context.lines[0],
    quantity: toDecimal(extra.quantity ?? '24'),
    runningUnitValue: toDecimal(extra.runningUnitValue ?? '45'),
    unitCostNet: toDecimal(extra.unitCostNet ?? '20'),
    componentValues: {},
    deps: buildDeps(overrides),
  }
}

describe('guardrails with no authorised deadstock floor', () => {
  it('prices exactly as before, because nobody authorised anything', async () => {
    const result = await guardrailsComponent.compute(args())

    expect(result.params.effectiveFloorSource).toBeUndefined()
    expect(result.params.deadstockFloorUnitPrice).toBeUndefined()
    expect(result.explainKey).toBe('pricing_engine.components.guardrails.explain.none')
  })
})

describe('guardrails with an authorised deadstock floor', () => {
  // The whole point of the mechanism, and the easiest thing to get wrong: without bypassing the
  // ordinary floors, `min_margin` raises the price straight back to 21.7391 and the markdown looks
  // like it is working while nothing has been discounted.
  it('lets the price go BELOW the minimum margin, which is what liquidating means', async () => {
    const result = await guardrailsComponent.compute(
      args({ deadstock: authorised('16.25') }, { runningUnitValue: '15' }),
    )

    expect(result.inputs.priceAfter).toBe('16.2500')
    expect(result.params.effectiveFloorSource).toBe('deadstock')
    expect(result.explainKey).toBe('pricing_engine.components.guardrails.explain.deadstockMarkdown')
    // 8% of a 20.00 cost would have floored this at 21.7391 without the bypass.
    expect(result.warnings).not.toContain('pricing_engine.warnings.minMarginEnforced')
  })

  it('reports how far the seller MAY still go when the price is already above the floor', async () => {
    const result = await guardrailsComponent.compute(
      args({ deadstock: authorised('16.25') }, { runningUnitValue: '45' }),
    )

    expect(result.inputs.priceAfter).toBe('45.0000')
    expect(result.explainKey).toBe('pricing_engine.components.guardrails.explain.deadstockHeadroom')
    // 45.00 - 16.25: the actionable number, and the reason a floor that moves is printed at all.
    expect(result.params.floorHeadroomPerUnit).toBe('28.7500')
  })

  it('names the decision behind the floor, so the number can be accounted for', async () => {
    const result = await guardrailsComponent.compute(
      args({ deadstock: authorised('16.25', 'never_sold') }, { runningUnitValue: '15' }),
    )

    expect(result.params.deadstockStage).toBe('never_sold')
    expect(result.params.deadstockStageLabelKey).toBe('pricing_engine.deadstock.stage.neverSold')
    expect(result.params.deadstockDecisionId).toBe('55555555-5555-4555-8555-555555555555')
  })

  it('never claims better than estimated, because the carrying rates are assumptions', async () => {
    const result = await guardrailsComponent.compute(
      args({ deadstock: authorised('16.25') }, { runningUnitValue: '15' }),
    )

    expect(result.confidence).toBe('estimated')
  })
})

describe('guardrails with both ladders open', () => {
  // They are permissions, not discounts, and permissions do not add up. The deeper one wins whole.
  it('honours the deeper floor and says which one it was', async () => {
    const shallowExpiry = buildInventory({ lots: [expiringLot(60, 365)] })
    const result = await guardrailsComponent.compute(
      args({ inventory: shallowExpiry, deadstock: authorised('12.00') }, { runningUnitValue: '10' }),
    )

    expect(result.params.effectiveFloorSource).toBe('deadstock')
    expect(result.inputs.priceAfter).toBe('12.0000')
  })

  it('leaves the expiry ladder in charge when IT is the deeper of the two', async () => {
    // Five days from its date: the salvage rung goes far below any dormancy floor.
    const nearlyExpired = buildInventory({ lots: [expiringLot(5, 365)] })
    const result = await guardrailsComponent.compute(
      args({ inventory: nearlyExpired, deadstock: authorised('16.25') }, { runningUnitValue: '10' }),
    )

    expect(result.params.effectiveFloorSource).toBe('shelf_life')
    expect(Number.parseFloat(result.inputs.priceAfter as string)).toBeLessThan(16.25)
  })

  it('does not stack the two markdowns', async () => {
    const nearlyExpired = buildInventory({ lots: [expiringLot(5, 365)] })
    const withBoth = await guardrailsComponent.compute(
      args({ inventory: nearlyExpired, deadstock: authorised('16.25') }, { runningUnitValue: '10' }),
    )
    const expiryOnly = await guardrailsComponent.compute(
      args({ inventory: nearlyExpired }, { runningUnitValue: '10' }),
    )

    expect(withBoth.inputs.priceAfter).toBe(expiryOnly.inputs.priceAfter)
  })
})

describe('effectiveFloorSource names all four floors, not only the moving ones', () => {
  // The commonest case on the customer-pricing panel: no ladder anywhere, and an ordinary floor
  // raises the price. Reporting nothing here leaves a number the seller cannot account for.
  it('names min_margin when the ordinary margin floor raises the price', async () => {
    const result = await guardrailsComponent.compute(args({}, { runningUnitValue: '15' }))

    // 20.00 cost at an 8% minimum margin: 20 / 0.92 = 21.7391.
    expect(result.inputs.priceAfter).toBe('21.7391')
    expect(result.params.effectiveFloorSource).toBe('min_margin')
    expect(result.params.effectiveFloorUnitPrice).toBe('21.7391')
    expect(result.warnings).toContain('pricing_engine.warnings.minMarginEnforced')
  })

  it('stays silent when nothing floors the price at all', async () => {
    const result = await guardrailsComponent.compute(args({}, { runningUnitValue: '45' }))

    expect(result.params.effectiveFloorSource).toBeUndefined()
    expect(result.params.effectiveFloorUnitPrice).toBeUndefined()
  })
})
