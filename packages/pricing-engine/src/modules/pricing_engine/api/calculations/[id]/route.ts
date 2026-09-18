import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { PricingCalculation, PricingCalculationLine } from '../../../data/entities'
import { resolvePricingRouteContext } from '../../../lib/api/context'

const logger = createLogger('pricing_engine')

export const metadata = {
  path: '/pricing/calculations/[id]',
  GET: { requireAuth: true, requireFeatures: ['pricing.audit.read'] },
}

const calculationResponseSchema = z.object({
  id: z.string().uuid(),
  currencyCode: z.string(),
  mode: z.enum(['shadow', 'advisory', 'live']),
  parameterSetVersion: z.number().int(),
  contextSnapshot: z.record(z.string(), z.unknown()),
  finalUnitPriceNet: z.string(),
  finalTotalNet: z.string(),
  totalCostNet: z.string(),
  markupPercent: z.string(),
  marginPercent: z.string(),
  warnings: z.array(z.string()),
  calculatedAt: z.string(),
  lines: z.array(
    z.object({
      basketLineIndex: z.number().int(),
      componentCode: z.string(),
      position: z.number().int(),
      effect: z.enum(['add', 'mul']),
      value: z.string(),
      runningTotal: z.string(),
      inputs: z.record(z.string(), z.unknown()).nullable(),
      params: z.record(z.string(), z.unknown()).nullable(),
      explainKey: z.string(),
      explainValues: z.record(z.string(), z.unknown()).nullable(),
      confidence: z.enum(['measured', 'estimated', 'default']),
      warnings: z.array(z.string()).nullable(),
    }),
  ),
})

export async function GET(
  req: Request,
  routeContext: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const ctx = await resolvePricingRouteContext(req)
    const { id } = await routeContext.params
    const em = ctx.container.resolve('em') as EntityManager

    const calculation = await em.findOne(PricingCalculation, {
      id,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    })
    if (!calculation) {
      return NextResponse.json({ error: 'pricing_engine.errors.calculationNotFound' }, { status: 404 })
    }

    const lines = await em.find(
      PricingCalculationLine,
      { calculationId: calculation.id, tenantId: ctx.tenantId, organizationId: ctx.organizationId },
      { orderBy: { basketLineIndex: 'asc', position: 'asc' } },
    )

    return NextResponse.json(
      calculationResponseSchema.parse({
        id: calculation.id,
        currencyCode: calculation.currencyCode,
        mode: calculation.mode,
        parameterSetVersion: calculation.parameterSetVersion,
        contextSnapshot: calculation.contextSnapshot,
        finalUnitPriceNet: calculation.finalUnitPriceNet,
        finalTotalNet: calculation.finalTotalNet,
        totalCostNet: calculation.totalCostNet,
        markupPercent: calculation.markupPercent,
        marginPercent: calculation.marginPercent,
        warnings: calculation.warnings ?? [],
        calculatedAt: calculation.calculatedAt.toISOString(),
        lines: lines.map((line) => ({
          basketLineIndex: line.basketLineIndex,
          componentCode: line.componentCode,
          position: line.position,
          effect: line.effect,
          value: line.value,
          runningTotal: line.runningTotal,
          inputs: line.inputs ?? null,
          params: line.params ?? null,
          explainKey: line.explainKey,
          explainValues: line.explainValues ?? null,
          confidence: line.confidence,
          warnings: line.warnings ?? null,
        })),
      }),
    )
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    logger.error('Pricing calculation lookup failed', { error: err })
    return NextResponse.json({ error: 'pricing_engine.errors.calculationFailed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Pricing Engine',
  summary: 'Replay a stored calculation',
  methods: {
    GET: {
      summary: 'Return a persisted calculation with its full component breakdown',
      responses: [
        { status: 200, description: 'Stored calculation', schema: calculationResponseSchema },
        { status: 404, description: 'Not found', schema: z.object({ error: z.string() }) },
      ],
    },
  },
}
