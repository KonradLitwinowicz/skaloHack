import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { parseBooleanFromUnknown } from '@open-mercato/shared/lib/boolean'
import { PricingVehicle } from '../../data/entities'
import {
  vehicleCreateSchema,
  vehicleUpdateSchema,
  type VehicleCreateInput,
  type VehicleUpdateInput,
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
  toDecimalOrNull,
  type PricingListPayload,
  type PricingRawBody,
  pricingParameterEventHooks,
} from '../../lib/crud/pricingCrudRoute'

// Pinned path: the auto-derived value would be `/pricing-engine/vehicles`.
// The generator resolves the served path by STATIC analysis: it reads `metadata.path` from an
// object literal and cannot evaluate a helper call. A computed metadata object therefore falls
// back to the module-id convention (`/api/pricing_engine/...`) and every caller 404s. The literal
// below is what pins `/api/pricing/*` — a frozen contract surface.
export const metadata = {
  path: '/pricing/vehicles',
  GET: { requireAuth: true, requireFeatures: ['pricing.params.read'] },
  POST: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  PUT: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
}

const listSchema = pricingListSchema({
  isActive: z.preprocess((value) => parseBooleanFromUnknown(value) ?? undefined, z.boolean().optional()),
  fuelType: z.string().trim().min(1).max(100).optional(),
})

type VehicleListQuery = z.infer<typeof listSchema>
type VehicleRow = ReturnType<typeof toVehicleRow>

function toVehicleRow(entity: PricingVehicle) {
  return {
    ...baseRow(entity),
    code: entity.code,
    label: entity.label,
    capacityKg: entity.capacityKg ?? null,
    capacityM3: entity.capacityM3 ?? null,
    capacityPallets: entity.capacityPallets ?? null,
    fuelType: entity.fuelType,
    consumptionLPer100Km: entity.consumptionLPer100Km,
    fixedCostMonth: entity.fixedCostMonth,
    driverRoleCode: entity.driverRoleCode,
    isActive: entity.isActive,
  }
}

function toEntityData(input: VehicleCreateInput, ctx: CrudCtx): Record<string, unknown> {
  return {
    ...scopeFromContext(ctx),
    code: input.code,
    label: input.label,
    capacityKg: toDecimalOrNull(input.capacityKg),
    capacityM3: toDecimalOrNull(input.capacityM3),
    capacityPallets: input.capacityPallets ?? null,
    fuelType: input.fuelType,
    consumptionLPer100Km: input.consumptionLPer100Km,
    fixedCostMonth: input.fixedCostMonth,
    driverRoleCode: input.driverRoleCode,
    isActive: input.isActive,
  }
}

function applyUpdate(entity: PricingVehicle, input: VehicleUpdateInput): void {
  entity.code = input.code
  entity.label = input.label
  entity.capacityKg = toDecimalOrNull(input.capacityKg)
  entity.capacityM3 = toDecimalOrNull(input.capacityM3)
  entity.capacityPallets = input.capacityPallets ?? null
  entity.fuelType = input.fuelType
  entity.consumptionLPer100Km = input.consumptionLPer100Km
  entity.fixedCostMonth = input.fixedCostMonth
  entity.driverRoleCode = input.driverRoleCode
  entity.isActive = input.isActive
}

const crud = makeCrudRoute<PricingRawBody, PricingRawBody, VehicleListQuery>({
  metadata,
  orm: { entity: PricingVehicle, ...pricingOrmConfig },
  events: { module: 'pricing_engine', entity: 'vehicle' },
  list: {
    schema: listSchema,
    buildFilters: async (query) => {
      const filters: Record<string, unknown> = {}
      buildIdFilter(filters, query)
      if (query.isActive !== undefined) filters.isActive = query.isActive
      if (query.fuelType) filters.fuelType = query.fuelType
      buildSearchFilter(filters, query.search, ['code', 'label', 'fuelType'])
      return filters
    },
  },
  hooks: {
    ...pricingParameterEventHooks('vehicle'),
    afterList: (payload: PricingListPayload, ctx) => {
      finalizePricingList<PricingVehicle, VehicleRow>(payload, ctx.query, {
        mapItem: toVehicleRow,
        defaultSort: { field: 'code', dir: 'asc' },
      })
    },
  },
  create: {
    schema: pricingRawBodySchema,
    mapToEntity: (input, ctx) => toEntityData(vehicleCreateSchema.parse(input), ctx),
  },
  update: {
    schema: pricingRawBodySchema,
    getId: readBodyId,
    applyToEntity: (entity, input) => {
      applyUpdate(entity as PricingVehicle, vehicleUpdateSchema.parse(input))
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
  summary: 'Delivery vehicles',
  itemSchema: pricingBaseRowSchema.extend({
    code: z.string(),
    label: z.string(),
    capacityKg: z.string().nullable(),
    capacityM3: z.string().nullable(),
    capacityPallets: z.number().int().nullable(),
    fuelType: z.string(),
    consumptionLPer100Km: z.string(),
    fixedCostMonth: z.string(),
    driverRoleCode: z.string(),
    isActive: z.boolean(),
  }),
  createSchema: vehicleCreateSchema,
  updateSchema: vehicleUpdateSchema,
})
