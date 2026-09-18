import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { PricingPurchasePosition } from '../../data/entities'
import {
  purchasePositionCreateSchema,
  purchasePositionUpdateSchema,
  type PurchasePositionCreateInput,
  type PurchasePositionUpdateInput,
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
  toIso,
  toTextOrNull,
  type PricingListPayload,
  type PricingRawBody,
} from '../../lib/crud/pricingCrudRoute'

// Pinned path: the auto-derived value would be `/pricing-engine/purchase-positions`.
// The generator resolves the served path by STATIC analysis: it reads `metadata.path` from an
// object literal and cannot evaluate a helper call. A computed metadata object therefore falls
// back to the module-id convention (`/api/pricing_engine/...`) and every caller 404s. The literal
// below is what pins `/api/pricing/*` — a frozen contract surface.
export const metadata = {
  path: '/pricing/purchase-positions',
  GET: { requireAuth: true, requireFeatures: ['pricing.params.read'] },
  POST: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  PUT: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
}

const listSchema = pricingListSchema({
  catalogProductId: z.string().uuid().optional(),
  productGroupCode: z.string().trim().min(1).max(300).optional(),
})

type PurchasePositionListQuery = z.infer<typeof listSchema>
type PurchasePositionRow = ReturnType<typeof toPurchasePositionRow>

// Freshness of the measured purchase cost drives the `product_cost` component's confidence, so
// the list needs the age in days to rank what is worth re-negotiating.
function ageInDays(value: Date | null | undefined, now: Date): number | null {
  if (!value) return null
  return Math.max(0, Math.floor((now.getTime() - value.getTime()) / 86_400_000))
}

function toPurchasePositionRow(entity: PricingPurchasePosition) {
  const now = new Date()
  return {
    ...baseRow(entity),
    catalogProductId: entity.catalogProductId,
    catalogVariantId: entity.catalogVariantId ?? null,
    sku: entity.sku ?? null,
    annualVolume: entity.annualVolume,
    currentTierCode: entity.currentTierCode ?? null,
    currentTierDiscount: entity.currentTierDiscount,
    nextTierVolume: entity.nextTierVolume ?? null,
    nextTierDiscount: entity.nextTierDiscount ?? null,
    lastDeliveryUnitCost: entity.lastDeliveryUnitCost ?? null,
    lastDeliveryAt: toIso(entity.lastDeliveryAt),
    lastDeliveryAgeDays: ageInDays(entity.lastDeliveryAt, now),
    lastDeliveryQuantity: entity.lastDeliveryQuantity ?? null,
    soldQuantityPeriod: entity.soldQuantityPeriod ?? null,
    productGroupCode: entity.productGroupCode ?? null,
  }
}

function toEntityData(input: PurchasePositionCreateInput, ctx: CrudCtx): Record<string, unknown> {
  return {
    ...scopeFromContext(ctx),
    catalogProductId: input.catalogProductId,
    catalogVariantId: input.catalogVariantId ?? null,
    sku: toTextOrNull(input.sku),
    annualVolume: input.annualVolume,
    currentTierCode: toTextOrNull(input.currentTierCode),
    currentTierDiscount: input.currentTierDiscount,
    nextTierVolume: toDecimalOrNull(input.nextTierVolume),
    nextTierDiscount: toDecimalOrNull(input.nextTierDiscount),
    lastDeliveryUnitCost: toDecimalOrNull(input.lastDeliveryUnitCost),
    lastDeliveryAt: input.lastDeliveryAt ?? null,
    lastDeliveryQuantity: toDecimalOrNull(input.lastDeliveryQuantity),
    soldQuantityPeriod: toDecimalOrNull(input.soldQuantityPeriod),
    productGroupCode: toTextOrNull(input.productGroupCode),
  }
}

function applyUpdate(entity: PricingPurchasePosition, input: PurchasePositionUpdateInput): void {
  entity.catalogProductId = input.catalogProductId
  entity.catalogVariantId = input.catalogVariantId ?? null
  entity.sku = toTextOrNull(input.sku)
  entity.annualVolume = input.annualVolume
  entity.currentTierCode = toTextOrNull(input.currentTierCode)
  entity.currentTierDiscount = input.currentTierDiscount
  entity.nextTierVolume = toDecimalOrNull(input.nextTierVolume)
  entity.nextTierDiscount = toDecimalOrNull(input.nextTierDiscount)
  entity.lastDeliveryUnitCost = toDecimalOrNull(input.lastDeliveryUnitCost)
  entity.lastDeliveryAt = input.lastDeliveryAt ?? null
  entity.lastDeliveryQuantity = toDecimalOrNull(input.lastDeliveryQuantity)
  entity.soldQuantityPeriod = toDecimalOrNull(input.soldQuantityPeriod)
  entity.productGroupCode = toTextOrNull(input.productGroupCode)
}

const crud = makeCrudRoute<PricingRawBody, PricingRawBody, PurchasePositionListQuery>({
  metadata,
  orm: { entity: PricingPurchasePosition, ...pricingOrmConfig },
  events: { module: 'pricing_engine', entity: 'purchase_position' },
  list: {
    schema: listSchema,
    buildFilters: async (query) => {
      const filters: Record<string, unknown> = {}
      buildIdFilter(filters, query)
      if (query.catalogProductId) filters.catalogProductId = query.catalogProductId
      if (query.productGroupCode) filters.productGroupCode = query.productGroupCode
      buildSearchFilter(filters, query.search, ['sku', 'productGroupCode', 'currentTierCode'])
      return filters
    },
  },
  hooks: {
    afterList: (payload: PricingListPayload, ctx) => {
      finalizePricingList<PricingPurchasePosition, PurchasePositionRow>(payload, ctx.query, {
        mapItem: toPurchasePositionRow,
        defaultSort: { field: 'sku', dir: 'asc' },
      })
    },
  },
  create: {
    schema: pricingRawBodySchema,
    mapToEntity: (input, ctx) => toEntityData(purchasePositionCreateSchema.parse(input), ctx),
  },
  update: {
    schema: pricingRawBodySchema,
    getId: readBodyId,
    applyToEntity: (entity, input) => {
      applyUpdate(entity as PricingPurchasePosition, purchasePositionUpdateSchema.parse(input))
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
  summary: 'Purchase positions',
  itemSchema: pricingBaseRowSchema.extend({
    catalogProductId: z.string().uuid(),
    catalogVariantId: z.string().uuid().nullable(),
    sku: z.string().nullable(),
    annualVolume: z.string(),
    currentTierCode: z.string().nullable(),
    currentTierDiscount: z.string(),
    nextTierVolume: z.string().nullable(),
    nextTierDiscount: z.string().nullable(),
    lastDeliveryUnitCost: z.string().nullable(),
    lastDeliveryAt: z.string().nullable(),
    lastDeliveryAgeDays: z.number().int().nullable(),
    lastDeliveryQuantity: z.string().nullable(),
    soldQuantityPeriod: z.string().nullable(),
    productGroupCode: z.string().nullable(),
  }),
  createSchema: purchasePositionCreateSchema,
  updateSchema: purchasePositionUpdateSchema,
})
