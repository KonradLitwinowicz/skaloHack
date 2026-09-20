import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { PricingComponentParam, PricingSupplierProfile } from '../../data/entities'
import { resolvePricingRouteContext } from '../../lib/api/context'
import { loadDeadstock } from '../../lib/deadstock/loader'
import { DEADSTOCK_COMPONENT_CODE, readDeadstockPolicy } from '../../lib/deadstock/policy'
import { deadstockListQuerySchema, deadstockListResponseSchema } from '../../lib/deadstock/schemas'
import {
  deadstockTotals,
  filterDeadstockRows,
  paginate,
  sortDeadstockRows,
  toDeadstockRow,
} from '../../lib/deadstock/view'

const logger = createLogger('pricing_engine')

// The literal matters: the route generator resolves `path` by static analysis, and a value built by
// a helper call falls back to /api/pricing_engine/... and 404s for everybody.
export const metadata = {
  path: '/pricing/deadstock',
  GET: { requireAuth: true, requireFeatures: ['pricing.view'] },
}

/**
 * Reads the deadstock policy from its parameter row.
 *
 * Global scope only. Per-product thresholds are expressible — `pricing_component_params` carries a
 * scope chain — but a screen that ranks the whole catalogue against each other has to rank it by
 * one standard, or the ordering means nothing.
 */
async function loadPolicy(em: EntityManager, tenantId: string, organizationId: string, asOf: Date) {
  const rows = await em.find(PricingComponentParam, {
    tenantId,
    organizationId,
    deletedAt: null,
    componentCode: DEADSTOCK_COMPONENT_CODE,
    scope: 'global',
  })
  const applicable = rows
    .filter((row) => row.validFrom.getTime() <= asOf.getTime())
    .filter((row) => !row.validTo || row.validTo.getTime() > asOf.getTime())
    .sort((left, right) => right.validFrom.getTime() - left.validFrom.getTime())
  return readDeadstockPolicy(applicable[0]?.payload ?? null)
}

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await resolvePricingRouteContext(req)
    const em = ctx.container.resolve('em') as EntityManager
    const url = new URL(req.url)
    const query = deadstockListQuerySchema.parse(Object.fromEntries(url.searchParams.entries()))

    const asOf = new Date()
    const [policy, supplier] = await Promise.all([
      loadPolicy(em, ctx.tenantId, ctx.organizationId, asOf),
      em.findOne(PricingSupplierProfile, {
        tenantId: ctx.tenantId,
        organizationId: ctx.organizationId,
        deletedAt: null,
      }),
    ])
    const loaded = await loadDeadstock(
      em,
      ctx.container,
      { tenantId: ctx.tenantId, organizationId: ctx.organizationId },
      { asOf, policy },
    )

    const rows = loaded.positions.map((position) => toDeadstockRow(position, loaded.asOf))
    // Totals are computed over every position before filtering: "82 972 zl is asleep" must not
    // change because somebody typed a word into the search box.
    //
    // `catalogCount` comes from the loader rather than from `rows.length`: positions are built
    // only for stocked products, so the row count answers "how many positions hold stock", and
    // the catalogue size is a different — larger — number.
    const stockedCount = rows.filter((row) => row.onHandQuantity !== '0.0000').length
    const totals = deadstockTotals(rows, stockedCount, loaded.catalogCount)

    const filtered = filterDeadstockRows(rows, query)
    const sorted = sortDeadstockRows(filtered, query.sort, query.dir)
    const { items, total, totalPages } = paginate(sorted, query.page, query.pageSize)

    const warnings = Array.from(new Set([...loaded.warnings, ...policy.rejected.map(policyWarningKey)]))

    return NextResponse.json(
      deadstockListResponseSchema.parse({
        items,
        totals,
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages,
        asOf: loaded.asOf.toISOString(),
        historyStartsAt: loaded.historyStartsAt.toISOString(),
        currencyCode: supplier?.currencyCode ?? 'PLN',
        warehouseCostConfigured: loaded.warehouse !== null,
        truncated: loaded.truncated,
        warnings,
      }),
    )
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    logger.error('Deadstock listing failed', { error: err })
    return NextResponse.json({ error: 'pricing_engine.errors.deadstockFailed' }, { status: 500 })
  }
}

function policyWarningKey(field: string): string {
  return `pricing_engine.deadstock.warnings.policyRejected.${field}`
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Pricing Engine',
  summary: 'Deadstock and rotation',
  methods: {
    GET: {
      summary: 'Rank stocked products by rotation, carrying cost and liquidation floor',
      responses: [{ status: 200, description: 'Deadstock rows with totals', schema: deadstockListResponseSchema }],
    },
  },
}
