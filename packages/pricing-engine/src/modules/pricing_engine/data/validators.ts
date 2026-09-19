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
  // Additive and optional: an older client ignores it and still renders the binary state.
  pendingReason: z.enum(['awaiting_data', 'superseded']).nullable().optional(),
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

// ---------------------------------------------------------------------------
// Parameter CRUD schemas (Lane B).
//
// Every numeric column below is `numeric(p,s)` and MikroORM hands it back as a
// string, so the schemas keep the string form end to end and never round-trip
// through `Number`. Percent columns hold a WHOLE-NUMBER percent (66.0000 = 66%),
// matching `percentToFactor` in `lib/decimal.ts`.
//
// `organizationId` / `tenantId` are deliberately absent: the routes read them
// from `CrudCtx` so a request body can never widen its own scope.
// ---------------------------------------------------------------------------

export const TARGET_MARGIN_COMPONENT_CODE = 'target_margin'

export const pricingParamScopeSchema = z.enum([
  'global',
  'product_group',
  'product',
  'customer_group',
  'customer',
])

const codeString = z.string().trim().min(1).max(100)
const labelString = z.string().trim().min(1).max(300)
const scopeRefString = z.string().trim().min(1).max(200).nullable().optional()
const nullableDecimalString = decimalString.nullable().optional()
const nullableText = z.string().trim().max(300).nullable().optional()

type ScopedInput = { scope: z.infer<typeof pricingParamScopeSchema>; scopeRefId?: string | null }

// A global rule has nothing to point at, and a scoped rule that points at nothing would
// silently never match any quote — `resolveComponentParam` skips a scope whose ref is falsy.
function refineScopeRef(value: ScopedInput, ctx: z.RefinementCtx): void {
  if (value.scope === 'global') return
  if (!value.scopeRefId) {
    ctx.addIssue({
      code: 'custom',
      path: ['scopeRefId'],
      message: 'pricing_engine.params.errors.scopeRefRequired',
    })
  }
}

function normalizeScopeRef<T extends ScopedInput>(value: T): T & { scopeRefId: string | null } {
  return { ...value, scopeRefId: value.scope === 'global' ? null : (value.scopeRefId ?? null) }
}

const validityShape = {
  validFrom: z.coerce.date(),
  validTo: z.coerce.date().nullable().optional(),
}

function refineValidity(value: { validFrom: Date; validTo?: Date | null }, ctx: z.RefinementCtx): void {
  if (value.validTo && value.validTo.getTime() <= value.validFrom.getTime()) {
    ctx.addIssue({
      code: 'custom',
      path: ['validTo'],
      message: 'pricing_engine.params.errors.validToBeforeValidFrom',
    })
  }
}

const idField = z.string().uuid()

// --- margin rules: one `pricing_component_params` row -----------------------

const marginRuleShape = {
  componentCode: codeString.default(TARGET_MARGIN_COMPONENT_CODE),
  scope: pricingParamScopeSchema,
  scopeRefId: scopeRefString,
  targetMarkupPercent: decimalString,
  changeNote: z.string().trim().min(1).max(2000),
  ...validityShape,
}

export const marginRuleCreateSchema = z
  .object(marginRuleShape)
  .superRefine((value, ctx) => {
    refineScopeRef(value, ctx)
    refineValidity(value, ctx)
  })
  .transform(normalizeScopeRef)

export const marginRuleUpdateSchema = z
  .object({ id: idField, ...marginRuleShape })
  .superRefine((value, ctx) => {
    refineScopeRef(value, ctx)
    refineValidity(value, ctx)
  })
  .transform(normalizeScopeRef)

// --- guardrails -------------------------------------------------------------

export const negotiatedPricePrecedenceSchema = z.enum(['negotiated_wins', 'rules_win'])

const guardrailShape = {
  code: codeString,
  scope: pricingParamScopeSchema,
  scopeRefId: scopeRefString,
  minMarginPercent: nullableDecimalString,
  // Caps how far a negotiated price may sit below the engine's own target (lib/components/guardrails.ts).
  maxDiscountPercent: nullableDecimalString,
  floorPrice: nullableDecimalString,
  // `negotiated_price_precedence` is NOT NULL in the database and only the literal
  // 'negotiated_wins' has behaviour in `lib/components/guardrails.ts`; never accept null here.
  negotiatedPricePrecedence: negotiatedPricePrecedenceSchema.default('negotiated_wins'),
  ...validityShape,
}

function refineGuardrail(
  value: { minMarginPercent?: string | null; maxDiscountPercent?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (value.minMarginPercent !== null && value.minMarginPercent !== undefined) {
    const percent = Number(value.minMarginPercent)
    if (percent < 0 || percent >= 100) {
      ctx.addIssue({
        code: 'custom',
        path: ['minMarginPercent'],
        message: 'pricing_engine.params.errors.minMarginOutOfRange',
      })
    }
  }
  if (value.maxDiscountPercent !== null && value.maxDiscountPercent !== undefined) {
    const percent = Number(value.maxDiscountPercent)
    if (percent < 0 || percent >= 100) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxDiscountPercent'],
        message: 'pricing_engine.params.errors.maxDiscountOutOfRange',
      })
    }
  }
}

export const guardrailCreateSchema = z
  .object(guardrailShape)
  .superRefine((value, ctx) => {
    refineScopeRef(value, ctx)
    refineValidity(value, ctx)
    refineGuardrail(value, ctx)
  })
  .transform(normalizeScopeRef)

export const guardrailUpdateSchema = z
  .object({ id: idField, ...guardrailShape })
  .superRefine((value, ctx) => {
    refineScopeRef(value, ctx)
    refineValidity(value, ctx)
    refineGuardrail(value, ctx)
  })
  .transform(normalizeScopeRef)

// --- delivery zones ---------------------------------------------------------

const deliveryZoneShape = {
  code: codeString,
  label: labelString,
  avgDistanceKm: decimalString,
  avgDriveMinutes: decimalString,
  typicalStops: z.coerce.number().int().min(1).max(50).default(1),
  defaultVehicleCode: nullableText,
}

export const deliveryZoneCreateSchema = z.object(deliveryZoneShape)
export const deliveryZoneUpdateSchema = z.object({ id: idField, ...deliveryZoneShape })

// --- vehicles ---------------------------------------------------------------

const vehicleShape = {
  code: codeString,
  label: labelString,
  capacityKg: nullableDecimalString,
  capacityM3: nullableDecimalString,
  capacityPallets: z.coerce.number().int().min(0).nullable().optional(),
  fuelType: codeString,
  consumptionLPer100Km: decimalString,
  fixedCostMonth: decimalString.default('0'),
  driverRoleCode: codeString,
  isActive: z.boolean().default(true),
}

// `logisticsCost` divides a trip across the vehicle's capacity, so a vehicle with no capacity
// at all contributes nothing and the operator gets no error — refuse it at the edge instead.
function refineVehicleCapacity(
  value: { capacityKg?: string | null; capacityM3?: string | null; capacityPallets?: number | null },
  ctx: z.RefinementCtx,
): void {
  if (value.capacityKg || value.capacityM3 || (value.capacityPallets ?? 0) > 0) return
  ctx.addIssue({
    code: 'custom',
    path: ['capacityKg'],
    message: 'pricing_engine.params.errors.vehicleCapacityRequired',
  })
}

export const vehicleCreateSchema = z.object(vehicleShape).superRefine(refineVehicleCapacity)
export const vehicleUpdateSchema = z
  .object({ id: idField, ...vehicleShape })
  .superRefine(refineVehicleCapacity)

// --- fuel prices (an append-only observation series) -------------------------

const fuelPriceShape = {
  fuelType: codeString,
  pricePerLitre: positiveDecimalString,
  observedOn: z.coerce.date(),
}

export const fuelPriceCreateSchema = z.object(fuelPriceShape)
export const fuelPriceUpdateSchema = z.object({ id: idField, ...fuelPriceShape })

// --- labour rates -----------------------------------------------------------

const laborRateShape = {
  roleCode: codeString,
  label: labelString,
  hourlyRate: decimalString,
  overheadRate: decimalString.default('0'),
  ...validityShape,
}

export const laborRateCreateSchema = z.object(laborRateShape).superRefine(refineValidity)
export const laborRateUpdateSchema = z
  .object({ id: idField, ...laborRateShape })
  .superRefine(refineValidity)

// --- process steps ----------------------------------------------------------

const processStepShape = {
  code: codeString,
  label: labelString,
  roleCode: codeString,
  durationMinutes: decimalString,
  isPerLine: z.boolean().default(false),
  isPerOrder: z.boolean().default(true),
  ...validityShape,
}

export const processStepCreateSchema = z.object(processStepShape).superRefine(refineValidity)
export const processStepUpdateSchema = z
  .object({ id: idField, ...processStepShape })
  .superRefine(refineValidity)

// --- order scenarios --------------------------------------------------------

const orderScenarioShape = {
  code: codeString,
  label: labelString,
  stepMultipliers: z.record(codeString, decimalString).nullable().optional(),
  extraStepCodes: z.array(codeString).nullable().optional(),
  ...validityShape,
}

export const orderScenarioCreateSchema = z.object(orderScenarioShape).superRefine(refineValidity)
export const orderScenarioUpdateSchema = z
  .object({ id: idField, ...orderScenarioShape })
  .superRefine(refineValidity)

// --- packaging costs --------------------------------------------------------

const packagingCostShape = {
  unitCode: codeString,
  materialCost: decimalString,
  packMinutes: decimalString,
  roleCode: codeString,
  ...validityShape,
}

export const packagingCostCreateSchema = z.object(packagingCostShape).superRefine(refineValidity)
export const packagingCostUpdateSchema = z
  .object({ id: idField, ...packagingCostShape })
  .superRefine(refineValidity)

// --- warehouse costs --------------------------------------------------------

export const warehouseBasisSchema = z.enum(['m2', 'pallet_slot'])

const warehouseCostShape = {
  basis: warehouseBasisSchema,
  costPerMonth: decimalString,
  capitalCostAnnualRate: decimalString.default('0'),
  defaultTurnoverDays: z.coerce.number().int().min(1).max(3650).default(30),
  ...validityShape,
}

export const warehouseCostCreateSchema = z.object(warehouseCostShape).superRefine(refineValidity)
export const warehouseCostUpdateSchema = z
  .object({ id: idField, ...warehouseCostShape })
  .superRefine(refineValidity)

// --- purchase positions -----------------------------------------------------

const purchasePositionShape = {
  catalogProductId: z.string().uuid(),
  catalogVariantId: z.string().uuid().nullable().optional(),
  sku: nullableText,
  annualVolume: decimalString.default('0'),
  currentTierCode: nullableText,
  currentTierDiscount: decimalString.default('0'),
  nextTierVolume: nullableDecimalString,
  nextTierDiscount: nullableDecimalString,
  lastDeliveryUnitCost: nullableDecimalString,
  lastDeliveryAt: z.coerce.date().nullable().optional(),
  lastDeliveryQuantity: nullableDecimalString,
  soldQuantityPeriod: nullableDecimalString,
  productGroupCode: nullableText,
}

export const purchasePositionCreateSchema = z.object(purchasePositionShape)
export const purchasePositionUpdateSchema = z.object({ id: idField, ...purchasePositionShape })

// --- customer pricing profiles ----------------------------------------------
//
// One row per customer (unique on tenant + organization + customer_id) holding the six fields the
// engine reads for that customer: the group and zone codes it resolves rules by, the default
// order scenario, and the negotiated price book with its single expiry.

const nullableCode = z.string().trim().max(100).nullable().optional()

// The map is keyed by CATALOG PRODUCT ID: `negotiatedUnitPrice` in `lib/params.ts` looks a line up
// as `prices[productId]`, so a key that is not a product uuid can never be hit and is dead weight
// that still ships to the engine on every quote. Rejecting it here is the only gate there is —
// until this route existed the column was written by hand in SQL and nothing validated it.
const negotiatedPriceProductId = z.string().uuid()

/**
 * `negotiatedUnitPrice` resolves a line with `prices[productId]` — an EXACT string match against
 * the uuid Postgres renders in lowercase. A key that differs only in case, or that carries stray
 * whitespace from a paste, passes `z.string().uuid()`, lands in the jsonb column and then never
 * matches anything: the negotiated price exists in the database and is inert. The engine never
 * sees the raw body, so write time is the only place that can canonicalise it.
 */
export function canonicalNegotiatedPriceKey(key: string): string {
  return key.trim().toLowerCase()
}

// The whole map is read from jsonb on EVERY quote (`loadPricingParameters`), so its size is a
// per-quote cost, not a storage cost. 500 entries is ~2.5x the 204 products in the catalogue this
// runs against — room for a catalogue that triples without ever letting a paste turn one customer
// row into a megabyte the engine re-parses on every line.
const NEGOTIATED_PRICES_MAX_ENTRIES = 500

// Every money column in this module is `numeric(18, 4)`, whose widest value is 14 integer digits,
// a dot and 4 decimals = 19 characters. A longer string could not survive a round trip through the
// rest of the pricing schema anyway, so it is a typo, not a price.
const NEGOTIATED_PRICE_MAX_LENGTH = 19

// A single regex carries the whole rule — "a non-negative decimal" — so a letter, an exponent and a
// negative all resolve to one message instead of three. The value stays a STRING end to end: the
// engine hands it to decimal math untouched, and a float round-trip would lose the last grosz.
const negotiatedPriceValue = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .superRefine((value, ctx) => {
    if (!/^\d+(\.\d+)?$/.test(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'pricing_engine.params.errors.negotiatedPriceInvalid',
      })
      return
    }
    if (value.length > NEGOTIATED_PRICE_MAX_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        message: 'pricing_engine.params.errors.negotiatedPriceTooLong',
      })
    }
  })

// An empty map and `null` are the SAME state to the engine — `negotiatedUnitPrice` reads
// `customerProfile.negotiatedPrices ?? {}` and then misses on every product either way. So the
// schema accepts both rather than forcing the form to choose, and the route canonicalises an empty
// map to `null` on write (see `toNegotiatedPricesOrNull`) so two identically-priced customers never
// read differently in the table. Responses go the other way and always carry an object.
//
// The KEY schema is deliberately permissive. Zod reports a rejected record key as ONE `invalid_key`
// issue whose own `message` is the English "Invalid key in record" and buries the key schema's
// message one level down, where `normalizeCrudServerError` never looks — the sales rep would read
// untranslatable English. Validating the keys in a refinement instead puts the i18n key in
// `issue.message` and the offending product in `issue.path`.
export const negotiatedPricesSchema = z
  .record(z.string(), negotiatedPriceValue)
  .superRefine((value, ctx) => {
    const rawKeys = Object.keys(value)
    if (rawKeys.length > NEGOTIATED_PRICES_MAX_ENTRIES) {
      ctx.addIssue({
        code: 'custom',
        message: 'pricing_engine.params.errors.negotiatedPricesTooMany',
      })
    }
    const seen = new Set<string>()
    for (const rawKey of rawKeys) {
      const key = canonicalNegotiatedPriceKey(rawKey)
      if (!negotiatedPriceProductId.safeParse(key).success) {
        ctx.addIssue({
          code: 'custom',
          path: [rawKey],
          message: 'pricing_engine.params.errors.negotiatedPriceProductRequired',
        })
        continue
      }
      // Two spellings of one product would collapse into a single entry on canonicalisation and one
      // of the two prices would vanish without a word. Which one survives is object-key order, so
      // the only safe answer is to refuse the body.
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [rawKey],
          message: 'pricing_engine.params.errors.negotiatedPriceDuplicate',
        })
        continue
      }
      seen.add(key)
    }
  })
  .transform((value) => {
    const canonical: Record<string, string> = {}
    for (const [rawKey, price] of Object.entries(value)) {
      canonical[canonicalNegotiatedPriceKey(rawKey)] = price
    }
    return canonical
  })

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * "These prices expire on 31 December" means the 31st is still a trading day — the book dies at the
 * END of that date. `lib/params.ts:223` reads the stored instant as the moment the book is ALREADY
 * dead (`negotiatedPriceExpiresAt <= quote date`), and the tab's field is a `date` input, so a bare
 * `2026-12-31` coerced to midnight killed every negotiated price for the whole of the 31st.
 *
 * A date-only value is therefore pinned to the last millisecond of that day in UTC: the 31st prices
 * as agreed, the 1st does not. A body carrying a full timestamp is taken literally — an integration
 * that means 00:00 keeps meaning 00:00. `23:59:59.999Z` also slices back to `2026-12-31` for
 * `isoToDateInput`, so the date the rep typed is the date the form shows again.
 */
const negotiatedPriceExpiresAtSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return DATE_ONLY_PATTERN.test(trimmed) ? `${trimmed}T23:59:59.999Z` : value
}, z.coerce.date())

const customerProfileShape = {
  customerId: idField,
  customerGroupCode: nullableCode,
  deliveryZoneCode: nullableCode,
  defaultOrderScenarioCode: nullableCode,
  negotiatedPrices: negotiatedPricesSchema.nullable().optional(),
  // One date wipes the WHOLE map; there is no per-product term. `validFrom`/`validTo` are absent by
  // design — this table is not versioned, the engine reads the single current row.
  negotiatedPriceExpiresAt: negotiatedPriceExpiresAtSchema.nullable().optional(),
}

export const customerProfileCreateSchema = z.object(customerProfileShape)

/**
 * Every field but the identity pair is optional here, which makes the update body a PATCH: a field
 * the caller did not send must be LEFT ALONE, and a field sent as `null` must be CLEARED. Zod keeps
 * exactly that distinction in its output — an absent optional key is absent from the parsed object,
 * an explicit `null` is present with the value `null` — so the route branches on key presence
 * (`applyCustomerProfileUpdate`) instead of reading `undefined` as "clear it", which used to wipe a
 * whole negotiated price book on any partial PUT.
 */
export const customerProfileUpdateSchema = z.object({ id: idField, ...customerProfileShape })

/** The PATCH-able columns, in the order `applyCustomerProfileUpdate` writes them. */
export const CUSTOMER_PROFILE_PATCH_FIELDS = [
  'customerGroupCode',
  'deliveryZoneCode',
  'defaultOrderScenarioCode',
  'negotiatedPrices',
  'negotiatedPriceExpiresAt',
] as const

export type CustomerProfilePatchField = (typeof CUSTOMER_PROFILE_PATCH_FIELDS)[number]

export type PricingParamScopeValue = z.infer<typeof pricingParamScopeSchema>
export type MarginRuleCreateInput = z.infer<typeof marginRuleCreateSchema>
export type MarginRuleUpdateInput = z.infer<typeof marginRuleUpdateSchema>
export type GuardrailCreateInput = z.infer<typeof guardrailCreateSchema>
export type GuardrailUpdateInput = z.infer<typeof guardrailUpdateSchema>
export type DeliveryZoneCreateInput = z.infer<typeof deliveryZoneCreateSchema>
export type DeliveryZoneUpdateInput = z.infer<typeof deliveryZoneUpdateSchema>
export type VehicleCreateInput = z.infer<typeof vehicleCreateSchema>
export type VehicleUpdateInput = z.infer<typeof vehicleUpdateSchema>
export type FuelPriceCreateInput = z.infer<typeof fuelPriceCreateSchema>
export type FuelPriceUpdateInput = z.infer<typeof fuelPriceUpdateSchema>
export type LaborRateCreateInput = z.infer<typeof laborRateCreateSchema>
export type LaborRateUpdateInput = z.infer<typeof laborRateUpdateSchema>
export type ProcessStepCreateInput = z.infer<typeof processStepCreateSchema>
export type ProcessStepUpdateInput = z.infer<typeof processStepUpdateSchema>
export type OrderScenarioCreateInput = z.infer<typeof orderScenarioCreateSchema>
export type OrderScenarioUpdateInput = z.infer<typeof orderScenarioUpdateSchema>
export type PackagingCostCreateInput = z.infer<typeof packagingCostCreateSchema>
export type PackagingCostUpdateInput = z.infer<typeof packagingCostUpdateSchema>
export type WarehouseCostCreateInput = z.infer<typeof warehouseCostCreateSchema>
export type WarehouseCostUpdateInput = z.infer<typeof warehouseCostUpdateSchema>
export type PurchasePositionCreateInput = z.infer<typeof purchasePositionCreateSchema>
export type PurchasePositionUpdateInput = z.infer<typeof purchasePositionUpdateSchema>
export type NegotiatedPrices = z.infer<typeof negotiatedPricesSchema>
export type CustomerProfileCreateInput = z.infer<typeof customerProfileCreateSchema>
export type CustomerProfileUpdateInput = z.infer<typeof customerProfileUpdateSchema>
