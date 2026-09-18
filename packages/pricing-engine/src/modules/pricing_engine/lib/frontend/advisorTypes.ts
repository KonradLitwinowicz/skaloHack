import type { QuoteResponse } from './quoteTypes'

// Plain client mirror of `lib/advisor/schemas.ts`. The zod module pulls `data/validators` and the
// whole zod runtime into anything that imports it; the advisor screen only needs the shapes.
// `__tests__/advisorTypes.test.ts` asserts the two stay in step.

export type AdvisorSuggestionKind =
  | 'volume_threshold'
  | 'full_pack_rounding'
  | 'basket_consolidation'
  | 'cheaper_equivalent'
  | 'order_channel_change'

export type AdvisorConfidence = 'measured' | 'estimated' | 'default'

export type AdvisorSuggestionChange = {
  productId?: string
  fromQuantity?: string
  toQuantity?: string
  toProductId?: string
  toOrderScenarioCode?: string
}

export type AdvisorSuggestion = {
  code: AdvisorSuggestionKind
  titleKey: string
  explainKey: string
  explainValues: Record<string, string>
  breakEvenConditionKey: string
  change: AdvisorSuggestionChange
  customerUnitPriceBefore: string
  customerUnitPriceAfter: string
  supplierProfitBefore: string
  supplierProfitAfter: string
  basketProfitBefore: string
  basketProfitAfter: string
  supplierMarginPercentBefore: string
  supplierMarginPercentAfter: string
  profitNeutralUnitPrice: string
  guardrailFloorUnitPrice: string | null
  confidence: AdvisorConfidence
  raisesCustomerPrice: boolean
}

export type AdvisorVolumePoint = {
  quantity: string
  unitPriceNet: string
  unitCostNet: string
  totalPriceNet: string
  marginPercent: string
  markupPercent: string
  unitProfitNet: string
  lineProfitNet: string
  crossesNextTierVolume: boolean
  packBoundaryUnitCode: string | null
}

export type AdvisorVolumeSensitivity = {
  productId: string
  sku: string | null
  currencyCode: string
  points: AdvisorVolumePoint[]
}

export type AdvisorMarginFloor = {
  productId: string
  sku: string | null
  minMarginPercent: string
  unitCostNet: string
  currentUnitPriceNet: string
  lowestUnitPriceNet: string | null
  discountHeadroomPercent: string | null
  source: 'guardrail' | 'requested'
}

export type AdvisorPurchasingInsight = {
  productId: string
  sku: string | null
  annualVolume: string
  nextTierVolume: string
  unitsToNextTier: string
  currentTierDiscount: string
  nextTierDiscount: string
  unitCostSaving: string
  annualSavingAtNextTier: string
}

export type AdviseResponse = {
  baseline: QuoteResponse
  suggestions: AdvisorSuggestion[]
  volumeSensitivity: AdvisorVolumeSensitivity[]
  marginFloors: AdvisorMarginFloor[]
  purchasingInsights: AdvisorPurchasingInsight[]
}

export type AdviseRequestBody = {
  customerId?: string | null
  orderScenarioCode?: string | null
  lines: Array<{ productId: string; quantity: string }>
  overrides?: { targetMarkupPercent?: string; orderScenarioCode?: string }
  advisor?: {
    kinds?: AdvisorSuggestionKind[]
    maxPerKind?: number
    minMarginPercent?: string
    quantityLadder?: string[]
  }
}
