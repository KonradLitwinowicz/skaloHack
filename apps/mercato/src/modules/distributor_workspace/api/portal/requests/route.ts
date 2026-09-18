import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import {
  SALES_RESOURCE_KIND_ORDER,
  SALES_RESOURCE_KIND_QUOTE,
} from '@open-mercato/core/modules/sales/commands/shared'
import type {
  OrderCreateInput,
  QuoteCreateInput,
} from '@open-mercato/core/modules/sales/data/validators'
import { parsePortalBasket, portalBasketLineSchema, priceBasket } from '../../../lib/portalBasket'
import type { PortalQuoteResponse } from '../../../lib/portalPricing'
import type { SellableProduct } from '../../../lib/portalCatalog'
import {
  assertPortalFeature,
  PORTAL_ORDER_CREATE_FEATURE,
  PORTAL_QUOTE_REQUEST_FEATURE,
  resolvePortalSession,
  type PortalSession,
} from '../../../lib/portalSession'

export const metadata = {
  POST: { requireAuth: false },
}

const logger = createLogger('distributor_workspace').child({ component: 'portal-requests' })

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/

const submitRequestSchema = z.object({
  kind: z.enum(['quote', 'order']),
  comments: z.string().trim().max(4000).optional(),
  lines: z.array(portalBasketLineSchema).min(1).max(100),
})

type SubmitKind = z.infer<typeof submitRequestSchema>['kind']

function buildDocumentLines(
  quote: PortalQuoteResponse,
  products: Map<string, SellableProduct>,
): NonNullable<QuoteCreateInput['lines']> {
  return quote.lines.map((line, index) => ({
    lineNumber: index + 1,
    kind: 'product' as const,
    productId: line.productId,
    name: products.get(line.productId)?.title ?? line.sku ?? undefined,
    currencyCode: quote.currencyCode,
    quantity: Number(line.quantity),
    unitPriceNet: Number(line.unitPriceNet),
    totalNetAmount: Number(line.totalPriceNet),
  }))
}

async function runPortalGuard(
  req: Request,
  session: PortalSession,
  kind: SubmitKind,
  mutationPayload: Record<string, unknown>,
) {
  return runRouteMutationGuards({
    container: session.container,
    req,
    auth: {
      userId: session.auth.sub,
      tenantId: session.tenantId,
      organizationId: session.organizationId,
      userFeatures: session.auth.resolvedFeatures,
    },
    input: {
      resourceKind: kind === 'order' ? SALES_RESOURCE_KIND_ORDER : SALES_RESOURCE_KIND_QUOTE,
      resourceId: null,
      operation: 'create',
      mutationPayload,
    },
  })
}

export async function POST(req: Request) {
  const session = await resolvePortalSession(req, [])
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

  const parsed = submitRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'distributor_workspace.portal.errors.invalidInput' },
      { status: 400 },
    )
  }
  const basket = parsePortalBasket({ lines: parsed.data.lines })
  if (!basket) {
    return NextResponse.json(
      { ok: false, error: 'distributor_workspace.portal.errors.invalidInput' },
      { status: 400 },
    )
  }

  const kind = parsed.data.kind
  const denied = await assertPortalFeature(session, [
    kind === 'order' ? PORTAL_ORDER_CREATE_FEATURE : PORTAL_QUOTE_REQUEST_FEATURE,
  ])
  if (denied) return denied

  // Prices are always recomputed here. Anything the browser sent about money is ignored.
  const priced = await priceBasket(session, basket)
  if (!priced.ok) return priced.response

  const currencyCode = priced.quote.currencyCode
  if (!CURRENCY_CODE_PATTERN.test(currencyCode)) {
    return NextResponse.json(
      { ok: false, error: 'distributor_workspace.portal.errors.pricingUnavailable' },
      { status: 409 },
    )
  }

  const totalNet = Number(priced.quote.totalNet)
  const lines = buildDocumentLines(priced.quote, priced.products)
  const shared = {
    organizationId: session.organizationId,
    tenantId: session.tenantId,
    customerEntityId: session.customerEntityId,
    currencyCode,
    comments: parsed.data.comments,
    subtotalNetAmount: totalNet,
    grandTotalNetAmount: totalNet,
    lineItemCount: lines.length,
  }

  const guarded = await runPortalGuard(req, session, kind, { ...shared, lines })
  if (!guarded.ok) return guarded.response

  const commandBus = session.container.resolve('commandBus') as CommandBus
  try {
    if (kind === 'order') {
      const input: OrderCreateInput = { ...shared, lines }
      const created = await commandBus.execute<OrderCreateInput, { orderId: string }>(
        'sales.orders.create',
        { input, ctx: session.commandCtx },
      )
      const orderId = created.result?.orderId
      if (typeof orderId !== 'string') {
        return NextResponse.json(
          { ok: false, error: 'distributor_workspace.portal.errors.submitFailed' },
          { status: 500 },
        )
      }
      await guarded.runAfterSuccess()
      return NextResponse.json({ ok: true, kind, documentId: orderId }, { status: 201 })
    }

    const input: QuoteCreateInput = { ...shared, lines }
    const created = await commandBus.execute<QuoteCreateInput, { quoteId: string }>(
      'sales.quotes.create',
      { input, ctx: session.commandCtx },
    )
    const quoteId = created.result?.quoteId
    if (typeof quoteId !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'distributor_workspace.portal.errors.submitFailed' },
        { status: 500 },
      )
    }
    await guarded.runAfterSuccess()
    return NextResponse.json({ ok: true, kind, documentId: quoteId }, { status: 201 })
  } catch (err) {
    if (isCrudHttpError(err)) {
      // The status is useful to the caller; the body is not. It comes from an internal sales command
      // and can carry field names, validator details and messages written for staff. A portal session
      // is an external party, so it gets a stable key and nothing else — the detail goes to the log.
      logger.warn('portal basket submission rejected', {
        status: err.status,
        kind,
        customerEntityId: session.customerEntityId,
        tenantId: session.tenantId,
        organizationId: session.organizationId,
      })
      return NextResponse.json(
        { ok: false, error: 'distributor_workspace.portal.errors.submitRejected' },
        { status: err.status },
      )
    }
    logger.error('portal basket submission failed', {
      err,
      kind,
      customerEntityId: session.customerEntityId,
      tenantId: session.tenantId,
      organizationId: session.organizationId,
    })
    return NextResponse.json(
      { ok: false, error: 'distributor_workspace.portal.errors.submitFailed' },
      { status: 500 },
    )
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Distributor Portal',
  summary: 'Customer portal basket submission',
  methods: {
    POST: {
      summary: 'Submit the basket as a sales quote request or a sales order',
      requestBody: { contentType: 'application/json', schema: submitRequestSchema },
      responses: [
        {
          status: 201,
          description: 'The created sales document',
          schema: z.object({
            ok: z.literal(true),
            kind: z.enum(['quote', 'order']),
            documentId: z.string().uuid(),
          }),
        },
      ],
    },
  },
}
