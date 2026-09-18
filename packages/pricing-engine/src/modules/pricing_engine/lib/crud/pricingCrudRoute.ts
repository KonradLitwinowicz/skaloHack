import { z } from 'zod'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'

/**
 * Shared plumbing for the pricing parameter CRUD routes.
 *
 * Every one of these routes takes the plain-ORM list path rather than the Query Engine, because
 * the generated field constants for `pricing_*` entities omit every column inherited from
 * `PricingScopedEntity` (`id`, `organization_id`, `updated_at`, ...) — the id generator walks a
 * class's own members and never its `extends` clause. The fallback path returns `{ items, total }`
 * with no ordering and no paging, so `finalizePricingList` supplies both from an `afterList` hook.
 * The parameter tables are tens of rows each, so sorting them in the route is cheap and keeps one
 * code path for all of them.
 */

export type PricingRouteScope = { organizationId: string; tenantId: string }

export function scopeFromContext(ctx: CrudCtx): PricingRouteScope {
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  const tenantId = ctx.auth?.tenantId ?? null
  if (!organizationId || !tenantId) {
    throw new CrudHttpError(400, { error: '[internal] pricing parameter scope is missing' })
  }
  return { organizationId, tenantId }
}

export function actorFromContext(ctx: CrudCtx): string | null {
  const subject = ctx.auth?.sub
  return typeof subject === 'string' && subject.length > 0 ? subject : null
}

const uuid = z.string().uuid()

const idsQuerySchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  }
  return value
}, z.array(uuid).min(1).max(500).optional())

export const pricingListBaseShape = {
  id: uuid.optional(),
  ids: idsQuerySchema,
  search: z.string().trim().max(300).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  sortField: z.string().trim().min(1).max(60).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
}

export function pricingListSchema<TShape extends z.ZodRawShape>(extra?: TShape) {
  return z.object({ ...pricingListBaseShape, ...(extra ?? ({} as TShape)) }).passthrough()
}

export type PricingListQueryBase = {
  id?: string
  ids?: string[]
  search?: string
  page: number
  pageSize: number
  sortField?: string
  sortDir?: 'asc' | 'desc'
}

export type PricingListPayload = {
  items?: unknown[]
  total?: number
  page?: number
  pageSize?: number
  totalPages?: number
}

export type PricingSort = { field: string; dir: 'asc' | 'desc' }

export type PricingScopedRecord = {
  id: string
  organizationId: string
  tenantId: string
  isDemo: boolean
  createdAt?: Date | null
  updatedAt?: Date | null
}

export type PricingBaseRow = {
  id: string
  organizationId: string
  tenantId: string
  isDemo: boolean
  createdAt: string | null
  updatedAt: string | null
}

export type PricingVersionedRecord = PricingScopedRecord & {
  validFrom: Date
  validTo?: Date | null
}

export type PricingVersionRow = {
  validFrom: string | null
  validTo: string | null
  /** True when this row is the one the engine resolves for a quote priced right now. */
  isInForce: boolean
}

export function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function toDecimalOrNull(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

export function toTextOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function baseRow(entity: PricingScopedRecord): PricingBaseRow {
  return {
    id: entity.id,
    organizationId: entity.organizationId,
    tenantId: entity.tenantId,
    isDemo: entity.isDemo,
    createdAt: toIso(entity.createdAt),
    updatedAt: toIso(entity.updatedAt),
  }
}

/**
 * Mirrors `validAt` in `lib/params.ts`: a row is in force when it has started and has not been
 * closed out yet. The list shows this so an operator can tell the rule that is pricing today's
 * quotes from the three historical versions sitting above it.
 */
export function versionRow(entity: PricingVersionedRecord, now: Date): PricingVersionRow {
  const started = entity.validFrom.getTime() <= now.getTime()
  const closed = entity.validTo ? entity.validTo.getTime() <= now.getTime() : false
  return {
    validFrom: toIso(entity.validFrom),
    validTo: toIso(entity.validTo),
    isInForce: started && !closed,
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0
  if (left === null || left === undefined) return 1
  if (right === null || right === undefined) return -1
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return Number(right === true) - Number(left === true)
  }
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber
  }
  return String(left).localeCompare(String(right))
}

/**
 * Turns the fallback `{ items, total }` into the `{ items, total, page, pageSize, totalPages }`
 * shape `DataTable`'s pagination prop needs, after mapping each entity to a plain row so the
 * response carries ISO dates and a camelCase `updatedAt` for `CrudForm`'s lock header.
 */
export function finalizePricingList<TEntity, TRow extends Record<string, unknown>>(
  payload: PricingListPayload,
  query: PricingListQueryBase,
  options: { mapItem: (entity: TEntity) => TRow; defaultSort: PricingSort },
): void {
  const source = Array.isArray(payload.items) ? (payload.items as TEntity[]) : []
  const rows = source.map(options.mapItem)
  const sortField = query.sortField ?? options.defaultSort.field
  const sortDir = query.sortDir ?? (query.sortField ? 'asc' : options.defaultSort.dir)
  const direction = sortDir === 'desc' ? -1 : 1
  rows.sort((left, right) => compareValues(left[sortField], right[sortField]) * direction)

  const total = rows.length
  const pageSize = query.pageSize
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(1, query.page), totalPages)
  payload.items = rows.slice((page - 1) * pageSize, page * pageSize)
  payload.total = total
  payload.page = page
  payload.pageSize = pageSize
  payload.totalPages = totalPages
}

export function buildIdFilter(
  filters: Record<string, unknown>,
  query: PricingListQueryBase,
): void {
  if (query.id) filters.id = query.id
  else if (query.ids?.length) filters.id = { $in: query.ids }
}

/**
 * Case-insensitive contains over the columns a list's search box covers. The ORM fallback path
 * receives these as MikroORM property names, not column names.
 */
export function buildSearchFilter(
  filters: Record<string, unknown>,
  search: string | undefined,
  properties: string[],
): void {
  if (!search || properties.length === 0) return
  const pattern = `%${search.replace(/[%_]/g, (match) => `\\${match}`)}%`
  filters.$or = properties.map((property) => ({ [property]: { $ilike: pattern } }))
}

export const PRICING_PARAMS_READ = 'pricing.params.read'
export const PRICING_PARAMS_WRITE = 'pricing.params.write'

export function pricingRouteMetadata(path: string) {
  return {
    path,
    GET: { requireAuth: true, requireFeatures: [PRICING_PARAMS_READ] },
    POST: { requireAuth: true, requireFeatures: [PRICING_PARAMS_WRITE] },
    PUT: { requireAuth: true, requireFeatures: [PRICING_PARAMS_WRITE] },
    DELETE: { requireAuth: true, requireFeatures: [PRICING_PARAMS_WRITE] },
  }
}

export const pricingOrmConfig = {
  idField: 'id',
  orgField: 'organizationId',
  tenantField: 'tenantId',
  softDeleteField: 'deletedAt',
} as const

export function readBodyId(input: Record<string, unknown>): string {
  const id = input.id
  return typeof id === 'string' ? id : ''
}

export const pricingRawBodySchema = z.object({}).passthrough()
export type PricingRawBody = z.infer<typeof pricingRawBodySchema>

const okResponseSchema = z.object({ ok: z.boolean() })

const conflictResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
  currentUpdatedAt: z.string(),
  expectedUpdatedAt: z.string(),
})

export const pricingBaseRowSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
  isDemo: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
})

export const pricingVersionRowSchema = z.object({
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  isInForce: z.boolean(),
})

export function pricingCrudOpenApi(options: {
  summary: string
  itemSchema: z.ZodTypeAny
  createSchema: z.ZodTypeAny
  updateSchema: z.ZodTypeAny
}) {
  return {
    tag: 'Pricing Engine',
    summary: options.summary,
    methods: {
      GET: {
        summary: `List ${options.summary.toLowerCase()}`,
        responses: [
          {
            status: 200,
            description: options.summary,
            schema: z.object({
              items: z.array(options.itemSchema),
              total: z.number().int(),
              page: z.number().int(),
              pageSize: z.number().int(),
              totalPages: z.number().int(),
            }),
          },
        ],
      },
      POST: {
        summary: `Create an entry in ${options.summary.toLowerCase()}`,
        requestBody: { contentType: 'application/json', schema: options.createSchema },
        responses: [{ status: 200, description: 'Created', schema: options.itemSchema }],
      },
      PUT: {
        summary: `Update an entry in ${options.summary.toLowerCase()}`,
        requestBody: { contentType: 'application/json', schema: options.updateSchema },
        responses: [
          { status: 200, description: 'Updated', schema: okResponseSchema },
          { status: 409, description: 'The record changed since it was loaded', schema: conflictResponseSchema },
        ],
      },
      DELETE: {
        summary: `Soft-delete an entry in ${options.summary.toLowerCase()}`,
        responses: [{ status: 200, description: 'Deleted', schema: okResponseSchema }],
      },
    },
  }
}
