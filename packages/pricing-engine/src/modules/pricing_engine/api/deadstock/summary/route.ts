import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { PricingComponentParam, PricingSupplierProfile } from '../../../data/entities'
import { resolvePricingRouteContext } from '../../../lib/api/context'
import { loadDeadstock } from '../../../lib/deadstock/loader'
import { DEADSTOCK_COMPONENT_CODE, readDeadstockPolicy } from '../../../lib/deadstock/policy'
import { deadstockSummaryResponseSchema } from '../../../lib/deadstock/schemas'
import { deadstockTotals, toDeadstockRow } from '../../../lib/deadstock/view'

const logger = createLogger('pricing_engine')

/**
 * Totals only — how much stock is dormant, what it ties up and what keeping it costs.
 *
 * ## Why this is a separate route rather than a flag on the list
 *
 * It is gated on `pricing.deadstock.summary`, which exists to be granted ON ITS OWN to a warehouse
 * role: someone running an operational screen needs the scale of the problem without access to
 * purchase prices, margins or the pricing module. A flag on the list route could not express that —
 * the endpoint would still be capable of returning unit costs, and a permission that depends on a
 * query parameter is not a permission.
 *
 * The response shape carries no rows at all, so no product-level figure can escape through it
 * however the request is written. The totals are computed by the same function the screen uses, so
 * a tile and the screen behind it can never disagree.
 */
export const metadata = {
  path: '/pricing/deadstock/summary',
  GET: { requireAuth: true, requireFeatures: ['pricing.deadstock.summary'] },
}

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await resolvePricingRouteContext(req)
    const em = ctx.container.resolve('em') as EntityManager
    const asOf = new Date()

    const [paramRows, supplier] = await Promise.all([
      em.find(PricingComponentParam, {
        tenantId: ctx.tenantId,
        organizationId: ctx.organizationId,
        deletedAt: null,
        componentCode: DEADSTOCK_COMPONENT_CODE,
        scope: 'global',
      }),
      em.findOne(PricingSupplierProfile, {
        tenantId: ctx.tenantId,
        organizationId: ctx.organizationId,
        deletedAt: null,
      }),
    ])

    const applicable = paramRows
      .filter((row) => row.validFrom.getTime() <= asOf.getTime())
      .filter((row) => !row.validTo || row.validTo.getTime() > asOf.getTime())
      .sort((left, right) => right.validFrom.getTime() - left.validFrom.getTime())
    const policy = readDeadstockPolicy(applicable[0]?.payload ?? null)

    const loaded = await loadDeadstock(
      em,
      ctx.container,
      { tenantId: ctx.tenantId, organizationId: ctx.organizationId },
      { asOf, policy },
    )

    const rows = loaded.positions.map((position) => toDeadstockRow(position, loaded.asOf))
    const stockedCount = rows.filter((row) => row.onHandQuantity !== '0.0000').length

    return NextResponse.json(
      deadstockSummaryResponseSchema.parse({
        totals: deadstockTotals(rows, stockedCount, rows.length),
        asOf: loaded.asOf.toISOString(),
        currencyCode: supplier?.currencyCode ?? 'PLN',
        warehouseCostConfigured: loaded.warehouse !== null,
        warnings: loaded.warnings,
      }),
    )
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    logger.error('Deadstock summary failed', { error: err })
    return NextResponse.json({ error: 'pricing_engine.errors.deadstockFailed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Pricing Engine',
  summary: 'Deadstock totals',
  methods: {
    GET: {
      summary: 'Dormant stock totals for KPI tiles, without any product-level figures',
      responses: [{ status: 200, description: 'Deadstock totals', schema: deadstockSummaryResponseSchema }],
    },
  },
}
