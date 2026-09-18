import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { quoteResponseSchema, simulateRequestSchema } from '../../data/validators'
import { handleQuoteRequest } from '../../lib/api/quoteHandler'

export const metadata = {
  path: '/pricing/simulate',
  POST: { requireAuth: true, requireFeatures: ['pricing.simulate'] },
}

// A what-if must never pollute the audit ledger, so this route runs the identical pipeline with
// persistence off rather than writing and deleting.
export async function POST(req: Request): Promise<Response> {
  return handleQuoteRequest(req, { persist: false, triggeredBy: 'simulate' })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Pricing Engine',
  summary: 'Simulate a price without persisting',
  methods: {
    POST: {
      summary: 'Run the pricing pipeline without writing a calculation record',
      requestBody: { contentType: 'application/json', schema: simulateRequestSchema },
      responses: [
        { status: 200, description: 'Simulated price with breakdown', schema: quoteResponseSchema },
      ],
    },
  },
}
