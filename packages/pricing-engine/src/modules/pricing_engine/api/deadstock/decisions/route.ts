import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { PricingDeadstockDecision } from '../../../data/entities'
import { resolvePricingRouteContext } from '../../../lib/api/context'
import { loadDeadstock } from '../../../lib/deadstock/loader'
import { toDeadstockRow } from '../../../lib/deadstock/view'
import { isUndefinedTableError } from '../../../lib/deadstock/missingTable'
import {
  deadstockDecisionCreateSchema,
  deadstockDecisionResponseSchema,
} from '../../../lib/deadstock/schemas'

const logger = createLogger('pricing_engine')

export const metadata = {
  path: '/pricing/deadstock/decisions',
  POST: { requireAuth: true, requireFeatures: ['pricing.deadstock.decide'] },
}

const MS_PER_DAY = 86_400_000

/**
 * Decisions are append-only, and that is why this route has no PUT and no DELETE.
 *
 * A judgement is a historical fact: somebody looked at these figures, on this date, and said this.
 * Editing it away would destroy the only audit trail the feature has, and the reversal an operator
 * actually wants — "I was wrong, put it back on the list" — is itself a decision worth recording.
 * So a change is a new row, and the most recent row is the one in force. No row is ever rewritten,
 * which is also why there is no version to lock against.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const ctx = await resolvePricingRouteContext(req)
    const em = ctx.container.resolve('em') as EntityManager
    const input = deadstockDecisionCreateSchema.parse(await req.json())

    const decidedAt = new Date()

    // The snapshot is computed here, never taken from the request body.
    //
    // It is not decoration: `guardrails` reads the floor out of it, so a client that could post its
    // own numbers could authorise any price it liked. Recomputing costs one narrow pass over a
    // single product, and a decision is a rare event.
    const loaded = await loadDeadstock(
      em,
      ctx.container,
      { tenantId: ctx.tenantId, organizationId: ctx.organizationId },
      { asOf: decidedAt, productIds: [input.productId] },
    )
    const position = loaded.positions.find((row) => row.productId === input.productId) ?? null
    const snapshot = position
      ? (toDeadstockRow(position, decidedAt) as unknown as Record<string, unknown>)
      : null

    const decision = em.create(PricingDeadstockDecision, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      catalogProductId: input.productId,
      catalogVariantId: input.variantId ?? null,
      verdict: input.verdict,
      reasonCode: input.reasonCode ?? null,
      note: input.note ?? null,
      decidedBy: ctx.userId ?? null,
      decidedAt,
      // A dismissal with no review date never lapses, which is a choice the operator has to make
      // deliberately rather than by leaving a field blank on a form that defaulted to forever.
      reviewAt:
        input.verdict === 'dismissed' && input.reviewInDays
          ? new Date(decidedAt.getTime() + input.reviewInDays * MS_PER_DAY)
          : null,
      snapshot,
    })
    em.persist(decision)
    await em.flush()

    return NextResponse.json(
      deadstockDecisionResponseSchema.parse({
        ok: true,
        decision: {
          id: decision.id,
          verdict: decision.verdict,
          reasonCode: decision.reasonCode ?? null,
          note: decision.note ?? null,
          decidedAt: decision.decidedAt.toISOString(),
          reviewAt: decision.reviewAt ? decision.reviewAt.toISOString() : null,
          inForce: true,
        },
      }),
    )
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    // The read paths treat a missing table as "no decisions"; a write cannot, because there is
    // nowhere to put the decision. But it is not an internal error either — the deployment is
    // simply a migration behind, which is a normal state of this repo. Saying that costs one
    // branch and saves the operator from a generic failure with no next step.
    if (isUndefinedTableError(err)) {
      logger.warn('Deadstock decision rejected: table not migrated yet')
      return NextResponse.json({ error: 'pricing_engine.errors.deadstockNotMigrated' }, { status: 503 })
    }
    logger.error('Deadstock decision failed', { error: err })
    return NextResponse.json({ error: 'pricing_engine.errors.deadstockDecisionFailed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Pricing Engine',
  summary: 'Deadstock decisions',
  methods: {
    POST: {
      summary: 'Record an operator judgement about a dormant position',
      responses: [{ status: 200, description: 'Decision recorded', schema: deadstockDecisionResponseSchema }],
    },
  },
}
