import { z } from 'zod'

const decimalString = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .refine((value) => /^-?\d+(\.\d+)?$/.test(value.trim()), {
    message: 'pricing_engine.errors.invalidDecimal',
  })

const positiveDecimalString = decimalString.refine((value) => Number(value) > 0, {
  message: 'pricing_engine.errors.quantityMustBePositive',
})

export const quoteLineSchema = z.object({
  productId: z.string().uuid().optional(),
  sku: z.string().min(1).optional(),
  variantId: z.string().uuid().nullable().optional(),
  quantity: positiveDecimalString,
  enteredQuantity: decimalString.nullable().optional(),
  enteredUnitCode: z.string().min(1).nullable().optional(),
})

export const quoteRequestSchema = z.object({
  customerId: z.string().uuid().nullable().optional(),
  customerGroupCode: z.string().min(1).nullable().optional(),
  orderScenarioCode: z.string().min(1).nullable().optional(),
  deliveryZoneCode: z.string().min(1).nullable().optional(),
  currencyCode: z.string().min(3).max(3).optional(),
  date: z.coerce.date().optional(),
  lines: z.array(quoteLineSchema).min(1),
})

export const simulateRequestSchema = quoteRequestSchema.extend({
  overrides: z
    .object({
      targetMarkupPercent: decimalString.optional(),
      orderScenarioCode: z.string().min(1).optional(),
    })
    .optional(),
})

const componentResultSchema = z.object({
  code: z.string(),
  labelKey: z.string(),
  effect: z.enum(['add', 'mul']),
  value: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  params: z.record(z.string(), z.unknown()),
  explainKey: z.string(),
  explainValues: z.record(z.string(), z.unknown()),
  confidence: z.enum(['measured', 'estimated', 'default']),
  warnings: z.array(z.string()).optional(),
})

export const quoteLineResponseSchema = z.object({
  productId: z.string(),
  sku: z.string().nullable(),
  quantity: z.string(),
  unitPriceNet: z.string(),
  totalPriceNet: z.string(),
  unitCostNet: z.string(),
  markupPercent: z.string(),
  marginPercent: z.string(),
  breakdown: z.array(componentResultSchema),
  warnings: z.array(z.string()),
})

export const quoteResponseSchema = z.object({
  calculationId: z.string().uuid().nullable(),
  currencyCode: z.string(),
  mode: z.enum(['shadow', 'advisory', 'live']),
  parameterSetVersion: z.number().int(),
  lines: z.array(quoteLineResponseSchema),
  totalNet: z.string(),
  totalCostNet: z.string(),
  totalMarkupPercent: z.string(),
  totalMarginPercent: z.string(),
  warnings: z.array(z.string()),
  durationMs: z.number().int(),
})

export const coverageEntryResponseSchema = z.object({
  componentCode: z.string(),
  labelKey: z.string(),
  implemented: z.boolean(),
  sourceKind: z.string(),
  sourceRef: z.string().nullable(),
  freshnessDays: z.number().int().nullable(),
  confidence: z.enum(['measured', 'estimated', 'default']),
  missingReasonKey: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
})

export const coverageResponseSchema = z.object({
  items: z.array(coverageEntryResponseSchema),
})

export type QuoteRequest = z.infer<typeof quoteRequestSchema>
export type SimulateRequest = z.infer<typeof simulateRequestSchema>
export type QuoteResponse = z.infer<typeof quoteResponseSchema>
export type CoverageResponse = z.infer<typeof coverageResponseSchema>
