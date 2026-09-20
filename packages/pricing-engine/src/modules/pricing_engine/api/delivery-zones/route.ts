import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { PricingDeliveryZone } from '../../data/entities'
import {
  deliveryZoneCreateSchema,
  deliveryZoneUpdateSchema,
  type DeliveryZoneCreateInput,
  type DeliveryZoneUpdateInput,
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
  readBodyId,
  scopeFromContext,
  toTextOrNull,
  type PricingListPayload,
  type PricingRawBody,
  pricingParameterEventHooks,
} from '../../lib/crud/pricingCrudRoute'

// Pinned path: the auto-derived value would be `/pricing-engine/delivery-zones`.
// The generator resolves the served path by STATIC analysis: it reads `metadata.path` from an
// object literal and cannot evaluate a helper call. A computed metadata object therefore falls
// back to the module-id convention (`/api/pricing_engine/...`) and every caller 404s. The literal
// below is what pins `/api/pricing/*` — a frozen contract surface.
export const metadata = {
  path: '/pricing/delivery-zones',
  GET: { requireAuth: true, requireFeatures: ['pricing.params.read'] },
  POST: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  PUT: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
}

const listSchema = pricingListSchema({
  defaultVehicleCode: z.string().trim().min(1).max(100).optional(),
})

type DeliveryZoneListQuery = z.infer<typeof listSchema>
type DeliveryZoneRow = ReturnType<typeof toDeliveryZoneRow>

function toDeliveryZoneRow(entity: PricingDeliveryZone) {
  return {
    ...baseRow(entity),
    code: entity.code,
    label: entity.label,
    avgDistanceKm: entity.avgDistanceKm,
    avgDriveMinutes: entity.avgDriveMinutes,
    typicalStops: entity.typicalStops,
    defaultVehicleCode: entity.defaultVehicleCode ?? null,
  }
}

function toEntityData(input: DeliveryZoneCreateInput, ctx: CrudCtx): Record<string, unknown> {
  return {
    ...scopeFromContext(ctx),
    code: input.code,
    label: input.label,
    avgDistanceKm: input.avgDistanceKm,
    avgDriveMinutes: input.avgDriveMinutes,
    typicalStops: input.typicalStops,
    defaultVehicleCode: toTextOrNull(input.defaultVehicleCode),
  }
}

function applyUpdate(entity: PricingDeliveryZone, input: DeliveryZoneUpdateInput): void {
  entity.code = input.code
  entity.label = input.label
  entity.avgDistanceKm = input.avgDistanceKm
  entity.avgDriveMinutes = input.avgDriveMinutes
  entity.typicalStops = input.typicalStops
  entity.defaultVehicleCode = toTextOrNull(input.defaultVehicleCode)
}

const crud = makeCrudRoute<PricingRawBody, PricingRawBody, DeliveryZoneListQuery>({
  metadata,
  orm: { entity: PricingDeliveryZone, ...pricingOrmConfig },
  events: { module: 'pricing_engine', entity: 'delivery_zone' },
  list: {
    schema: listSchema,
    buildFilters: async (query) => {
      const filters: Record<string, unknown> = {}
      buildIdFilter(filters, query)
      if (query.defaultVehicleCode) filters.defaultVehicleCode = query.defaultVehicleCode
      buildSearchFilter(filters, query.search, ['code', 'label'])
      return filters
    },
  },
  hooks: {
    ...pricingParameterEventHooks('delivery_zone'),
    afterList: (payload: PricingListPayload, ctx) => {
      finalizePricingList<PricingDeliveryZone, DeliveryZoneRow>(payload, ctx.query, {
        mapItem: toDeliveryZoneRow,
        defaultSort: { field: 'code', dir: 'asc' },
      })
    },
  },
  create: {
    schema: pricingRawBodySchema,
    mapToEntity: (input, ctx) => toEntityData(deliveryZoneCreateSchema.parse(input), ctx),
  },
  update: {
    schema: pricingRawBodySchema,
    getId: readBodyId,
    applyToEntity: (entity, input) => {
      applyUpdate(entity as PricingDeliveryZone, deliveryZoneUpdateSchema.parse(input))
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
  summary: 'Delivery zones',
  itemSchema: pricingBaseRowSchema.extend({
    code: z.string(),
    label: z.string(),
    avgDistanceKm: z.string(),
    avgDriveMinutes: z.string(),
    typicalStops: z.number().int(),
    defaultVehicleCode: z.string().nullable(),
  }),
  createSchema: deliveryZoneCreateSchema,
  updateSchema: deliveryZoneUpdateSchema,
})
