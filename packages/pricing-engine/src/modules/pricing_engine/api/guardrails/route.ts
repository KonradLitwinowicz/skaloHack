import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { PricingGuardrail } from '../../data/entities'
import {
  guardrailCreateSchema,
  guardrailUpdateSchema,
  negotiatedPricePrecedenceSchema,
  pricingParamScopeSchema,
  type GuardrailCreateInput,
  type GuardrailUpdateInput,
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
  toDecimalOrNull,
  versionRow,
  type PricingListPayload,
  type PricingRawBody,
  pricingParameterEventHooks,
} from '../../lib/crud/pricingCrudRoute'

// Pinned path: the auto-derived value would be `/pricing-engine/guardrails`.
// The generator resolves the served path by STATIC analysis: it reads `metadata.path` from an
// object literal and cannot evaluate a helper call. A computed metadata object therefore falls
// back to the module-id convention (`/api/pricing_engine/...`) and every caller 404s. The literal
// below is what pins `/api/pricing/*` — a frozen contract surface.
export const metadata = {
  path: '/pricing/guardrails',
  GET: { requireAuth: true, requireFeatures: ['pricing.params.read'] },
  POST: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  PUT: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
}

const listSchema = pricingListSchema({
  scope: pricingParamScopeSchema.optional(),
  scopeRefId: z.string().trim().min(1).max(200).optional(),
})

type GuardrailListQuery = z.infer<typeof listSchema>
type GuardrailRow = ReturnType<typeof toGuardrailRow>

function toGuardrailRow(entity: PricingGuardrail) {
  const now = new Date()
  return {
    ...baseRow(entity),
    ...versionRow(entity, now),
    code: entity.code,
    scope: entity.scope,
    scopeRefId: entity.scopeRefId ?? null,
    minMarginPercent: entity.minMarginPercent ?? null,
    // Surfaced read-only: the engine resolves it but `lib/components/guardrails.ts` never clamps
    // on it, so the screens must not present it as an editable control.
    maxDiscountPercent: entity.maxDiscountPercent ?? null,
    floorPrice: entity.floorPrice ?? null,
    negotiatedPricePrecedence: entity.negotiatedPricePrecedence,
  }
}

function toEntityData(input: GuardrailCreateInput, ctx: CrudCtx): Record<string, unknown> {
  return {
    ...scopeFromContext(ctx),
    code: input.code,
    scope: input.scope,
    scopeRefId: input.scopeRefId,
    minMarginPercent: toDecimalOrNull(input.minMarginPercent),
    maxDiscountPercent: toDecimalOrNull(input.maxDiscountPercent),
    floorPrice: toDecimalOrNull(input.floorPrice),
    negotiatedPricePrecedence: input.negotiatedPricePrecedence,
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
  }
}

function applyUpdate(entity: PricingGuardrail, input: GuardrailUpdateInput): void {
  entity.code = input.code
  entity.scope = input.scope
  entity.scopeRefId = input.scopeRefId
  entity.minMarginPercent = toDecimalOrNull(input.minMarginPercent)
  // Absent (an older client) leaves the stored cap alone; an explicit null clears it.
  if (input.maxDiscountPercent !== undefined) entity.maxDiscountPercent = toDecimalOrNull(input.maxDiscountPercent)
  entity.floorPrice = toDecimalOrNull(input.floorPrice)
  entity.negotiatedPricePrecedence = input.negotiatedPricePrecedence
  entity.validFrom = input.validFrom
  entity.validTo = input.validTo ?? null
}

const crud = makeCrudRoute<PricingRawBody, PricingRawBody, GuardrailListQuery>({
  metadata,
  orm: { entity: PricingGuardrail, ...pricingOrmConfig },
  events: { module: 'pricing_engine', entity: 'guardrail' },
  list: {
    schema: listSchema,
    buildFilters: async (query) => {
      const filters: Record<string, unknown> = {}
      buildIdFilter(filters, query)
      if (query.scope) filters.scope = query.scope
      if (query.scopeRefId) filters.scopeRefId = query.scopeRefId
      buildSearchFilter(filters, query.search, ['code', 'scopeRefId'])
      return filters
    },
  },
  hooks: {
    ...pricingParameterEventHooks('guardrail'),
    afterList: (payload: PricingListPayload, ctx) => {
      finalizePricingList<PricingGuardrail, GuardrailRow>(payload, ctx.query, {
        mapItem: toGuardrailRow,
        defaultSort: { field: 'validFrom', dir: 'desc' },
      })
    },
  },
  create: {
    schema: pricingRawBodySchema,
    mapToEntity: (input, ctx) => toEntityData(guardrailCreateSchema.parse(input), ctx),
  },
  update: {
    schema: pricingRawBodySchema,
    getId: readBodyId,
    applyToEntity: (entity, input) => {
      applyUpdate(entity as PricingGuardrail, guardrailUpdateSchema.parse(input))
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
  summary: 'Pricing guardrails',
  itemSchema: pricingBaseRowSchema.extend(pricingVersionRowSchema.shape).extend({
    code: z.string(),
    scope: pricingParamScopeSchema,
    scopeRefId: z.string().nullable(),
    minMarginPercent: z.string().nullable(),
    maxDiscountPercent: z.string().nullable(),
    floorPrice: z.string().nullable(),
    negotiatedPricePrecedence: negotiatedPricePrecedenceSchema,
  }),
  createSchema: guardrailCreateSchema,
  updateSchema: guardrailUpdateSchema,
})
