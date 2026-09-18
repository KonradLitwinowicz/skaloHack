import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { quoteRequestSchema, quoteResponseSchema } from '../../data/validators'
import { handleQuoteRequest } from '../../lib/api/quoteHandler'

// Pinned path: the auto-derived value would be `/pricing-engine/quote`. `resolveApiPathFromMetadata`
// honours `metadata.path` verbatim. This is a frozen contract surface.
export const metadata = {
  path: '/pricing/quote',
  POST: { requireAuth: true, requireFeatures: ['pricing.quote'] },
}

export async function POST(req: Request): Promise<Response> {
  return handleQuoteRequest(req, { persist: true, triggeredBy: 'api' })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Pricing Engine',
  summary: 'Price a basket',
  methods: {
    POST: {
      summary: 'Price a basket and persist the calculation with its component breakdown',
      requestBody: { contentType: 'application/json', schema: quoteRequestSchema },
      responses: [
        { status: 200, description: 'Priced basket with breakdown', schema: quoteResponseSchema },
        {
          status: 409,
          description: 'No supplier profile configured for this tenant',
          schema: z.object({ error: z.string() }),
        },
      ],
    },
  },
}
