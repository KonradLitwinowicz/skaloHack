import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import {
  invalidateForecastCacheForTenant,
  resolveForecastCache,
  type ForecastCacheService,
} from '../../../../lib/orderForecastCache'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { DistributorOrderPredictionFeedback } from '../../../../data/entities'
import {
  predictionFeedbackCreateSchema,
  predictionFeedbackDeleteSchema,
} from '../../../../data/validators'
import { productKeyOf, type PredictionFeedbackKind } from '../../../../lib/orderForecast'

const logger = createLogger('distributor_workspace').child({ component: 'prediction-feedback' })

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * How long each statement is taken at face value before the order history speaks for itself again.
 *
 * A confirmation is about one upcoming delivery, so it expires with the cycle it refers to; a
 * snooze is an explicit "not now"; a dismissal is open-ended because its usual cause — the product
 * left this customer's list for good — does not expire. None of these mute the data permanently by
 * accident, which is the failure mode worth designing against: a forecast silently suppressed by a
 * note somebody left eight months ago.
 */
const DEFAULT_VALIDITY_DAYS: Record<PredictionFeedbackKind, number | null> = {
  confirmed: 30,
  snoozed: 30,
  dismissed: null,
}

export const metadata = {
  POST: {
    requireAuth: true,
    requireFeatures: ['customers.companies.manage', 'sales.orders.view', 'distributor_workspace.forecast.feedback'],
  },
  DELETE: {
    requireAuth: true,
    requireFeatures: ['customers.companies.manage', 'sales.orders.view', 'distributor_workspace.forecast.feedback'],
  },
}

const paramsSchema = z.object({ customerId: z.string().uuid() })
const okSchema = z.object({ ok: z.literal(true), productKey: z.string() })
const errorSchema = z.object({ error: z.string() })

type RouteScope = {
  cache: ForecastCacheService | null
  em: EntityManager
  organizationId: string
  tenantId: string
  userId: string | null
}

async function resolveScope(request: Request): Promise<RouteScope> {
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
  return {
    cache: resolveForecastCache(container),
    em: (container.resolve('em') as EntityManager).fork(),
    organizationId,
    tenantId: auth.tenantId,
    userId: auth.sub ?? null,
  }
}

function resolveValidUntil(kind: PredictionFeedbackKind, provided: Date | null | undefined): Date | null {
  if (provided !== undefined && provided !== null) return provided
  const days = DEFAULT_VALIDITY_DAYS[kind]
  return days === null ? null : new Date(Date.now() + days * MILLISECONDS_PER_DAY)
}

export async function POST(request: Request, context: { params?: { customerId?: string } }) {
  try {
    const { customerId } = paramsSchema.parse({ customerId: context.params?.customerId })
    const body = await readJsonSafe<unknown>(request, {})
    const input = predictionFeedbackCreateSchema.parse(body)
    const scope = await resolveScope(request)

    const productKey = productKeyOf(input.productVariantId ?? null, input.productId ?? null)
    if (productKey === 'unknown') {
      throw new CrudHttpError(400, { error: 'distributor_workspace.orderForecast.errors.productRequired' })
    }

    const existing = await scope.em.findOne(DistributorOrderPredictionFeedback, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      customerEntityId: customerId,
      productKey,
    })

    const validUntil = resolveValidUntil(input.kind, input.validUntil)
    if (existing) {
      existing.kind = input.kind
      existing.note = input.note ?? null
      existing.productId = input.productId ?? null
      existing.productVariantId = input.productVariantId ?? null
      existing.productName = input.productName ?? existing.productName ?? null
      existing.validUntil = validUntil
      existing.createdByUserId = scope.userId
      existing.deletedAt = null
      existing.updatedAt = new Date()
    } else {
      scope.em.persist(
        scope.em.create(DistributorOrderPredictionFeedback, {
          id: randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          customerEntityId: customerId,
          productKey,
          productId: input.productId ?? null,
          productVariantId: input.productVariantId ?? null,
          productName: input.productName ?? null,
          kind: input.kind,
          note: input.note ?? null,
          validUntil,
          createdByUserId: scope.userId,
        }),
      )
    }
    await scope.em.flush()
    // Notes feed the forecast, and they do not travel as sales events, so the cached forecast is
    // retired here rather than waiting out its TTL.
    await invalidateForecastCacheForTenant(scope.cache, scope.tenantId)

    return NextResponse.json(okSchema.parse({ ok: true, productKey }))
  } catch (error) {
    if (isCrudHttpError(error)) {
      return NextResponse.json(error.body, { status: error.status })
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    logger.error('Failed to record prediction feedback', { err: error })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: Request, context: { params?: { customerId?: string } }) {
  try {
    const { customerId } = paramsSchema.parse({ customerId: context.params?.customerId })
    const url = new URL(request.url)
    const input = predictionFeedbackDeleteSchema.parse({
      productId: url.searchParams.get('productId') ?? undefined,
      productVariantId: url.searchParams.get('productVariantId') ?? undefined,
    })
    const scope = await resolveScope(request)

    const productKey = productKeyOf(input.productVariantId ?? null, input.productId ?? null)
    await scope.em.nativeDelete(DistributorOrderPredictionFeedback, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      customerEntityId: customerId,
      productKey,
    })
    await invalidateForecastCacheForTenant(scope.cache, scope.tenantId)

    return NextResponse.json(okSchema.parse({ ok: true, productKey }))
  } catch (error) {
    if (isCrudHttpError(error)) {
      return NextResponse.json(error.body, { status: error.status })
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    logger.error('Failed to clear prediction feedback', { err: error })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Distributor Workspace',
  summary: 'Operator notes on a customer order prediction',
  description:
    'Records what the order history cannot know: that a product has left this customer list, that the next delivery was confirmed by phone, or that a prediction should be held back for now. One note per customer and product; posting again replaces it, and DELETE removes it so the raw rhythm shows through again.',
  methods: {
    POST: {
      summary: 'Record or replace a note',
      responses: [{ status: 200, description: 'Note stored', schema: okSchema }],
      errors: [
        { status: 400, description: 'Invalid payload', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 500, description: 'Note could not be stored', schema: errorSchema },
      ],
    },
    DELETE: {
      summary: 'Remove the note for one product',
      responses: [{ status: 200, description: 'Note removed', schema: okSchema }],
      errors: [
        { status: 400, description: 'Invalid payload', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 500, description: 'Note could not be removed', schema: errorSchema },
      ],
    },
  },
}
