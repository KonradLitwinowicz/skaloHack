import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { PricingService } from '@open-mercato/pricing-engine/modules/pricing_engine/services/pricingService'
import type {
  PricingContext,
  PricingQuoteResult,
} from '@open-mercato/pricing-engine/modules/pricing_engine/lib/types'

const logger = createLogger('distributor_workspace').child({ component: 'basket-pricing' })

/**
 * What the predicted basket costs as ONE delivery against what the same goods cost split apart.
 *
 * This is the question the basket view raises and cannot answer on its own. Several costs in the
 * pricing engine are per-delivery rather than per-item — the trip, the pick, the packaging setup —
 * so the same products bought together and bought one at a time are not the same price. Showing
 * only one number would leave the operator guessing which one it was, and would hide the argument
 * they can actually make on the phone: order it all on Monday and it costs you this much less.
 *
 * Priced through the engine's own service with `persist: false`, which is what `/pricing/simulate`
 * does. A comparison is a what-if by definition and has no business writing n+1 rows into the
 * pricing audit ledger every time somebody opens a card.
 *
 * The engine belongs to another module and can be unavailable — no supplier profile configured, a
 * migration not yet applied. That is reported as an unpriced comparison rather than as a failure
 * of the forecast, because the prediction itself does not depend on it.
 */
export const metadata = {
  POST: {
    requireAuth: true,
    requireFeatures: ['customers.companies.view', 'sales.orders.view', 'pricing.simulate'],
  },
}

const paramsSchema = z.object({ customerId: z.string().uuid() })

const requestSchema = z.object({
  currencyCode: z.string().trim().length(3).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        variantId: z.string().uuid().nullable().optional(),
        quantity: z.coerce.number().positive(),
      }),
    )
    .min(1)
    .max(50),
})

const totalsSchema = z.object({
  totalNet: z.number(),
  totalCostNet: z.number(),
  marginPercent: z.number().nullable(),
})

const responseSchema = z.object({
  currencyCode: z.string().nullable(),
  together: totalsSchema.nullable(),
  separate: totalsSchema.nullable(),
  savingAmount: z.number().nullable(),
  savingPercent: z.number().nullable(),
  lineCount: z.number().int(),
  warnings: z.array(z.string()),
  unavailableReason: z.string().nullable(),
})

const errorSchema = z.object({ error: z.string() })

function toNumber(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

type BasketLine = z.infer<typeof requestSchema>['lines'][number]

function buildContext(
  base: { tenantId: string; organizationId: string; customerId: string; currencyCode: string },
  lines: BasketLine[],
): PricingContext {
  return {
    tenantId: base.tenantId,
    organizationId: base.organizationId,
    currencyCode: base.currencyCode,
    customerId: base.customerId,
    customerGroupCode: null,
    orderScenarioCode: null,
    deliveryZoneCode: null,
    lines: lines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId ?? null,
      sku: null,
      quantity: String(line.quantity),
      enteredQuantity: null,
      enteredUnitCode: null,
    })),
    date: new Date(),
    mode: 'shadow',
  }
}

export async function POST(request: Request, context: { params?: { customerId?: string } }) {
  try {
    const { customerId } = paramsSchema.parse({ customerId: context.params?.customerId })
    const body = await readJsonSafe<unknown>(request, {})
    const input = requestSchema.parse(body)

    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(request)
    if (!auth?.tenantId) {
      throw new CrudHttpError(401, { error: 'Unauthorized' })
    }
    const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
    const organizationId = organizationScope?.selectedId ?? auth.orgId ?? null
    if (!organizationId) {
      throw new CrudHttpError(401, { error: 'Unauthorized' })
    }

    const base = {
      tenantId: auth.tenantId,
      organizationId,
      customerId,
      currencyCode: input.currencyCode ?? '',
    }

    let pricingService: PricingService
    try {
      pricingService = container.resolve('pricingService') as PricingService
    } catch (error) {
      logger.warn('Pricing engine not available for basket comparison', { err: error })
      return NextResponse.json(
        responseSchema.parse({
          currencyCode: null,
          together: null,
          separate: null,
          savingAmount: null,
          savingPercent: null,
          lineCount: input.lines.length,
          warnings: [],
          unavailableReason: 'distributor_workspace.orderForecast.pricing.engineUnavailable',
        }),
      )
    }

    const quoteOptions = { persist: false, triggeredBy: 'simulate' as const, triggeredByUserId: null }

    let together: PricingQuoteResult
    const separateResults: PricingQuoteResult[] = []
    try {
      together = await pricingService.quote(buildContext(base, input.lines), quoteOptions)
      for (const line of input.lines) {
        separateResults.push(await pricingService.quote(buildContext(base, [line]), quoteOptions))
      }
    } catch (error) {
      logger.warn('Basket pricing comparison failed', { err: error })
      return NextResponse.json(
        responseSchema.parse({
          currencyCode: null,
          together: null,
          separate: null,
          savingAmount: null,
          savingPercent: null,
          lineCount: input.lines.length,
          warnings: [],
          unavailableReason: 'distributor_workspace.orderForecast.pricing.quoteFailed',
        }),
      )
    }

    const togetherNet = toNumber(together.totalNet)
    const separateNet = separateResults.reduce((total, result) => total + toNumber(result.totalNet), 0)
    const separateCost = separateResults.reduce(
      (total, result) => total + toNumber(result.totalCostNet),
      0,
    )
    const savingAmount = separateNet - togetherNet

    const warnings = [
      ...together.warnings,
      ...separateResults.flatMap((result) => result.warnings),
    ]

    return NextResponse.json(
      responseSchema.parse({
        currencyCode: together.currencyCode,
        together: {
          totalNet: togetherNet,
          totalCostNet: toNumber(together.totalCostNet),
          marginPercent: toNumber(together.totalMarginPercent),
        },
        separate: {
          totalNet: separateNet,
          totalCostNet: separateCost,
          marginPercent: separateNet > 0 ? ((separateNet - separateCost) / separateNet) * 100 : null,
        },
        savingAmount,
        // Expressed against the dearer of the two, so "12% cheaper" means what a customer would
        // take it to mean: this much off what splitting the order would have cost them.
        savingPercent: separateNet > 0 ? (savingAmount / separateNet) * 100 : null,
        lineCount: input.lines.length,
        warnings: [...new Set(warnings)],
        unavailableReason: null,
      }),
    )
  } catch (error) {
    if (isCrudHttpError(error)) {
      return NextResponse.json(error.body, { status: error.status })
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    logger.error('Failed to compare basket pricing', { err: error })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Distributor Workspace',
  summary: 'Price a predicted basket together against separately',
  description:
    'Prices the predicted basket twice through the pricing engine — once as a single delivery, once as one delivery per line — and reports the difference. Several engine costs are per-delivery rather than per-item, so consolidating an order genuinely changes its price, and this is the number an operator can quote on the phone. Runs without persisting a calculation; if the pricing engine is unavailable the comparison is reported as unpriced rather than failing.',
  methods: {
    POST: {
      summary: 'Compare the basket priced together and priced apart',
      responses: [{ status: 200, description: 'Both totals and the difference', schema: responseSchema }],
      errors: [
        { status: 400, description: 'Invalid payload', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 500, description: 'Comparison failed', schema: errorSchema },
      ],
    },
  },
}
