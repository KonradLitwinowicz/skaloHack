import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { PricingLaborRate } from '../../data/entities'
import {
  laborRateCreateSchema,
  laborRateUpdateSchema,
  type LaborRateCreateInput,
  type LaborRateUpdateInput,
} from '../../data/validators'
import {
  baseRow,
  buildIdFilter,
  buildSearchFilter,
  finalizePricingList,
  pricingBaseRowSchema,
  pricingCrudOpenApi,
  pricingListSchema,
  pricingOrmConfig,
  pricingRawBodySchema,
  pricingVersionRowSchema,
  readBodyId,
  scopeFromContext,
  versionRow,
  type PricingListPayload,
  type PricingRawBody,
  pricingParameterEventHooks,
} from '../../lib/crud/pricingCrudRoute'

// Pinned path: the auto-derived value would be `/pricing-engine/labor-rates`.
// The generator resolves the served path by STATIC analysis: it reads `metadata.path` from an
// object literal and cannot evaluate a helper call. A computed metadata object therefore falls
// back to the module-id convention (`/api/pricing_engine/...`) and every caller 404s. The literal
// below is what pins `/api/pricing/*` — a frozen contract surface.
export const metadata = {
  path: '/pricing/labor-rates',
  GET: { requireAuth: true, requireFeatures: ['pricing.params.read'] },
  POST: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  PUT: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
}

const listSchema = pricingListSchema({
  roleCode: z.string().trim().min(1).max(100).optional(),
})

type LaborRateListQuery = z.infer<typeof listSchema>
type LaborRateRow = ReturnType<typeof toLaborRateRow>

function toLaborRateRow(entity: PricingLaborRate) {
  const now = new Date()
  return {
    ...baseRow(entity),
    ...versionRow(entity, now),
    roleCode: entity.roleCode,
    label: entity.label,
    hourlyRate: entity.hourlyRate,
    overheadRate: entity.overheadRate,
  }
}

function toEntityData(input: LaborRateCreateInput, ctx: CrudCtx): Record<string, unknown> {
  return {
    ...scopeFromContext(ctx),
    roleCode: input.roleCode,
    label: input.label,
    hourlyRate: input.hourlyRate,
    overheadRate: input.overheadRate,
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
  }
}

function applyUpdate(entity: PricingLaborRate, input: LaborRateUpdateInput): void {
  entity.roleCode = input.roleCode
  entity.label = input.label
  entity.hourlyRate = input.hourlyRate
  entity.overheadRate = input.overheadRate
  entity.validFrom = input.validFrom
  entity.validTo = input.validTo ?? null
}

const crud = makeCrudRoute<PricingRawBody, PricingRawBody, LaborRateListQuery>({
  metadata,
  orm: { entity: PricingLaborRate, ...pricingOrmConfig },
  events: { module: 'pricing_engine', entity: 'labor_rate' },
  list: {
    schema: listSchema,
    buildFilters: async (query) => {
      const filters: Record<string, unknown> = {}
      buildIdFilter(filters, query)
      if (query.roleCode) filters.roleCode = query.roleCode
      buildSearchFilter(filters, query.search, ['roleCode', 'label'])
      return filters
    },
  },
  hooks: {
    ...pricingParameterEventHooks('labor_rate'),
    afterList: (payload: PricingListPayload, ctx) => {
      finalizePricingList<PricingLaborRate, LaborRateRow>(payload, ctx.query, {
        mapItem: toLaborRateRow,
        defaultSort: { field: 'roleCode', dir: 'asc' },
      })
    },
  },
  create: {
    schema: pricingRawBodySchema,
    mapToEntity: (input, ctx) => toEntityData(laborRateCreateSchema.parse(input), ctx),
  },
  update: {
    schema: pricingRawBodySchema,
    getId: readBodyId,
    applyToEntity: (entity, input) => {
      applyUpdate(entity as PricingLaborRate, laborRateUpdateSchema.parse(input))
    },
    response: () => ({ ok: true }),
  },
  del: { idFrom: 'query', softDelete: true, response: () => ({ ok: true }) },
})

export const GET = crud.GET
export const POST = crud.POST
export const PUT = crud.PUT
export const DELETE = crud.DELETE

export const openApi: OpenApiRouteDoc = pricingCrudOpenApi({
  summary: 'Labour rates',
  itemSchema: pricingBaseRowSchema.extend(pricingVersionRowSchema.shape).extend({
    roleCode: z.string(),
    label: z.string(),
    hourlyRate: z.string(),
    overheadRate: z.string(),
  }),
  createSchema: laborRateCreateSchema,
  updateSchema: laborRateUpdateSchema,
})
