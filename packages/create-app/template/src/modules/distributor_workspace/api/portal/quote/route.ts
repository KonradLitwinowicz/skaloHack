import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { parsePortalBasket, portalBasketSchema, priceBasket } from '../../../lib/portalBasket'
import { PORTAL_CATALOG_FEATURE, resolvePortalSession } from '../../../lib/portalSession'

// Deliberately NOT `/api/pricing/quote`: that route is guarded by the staff feature
// `pricing.quote` and its response carries unit cost, markup, margin and the full component
// breakdown. This route authenticates a customer session and returns the buyer-safe projection
// built by `lib/portalPricing.ts`.
export const metadata = {
  POST: { requireAuth: false },
}

const portalQuoteLineSchema = z.object({
  productId: z.string().uuid(),
  sku: z.string().nullable(),
  quantity: z.string(),
  unitPriceNet: z.string(),
  totalPriceNet: z.string(),
})

export async function POST(req: Request) {
  const session = await resolvePortalSession(req, [PORTAL_CATALOG_FEATURE])
  if (session instanceof Response) return session

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'distributor_workspace.portal.errors.invalidInput' },
      { status: 400 },
    )
  }

  const basket = parsePortalBasket(body)
  if (!basket) {
    return NextResponse.json(
      { ok: false, error: 'distributor_workspace.portal.errors.invalidInput' },
      { status: 400 },
    )
  }

  const priced = await priceBasket(session, basket)
  if (!priced.ok) return priced.response
  return NextResponse.json(priced.quote)
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Distributor Portal',
  summary: 'Customer portal basket pricing',
  methods: {
    POST: {
      summary: 'Price a basket for the authenticated customer, without any cost or margin data',
      requestBody: { contentType: 'application/json', schema: portalBasketSchema },
      responses: [
        {
          status: 200,
          description: 'The prices this customer pays',
          schema: z.object({
            ok: z.literal(true),
            currencyCode: z.string(),
            lines: z.array(portalQuoteLineSchema),
            totalNet: z.string(),
          }),
        },
      ],
    },
  },
}
