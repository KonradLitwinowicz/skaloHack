import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { listPortalCatalog } from '../../../lib/portalCatalog'
import { PORTAL_CATALOG_FEATURE, resolvePortalSession } from '../../../lib/portalSession'

// Staff auth is opted out here so the handler can resolve the CUSTOMER session instead; the API
// dispatcher never consults `customerRbacService`, so authorization happens in-handler.
export const metadata = {
  GET: { requireAuth: false },
}

const emptyToUndefined = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(24),
  search: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(190).optional()),
  category: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(190).optional()),
})

const catalogItemSchema = z.object({
  productId: z.string().uuid(),
  sku: z.string().nullable(),
  title: z.string(),
  categoryCode: z.string().nullable(),
})

const catalogCategorySchema = z.object({
  code: z.string(),
  label: z.string(),
  productCount: z.number().int().nonnegative(),
})

export async function GET(req: Request) {
  const session = await resolvePortalSession(req, [PORTAL_CATALOG_FEATURE])
  if (session instanceof Response) return session

  const url = new URL(req.url)
  const parsed = listQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'distributor_workspace.portal.errors.invalidInput' },
      { status: 400 },
    )
  }

  const page = await listPortalCatalog(
    {
      em: session.em,
      container: session.container,
      tenantId: session.tenantId,
      organizationId: session.organizationId,
    },
    {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      search: parsed.data.search,
      categoryCode: parsed.data.category,
    },
  )

  return NextResponse.json({ ok: true, ...page })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Distributor Portal',
  summary: 'Customer portal catalog browse',
  methods: {
    GET: {
      summary: 'List the products this customer can order, with their browse categories',
      query: listQuerySchema,
      responses: [
        {
          status: 200,
          description: 'A page of orderable products',
          schema: z.object({
            ok: z.literal(true),
            items: z.array(catalogItemSchema),
            total: z.number().int().nonnegative(),
            page: z.number().int().min(1),
            pageSize: z.number().int().min(1),
            totalPages: z.number().int().min(1),
            categories: z.array(catalogCategorySchema),
          }),
        },
      ],
    },
  },
}
