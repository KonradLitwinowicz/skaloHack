import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { PricingShadowObservation } from '../../data/entities'
import { resolvePricingRouteContext } from '../../lib/api/context'

const logger = createLogger('pricing_engine')

// Pinned path: the generator resolves the served path by STATIC analysis of this object literal.
// Read-only by construction — `pricing_shadow_observations` is an append-only ledger written by the
// sales decorator, and nothing may edit or delete a row through the API.
export const metadata = {
  path: '/pricing/shadow-observations',
  GET: { requireAuth: true, requireFeatures: ['pricing.audit.read'] },
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  observedFrom: z.coerce.date().optional(),
  observedTo: z.coerce.date().optional(),
  // Magnitude, unsigned: an operator asking "show me the lines that diverge by more than 10%" means
  // either direction, so this filters on the absolute value of a signed column.
  minAbsDeltaPercent: z.coerce.number().min(0).max(999.9999).optional(),
})

const observationSchema = z.object({
  id: z.string().uuid(),
  observedAt: z.string(),
  salesDocumentKind: z.string().nullable(),
  salesDocumentId: z.string().nullable(),
  salesLineId: z.string().nullable(),
  customerId: z.string().nullable(),
  calculationId: z.string().nullable(),
  invoicedUnitPriceNet: z.string(),
  engineUnitPriceNet: z.string(),
  deltaAbsolute: z.string(),
  deltaPercent: z.string(),
  /** False when the invoiced amount was zero, so `deltaPercent` carries a filler value. */
  hasDeltaPercent: z.boolean(),
})

const listResponseSchema = z.object({
  items: z.array(observationSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
})

function buildFilters(
  scope: { tenantId: string; organizationId: string },
  query: z.infer<typeof listQuerySchema>,
): Record<string, unknown> {
  const filters: Record<string, unknown> = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  }

  const observedAt: Record<string, Date> = {}
  if (query.observedFrom) observedAt.$gte = query.observedFrom
  if (query.observedTo) observedAt.$lte = query.observedTo
  if (Object.keys(observedAt).length > 0) filters.observedAt = observedAt

  if (query.minAbsDeltaPercent !== undefined && query.minAbsDeltaPercent > 0) {
    const threshold = query.minAbsDeltaPercent.toFixed(4)
    filters.$or = [
      { deltaPercent: { $gte: threshold } },
      { deltaPercent: { $lte: `-${threshold}` } },
    ]
  }

  return filters
}

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await resolvePricingRouteContext(req)
    const parsed = listQuerySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams.entries()),
    )
    if (!parsed.success) {
      return NextResponse.json({ error: 'pricing_engine.errors.invalidInput' }, { status: 400 })
    }
    const query = parsed.data

    const em = ctx.container.resolve('em') as EntityManager
    const [rows, total] = await em.findAndCount(
      PricingShadowObservation,
      buildFilters({ tenantId: ctx.tenantId, organizationId: ctx.organizationId }, query),
      {
        orderBy: { observedAt: 'desc' },
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      },
    )

    return NextResponse.json(
      listResponseSchema.parse({
        items: rows.map((row) => ({
          id: row.id,
          observedAt: row.observedAt.toISOString(),
          salesDocumentKind: row.salesDocumentKind ?? null,
          salesDocumentId: row.salesDocumentId ?? null,
          salesLineId: row.salesLineId ?? null,
          customerId: row.customerId ?? null,
          calculationId: row.calculationId ?? null,
          invoicedUnitPriceNet: row.invoicedUnitPriceNet,
          engineUnitPriceNet: row.engineUnitPriceNet,
          deltaAbsolute: row.deltaAbsolute,
          deltaPercent: row.deltaPercent,
          hasDeltaPercent: Number(row.invoicedUnitPriceNet) !== 0,
        })),
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      }),
    )
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    logger.error('Pricing shadow observation lookup failed', { error: err })
    return NextResponse.json({ error: 'pricing_engine.errors.shadowObservationsFailed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Pricing Engine',
  summary: 'Shadow observations',
  methods: {
    GET: {
      summary:
        'List what the engine would have charged next to what sales actually invoiced. Read-only: these rows are never a price.',
      responses: [
        { status: 200, description: 'Shadow observations', schema: listResponseSchema },
        { status: 400, description: 'Invalid query', schema: z.object({ error: z.string() }) },
      ],
    },
  },
}
