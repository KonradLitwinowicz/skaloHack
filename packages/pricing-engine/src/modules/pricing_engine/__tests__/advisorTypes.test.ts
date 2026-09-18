import {
  ALL_SUGGESTION_KINDS,
  suggestionChangeSchema,
  suggestionSchema,
  volumeSensitivityPointSchema,
  marginFloorSchema,
  purchasingInsightSchema,
} from '../lib/advisor/schemas'
import type {
  AdvisorMarginFloor,
  AdvisorPurchasingInsight,
  AdvisorSuggestion,
  AdvisorSuggestionChange,
  AdvisorSuggestionKind,
  AdvisorVolumePoint,
} from '../lib/frontend/advisorTypes'

// `lib/frontend/advisorTypes.ts` is a hand-written mirror so the advisor screen does not pull the
// zod runtime into the browser bundle. A mirror drifts unless something compares the two.

const SAMPLE_SUGGESTION: AdvisorSuggestion = {
  code: 'volume_threshold',
  titleKey: 'pricing_engine.advisor.suggestion.volumeThreshold.title',
  explainKey: 'pricing_engine.advisor.suggestion.volumeThreshold.explain',
  explainValues: { currency: 'PLN' },
  breakEvenConditionKey: 'pricing_engine.advisor.breakEven.volumeThreshold',
  change: { productId: 'product-1', fromQuantity: '24', toQuantity: '30' },
  customerUnitPriceBefore: '166.0000',
  customerUnitPriceAfter: '156.0000',
  supplierProfitBefore: '66.0000',
  supplierProfitAfter: '60.0000',
  basketProfitBefore: '1584.0000',
  basketProfitAfter: '1800.0000',
  supplierMarginPercentBefore: '39.7590',
  supplierMarginPercentAfter: '38.4615',
  profitNeutralUnitPrice: '156.0000',
  guardrailFloorUnitPrice: '108.6957',
  confidence: 'measured',
  raisesCustomerPrice: false,
}

const SAMPLE_CHANGE: AdvisorSuggestionChange = { toOrderScenarioCode: 'ideal_file' }

const SAMPLE_POINT: AdvisorVolumePoint = {
  quantity: '24',
  unitPriceNet: '166.0000',
  unitCostNet: '100.0000',
  totalPriceNet: '3984.0000',
  marginPercent: '39.7590',
  markupPercent: '66.0000',
  unitProfitNet: '66.0000',
  lineProfitNet: '1584.0000',
  crossesNextTierVolume: false,
  packBoundaryUnitCode: null,
}

const SAMPLE_FLOOR: AdvisorMarginFloor = {
  productId: 'product-1',
  sku: 'CHEM-014',
  minMarginPercent: '8.0000',
  unitCostNet: '100.0000',
  currentUnitPriceNet: '166.0000',
  lowestUnitPriceNet: '108.6957',
  discountHeadroomPercent: '34.5207',
  source: 'guardrail',
}

const SAMPLE_INSIGHT: AdvisorPurchasingInsight = {
  productId: 'product-1',
  sku: 'CHEM-014',
  annualVolume: '1000',
  nextTierVolume: '1250',
  unitsToNextTier: '250.0000',
  currentTierDiscount: '4.0000',
  nextTierDiscount: '7.0000',
  unitCostSaving: '0.8146',
  annualSavingAtNextTier: '1018.2500',
}

function keysOf(value: object): string[] {
  return Object.keys(value).sort()
}

describe('advisor client types mirror the server schemas', () => {
  it.each([
    ['suggestion', suggestionSchema, SAMPLE_SUGGESTION],
    ['change', suggestionChangeSchema, SAMPLE_CHANGE],
    ['volume point', volumeSensitivityPointSchema, SAMPLE_POINT],
    ['margin floor', marginFloorSchema, SAMPLE_FLOOR],
    ['purchasing insight', purchasingInsightSchema, SAMPLE_INSIGHT],
  ])('%s carries the same fields on both sides', (_label, schema, sample) => {
    expect(schema.parse(sample)).toEqual(sample)
  })

  it('declares the same field set for a suggestion', () => {
    expect(keysOf(SAMPLE_SUGGESTION)).toEqual(keysOf(suggestionSchema.shape))
  })

  it('declares the same suggestion kinds on both sides', () => {
    const clientKinds: AdvisorSuggestionKind[] = [
      'volume_threshold',
      'full_pack_rounding',
      'basket_consolidation',
      'cheaper_equivalent',
      'order_channel_change',
    ]
    expect([...ALL_SUGGESTION_KINDS].sort()).toEqual([...clientKinds].sort())
  })
})
