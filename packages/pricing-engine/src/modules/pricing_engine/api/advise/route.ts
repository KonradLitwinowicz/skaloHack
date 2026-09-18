import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { hasAllFeatures } from '@open-mercato/shared/lib/auth/featureMatch'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { adviseRequestSchema, adviseResponseSchema, type Suggestion } from '../../lib/advisor/schemas'
import { resolvePricingRouteContext } from '../../lib/api/context'
import { serializeQuoteResult, toPricingErrorResponse } from '../../lib/api/quoteHandler'
import type { PricingAdvisorService } from '../../services/pricingAdvisorService'
import type { PricingContext } from '../../lib/types'

// Pinned path: the auto-derived value would be `/pricing-engine/advise`.
// `pricing.simulate` is the right gate because the advisor persists nothing — it scores
// hypothetical baskets and writes no calculation record.
export const metadata = {
  path: '/pricing/advise',
  POST: { requireAuth: true, requireFeatures: ['pricing.simulate'] },
}

const REP_ONLY_FEATURE = 'pricing.quote'

function grantedFeatures(auth: unknown): string[] {
  const features = (auth as { features?: unknown } | null)?.features
  if (!Array.isArray(features)) return []
  return features.filter((value): value is string => typeof value === 'string')
}

/**
 * A suggestion that raises the customer's price is a rep-side negotiation lever, never something a
 * customer-facing surface may render. Callers holding only `pricing.simulate` never see one.
 */
function filterForActor(suggestions: Suggestion[], features: string[]): Suggestion[] {
  if (hasAllFeatures([REP_ONLY_FEATURE], features)) return suggestions
  return suggestions.filter((suggestion) => !suggestion.raisesCustomerPrice)
}

export async function POST(req: Request): Promise<Response> {
  try {
    const ctx = await resolvePricingRouteContext(req)
    const auth = await getAuthFromRequest(req)
    const payload = await readJsonSafe(req, {})
    const parsed = adviseRequestSchema.parse(payload)

    const missingProductId = parsed.lines.find((line) => !line.productId)
    if (missingProductId) {
      throw new CrudHttpError(400, {
        error: ctx.translate(
          'pricing_engine.errors.productIdRequired',
          'Every line must carry a productId until SKU lookup ships.',
        ),
      })
    }

    const advisor = ctx.container.resolve('pricingAdvisorService') as PricingAdvisorService
    const context: PricingContext = {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      currencyCode: parsed.currencyCode ?? '',
      customerId: parsed.customerId ?? null,
      customerGroupCode: parsed.customerGroupCode ?? null,
      orderScenarioCode: parsed.orderScenarioCode ?? null,
      deliveryZoneCode: parsed.deliveryZoneCode ?? null,
      lines: parsed.lines.map((line) => ({
        productId: line.productId as string,
        variantId: line.variantId ?? null,
        sku: line.sku ?? null,
        quantity: line.quantity,
        enteredQuantity: line.enteredQuantity ?? null,
        enteredUnitCode: line.enteredUnitCode ?? null,
      })),
      date: parsed.date ?? new Date(),
      mode: 'shadow',
    }

    const result = await advisor.advise(context, {
      advisor: parsed.advisor,
      overrides: parsed.overrides,
    })

    return NextResponse.json({
      baseline: serializeQuoteResult(result.baseline),
      suggestions: filterForActor(result.suggestions, grantedFeatures(auth)),
      volumeSensitivity: result.volumeSensitivity,
      marginFloors: result.marginFloors,
      purchasingInsights: result.purchasingInsights,
    })
  } catch (err) {
    return toPricingErrorResponse(err, 'Pricing advise failed')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Pricing Engine',
  summary: 'Advise on price and margin without persisting',
  methods: {
    POST: {
      summary:
        'Score hypothetical baskets and return both sides of every suggestion: the customer price and the supplier profit, before and after',
      requestBody: { contentType: 'application/json', schema: adviseRequestSchema },
      responses: [
        { status: 200, description: 'Baseline quote with suggestions and sensitivity', schema: adviseResponseSchema },
      ],
    },
  },
}
