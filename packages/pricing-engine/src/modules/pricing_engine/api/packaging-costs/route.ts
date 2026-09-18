import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { PricingPackagingCost } from '../../data/entities'
import {
  packagingCostCreateSchema,
  packagingCostUpdateSchema,
  type PackagingCostCreateInput,
  type PackagingCostUpdateInput,
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
} from '../../lib/crud/pricingCrudRoute'

// Pinned path: the auto-derived value would be `/pricing-engine/packaging-costs`.
// The generator resolves the served path by STATIC analysis: it reads `metadata.path` from an
// object literal and cannot evaluate a helper call. A computed metadata object therefore falls
// back to the module-id convention (`/api/pricing_engine/...`) and every caller 404s. The literal
// below is what pins `/api/pricing/*` — a frozen contract surface.
export const metadata = {
  path: '/pricing/packaging-costs',
  GET: { requireAuth: true, requireFeatures: ['pricing.params.read'] },
  POST: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  PUT: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
}

const listSchema = pricingListSchema({
  unitCode: z.string().trim().min(1).max(100).optional(),
})

type PackagingCostListQuery = z.infer<typeof listSchema>
type PackagingCostRow = ReturnType<typeof toPackagingCostRow>

function toPackagingCostRow(entity: PricingPackagingCost) {
  const now = new Date()
  return {
    ...baseRow(entity),
    ...versionRow(entity, now),
    unitCode: entity.unitCode,
    materialCost: entity.materialCost,
    packMinutes: entity.packMinutes,
    roleCode: entity.roleCode,
  }
}

function toEntityData(input: PackagingCostCreateInput, ctx: CrudCtx): Record<string, unknown> {
  return {
    ...scopeFromContext(ctx),
    unitCode: input.unitCode,
    materialCost: input.materialCost,
    packMinutes: input.packMinutes,
    roleCode: input.roleCode,
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
  }
}

function applyUpdate(entity: PricingPackagingCost, input: PackagingCostUpdateInput): void {
  entity.unitCode = input.unitCode
  entity.materialCost = input.materialCost
  entity.packMinutes = input.packMinutes
  entity.roleCode = input.roleCode
  entity.validFrom = input.validFrom
  entity.validTo = input.validTo ?? null
}

const crud = makeCrudRoute<PricingRawBody, PricingRawBody, PackagingCostListQuery>({
  metadata,
  orm: { entity: PricingPackagingCost, ...pricingOrmConfig },
  events: { module: 'pricing_engine', entity: 'packaging_cost' },
  list: {
    schema: listSchema,
    buildFilters: async (query) => {
      const filters: Record<string, unknown> = {}
      buildIdFilter(filters, query)
      if (query.unitCode) filters.unitCode = query.unitCode
      buildSearchFilter(filters, query.search, ['unitCode', 'roleCode'])
      return filters
    },
  },
  hooks: {
    afterList: (payload: PricingListPayload, ctx) => {
      finalizePricingList<PricingPackagingCost, PackagingCostRow>(payload, ctx.query, {
        mapItem: toPackagingCostRow,
        defaultSort: { field: 'unitCode', dir: 'asc' },
      })
    },
  },
  create: {
    schema: pricingRawBodySchema,
    mapToEntity: (input, ctx) => toEntityData(packagingCostCreateSchema.parse(input), ctx),
  },
  update: {
    schema: pricingRawBodySchema,
    getId: readBodyId,
    applyToEntity: (entity, input) => {
      applyUpdate(entity as PricingPackagingCost, packagingCostUpdateSchema.parse(input))
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
  summary: 'Packaging costs',
  itemSchema: pricingBaseRowSchema.extend(pricingVersionRowSchema.shape).extend({
    unitCode: z.string(),
    materialCost: z.string(),
    packMinutes: z.string(),
    roleCode: z.string(),
  }),
  createSchema: packagingCostCreateSchema,
  updateSchema: packagingCostUpdateSchema,
})
