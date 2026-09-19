import { guardrailsComponent } from '../lib/components/guardrails'
import { toDecimal } from '../lib/decimal'
import type { InventorySnapshot, ProductLotSnapshot } from '../lib/types'
import { buildContext, buildDeps, buildInventory, buildLot, PRODUCT_ID, QUOTE_DATE } from './fixtures'

const MS_PER_DAY = 86_400_000

const HAZARDOUS_LADDER = {
  earlyThresholdPercent: '25',
  atCostThresholdPercent: '10',
  salvageThresholdPercent: '5',
  earlyMarginPercent: '5',
  disposalRatePerKg: '6.00',
  defaultShelfLifeDays: 365,
}

function daysFromQuote(days: number): Date {
  return new Date(QUOTE_DATE.getTime() + days * MS_PER_DAY)
}

function lotWithFraction(
  remainingDays: number,
  totalDays: number,
  overrides: Partial<ProductLotSnapshot> = {},
): ProductLotSnapshot {
  return buildLot({
    lotNumber: 'L-CHEM-0070',
    manufacturedAt: daysFromQuote(remainingDays - totalDays),
    expiresAt: daysFromQuote(remainingDays),
    quantityAvailable: '30.0000',
    ...overrides,
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

function inventoryWith(lots: ProductLotSnapshot[]): InventorySnapshot {
  return buildInventory({ lots })
}

describe('guardrails without stock', () => {
  // The regression that matters most: every existing quote must price exactly as it did before
  // stock entered the model. `deps.inventory` is undefined unless a caller supplies it.
  it('is bit-for-bit unchanged when no inventory snapshot is supplied', async () => {
    const result = await guardrailsComponent.compute(
      args({}, { runningUnitValue: '166', unitCostNet: '100' }),
    )
    expect(result.value).toBe('1.0000')
    expect(result.explainKey).toBe('pricing_engine.components.guardrails.explain.none')
    expect(result.params).not.toHaveProperty('shelfLifeStage')
    expect(result.inputs).not.toHaveProperty('lotAllocations')
    expect(result.confidence).toBe('measured')
  })

  it('still raises a price that would breach the minimum margin', async () => {
    const result = await guardrailsComponent.compute(
      args({}, { runningUnitValue: '101', unitCostNet: '100' }),
    )
    expect(Number(result.explainValues.priceAfter)).toBeCloseTo(108.6957, 3)
    expect(result.warnings).toContain('pricing_engine.warnings.minMarginEnforced')
  })

  it('leaves the price alone when the product has lots but none of them is near its date', async () => {
    const result = await guardrailsComponent.compute(
      args(
        { inventory: inventoryWith([lotWithFraction(300, 400, { quantityAvailable: '500.0000' })]) },
        { runningUnitValue: '166', unitCostNet: '100' },
      ),
    )
    expect(result.value).toBe('1.0000')
    expect(result.explainKey).toBe('pricing_engine.components.guardrails.explain.none')
  })
})

describe('guardrails with an expiring lot', () => {
  // The ladder is an ENTITLEMENT to discount, not a discount. A price already above the expiry
  // floor is left exactly where it was: quoting cost price to a customer who would have paid full
  // price, because one crate in the warehouse is ageing, throws away margin that was never at risk.
  it('lowers the floor without touching a price that already sits above it', async () => {
    const result = await guardrailsComponent.compute(
      args(
        { inventory: inventoryWith([lotWithFraction(20, 400, { quantityAvailable: '100.0000' })]) },
        { quantity: '24', runningUnitValue: '45', unitCostNet: '20' },
      ),
    )

    expect(result.value).toBe('1.0000')
    expect(result.explainValues.priceAfter).toBe('45.0000')
    expect(result.explainKey).toBe('pricing_engine.components.guardrails.explain.shelfLifeHeadroom')
    expect(result.params.shelfLifeStage).toBe('at_cost')
    expect(result.params.shelfLifeFloorUnitPrice).toBe('20.0000')
    expect(result.params.floorHeadroomPerUnit).toBe('25.0000')
    expect(result.warnings).not.toContain('pricing_engine.warnings.minMarginEnforced')
  })

  // The ordinary 8% floor would have demanded 21.74. The ladder replaces it with cost, so a rep who
  // takes the price down to 20 is now inside the rules instead of being clamped back up.
  it('clamps to the ladder floor instead of the ordinary margin floor', async () => {
    const result = await guardrailsComponent.compute(
      args(
        { inventory: inventoryWith([lotWithFraction(20, 400, { quantityAvailable: '100.0000' })]) },
        { quantity: '24', runningUnitValue: '12', unitCostNet: '20' },
      ),
    )

    expect(result.explainValues.priceAfter).toBe('20.0000')
    expect(result.explainKey).toBe('pricing_engine.components.guardrails.explain.shelfLifeMarkdown')
    expect(result.warnings).not.toContain('pricing_engine.warnings.minMarginEnforced')
  })

  it('blends the floor across the lots FEFO would actually consume', async () => {
    const result = await guardrailsComponent.compute(
      args(
        { inventory: inventoryWith([lotWithFraction(20, 400, { quantityAvailable: '30.0000' })]) },
        { quantity: '100', runningUnitValue: '45', unitCostNet: '20' },
      ),
    )

    // (30 at cost + 70 at the price they would have fetched anyway) / 100.
    expect(result.params.shelfLifeFloorUnitPrice).toBe('37.5000')
    expect(result.params.markdownQuantity).toBe('30.0000')
    expect(result.explainValues.priceAfter).toBe('45.0000')
  })

  it('never lets a price fall below the salvage floor, however low it arrived', async () => {
    const deps = {
      inventory: inventoryWith([lotWithFraction(10, 400, { quantityAvailable: '100.0000' })]),
      lookup: { componentPayloads: { shelf_life_markdown: HAZARDOUS_LADDER } },
    }
    const alreadyLow = await guardrailsComponent.compute(
      args(deps, { quantity: '24', runningUnitValue: '-90', unitCostNet: '20' }),
    )

    // 5.2 kg at 6.00 PLN/kg of disposal cost: giving the unit away beats paying to destroy it.
    expect(alreadyLow.explainValues.priceAfter).toBe('-31.2000')
    expect(alreadyLow.params.salvageFloorUnitPrice).toBe('-31.2000')
    expect(alreadyLow.params.disposalRatePerKg).toBe('6.0000')
    expect(alreadyLow.confidence).toBe('measured')
  })

  it('carries the lot identity into the ledger columns', async () => {
    const result = await guardrailsComponent.compute(
      args(
        {
          inventory: inventoryWith([
            lotWithFraction(10, 400, { lotId: 'lot-0070', quantityAvailable: '65.3500' }),
          ]),
          lookup: { componentPayloads: { shelf_life_markdown: HAZARDOUS_LADDER } },
        },
        { quantity: '24', runningUnitValue: '-90', unitCostNet: '20' },
      ),
    )

    expect(result.params.leadLotId).toBe('lot-0070')
    expect(result.params.leadLotNumber).toBe('L-CHEM-0070')
    expect(result.params.leadLotDaysRemaining).toBe(10)
    expect(result.params.leadLotExpiresAt).toBe(daysFromQuote(10).toISOString())
    expect(result.explainValues.lotNumber).toBe('L-CHEM-0070')
    expect(result.explainValues.daysRemaining).toBe(10)
    expect(result.explainValues.writeOffAvoided).toBe('1307.0000')
    expect(result.explainValues.belowCostAmount).toBe('1228.8000')
    expect(result.params.belowCostAmount).toBe('1228.8000')

    const allocations = result.inputs.lotAllocations as Array<Record<string, unknown>>
    expect(allocations).toHaveLength(1)
    expect(allocations[0]).toMatchObject({
      lotId: 'lot-0070',
      lotNumber: 'L-CHEM-0070',
      stage: 'salvage',
      quantity: '24.0000',
      unitPrice: '-31.2000',
    })
  })

  // The write-off answers "what is lost if nobody buys it". Unsold stock never incurs picking,
  // packing or delivery, so it is priced at what the goods COST TO BUY, not at cost-to-serve.
  it('prices the avoided write-off at purchase cost, not at cost to serve', async () => {
    const base = args(
      {
        inventory: inventoryWith([lotWithFraction(10, 400, { quantityAvailable: '100.0000' })]),
        lookup: { componentPayloads: { shelf_life_markdown: HAZARDOUS_LADDER } },
      },
      { quantity: '24', runningUnitValue: '45', unitCostNet: '20' },
    )
    const withPurchaseCost = await guardrailsComponent.compute({
      ...base,
      componentValues: { product_cost: '14.0000' },
    })
    const withoutPurchaseCost = await guardrailsComponent.compute(base)

    expect(withPurchaseCost.explainValues.writeOffAvoided).toBe('1400.0000')
    expect(withoutPurchaseCost.explainValues.writeOffAvoided).toBe('2000.0000')
  })
})

describe('guardrails when a negotiated price collides with a markdown', () => {
  it('lets a negotiated price above the ladder floor stand untouched', async () => {
    const result = await guardrailsComponent.compute(
      args(
        {
          inventory: inventoryWith([lotWithFraction(20, 400, { quantityAvailable: '100.0000' })]),
          lookup: { negotiatedPrices: { [PRODUCT_ID]: '30.0000' } },
        },
        { quantity: '24', runningUnitValue: '45', unitCostNet: '20' },
      ),
    )

    expect(result.explainValues.priceAfter).toBe('30.0000')
    expect(result.explainKey).toBe('pricing_engine.components.guardrails.explain.shelfLifeHeadroom')
  })

  // `rules_win` means the stored rules decide, so the negotiated price is never adopted in the
  // first place and the running value meets the ladder floor on its own.
  it('holds the ladder floor under rules_win', async () => {
    const result = await guardrailsComponent.compute(
      args(
        {
          inventory: inventoryWith([lotWithFraction(20, 400, { quantityAvailable: '100.0000' })]),
          lookup: {
            negotiatedPrices: { [PRODUCT_ID]: '30.0000' },
            guardrail: {
              code: 'default',
              minMarginPercent: '8.0000',
              maxDiscountPercent: null,
              floorPrice: null,
              rounding: null,
              negotiatedPricePrecedence: 'rules_win',
            },
          },
        },
        { quantity: '24', runningUnitValue: '12', unitCostNet: '20' },
      ),
    )

    expect(result.explainValues.priceAfter).toBe('20.0000')
    expect(result.explainKey).toBe('pricing_engine.components.guardrails.explain.shelfLifeMarkdown')
  })
})
