/**
 * The one place that turns database rows into a forecast.
 *
 * Kept out of the route so the SQL, the engine call and the backtest stay together and can be
 * reused by anything that later wants a forecast — a dashboard card, an AI tool, a nightly report —
 * without any of them re-deriving what counts as a purchase.
 *
 * That definition is the load-bearing part of this file: draft, cancelled and rejected orders are
 * not purchases, and non-product lines (shipping, surcharges) are not things a customer reorders.
 * Getting either wrong would not crash anything — it would quietly teach the detector a rhythm the
 * customer never had.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import {
  buildOrderForecast,
  productKeyOf,
  type OrderForecast,
  type OrderObservation,
  type OrderForecastOptions,
  type PredictionFeedbackInput,
  type PredictionFeedbackKind,
  type PredictionRejectionReason,
} from './orderForecast'
import { runForecastBacktest, type BacktestResult } from './orderForecastBacktest'
import { buildPredictedBaskets, type PredictedBasket } from './predictedBaskets'

const logger = createLogger('distributor_workspace').child({ component: 'order-forecast' })

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Statuses that describe an intention rather than a purchase.
 *
 * Compared lower-cased on both sides. Every status in the database is lower-case today, so this
 * changes nothing now — but a single `Canceled` written by an import would otherwise be counted as
 * a sale here while a sibling reader that lower-cases (the dead-stock loader does) discarded it,
 * and the two screens would disagree by one order with no visible cause.
 */
const NON_PURCHASE_ORDER_STATUSES = ['canceled', 'cancelled', 'rejected', 'draft'] as const

export type ForecastScope = {
  organizationId: string
  tenantId: string
}

export type HistorySummary = {
  orderCount: number
  lineCount: number
  firstOrderAt: string | null
  lastOrderAt: string | null
}

export type RejectionSummary = {
  reason: PredictionRejectionReason
  count: number
  examples: string[]
}

export type CustomerOrderForecast = {
  forecast: OrderForecast
  baskets: PredictedBasket[]
  accuracy: BacktestResult
  history: HistorySummary
  notes: PredictionNote[]
}

type ObservationRow = {
  order_id: string
  placed_at: Date | string
  order_net_amount: string | number | null
  currency_code: string | null
  product_id: string | null
  product_variant_id: string | null
  product_name: string | null
  sku: string | null
  quantity: string | number | null
  quantity_unit: string | null
  line_net_amount: string | number | null
}

type FeedbackRow = {
  product_id: string | null
  product_variant_id: string | null
  product_name: string | null
  kind: string
  valid_until: Date | string | null
}

/**
 * An operator's note as the UI needs it: the ids to address it by and the product name to show.
 *
 * A dismissal is the only prediction the operator can no longer see, so it is also the only one
 * they cannot undo from the list itself. The note has to travel back to the screen or the action
 * is one-way — which is not a decision anybody made, just a gap.
 */
export type PredictionNote = {
  productId: string | null
  productVariantId: string | null
  productName: string | null
  kind: PredictionFeedbackKind
  validUntil: string | null
}

function toNumber(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

/**
 * The product name is read from three places in falling order of truthfulness: the line's own
 * snapshot (what the customer was actually sold, under the name it carried then), the live catalog
 * title, and finally the SKU. A prediction row with no label would be unusable, and the catalog
 * title alone would silently rewrite history whenever a product is renamed.
 */
export async function loadOrderObservations(
  em: EntityManager,
  scope: ForecastScope,
  customerEntityId: string,
  lookbackDays: number,
): Promise<OrderObservation[]> {
  const horizon = new Date(Date.now() - lookbackDays * MILLISECONDS_PER_DAY)
  const statusPlaceholders = NON_PURCHASE_ORDER_STATUSES.map(() => '?').join(', ')

  const rows = await em.getConnection().execute<ObservationRow[]>(
    `select o.id as order_id,
            coalesce(o.placed_at, o.created_at) as placed_at,
            o.grand_total_net_amount as order_net_amount,
            o.currency_code as currency_code,
            l.product_id as product_id,
            l.product_variant_id as product_variant_id,
            coalesce(nullif(l.name, ''), p.title, v.sku, p.sku) as product_name,
            coalesce(v.sku, p.sku, l.catalog_snapshot ->> 'sku') as sku,
            l.quantity as quantity,
            l.quantity_unit as quantity_unit,
            l.total_net_amount as line_net_amount
     from sales_orders o
     join sales_order_lines l
       on l.order_id = o.id
      and l.organization_id = o.organization_id
      and l.tenant_id = o.tenant_id
      and l.deleted_at is null
      and l.kind = 'product'
     left join catalog_products p
       on p.id = l.product_id
      and p.deleted_at is null
     left join catalog_product_variants v
       on v.id = l.product_variant_id
      and v.deleted_at is null
     where o.organization_id = ?
       and o.tenant_id = ?
       and o.deleted_at is null
       and o.customer_entity_id = ?
       and lower(coalesce(o.status, '')) not in (${statusPlaceholders})
       and coalesce(o.placed_at, o.created_at) >= ?
     order by coalesce(o.placed_at, o.created_at) asc`,
    [scope.organizationId, scope.tenantId, customerEntityId, ...NON_PURCHASE_ORDER_STATUSES, horizon],
  )

  const observations: OrderObservation[] = []
  for (const row of rows) {
    const placedAt = toDate(row.placed_at)
    if (!placedAt) continue
    if (!row.product_id && !row.product_variant_id) continue
    observations.push({
      orderId: row.order_id,
      placedAt,
      productId: row.product_id,
      productVariantId: row.product_variant_id,
      productName: row.product_name ?? row.sku ?? row.order_id,
      sku: row.sku,
      quantity: toNumber(row.quantity),
      quantityUnit: row.quantity_unit,
      lineNetAmount: toNumber(row.line_net_amount),
      orderNetAmount: toNumber(row.order_net_amount),
      currencyCode: row.currency_code,
    })
  }
  return observations
}

/**
 * Feedback is optional by construction.
 *
 * The table arrives with a migration; the forecast does not depend on it, and a deployment where
 * the migration has not run yet should show predictions rather than an error. A missing relation is
 * therefore logged once and treated as "no notes recorded", which is exactly what it means.
 */
export async function loadPredictionFeedback(
  em: EntityManager,
  scope: ForecastScope,
  customerEntityId: string,
): Promise<PredictionNote[]> {
  try {
    const rows = await em.getConnection().execute<FeedbackRow[]>(
      `select product_id, product_variant_id, product_name, kind, valid_until
       from distributor_order_prediction_feedback
       where organization_id = ?
         and tenant_id = ?
         and customer_entity_id = ?
         and deleted_at is null`,
      [scope.organizationId, scope.tenantId, customerEntityId],
    )
    return rows.map((row) => ({
      productId: row.product_id,
      productVariantId: row.product_variant_id,
      productName: row.product_name,
      kind: row.kind as PredictionFeedbackKind,
      validUntil: toDate(row.valid_until)?.toISOString() ?? null,
    }))
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error
    logger.warn('Prediction feedback table not created yet; continuing without operator notes', { err: error })
    return []
  }
}

function toEngineFeedback(notes: PredictionNote[]): PredictionFeedbackInput[] {
  return notes.map((note) => ({
    productId: note.productId,
    productVariantId: note.productVariantId,
    kind: note.kind,
    validUntil: note.validUntil === null ? null : new Date(note.validUntil),
  }))
}

/** Postgres `undefined_table`: the only failure that legitimately means "no notes recorded yet". */
const UNDEFINED_TABLE_SQLSTATE = '42P01'

/**
 * Matches the SQLSTATE, never the message text, and walks the cause chain to find it.
 *
 * `relation "…" does not exist` is localised by the database server, so a string match passes on an
 * English server and quietly stops matching on a Polish one — the failure mode being that a real
 * outage starts looking like an empty table. The chain walk is needed because MikroORM wraps the
 * driver error: the code sits on the cause, not on what was thrown.
 *
 * Everything else is rethrown, a dropped connection above all. A forecast computed in silence
 * without the operator's notes is worse than an error, because it changes what a person sees with
 * nothing to question: a product they hid reappears, and the only available reading is that their
 * click never saved.
 */
function isUndefinedTableError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (typeof current !== 'object') return false
    const candidate = current as {
      code?: unknown
      cause?: unknown
      previous?: unknown
      originalError?: unknown
    }
    if (candidate.code === UNDEFINED_TABLE_SQLSTATE) return true
    current = candidate.cause ?? candidate.previous ?? candidate.originalError ?? null
  }
  return false
}

export function summariseHistory(observations: OrderObservation[]): HistorySummary {
  if (observations.length === 0) {
    return { orderCount: 0, lineCount: 0, firstOrderAt: null, lastOrderAt: null }
  }
  const orderIds = new Set(observations.map((observation) => observation.orderId))
  const times = observations.map((observation) => observation.placedAt.getTime())
  return {
    orderCount: orderIds.size,
    lineCount: observations.length,
    firstOrderAt: new Date(Math.min(...times)).toISOString(),
    lastOrderAt: new Date(Math.max(...times)).toISOString(),
  }
}

export function summariseRejections(forecast: OrderForecast, examplesPerReason = 3): RejectionSummary[] {
  const byReason = new Map<PredictionRejectionReason, RejectionSummary>()
  for (const rejection of forecast.rejected) {
    const existing = byReason.get(rejection.reason)
    if (existing) {
      existing.count += 1
      if (existing.examples.length < examplesPerReason) existing.examples.push(rejection.productName)
      continue
    }
    byReason.set(rejection.reason, {
      reason: rejection.reason,
      count: 1,
      examples: [rejection.productName],
    })
  }
  return [...byReason.values()].sort((a, b) => b.count - a.count)
}

export type LoadCustomerForecastInput = {
  em: EntityManager
  scope: ForecastScope
  customerEntityId: string
  now?: Date
  options?: Partial<OrderForecastOptions>
}

/**
 * Order of operations matters here: the backtest runs on the RAW history and passes its score into
 * the forecast as calibration. Running it the other way round — scoring an already-calibrated
 * forecast — would feed the multiplier back into its own input on every request.
 */
export async function loadCustomerOrderForecast(
  input: LoadCustomerForecastInput,
): Promise<CustomerOrderForecast> {
  const { em, scope, customerEntityId } = input
  const now = input.now ?? new Date()
  const lookbackDays = input.options?.lookbackDays ?? 540

  const [observations, notes] = await Promise.all([
    loadOrderObservations(em, scope, customerEntityId, lookbackDays),
    loadPredictionFeedback(em, scope, customerEntityId),
  ])

  const accuracy = runForecastBacktest({ observations, options: input.options })
  const forecast = buildOrderForecast({
    observations,
    now,
    options: input.options,
    feedback: toEngineFeedback(notes),
    calibration: accuracy.trials > 0 ? { hits: accuracy.hits, trials: accuracy.trials } : null,
  })

  return {
    forecast,
    baskets: buildPredictedBaskets({ predictions: forecast.predictions, rhythm: forecast.rhythm, now }),
    accuracy,
    history: summariseHistory(observations),
    notes,
  }
}

/**
 * Everything the distributor is expecting to be asked for, across the whole customer base.
 *
 * The per-customer tab answers "what does THIS customer buy?", which is the right question once
 * you are already looking at an account. It is the wrong shape for the question an operator opens
 * the system with in the morning — "who is due today, and who is late?" — because answering it
 * would mean opening forty customer cards in turn.
 *
 * One SQL statement fetches every purchase line in the window and the rows are grouped in memory;
 * forty separate per-customer queries would turn one page load into forty round trips for data the
 * database can hand over in a single pass. The engine itself then runs per customer, unchanged and
 * with the same calibration, so a row here and the same row on the customer card cannot disagree.
 */
export type UpcomingForecastRow = {
  customerEntityId: string
  customerName: string | null
  basket: PredictedBasket
}

export type UpcomingForecastResult = {
  rows: UpcomingForecastRow[]
  customersAnalysed: number
  customersWithPredictions: number
  horizonDays: number
}

type CustomerObservationRow = ObservationRow & { customer_entity_id: string }

async function loadAllObservations(
  em: EntityManager,
  scope: ForecastScope,
  lookbackDays: number,
): Promise<Map<string, OrderObservation[]>> {
  const horizon = new Date(Date.now() - lookbackDays * MILLISECONDS_PER_DAY)
  const statusPlaceholders = NON_PURCHASE_ORDER_STATUSES.map(() => '?').join(', ')

  const rows = await em.getConnection().execute<CustomerObservationRow[]>(
    `select o.customer_entity_id as customer_entity_id,
            o.id as order_id,
            coalesce(o.placed_at, o.created_at) as placed_at,
            o.grand_total_net_amount as order_net_amount,
            o.currency_code as currency_code,
            l.product_id as product_id,
            l.product_variant_id as product_variant_id,
            coalesce(nullif(l.name, ''), p.title, v.sku, p.sku) as product_name,
            coalesce(v.sku, p.sku, l.catalog_snapshot ->> 'sku') as sku,
            l.quantity as quantity,
            l.quantity_unit as quantity_unit,
            l.total_net_amount as line_net_amount
     from sales_orders o
     join sales_order_lines l
       on l.order_id = o.id
      and l.organization_id = o.organization_id
      and l.tenant_id = o.tenant_id
      and l.deleted_at is null
      and l.kind = 'product'
     left join catalog_products p
       on p.id = l.product_id
      and p.deleted_at is null
     left join catalog_product_variants v
       on v.id = l.product_variant_id
      and v.deleted_at is null
     where o.organization_id = ?
       and o.tenant_id = ?
       and o.deleted_at is null
       and o.customer_entity_id is not null
       and lower(coalesce(o.status, '')) not in (${statusPlaceholders})
       and coalesce(o.placed_at, o.created_at) >= ?
     order by coalesce(o.placed_at, o.created_at) asc`,
    [scope.organizationId, scope.tenantId, ...NON_PURCHASE_ORDER_STATUSES, horizon],
  )

  const byCustomer = new Map<string, OrderObservation[]>()
  for (const row of rows) {
    const placedAt = toDate(row.placed_at)
    if (!placedAt) continue
    if (!row.product_id && !row.product_variant_id) continue
    const bucket = byCustomer.get(row.customer_entity_id) ?? []
    bucket.push({
      orderId: row.order_id,
      placedAt,
      productId: row.product_id,
      productVariantId: row.product_variant_id,
      productName: row.product_name ?? row.sku ?? row.order_id,
      sku: row.sku,
      quantity: toNumber(row.quantity),
      quantityUnit: row.quantity_unit,
      lineNetAmount: toNumber(row.line_net_amount),
      orderNetAmount: toNumber(row.order_net_amount),
      currencyCode: row.currency_code,
    })
    byCustomer.set(row.customer_entity_id, bucket)
  }
  return byCustomer
}

async function loadAllNotes(
  em: EntityManager,
  scope: ForecastScope,
): Promise<Map<string, PredictionNote[]>> {
  const byCustomer = new Map<string, PredictionNote[]>()
  try {
    const rows = await em.getConnection().execute<Array<FeedbackRow & { customer_entity_id: string }>>(
      `select customer_entity_id, product_id, product_variant_id, product_name, kind, valid_until
       from distributor_order_prediction_feedback
       where organization_id = ?
         and tenant_id = ?
         and deleted_at is null`,
      [scope.organizationId, scope.tenantId],
    )
    for (const row of rows) {
      const bucket = byCustomer.get(row.customer_entity_id) ?? []
      bucket.push({
        productId: row.product_id,
        productVariantId: row.product_variant_id,
        productName: row.product_name,
        kind: row.kind as PredictionFeedbackKind,
        validUntil: toDate(row.valid_until)?.toISOString() ?? null,
      })
      byCustomer.set(row.customer_entity_id, bucket)
    }
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error
    logger.warn('Prediction feedback table not created yet; continuing without operator notes', { err: error })
  }
  return byCustomer
}

/**
 * Customer names are read through the decrypting finder, never through the SQL above.
 *
 * `customer_entities.display_name` is encrypted at rest, so selecting it in the aggregate query
 * would return ciphertext and the list would be a wall of base64. Only the customers that actually
 * produced a prediction are resolved, so the decrypt cost scales with what is shown rather than
 * with the size of the customer base.
 */
async function loadCustomerNames(
  em: EntityManager,
  scope: ForecastScope,
  customerIds: string[],
): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>()
  if (customerIds.length === 0) return names
  const rows = await findWithDecryption(
    em,
    CustomerEntity,
    {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      id: { $in: customerIds },
      deletedAt: null,
    },
    {},
    { organizationId: scope.organizationId, tenantId: scope.tenantId },
  )
  for (const row of rows) {
    names.set(row.id, row.displayName ?? null)
  }
  return names
}

export type LoadUpcomingForecastsInput = {
  em: EntityManager
  scope: ForecastScope
  now?: Date
  horizonDays: number
  options?: Partial<OrderForecastOptions>
}

export async function loadUpcomingOrderForecasts(
  input: LoadUpcomingForecastsInput,
): Promise<UpcomingForecastResult> {
  const { em, scope, horizonDays } = input
  const now = input.now ?? new Date()
  const lookbackDays = input.options?.lookbackDays ?? 540

  const [observationsByCustomer, notesByCustomer] = await Promise.all([
    loadAllObservations(em, scope, lookbackDays),
    loadAllNotes(em, scope),
  ])

  const rows: UpcomingForecastRow[] = []
  let customersWithPredictions = 0

  for (const [customerEntityId, observations] of observationsByCustomer) {
    const accuracy = runForecastBacktest({ observations, options: input.options })
    const forecast = buildOrderForecast({
      observations,
      now,
      options: input.options,
      feedback: toEngineFeedback(notesByCustomer.get(customerEntityId) ?? []),
      calibration: accuracy.trials > 0 ? { hits: accuracy.hits, trials: accuracy.trials } : null,
    })
    const baskets = buildPredictedBaskets({
      predictions: forecast.predictions,
      rhythm: forecast.rhythm,
      now,
    }).filter((basket) => basket.daysUntilExpected <= horizonDays)
    if (baskets.length > 0) customersWithPredictions += 1
    for (const basket of baskets) {
      rows.push({ customerEntityId, customerName: null, basket })
    }
  }

  rows.sort((a, b) => {
    if (a.basket.daysUntilExpected !== b.basket.daysUntilExpected) {
      return a.basket.daysUntilExpected - b.basket.daysUntilExpected
    }
    return b.basket.confidence - a.basket.confidence
  })

  const names = await loadCustomerNames(em, scope, [...new Set(rows.map((row) => row.customerEntityId))])
  for (const row of rows) {
    row.customerName = names.get(row.customerEntityId) ?? null
  }

  return {
    rows,
    customersAnalysed: observationsByCustomer.size,
    customersWithPredictions,
    horizonDays,
  }
}

export { productKeyOf }
