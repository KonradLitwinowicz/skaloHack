import { z } from 'zod'
import { quoteLineSchema, quoteResponseSchema, simulateRequestSchema } from '../../data/validators'

// The advisor's own zod lives here rather than in `data/validators.ts`: that file is the frozen
// request/response contract for /pricing/quote and /pricing/simulate, and the advisor is additive.

const decimalString = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .refine((value) => /^-?\d+(\.\d+)?$/.test(value.trim()), {
    message: 'pricing_engine.errors.invalidDecimal',
  })

const fractionString = decimalString.refine(
  (value) => Number(value) >= 0 && Number(value) <= 1,
  { message: 'pricing_engine.errors.invalidPassThrough' },
)

export const suggestionKindSchema = z.enum([
  'volume_threshold',
  'full_pack_rounding',
  'basket_consolidation',
  'cheaper_equivalent',
  'order_channel_change',
])

export const confidenceSchema = z.enum(['measured', 'estimated', 'default'])

export const suggestionChangeSchema = z.object({
  productId: z.string().optional(),
  fromQuantity: z.string().optional(),
  toQuantity: z.string().optional(),
  toProductId: z.string().optional(),
  toOrderScenarioCode: z.string().optional(),
})

export const suggestionSchema = z.object({
  code: suggestionKindSchema,
  titleKey: z.string(),
  explainKey: z.string(),
  // Key + values rather than a rendered sentence: the advisor inherits the same i18n discipline the
  // pipeline components already follow, so a suggestion reads in Polish without a server round trip.
  explainValues: z.record(z.string(), z.string()),
  // Also an i18n key, not literal copy: "when this stops being worth it", rendered by the client.
  breakEvenConditionKey: z.string(),
  change: suggestionChangeSchema,
  customerUnitPriceBefore: z.string(),
  customerUnitPriceAfter: z.string(),
  supplierProfitBefore: z.string(),
  supplierProfitAfter: z.string(),
  // Unit profit alone is misleading whenever a suggestion moves quantity: it falls while the basket
  // profit rises. Both figures ship so the screen cannot show only the flattering half.
  basketProfitBefore: z.string(),
  basketProfitAfter: z.string(),
  supplierMarginPercentBefore: z.string(),
  supplierMarginPercentAfter: z.string(),
  profitNeutralUnitPrice: z.string(),
  guardrailFloorUnitPrice: z.string().nullable(),
  confidence: confidenceSchema,
  raisesCustomerPrice: z.boolean(),
})

export const volumeSensitivityPointSchema = z.object({
  quantity: z.string(),
  unitPriceNet: z.string(),
  unitCostNet: z.string(),
  totalPriceNet: z.string(),
  marginPercent: z.string(),
  markupPercent: z.string(),
  unitProfitNet: z.string(),
  lineProfitNet: z.string(),
  // True where this quantity would carry the distributor's ANNUAL purchase volume past
  // `next_tier_volume` — the only rebate ladder this tenant actually records.
  crossesNextTierVolume: z.boolean(),
  // 'box' | 'pallet' when the quantity is an exact multiple of that pack; null otherwise.
  packBoundaryUnitCode: z.string().nullable(),
})

export const volumeSensitivitySchema = z.object({
  productId: z.string(),
  sku: z.string().nullable(),
  currencyCode: z.string(),
  points: z.array(volumeSensitivityPointSchema),
})

export const marginFloorSchema = z.object({
  productId: z.string(),
  sku: z.string().nullable(),
  minMarginPercent: z.string(),
  unitCostNet: z.string(),
  currentUnitPriceNet: z.string(),
  lowestUnitPriceNet: z.string().nullable(),
  discountHeadroomPercent: z.string().nullable(),
  source: z.enum(['guardrail', 'requested']),
})

export const purchasingInsightSchema = z.object({
  productId: z.string(),
  sku: z.string().nullable(),
  annualVolume: z.string(),
  nextTierVolume: z.string(),
  unitsToNextTier: z.string(),
  currentTierDiscount: z.string(),
  nextTierDiscount: z.string(),
  unitCostSaving: z.string(),
  annualSavingAtNextTier: z.string(),
})

export const advisorOptionsSchema = z.object({
  kinds: z.array(suggestionKindSchema).optional(),
  maxPerKind: z.number().int().min(1).max(10).optional(),
  passThrough: fractionString.optional(),
  minMarginPercent: decimalString.optional(),
  quantityLadder: z.array(decimalString).max(24).optional(),
  consolidateWith: z.array(z.array(quoteLineSchema).min(1)).max(5).optional(),
})

export const adviseRequestSchema = simulateRequestSchema.extend({
  advisor: advisorOptionsSchema.optional(),
})

export const adviseResponseSchema = z.object({
  baseline: quoteResponseSchema,
  suggestions: z.array(suggestionSchema),
  volumeSensitivity: z.array(volumeSensitivitySchema),
  marginFloors: z.array(marginFloorSchema),
  purchasingInsights: z.array(purchasingInsightSchema),
})

export type SuggestionKind = z.infer<typeof suggestionKindSchema>
export type SuggestionChange = z.infer<typeof suggestionChangeSchema>
export type Suggestion = z.infer<typeof suggestionSchema>
export type VolumeSensitivityPoint = z.infer<typeof volumeSensitivityPointSchema>
export type VolumeSensitivity = z.infer<typeof volumeSensitivitySchema>
export type MarginFloor = z.infer<typeof marginFloorSchema>
export type PurchasingInsight = z.infer<typeof purchasingInsightSchema>
export type AdvisorOptions = z.infer<typeof advisorOptionsSchema>
export type AdviseRequest = z.infer<typeof adviseRequestSchema>
export type AdviseResponse = z.infer<typeof adviseResponseSchema>

export const ALL_SUGGESTION_KINDS: SuggestionKind[] = suggestionKindSchema.options
