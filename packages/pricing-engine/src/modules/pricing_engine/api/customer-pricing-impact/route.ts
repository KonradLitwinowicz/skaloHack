import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { marginPercent, markupPercent } from '../../lib/advisor/margin'
import { GUARDRAILS_CODE } from '../../lib/components'
import { money, rate as formatRate, toDecimal, ZERO } from '../../lib/decimal'
import { resolvePricingRouteContext } from '../../lib/api/context'
import { toPricingErrorResponse } from '../../lib/api/quoteHandler'
import {
  loadPricingInputs,
  priceWithInputs,
  resolveEffectiveContext,
  variantIdsByProduct,
  type PriceOverrides,
  type PricingInputs,
} from '../../services/pricingService'
import type {
  ComponentResult,
  ParameterLookup,
  PricingContext,
  PricingLineResult,
} from '../../lib/types'

// Pinned path: the auto-derived value would be `/pricing-engine/customer-pricing-impact`.
// The generator resolves the served path by STATIC analysis: it reads `metadata.path` from an
// object literal and cannot evaluate a helper call. A computed metadata object therefore falls
// back to the module-id convention (`/api/pricing_engine/...`) and every caller 404s. The literal
// below is what pins `/api/pricing/*` — a frozen contract surface.
//
// GET, not POST: this route reads parameters and runs the pipeline in memory. It writes no
// calculation record, emits no event and touches no row, so it needs no mutation guard, it is safe
// to re-issue while the operator is still typing, and the whole question fits in a query string.
// Feature gate is `pricing.params.read` rather than a write feature for the same reason — the
// screen that asks this question is a preview of a value that has NOT been saved yet.
export const metadata = {
  path: '/pricing/customer-pricing-impact',
  GET: { requireAuth: true, requireFeatures: ['pricing.params.read'] },
}

const decimalString = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine((value) => /^-?\d+(\.\d+)?$/.test(value), {
    message: 'pricing_engine.errors.invalidDecimal',
  })

const positiveDecimalString = decimalString.refine((value) => Number(value) > 0, {
  message: 'pricing_engine.errors.quantityMustBePositive',
})

// Local by design: `data/validators.ts` is the CRUD contract surface for stored parameters, and a
// preview that persists nothing has no business widening it.
export const customerPricingImpactQuerySchema = z.object({
  customerId: z.string().uuid(),
  productId: z.string().uuid(),
  proposedUnitPriceNet: decimalString,
  quantity: positiveDecimalString.default('1'),
  variantId: z.string().uuid().optional(),
  sku: z.string().min(1).optional(),
  currencyCode: z.string().min(3).max(3).optional(),
  customerGroupCode: z.string().min(1).optional(),
  deliveryZoneCode: z.string().min(1).optional(),
  orderScenarioCode: z.string().min(1).optional(),
  date: z.coerce.date().optional(),
})

export type CustomerPricingImpactQuery = z.infer<typeof customerPricingImpactQuerySchema>

/**
 * Every amount below is NET. The engine has no VAT model at all — there is no tax component in the
 * pipeline — so the flag is a constant rather than a computed field, and the screen must never
 * present these figures as gross.
 */
const AMOUNTS_ARE_NET_OF_VAT = true

/**
 * Wherever the operator's own price does not already sit on the floor, the floor is MEASURED by
 * running the line a third time with the price driven to the bottom, then reading back what the
 * guardrail did. It is never re-derived here: the floor is
 * `max(floor_price, price for min_margin)` on an ordinary line, but the shelf-life ladder REPLACES
 * that with a quantity-weighted blend, and an authorised deadstock floor can replace it again
 * (`lib/components/guardrails.ts`). A second copy of that rule here would disagree with the engine
 * the first time either side changed.
 *
 * The lever is the target markup, NOT a very low negotiated price. A negotiated price only reaches
 * the guardrail's target when the guardrail's own precedence is `negotiated_wins`
 * (`guardrails.ts`, `negotiatedApplied`); under `rules_win` the probe price was discarded, the
 * probe run priced identically to the engine's own run, and the field named `floor` reported THE
 * ENGINE PRICE — measured at 44.72 under an 8% minimum margin whose real floor was 29.28.
 * `targetMarkupPercent` has no such gate: it is an ordinary component parameter, honoured on every
 * run whatever the precedence, so the probe works from both sides of that setting.
 *
 * -99.99% and no lower. The multiplier this produces (1 + markup/100 = 0.0001) is serialised to
 * four decimal places like every other component value, so -99.9999% would serialise as `0.0000`
 * and the probe would price the line at zero instead of near zero. The same four places bound the
 * other end: the guardrail reports its clamp as `floor / probe price`, also to four places, so the
 * probe must stay within a few orders of magnitude of the floor for the round trip to be exact.
 */
const FLOOR_PROBE_TARGET_MARKUP_PERCENT = '-99.9900'

const PURCHASE_COST_MISSING_WARNING = 'pricing_engine.warnings.purchaseCostMissing'
const DELIVERY_ZONE_MISSING_WARNING = 'pricing_engine.warnings.deliveryZoneMissing'
const NEGOTIATED_WINS = 'negotiated_wins'

export const UNAVAILABLE_CUSTOMER_PROFILE_MISSING =
  'pricing_engine.customerPricingImpact.unavailable.customerProfileMissing'
export const UNAVAILABLE_PRODUCT_MISSING =
  'pricing_engine.customerPricingImpact.unavailable.productMissing'
export const UNAVAILABLE_PURCHASE_COST_MISSING =
  'pricing_engine.customerPricingImpact.unavailable.purchaseCostMissing'
export const UNAVAILABLE_DELIVERY_ZONE_MISSING =
  'pricing_engine.customerPricingImpact.unavailable.deliveryZoneMissing'
export const FLOOR_NOT_CONFIGURED = 'pricing_engine.customerPricingImpact.floor.notConfigured'
export const FLOOR_NOT_MEASURABLE = 'pricing_engine.customerPricingImpact.floor.notMeasurable'
export const NEGOTIATED_PRICE_IGNORED =
  'pricing_engine.customerPricingImpact.negotiatedPrice.ignoredByPrecedence'
export const MARGIN_UNDEFINED_AT_NON_POSITIVE_PRICE =
  'pricing_engine.customerPricingImpact.margin.undefinedAtNonPositivePrice'
export const MARKUP_UNDEFINED_AT_NON_POSITIVE_COST =
  'pricing_engine.customerPricingImpact.markup.undefinedAtNonPositiveCost'

/**
 * Which floor actually bound the price, straight from the guardrail's `effectiveFloorSource`. The
 * screen needs the label because two mechanisms with the same effect have different causes: a
 * minimum margin is a policy, an expiry ladder is a deadline, and they call for different
 * conversations with the customer.
 *
 * Listed rather than validated as an enum: a source the engine adds tomorrow must reach the screen
 * as an unrecognised label, not as a 500 from this route's own response parser.
 */
export const FLOOR_SOURCES = ['shelf_life', 'deadstock', 'min_margin', 'floor_price', 'max_discount'] as const
export type FloorSource = (typeof FLOOR_SOURCES)[number]

const priceRatiosSchema = z.object({
  // Named for what a sales rep reads off them. Margin is measured against the PRICE, markup against
  // the COST, and the engine stores the markup: leaving either field called "percent" would let the
  // two be read as interchangeable, which they are not (margin = markup / (1 + markup)).
  //
  // Nullable, because both ratios have a price or a cost in the denominator and neither is
  // guaranteed to be positive here. A null carries its own reason key beside it, so the screen can
  // tell "undefined" from a real 0.00%.
  marginOnPricePercent: z.string().nullable(),
  marginUnavailableReasonKey: z.string().nullable(),
  markupOnCostPercent: z.string().nullable(),
  markupUnavailableReasonKey: z.string().nullable(),
})

const priceFacetSchema = priceRatiosSchema.extend({ unitPriceNet: z.string() })

const customerPricingImpactResponseSchema = z.object({
  available: z.boolean(),
  unavailableReasonKeys: z.array(z.string()),
  currencyCode: z.string(),
  amountsAreNetOfVat: z.literal(true),
  customerId: z.string(),
  productId: z.string(),
  quantity: z.string(),
  unitCostNet: z.string().nullable(),
  negotiatedPrice: z.object({
    proposedUnitPriceNet: z.string(),
    appliesToQuote: z.boolean(),
    precedence: z.string().nullable(),
    ignoredReasonKey: z.string().nullable(),
    storedUnitPriceNet: z.string().nullable(),
  }),
  enginePrice: priceFacetSchema.nullable(),
  proposedPrice: priceFacetSchema.nullable(),
  appliedPrice: priceFacetSchema.extend({ raisedFromProposedPrice: z.boolean() }).nullable(),
  floor: priceRatiosSchema
    .extend({
      unitPriceNet: z.string().nullable(),
      // The engine's own label for the floor that bound the probe — one of `FLOOR_SOURCES`, or
      // null when no floor is in force. It names the ORIGIN of the number beside it; the number
      // itself stays a measurement, so a disagreement between the two is visible here rather than
      // inherited by the screen.
      source: z.string().nullable(),
      unavailableReasonKey: z.string().nullable(),
      guardrailCode: z.string().nullable(),
      minMarginPercent: z.string().nullable(),
      floorPriceParam: z.string().nullable(),
    })
    .nullable(),
  warnings: z.array(z.string()),
  engineWarnings: z.array(z.string()),
})

export type CustomerPricingImpactResponse = z.infer<typeof customerPricingImpactResponseSchema>

function readText(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function guardrailResult(line: PricingLineResult): ComponentResult | null {
  return line.breakdown.find((entry) => entry.code === GUARDRAILS_CODE) ?? null
}

type FloorMeasurement = {
  unitPriceNet: string
  source: string | null
  /** True when this run's own clamp landed on the floor, so the line price IS the floor. */
  quoted: boolean
}

/**
 * What one run says about the floor beneath it.
 *
 * `effectiveFloorUnitPrice` and `effectiveFloorSource` are written by the guardrail whenever ANY
 * floor is in force — minimum margin, floor price, the shelf-life ladder, an authorised deadstock
 * floor — and not only when one moves the price. Their absence is therefore the honest "no floor
 * applies to this customer and product", and their presence is the engine's own figure rather than
 * a second derivation of it.
 *
 * A run whose clamp LANDED on that floor is worth more than the figure itself: it carries the floor
 * through the rounding component and ends at the price the engine would really charge. The two can
 * differ by a rounding step, because the guardrail reports its clamp as a multiplier serialised to
 * four decimal places — at a pre-clamp price of 160.66 that is worth about eight tenths of a grosz,
 * enough to round 112.6001 up to 112.61. What the operator will be charged is 112.61.
 */
function measureFloor(line: PricingLineResult): FloorMeasurement | null {
  const guardrail = guardrailResult(line)
  if (!guardrail) return null
  const declaredUnitPriceNet = readText(guardrail.params, 'effectiveFloorUnitPrice')
  if (declaredUnitPriceNet === null) return null
  const priceAfter = readText(guardrail.inputs, 'priceAfter')
  const landedOnFloor = priceAfter !== null && toDecimal(priceAfter) === toDecimal(declaredUnitPriceNet)
  return {
    unitPriceNet: landedOnFloor ? line.unitPriceNet : declaredUnitPriceNet,
    source: readText(guardrail.params, 'effectiveFloorSource'),
    quoted: landedOnFloor,
  }
}

/**
 * The only seam the engine leaves for a price that has not been saved yet.
 *
 * `PriceOverrides` carries a markup lever and a channel lever, neither of which can set a unit
 * price, and `negotiated_prices` lives on a stored row. Wrapping the lookup the same way
 * `withMarkupOverride` wraps it keeps the hypothetical price on the identical code path a stored
 * one takes — guardrail scope resolution, floors, the shelf-life ladder and every warning included.
 */
function withNegotiatedUnitPrice(
  params: ParameterLookup,
  productId: string,
  unitPriceNet: string | null,
): ParameterLookup {
  return {
    ...params,
    negotiatedUnitPrice(candidateProductId: string): string | null {
      if (candidateProductId !== productId) return params.negotiatedUnitPrice(candidateProductId)
      return unitPriceNet
    },
  }
}

/**
 * Both ratios for one price, or an explicit reason why a ratio does not exist.
 *
 * `marginPercent` and `markupPercent` each return 0 when their denominator is not positive, which
 * is right for `lib/pipeline.ts` — it never prices a line below zero — and wrong here, where two of
 * the four facets really do carry non-positive prices: `proposedPrice` is whatever the operator
 * typed, including a negative number, and `floor` follows the shelf-life ladder down to a salvage
 * floor of -13.70 when disposal costs more than the goods are worth. A margin printed as `0.0000`
 * at those prices reads as break-even, which is the opposite of the truth.
 *
 * Null with a reason rather than a negative number, because at a non-positive price the quotient
 * is not a smaller margin — it is a different quantity. At zero it does not exist at all, and below
 * zero it inverts: -13.70 against a cost of 92.33 evaluates to +773%, which would read as an
 * excellent deal. Markup on cost, whose denominator stays positive, answers the same question
 * honestly (-105.0022%) and is reported beside it.
 *
 * Derived here rather than read off `PricingLineResult`, so every facet — including the operator's
 * own price, which no pipeline run reports once a floor clamps it away — goes through one formula.
 * For a positive price this is the identical arithmetic on the identical 4-decimal inputs the
 * pipeline used, so the numbers it reports are unchanged.
 */
function priceRatios(unitPriceNet: string, unitCostNet: string): z.infer<typeof priceRatiosSchema> {
  const price = toDecimal(unitPriceNet)
  const cost = toDecimal(unitCostNet)
  const marginDefined = price > ZERO
  const markupDefined = cost > ZERO
  return {
    marginOnPricePercent: marginDefined ? formatRate(marginPercent(price, cost)) : null,
    marginUnavailableReasonKey: marginDefined ? null : MARGIN_UNDEFINED_AT_NON_POSITIVE_PRICE,
    markupOnCostPercent: markupDefined ? formatRate(markupPercent(price, cost)) : null,
    markupUnavailableReasonKey: markupDefined ? null : MARKUP_UNDEFINED_AT_NON_POSITIVE_COST,
  }
}

function priceFacet(unitPriceNet: string, unitCostNet: string): z.infer<typeof priceFacetSchema> {
  return { unitPriceNet: money(toDecimal(unitPriceNet)), ...priceRatios(unitPriceNet, unitCostNet) }
}

function facetForLine(line: PricingLineResult): z.infer<typeof priceFacetSchema> {
  return priceFacet(line.unitPriceNet, line.unitCostNet)
}

const RATIOS_UNKNOWN: z.infer<typeof priceRatiosSchema> = {
  marginOnPricePercent: null,
  marginUnavailableReasonKey: null,
  markupOnCostPercent: null,
  markupUnavailableReasonKey: null,
}

function blockingReasonKeys(warnings: string[]): string[] {
  const keys: string[] = []
  // A missing purchase cost prices the line off a cost of zero, which reports a 100% margin. That
  // is not a small inaccuracy, it is the opposite of the answer the operator asked for.
  if (warnings.includes(PURCHASE_COST_MISSING_WARNING)) keys.push(UNAVAILABLE_PURCHASE_COST_MISSING)
  // No delivery zone means the logistics component contributes exactly nothing, so every margin
  // shown would be flattered by the whole cost of getting the goods to the customer.
  if (warnings.includes(DELIVERY_ZONE_MISSING_WARNING)) keys.push(UNAVAILABLE_DELIVERY_ZONE_MISSING)
  return keys
}

function unavailableResponse(
  query: CustomerPricingImpactQuery,
  currencyCode: string,
  reasonKeys: string[],
): CustomerPricingImpactResponse {
  return customerPricingImpactResponseSchema.parse({
    available: false,
    unavailableReasonKeys: reasonKeys,
    currencyCode,
    amountsAreNetOfVat: AMOUNTS_ARE_NET_OF_VAT,
    customerId: query.customerId,
    productId: query.productId,
    quantity: query.quantity,
    unitCostNet: null,
    negotiatedPrice: {
      proposedUnitPriceNet: money(toDecimal(query.proposedUnitPriceNet)),
      appliesToQuote: false,
      precedence: null,
      ignoredReasonKey: null,
      storedUnitPriceNet: null,
    },
    enginePrice: null,
    proposedPrice: null,
    appliedPrice: null,
    floor: null,
    warnings: [],
    engineWarnings: [],
  })
}

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await resolvePricingRouteContext(req)
    const url = new URL(req.url)
    const query = customerPricingImpactQuerySchema.parse(Object.fromEntries(url.searchParams))

    const em = ctx.container.resolve('em') as EntityManager
    const context: PricingContext = {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      currencyCode: query.currencyCode ?? '',
      customerId: query.customerId,
      customerGroupCode: query.customerGroupCode ?? null,
      orderScenarioCode: query.orderScenarioCode ?? null,
      deliveryZoneCode: query.deliveryZoneCode ?? null,
      lines: [
        {
          productId: query.productId,
          variantId: query.variantId ?? null,
          sku: query.sku ?? null,
          quantity: query.quantity,
          enteredQuantity: null,
          enteredUnitCode: null,
        },
      ],
      date: query.date ?? new Date(),
      mode: 'shadow',
    }

    const inputs: PricingInputs = await loadPricingInputs(
      em,
      ctx.container,
      {
        tenantId: ctx.tenantId,
        organizationId: ctx.organizationId,
        date: context.date,
        customerId: query.customerId,
      },
      [query.productId],
      variantIdsByProduct(context.lines),
    )

    const effectiveContext = resolveEffectiveContext(context, inputs)
    const currencyCode = effectiveContext.currencyCode

    // Both of these are structural: there is no row to save a negotiated price onto, or no product
    // to price. Neither can be reported as a number, so neither is.
    if (!inputs.customerProfile) {
      return NextResponse.json(
        unavailableResponse(query, currencyCode, [UNAVAILABLE_CUSTOMER_PROFILE_MISSING]),
      )
    }
    if (!inputs.catalog.byProductId.has(query.productId)) {
      return NextResponse.json(
        unavailableResponse(query, currencyCode, [UNAVAILABLE_PRODUCT_MISSING]),
      )
    }

    // One database load, three in-memory runs: `priceWithInputs` touches no EntityManager, so the
    // three answers cost one round trip between them.
    const priceWith = (negotiatedUnitPrice: string | null, overrides?: PriceOverrides) =>
      priceWithInputs(
        effectiveContext,
        {
          ...inputs,
          params: withNegotiatedUnitPrice(inputs.params, query.productId, negotiatedUnitPrice),
        },
        overrides,
      )

    const [engineRun, appliedRun, floorProbeRun] = await Promise.all([
      priceWith(null),
      priceWith(query.proposedUnitPriceNet),
      // No negotiated price on the probe either: a price stored on the profile would otherwise
      // become the probe's target wherever it beats the markup lever, and the run would measure
      // that price rather than the floor beneath it.
      priceWith(null, { targetMarkupPercent: FLOOR_PROBE_TARGET_MARKUP_PERCENT }),
    ])

    const engineLine = engineRun.lines[0]
    const appliedLine = appliedRun.lines[0]
    const floorProbeLine = floorProbeRun.lines[0]
    if (!engineLine || !appliedLine || !floorProbeLine) {
      return NextResponse.json(
        unavailableResponse(query, currencyCode, [UNAVAILABLE_PRODUCT_MISSING]),
      )
    }

    const blocking = blockingReasonKeys(appliedLine.warnings)
    if (blocking.length > 0) {
      return NextResponse.json(unavailableResponse(query, currencyCode, blocking))
    }

    const appliedGuardrail = guardrailResult(appliedLine)
    const precedence = appliedGuardrail ? readText(appliedGuardrail.params, 'negotiatedPricePrecedence') : null
    // Absent guardrail means the engine's own default, which is to honour the negotiated price.
    const appliesToQuote = (precedence ?? NEGOTIATED_WINS) === NEGOTIATED_WINS

    // Pre-rounding, so the rounding component's one-grosz step cannot be mistaken for a clamp.
    const appliedBeforeRounding = appliedGuardrail ? readText(appliedGuardrail.inputs, 'priceAfter') : null
    const raisedFromProposedPrice =
      appliesToQuote &&
      appliedBeforeRounding !== null &&
      toDecimal(appliedBeforeRounding) > toDecimal(query.proposedUnitPriceNet)

    // A cost so small that a ten-thousandth of it quantises to zero leaves the probe's guardrail
    // nothing to clamp and the run nothing to report. That is a failed measurement, not a floor of
    // zero, and it is reported as one.
    const probeGuardrail = guardrailResult(floorProbeLine)
    const probePriceBefore = probeGuardrail ? readText(probeGuardrail.inputs, 'priceBefore') : null
    const probeMeasured = probePriceBefore !== null && toDecimal(probePriceBefore) > ZERO

    // The run the operator is actually looking at comes first, but only when its OWN clamp landed
    // on the floor: `floor.unitPriceNet` is then the very number `appliedPrice` will charge, which
    // is what the screen means by "this price will be raised to the floor". The probe answers every
    // other case — a price already above the floor, a floor that never binds because it sits below
    // zero, and every line whose guardrail ignores negotiated prices altogether.
    const appliedFloor = measureFloor(appliedLine)
    const probeFloor = probeMeasured ? measureFloor(floorProbeLine) : null
    const floorMeasurement = appliedFloor?.quoted ? appliedFloor : (probeFloor ?? appliedFloor)
    const floorUnitPriceNet = floorMeasurement?.unitPriceNet ?? null
    const floorSource = floorMeasurement?.source ?? null

    return NextResponse.json(
      customerPricingImpactResponseSchema.parse({
        available: true,
        unavailableReasonKeys: [],
        currencyCode,
        amountsAreNetOfVat: AMOUNTS_ARE_NET_OF_VAT,
        customerId: query.customerId,
        productId: query.productId,
        quantity: query.quantity,
        unitCostNet: appliedLine.unitCostNet,
        negotiatedPrice: {
          proposedUnitPriceNet: money(toDecimal(query.proposedUnitPriceNet)),
          appliesToQuote,
          precedence,
          ignoredReasonKey: appliesToQuote ? null : NEGOTIATED_PRICE_IGNORED,
          storedUnitPriceNet: inputs.params.negotiatedUnitPrice(query.productId),
        },
        enginePrice: facetForLine(engineLine),
        proposedPrice: priceFacet(query.proposedUnitPriceNet, appliedLine.unitCostNet),
        appliedPrice: { ...facetForLine(appliedLine), raisedFromProposedPrice },
        floor: {
          unitPriceNet: floorUnitPriceNet,
          ...(floorUnitPriceNet === null
            ? RATIOS_UNKNOWN
            : priceRatios(floorUnitPriceNet, appliedLine.unitCostNet)),
          source: floorSource,
          unavailableReasonKey:
            floorUnitPriceNet !== null ? null : probeMeasured ? FLOOR_NOT_CONFIGURED : FLOOR_NOT_MEASURABLE,
          guardrailCode: appliedGuardrail ? readText(appliedGuardrail.params, 'guardrailCode') : null,
          minMarginPercent: appliedGuardrail ? readText(appliedGuardrail.params, 'minMarginPercent') : null,
          floorPriceParam: appliedGuardrail ? readText(appliedGuardrail.params, 'floorPrice') : null,
        },
        warnings: appliedLine.warnings,
        engineWarnings: engineLine.warnings,
      }),
    )
  } catch (err) {
    return toPricingErrorResponse(err, 'Pricing customer price impact failed')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Pricing Engine',
  summary: 'Preview what the engine does with a negotiated price',
  methods: {
    GET: {
      summary:
        'Price one line three ways — without the negotiated price, at the proposed price, and at the engine floor — so a rep sees the effect of a negotiated price before saving it',
      query: customerPricingImpactQuerySchema,
      responses: [
        {
          status: 200,
          description:
            'Net-of-VAT comparison with warnings, or an explicit reason when the figures cannot be computed',
          schema: customerPricingImpactResponseSchema,
        },
      ],
    },
  },
}
