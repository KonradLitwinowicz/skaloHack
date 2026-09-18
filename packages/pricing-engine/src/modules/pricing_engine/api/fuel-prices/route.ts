import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { PricingFuelPrice } from '../../data/entities'
import {
  fuelPriceCreateSchema,
  fuelPriceUpdateSchema,
  type FuelPriceCreateInput,
  type FuelPriceUpdateInput,
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
  toIso,
  type PricingListPayload,
  type PricingRawBody,
} from '../../lib/crud/pricingCrudRoute'

// Pinned path: the auto-derived value would be `/pricing-engine/fuel-prices`.
// The generator resolves the served path by STATIC analysis: it reads `metadata.path` from an
// object literal and cannot evaluate a helper call. A computed metadata object therefore falls
// back to the module-id convention (`/api/pricing_engine/...`) and every caller 404s. The literal
// below is what pins `/api/pricing/*` — a frozen contract surface.
export const metadata = {
  path: '/pricing/fuel-prices',
  GET: { requireAuth: true, requireFeatures: ['pricing.params.read'] },
  POST: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  PUT: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
}

const listSchema = pricingListSchema({
  fuelType: z.string().trim().min(1).max(100).optional(),
})

type FuelPriceListQuery = z.infer<typeof listSchema>
type FuelPriceRow = ReturnType<typeof toFuelPriceRow>

function toFuelPriceRow(entity: PricingFuelPrice) {
  return {
    ...baseRow(entity),
    fuelType: entity.fuelType,
    pricePerLitre: entity.pricePerLitre,
    observedOn: toIso(entity.observedOn),
  }
}

function toEntityData(input: FuelPriceCreateInput, ctx: CrudCtx): Record<string, unknown> {
  return {
    ...scopeFromContext(ctx),
    fuelType: input.fuelType,
    pricePerLitre: input.pricePerLitre,
    observedOn: input.observedOn,
  }
}

function applyUpdate(entity: PricingFuelPrice, input: FuelPriceUpdateInput): void {
  entity.fuelType = input.fuelType
  entity.pricePerLitre = input.pricePerLitre
  entity.observedOn = input.observedOn
}

const crud = makeCrudRoute<PricingRawBody, PricingRawBody, FuelPriceListQuery>({
  metadata,
  orm: { entity: PricingFuelPrice, ...pricingOrmConfig },
  events: { module: 'pricing_engine', entity: 'fuel_price' },
  list: {
    schema: listSchema,
    buildFilters: async (query) => {
      const filters: Record<string, unknown> = {}
      buildIdFilter(filters, query)
      if (query.fuelType) filters.fuelType = query.fuelType
      buildSearchFilter(filters, query.search, ['fuelType'])
      return filters
    },
  },
  hooks: {
    afterList: (payload: PricingListPayload, ctx) => {
      finalizePricingList<PricingFuelPrice, FuelPriceRow>(payload, ctx.query, {
        mapItem: toFuelPriceRow,
        defaultSort: { field: 'observedOn', dir: 'desc' },
      })
    },
  },
  create: {
    schema: pricingRawBodySchema,
    mapToEntity: (input, ctx) => toEntityData(fuelPriceCreateSchema.parse(input), ctx),
  },
  update: {
    schema: pricingRawBodySchema,
    getId: readBodyId,
    applyToEntity: (entity, input) => {
      applyUpdate(entity as PricingFuelPrice, fuelPriceUpdateSchema.parse(input))
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
  summary: 'Fuel price observations',
  itemSchema: pricingBaseRowSchema.extend({
    fuelType: z.string(),
    pricePerLitre: z.string(),
    observedOn: z.string().nullable(),
  }),
  createSchema: fuelPriceCreateSchema,
  updateSchema: fuelPriceUpdateSchema,
})
