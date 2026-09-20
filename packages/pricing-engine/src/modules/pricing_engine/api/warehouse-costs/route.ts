import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { PricingWarehouseCost } from '../../data/entities'
import {
  warehouseBasisSchema,
  warehouseCostCreateSchema,
  warehouseCostUpdateSchema,
  type WarehouseCostCreateInput,
  type WarehouseCostUpdateInput,
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

// Pinned path: the auto-derived value would be `/pricing-engine/warehouse-costs`.
// The generator resolves the served path by STATIC analysis: it reads `metadata.path` from an
// object literal and cannot evaluate a helper call. A computed metadata object therefore falls
// back to the module-id convention (`/api/pricing_engine/...`) and every caller 404s. The literal
// below is what pins `/api/pricing/*` — a frozen contract surface.
export const metadata = {
  path: '/pricing/warehouse-costs',
  GET: { requireAuth: true, requireFeatures: ['pricing.params.read'] },
  POST: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  PUT: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
}

const listSchema = pricingListSchema({
  basis: warehouseBasisSchema.optional(),
})

type WarehouseCostListQuery = z.infer<typeof listSchema>
type WarehouseCostRow = ReturnType<typeof toWarehouseCostRow>

function toWarehouseCostRow(entity: PricingWarehouseCost) {
  const now = new Date()
  return {
    ...baseRow(entity),
    ...versionRow(entity, now),
    basis: entity.basis,
    costPerMonth: entity.costPerMonth,
    capitalCostAnnualRate: entity.capitalCostAnnualRate,
    defaultTurnoverDays: entity.defaultTurnoverDays,
  }
}

function toEntityData(input: WarehouseCostCreateInput, ctx: CrudCtx): Record<string, unknown> {
  return {
    ...scopeFromContext(ctx),
    basis: input.basis,
    costPerMonth: input.costPerMonth,
    capitalCostAnnualRate: input.capitalCostAnnualRate,
    defaultTurnoverDays: input.defaultTurnoverDays,
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
  }
}

function applyUpdate(entity: PricingWarehouseCost, input: WarehouseCostUpdateInput): void {
  entity.basis = input.basis
  entity.costPerMonth = input.costPerMonth
  entity.capitalCostAnnualRate = input.capitalCostAnnualRate
  entity.defaultTurnoverDays = input.defaultTurnoverDays
  entity.validFrom = input.validFrom
  entity.validTo = input.validTo ?? null
}

const crud = makeCrudRoute<PricingRawBody, PricingRawBody, WarehouseCostListQuery>({
  metadata,
  orm: { entity: PricingWarehouseCost, ...pricingOrmConfig },
  events: { module: 'pricing_engine', entity: 'warehouse_cost' },
  list: {
    schema: listSchema,
    buildFilters: async (query) => {
      const filters: Record<string, unknown> = {}
      buildIdFilter(filters, query)
      if (query.basis) filters.basis = query.basis
      buildSearchFilter(filters, query.search, ['basis'])
      return filters
    },
  },
  hooks: {
    ...pricingParameterEventHooks('warehouse_cost'),
    afterList: (payload: PricingListPayload, ctx) => {
      finalizePricingList<PricingWarehouseCost, WarehouseCostRow>(payload, ctx.query, {
        mapItem: toWarehouseCostRow,
        defaultSort: { field: 'validFrom', dir: 'desc' },
      })
    },
  },
  create: {
    schema: pricingRawBodySchema,
    mapToEntity: (input, ctx) => toEntityData(warehouseCostCreateSchema.parse(input), ctx),
  },
  update: {
    schema: pricingRawBodySchema,
    getId: readBodyId,
    applyToEntity: (entity, input) => {
      applyUpdate(entity as PricingWarehouseCost, warehouseCostUpdateSchema.parse(input))
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
  summary: 'Warehouse costs',
  itemSchema: pricingBaseRowSchema.extend(pricingVersionRowSchema.shape).extend({
    basis: warehouseBasisSchema,
    costPerMonth: z.string(),
    capitalCostAnnualRate: z.string(),
    defaultTurnoverDays: z.number().int(),
  }),
  createSchema: warehouseCostCreateSchema,
  updateSchema: warehouseCostUpdateSchema,
})
