import { toDecimal } from '../lib/decimal'
import { basketProfitOf, type AdvisorRun, type BasketOverrides } from '../lib/advisor/runner'
import { generateFullPackRoundingSuggestions } from '../lib/advisor/suggestions/fullPackRounding'
import { generateOrderChannelChangeSuggestions } from '../lib/advisor/suggestions/orderChannelChange'
import { generateVolumeThresholdSuggestions } from '../lib/advisor/suggestions/volumeThreshold'
import { generateCheaperEquivalentSuggestions } from '../lib/advisor/suggestions/cheaperEquivalent'
import { computeVolumeSensitivity } from '../lib/advisor/volumeSensitivity'
import { computeMarginFloors } from '../lib/advisor/insights'
import { priceWithInputs, type PricingInputs } from '../services/pricingService'
import type { AdvisorOptions } from '../lib/advisor/schemas'
import type { CatalogProductSnapshot, PricingBasketLine, PricingContext } from '../lib/types'
import { buildContext, buildDeps, buildProduct, PRODUCT_ID } from './fixtures'

const SIBLING_PRODUCT_ID = '55555555-5555-4555-8555-555555555555'
const SCENARIO_CODES = ['ideal_file', 'nonstandard_file', 'email', 'sms', 'phone', 'rep_visit']

type HarnessOptions = {
  product?: Partial<CatalogProductSnapshot>
  siblings?: CatalogProductSnapshot[]
  lookup?: NonNullable<Parameters<typeof buildDeps>[0]>['lookup']
  context?: Partial<PricingContext>
  advisor?: AdvisorOptions
}

// The advisor's unit-test seam: `buildDeps` already assembles a ComponentDeps with no database, so
// every perturbation below runs the real pipeline against in-memory parameters.
async function buildRun(options: HarnessOptions = {}): Promise<AdvisorRun> {
  const deps = buildDeps({ product: options.product, lookup: options.lookup })
  const catalog = new Map(deps.catalog.byProductId)
  for (const sibling of options.siblings ?? []) catalog.set(sibling.productId, sibling)

  const inputs: PricingInputs = {
    supplier: deps.supplier,
    params: deps.params,
    catalog: { byProductId: catalog },
    indicators: deps.indicators,
    customerProfile: null,
    orderScenarioCodes: SCENARIO_CODES,
  }

  const context = buildContext({ customerId: null, ...options.context })
  const price = (lines: PricingBasketLine[], basketOverrides?: BasketOverrides) =>
    priceWithInputs(
      { ...context, lines },
      inputs,
      basketOverrides?.orderScenarioCode ? { orderScenarioCode: basketOverrides.orderScenarioCode } : undefined,
    )

  return {
    context,
    baseline: await price(context.lines),
    inputs,
    price,
    options: options.advisor ?? { maxPerKind: 5 },
  }
}

describe('full_pack_rounding', () => {
  it('skips a degenerate box conversion whose factor is 1', async () => {
    const run = await buildRun({ product: { unitConversions: { box: '1' } } })
    expect(await generateFullPackRoundingSuggestions(run)).toEqual([])
  })

  it('skips a line that already fills whole packs', async () => {
    const run = await buildRun({ product: { unitConversions: { box: '12' } } })
    expect(await generateFullPackRoundingSuggestions(run)).toEqual([])
  })

  it('rounds 24 up to the next whole carton of 10 and reports both sides', async () => {
    const run = await buildRun({ product: { unitConversions: { box: '10' } } })
    const [suggestion] = await generateFullPackRoundingSuggestions(run)

    expect(suggestion.code).toBe('full_pack_rounding')
    expect(suggestion.change).toMatchObject({ fromQuantity: '24', toQuantity: '30' })
    expect(suggestion.explainValues.packUnitCode).toBe('box')
    expect(Number(suggestion.basketProfitAfter)).toBeGreaterThan(Number(suggestion.basketProfitBefore))
    expect(suggestion.raisesCustomerPrice).toBe(
      Number(suggestion.customerUnitPriceAfter) > Number(suggestion.customerUnitPriceBefore),
    )
  })

  it('reports a pack crossing that RAISES the unit price rather than suppressing it', async () => {
    // A carton costing 500 to pack swamps the per-order amortisation, so crossing the boundary
    // genuinely makes every unit dearer. The generator must say so, not hide it.
    const run = await buildRun({
      product: { unitConversions: { box: '10' } },
      lookup: {
        packagingCosts: [
          { unitCode: 'pc', materialCost: '0.1200', packMinutes: '0.2000', roleCode: 'warehouse' },
          { unitCode: 'box', materialCost: '500.0000', packMinutes: '1.5000', roleCode: 'warehouse' },
        ],
      },
    })
    const [suggestion] = await generateFullPackRoundingSuggestions(run)

    expect(Number(suggestion.customerUnitPriceAfter)).toBeGreaterThan(
      Number(suggestion.customerUnitPriceBefore),
    )
    expect(suggestion.raisesCustomerPrice).toBe(true)
    expect(suggestion.explainKey).toBe('pricing_engine.advisor.suggestion.fullPackRounding.explainRaises')
  })
})

describe('volume_threshold', () => {
  it('only offers quantities that lower the unit price AND raise basket profit', async () => {
    const run = await buildRun({ product: { unitConversions: { box: '10' } } })
    const suggestions = await generateVolumeThresholdSuggestions(run)

    expect(suggestions.length).toBeGreaterThan(0)
    for (const suggestion of suggestions) {
      expect(Number(suggestion.customerUnitPriceAfter)).toBeLessThan(
        Number(suggestion.customerUnitPriceBefore),
      )
      expect(Number(suggestion.basketProfitAfter)).toBeGreaterThan(Number(suggestion.basketProfitBefore))
      expect(suggestion.raisesCustomerPrice).toBe(false)
      expect(Number(suggestion.change.toQuantity)).toBeGreaterThan(Number(suggestion.change.fromQuantity))
    }
  })

  it('flags the annual purchase tier when the added units would close the gap', async () => {
    const run = await buildRun({
      product: {
        purchase: {
          ...buildProduct().purchase!,
          annualVolume: '1000',
          nextTierVolume: '1005',
          nextTierDiscount: '9.0000',
        },
      },
    })
    const suggestions = await generateVolumeThresholdSuggestions(run)
    expect(suggestions.some((entry) => entry.explainKey.endsWith('explainNextTier'))).toBe(true)
  })
})

describe('order_channel_change', () => {
  it('finds the cheaper channel, cuts the customer price, and prices the profit-neutral alternative', async () => {
    const run = await buildRun({ context: { orderScenarioCode: 'phone' } })
    const [suggestion] = await generateOrderChannelChangeSuggestions(run)

    expect(suggestion.code).toBe('order_channel_change')
    expect(suggestion.change.toOrderScenarioCode).toBe('ideal_file')
    expect(Number(suggestion.customerUnitPriceAfter)).toBeLessThan(
      Number(suggestion.customerUnitPriceBefore),
    )
    // At a fixed markup a cost saving cuts absolute profit; the profit-neutral price is the number
    // that hands the customer the saving without that happening.
    expect(Number(suggestion.supplierProfitAfter)).toBeLessThan(Number(suggestion.supplierProfitBefore))
    expect(Number(suggestion.profitNeutralUnitPrice)).toBeGreaterThan(
      Number(suggestion.customerUnitPriceAfter),
    )
    expect(Number(suggestion.profitNeutralUnitPrice)).toBeLessThan(
      Number(suggestion.customerUnitPriceBefore),
    )
  })

  it('offers nothing when the customer already orders through the cheapest channel', async () => {
    const run = await buildRun({ context: { orderScenarioCode: 'ideal_file' } })
    expect(await generateOrderChannelChangeSuggestions(run)).toEqual([])
  })
})

describe('cheaper_equivalent', () => {
  it('ships at confidence "default" because a product group is a category, not a substitute list', async () => {
    const sibling = buildProduct({
      productId: SIBLING_PRODUCT_ID,
      sku: 'CHEM-099',
      purchase: { ...buildProduct().purchase!, lastDeliveryUnitCost: '12.0000' },
    })
    const run = await buildRun({ siblings: [sibling] })
    const [suggestion] = await generateCheaperEquivalentSuggestions(run)

    expect(suggestion.code).toBe('cheaper_equivalent')
    expect(suggestion.change.toProductId).toBe(SIBLING_PRODUCT_ID)
    expect(suggestion.confidence).toBe('default')
    expect(Number(suggestion.customerUnitPriceAfter)).toBeLessThan(
      Number(suggestion.customerUnitPriceBefore),
    )
  })

  it('ignores a sibling that is not actually cheaper', async () => {
    const sibling = buildProduct({
      productId: SIBLING_PRODUCT_ID,
      sku: 'CHEM-100',
      purchase: { ...buildProduct().purchase!, lastDeliveryUnitCost: '40.0000' },
    })
    const run = await buildRun({ siblings: [sibling] })
    expect(await generateCheaperEquivalentSuggestions(run)).toEqual([])
  })
})

describe('volume sensitivity', () => {
  it('falls monotonically in unit cost and rises in line profit across the ladder', async () => {
    const run = await buildRun({ advisor: { quantityLadder: ['1', '6', '24', '96', '240'] } })
    const sensitivity = await computeVolumeSensitivity(run, PRODUCT_ID)

    expect(sensitivity).not.toBeNull()
    const points = sensitivity!.points
    expect(points.map((point) => point.quantity)).toEqual(['1', '6', '24', '96', '240'])

    for (let index = 1; index < points.length; index += 1) {
      expect(Number(points[index].unitCostNet)).toBeLessThan(Number(points[index - 1].unitCostNet))
      expect(Number(points[index].lineProfitNet)).toBeGreaterThan(Number(points[index - 1].lineProfitNet))
    }
  })

  it('marks the rungs that sit on a whole pack boundary', async () => {
    const run = await buildRun({
      product: { unitConversions: { box: '12' } },
      advisor: { quantityLadder: ['5', '12', '24'] },
    })
    const sensitivity = await computeVolumeSensitivity(run, PRODUCT_ID)
    const marked = sensitivity!.points.filter((point) => point.packBoundaryUnitCode === 'box')
    expect(marked.map((point) => point.quantity)).toEqual(['12', '24'])
  })
})

describe('margin floors', () => {
  it('reports the guardrail floor and the headroom above it', async () => {
    const run = await buildRun()
    const [floor] = computeMarginFloors(run)

    expect(floor.source).toBe('guardrail')
    expect(floor.minMarginPercent).toBe('8.0000')
    expect(Number(floor.lowestUnitPriceNet)).toBeLessThan(Number(floor.currentUnitPriceNet))
    expect(Number(floor.discountHeadroomPercent)).toBeGreaterThan(0)
  })

  it('honours a margin the rep asks for instead of the stored guardrail', async () => {
    const run = await buildRun({ advisor: { minMarginPercent: '35' } })
    const [floor] = computeMarginFloors(run)

    expect(floor.source).toBe('requested')
    expect(floor.minMarginPercent).toBe('35')
  })
})

describe('basket profit', () => {
  it('measures the whole basket, not one line', async () => {
    const run = await buildRun()
    expect(basketProfitOf(run.baseline)).toBe(
      toDecimal(run.baseline.totalNet) - toDecimal(run.baseline.totalCostNet),
    )
  })
})
