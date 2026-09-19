import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  buildNextActions,
  NEXT_ACTION_KINDS,
  QUOTE_REQUEST_RESPONSE_DAYS,
  QUOTE_SILENCE_DAYS,
  resolveExpiryWatchWindow,
  type NextActionSignal,
} from '../../../lib/nextActions'

const logger = createLogger('distributor_workspace').child({ component: 'dashboard-next-actions' })

// No `path`: every other route in this module lets the generator derive it from the folder
// structure, and a hand-written one carrying the `/api` prefix is dropped from the module's route
// shard — the route then 404s while still appearing in the global manifest.
export const metadata = {
  GET: {
    requireAuth: true,
    requireFeatures: ['dashboards.view', 'wms.view', 'sales.quotes.view', 'sales.orders.view'],
  },
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

type Scope = {
  organizationId: string
  tenantId: string
}

type CountRow = {
  count: number | string | null
}

type DeadlineRow = CountRow & {
  deadline_at: Date | string | null
}

type DocumentAmountColumns = {
  amount: number | string | null
  currency_count: number | string | null
  currency_code: string | null
}

type DocumentRow = DeadlineRow & DocumentAmountColumns

type QuoteRequestRow = CountRow &
  DocumentAmountColumns & {
    submitted_at: Date | string | null
  }

function toCount(value: number | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function toAmount(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  const time = date.getTime()
  return Number.isFinite(time) ? date.toISOString() : null
}

/**
 * Lots the WMS expiry card counts, counted again here from the same window and the same
 * availability rule so the two numbers cannot disagree.
 *
 * Window: `resolveExpiryWatchWindow` reads the bounds straight out of the WMS
 * `buildExpiryWindowDateFilter`, so both ends are inclusive exactly as they are there.
 *
 * Availability: the `exists (…)` clause mirrors `resolveLotAvailableQuantity`
 * (packages/core/src/modules/wms/lib/loadOperationalDashboard.ts), which sums only the balance
 * rows whose own availability is positive — its total is therefore above zero precisely when one
 * such row exists. The lot list this widget links to narrows by the same rule, with the same
 * expression (packages/core/src/modules/wms/api/lots/route.ts, the `requiresAvailableStock`
 * subquery). A `sum(...) > 0` over the whole lot would instead let a negative row cancel a
 * positive one and drop a lot the WMS screens still show.
 *
 * No warehouse scope on purpose: the widget speaks for the whole organization, while the WMS
 * dashboard narrows to the warehouse its selector holds.
 */
async function loadExpiringStock(em: EntityManager, scope: Scope, now: Date): Promise<NextActionSignal> {
  const watchWindow = resolveExpiryWatchWindow(now)
  const rows = await em.getConnection().execute<DeadlineRow[]>(
    `select count(*)::int as count, min(l.expires_at) as deadline_at
     from wms_inventory_lots l
     where l.deleted_at is null
       and l.organization_id = ?
       and l.tenant_id = ?
       and l.status = 'available'
       and l.expires_at is not null
       and l.expires_at >= ?
       and l.expires_at <= ?
       and exists (
         select 1
         from wms_inventory_balances b
         where b.lot_id = l.id
           and b.organization_id = l.organization_id
           and b.tenant_id = l.tenant_id
           and b.deleted_at is null
           and (
             coalesce(b.quantity_on_hand, 0)
             - coalesce(b.quantity_reserved, 0)
             - coalesce(b.quantity_allocated, 0)
           ) > 0
       )`,
    [scope.organizationId, scope.tenantId, watchWindow.from, watchWindow.toInclusive],
  )
  const row = rows[0]
  return {
    kind: 'expiringStock',
    count: toCount(row?.count),
    deadlineAt: toIsoString(row?.deadline_at),
    amount: null,
    currencyCode: null,
  }
}

/**
 * The WMS `reorderCritical` KPI, expressed in SQL. The predicate is copied term for term from
 * `resolveLowStockVariantIds(…, 'belowSafety')`
 * (packages/core/src/modules/wms/lib/lowStockBalanceFilter.ts), which is what
 * `/backend/wms/inventory?lowStock=belowSafety` — the link this row opens — narrows by, and which
 * `evaluateLowStockThresholds` (lib/inventoryPolicy.ts) mirrors for the KPI:
 *
 *   coalesce(p.safety_stock, 0) > 0 and availability.available <= coalesce(p.safety_stock, 0)
 *
 * The reorder point is deliberately absent. A profile may carry a safety stock ABOVE its reorder
 * point — nothing validates the ordering — and such a position is below safety stock while still
 * sitting above the reorder point, so an extra `available <= reorder_point` term would hide it
 * here while the list and the KPI still show it.
 *
 * Availability is summed per (variant, warehouse) with NO per-row clamping, the same arithmetic
 * the WMS map does — unlike the expiry query above, where WMS clamps per balance row. The pair
 * universe comes from the balance rows, so a (variant, warehouse) combination with no balance row
 * is not a position and is not counted.
 *
 * One row per qualifying pair: `wms_inventory_profiles_variant_unique_idx` allows a single live
 * profile per (organization, variant), so the join cannot multiply a pair.
 *
 * No warehouse scope, for the same reason as the expiry query above.
 */
async function loadCriticalStock(em: EntityManager, scope: Scope): Promise<NextActionSignal> {
  const rows = await em.getConnection().execute<CountRow[]>(
    `select count(*)::int as count
     from (
       select b.catalog_variant_id as catalog_variant_id,
              b.warehouse_id as warehouse_id,
              sum(
                coalesce(b.quantity_on_hand, 0)
                - coalesce(b.quantity_reserved, 0)
                - coalesce(b.quantity_allocated, 0)
              ) as available
       from wms_inventory_balances b
       where b.organization_id = ?
         and b.tenant_id = ?
         and b.deleted_at is null
       group by b.catalog_variant_id, b.warehouse_id
     ) availability
     join wms_product_inventory_profiles p
       on p.catalog_variant_id = availability.catalog_variant_id
      and p.organization_id = ?
      and p.tenant_id = ?
      and p.deleted_at is null
      and p.catalog_variant_id is not null
     where coalesce(p.safety_stock, 0) > 0
       and availability.available <= coalesce(p.safety_stock, 0)`,
    [scope.organizationId, scope.tenantId, scope.organizationId, scope.tenantId],
  )
  const row = rows[0]
  return {
    kind: 'criticalStock',
    count: toCount(row?.count),
    deadlineAt: null,
    amount: null,
    currencyCode: null,
  }
}

// A summed total only means something when every row behind it is in one currency. Two currencies
// in one bucket would otherwise add up to a number that is not money in any of them.
function resolveDocumentMoney(row: DocumentAmountColumns | undefined): {
  amount: number | null
  currencyCode: string | null
} {
  const mixedCurrencies = toCount(row?.currency_count) > 1
  return {
    amount: mixedCurrencies ? null : toAmount(row?.amount),
    currencyCode: mixedCurrencies ? null : row?.currency_code ?? null,
  }
}

function toDocumentSignal(kind: NextActionSignal['kind'], row: DocumentRow | undefined): NextActionSignal {
  return {
    kind,
    count: toCount(row?.count),
    deadlineAt: toIsoString(row?.deadline_at),
    ...resolveDocumentMoney(row),
  }
}

/**
 * Quote requests the customer is waiting on us to answer.
 *
 * `coalesce(status, '')` is the whole point of this query. A request submitted through the customer
 * portal used to land with no status at all, and everything that reads sales_quotes by an exact
 * status value then skipped it forever. Portal submissions now carry `pending_approval`
 * (see api/portal/requests/route.ts), but the rows created before that still have a NULL status and
 * a customer still waiting behind them, so both spellings of "nobody has picked this up yet" count
 * here. `draft` is deliberately absent: that is our own unfinished document, not a customer asking.
 */
async function loadQuoteRequestsToAnswer(em: EntityManager, scope: Scope): Promise<NextActionSignal> {
  const rows = await em.getConnection().execute<QuoteRequestRow[]>(
    `select count(*)::int as count,
            min(created_at) as submitted_at,
            sum(grand_total_net_amount) as amount,
            count(distinct currency_code)::int as currency_count,
            min(currency_code) as currency_code
     from sales_quotes
     where deleted_at is null
       and organization_id = ?
       and tenant_id = ?
       and converted_order_id is null
       and coalesce(status, '') in ('', 'pending_approval')`,
    [scope.organizationId, scope.tenantId],
  )
  const row = rows[0]
  const submittedAt = toIsoString(row?.submitted_at)
  // The deadline is the promise we made the customer, not a date stored on the document: a quote
  // request has no `valid_until` of its own, so the oldest submission plus the response window is
  // the only honest clock available. No submission date means no deadline, not a made-up one.
  const deadlineAt =
    submittedAt === null
      ? null
      : new Date(Date.parse(submittedAt) + QUOTE_REQUEST_RESPONSE_DAYS * MILLISECONDS_PER_DAY).toISOString()
  return {
    kind: 'quoteRequestsToAnswer',
    count: toCount(row?.count),
    deadlineAt,
    ...resolveDocumentMoney(row),
  }
}

/**
 * Quotes we sent where the customer has gone quiet.
 *
 * `status = 'sent'` stays exact on purpose. This bucket is a statement about the customer's silence,
 * and only a quote that actually left the building can be silent about. The rows it skips are not
 * skipped quietly any more: a quote with no status, or one still awaiting our own answer, is counted
 * by `loadQuoteRequestsToAnswer` above, so no quote falls between the two buckets. The two must stay
 * disjoint — a status listed here must never also appear in that query's `in (...)` list.
 */
async function loadQuotesAwaitingReply(em: EntityManager, scope: Scope, now: Date): Promise<NextActionSignal> {
  const silentSince = new Date(now.getTime() - QUOTE_SILENCE_DAYS * MILLISECONDS_PER_DAY)
  const rows = await em.getConnection().execute<DocumentRow[]>(
    `select count(*)::int as count,
            min(valid_until) as deadline_at,
            sum(grand_total_net_amount) as amount,
            count(distinct currency_code)::int as currency_count,
            min(currency_code) as currency_code
     from sales_quotes
     where deleted_at is null
       and organization_id = ?
       and tenant_id = ?
       and status = 'sent'
       and converted_order_id is null
       and updated_at <= ?`,
    [scope.organizationId, scope.tenantId, silentSince],
  )
  return toDocumentSignal('quotesAwaitingReply', rows[0])
}

async function loadOrdersToFulfil(em: EntityManager, scope: Scope): Promise<NextActionSignal> {
  const rows = await em.getConnection().execute<DocumentRow[]>(
    `select count(*)::int as count,
            min(expected_delivery_at) as deadline_at,
            sum(grand_total_net_amount) as amount,
            count(distinct currency_code)::int as currency_count,
            min(currency_code) as currency_code
     from sales_orders
     where deleted_at is null
       and organization_id = ?
       and tenant_id = ?
       and coalesce(status, '') not in ('canceled', 'draft', 'rejected')
       and coalesce(fulfillment_status, '') not in ('fulfilled', 'canceled')`,
    [scope.organizationId, scope.tenantId],
  )
  return toDocumentSignal('ordersToFulfil', rows[0])
}

export async function GET(request: Request) {
  try {
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

    const em = (container.resolve('em') as EntityManager).fork()
    const scope: Scope = { organizationId, tenantId: auth.tenantId }
    const now = new Date()

    const signals = [
      await loadExpiringStock(em, scope, now),
      await loadCriticalStock(em, scope),
      await loadQuoteRequestsToAnswer(em, scope),
      await loadQuotesAwaitingReply(em, scope, now),
      await loadOrdersToFulfil(em, scope),
    ]

    return NextResponse.json(
      nextActionsResponseSchema.parse({
        generatedAt: now.toISOString(),
        actions: buildNextActions(signals, now),
      }),
    )
  } catch (error) {
    if (isCrudHttpError(error)) {
      return NextResponse.json(error.body, { status: error.status })
    }
    logger.error('Failed to load distributor next actions', { err: error })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const nextActionSchema = z.object({
  kind: z.enum(NEXT_ACTION_KINDS),
  count: z.number().int().positive(),
  href: z.string(),
  tone: z.enum(['error', 'warning', 'info']),
  deadlineAt: z.string().nullable(),
  daysUntilDeadline: z.number().int().nullable(),
  amount: z.number().nullable(),
  currencyCode: z.string().nullable(),
})

const nextActionsResponseSchema = z.object({
  generatedAt: z.string(),
  actions: z.array(nextActionSchema),
})

const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Distributor Workspace',
  summary: 'Next actions widget',
  description:
    'Ranked shortlist of what the distributor operator should handle first: stock about to expire, stock below the safety level, customer quote requests still waiting for an answer, quotes with no customer reply, and orders still waiting to be picked.',
  methods: {
    GET: {
      summary: 'Load the ranked next actions',
      responses: [{ status: 200, description: 'Ranked actions', schema: nextActionsResponseSchema }],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 500, description: 'Widget failed to load', schema: errorSchema },
      ],
    },
  },
}
