import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { PricingComponentParam } from '../../data/entities'
import {
  TARGET_MARGIN_COMPONENT_CODE,
  marginRuleCreateSchema,
  marginRuleUpdateSchema,
  pricingParamScopeSchema,
  type MarginRuleCreateInput,
  type MarginRuleUpdateInput,
} from '../../data/validators'
import {
  actorFromContext,
  baseRow,
  buildIdFilter,
  buildSearchFilter,
  finalizePricingList,
  pricingListSchema,
  pricingOrmConfig,
  pricingRawBodySchema,
  readBodyId,
  scopeFromContext,
  versionRow,
  type PricingListPayload,
  type PricingRawBody,
  pricingParameterEventHooks,
} from '../../lib/crud/pricingCrudRoute'

// Pinned path: the auto-derived value would be `/pricing-engine/margin-rules`.
// The generator resolves the served path by STATIC analysis: it reads `metadata.path` from an
// object literal and cannot evaluate a helper call. A computed metadata object therefore falls
// back to the module-id convention (`/api/pricing_engine/...`) and every caller 404s. The literal
// below is what pins `/api/pricing/*` — a frozen contract surface.
export const metadata = {
  path: '/pricing/margin-rules',
  GET: { requireAuth: true, requireFeatures: ['pricing.params.read'] },
  POST: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  PUT: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
}

const listSchema = pricingListSchema({
  componentCode: z.string().trim().min(1).max(100).optional(),
  scope: pricingParamScopeSchema.optional(),
  scopeRefId: z.string().trim().min(1).max(200).optional(),
})

type MarginRuleListQuery = z.infer<typeof listSchema>

type MarginRuleRow = ReturnType<typeof toMarginRuleRow>

function readMarkupPercent(payload: Record<string, unknown> | null | undefined): string | null {
  const value = payload?.targetMarkupPercent
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return null
}

function toMarginRuleRow(entity: PricingComponentParam) {
  const now = new Date()
  return {
    ...baseRow(entity),
    ...versionRow(entity, now),
    componentCode: entity.componentCode,
    scope: entity.scope,
    scopeRefId: entity.scopeRefId ?? null,
    targetMarkupPercent: readMarkupPercent(entity.payload),
    payload: entity.payload,
    changeNote: entity.changeNote ?? null,
    createdByUserId: entity.createdByUserId ?? null,
  }
}

function toEntityData(input: MarginRuleCreateInput, ctx: CrudCtx): Record<string, unknown> {
  return {
    ...scopeFromContext(ctx),
    componentCode: input.componentCode,
    scope: input.scope,
    scopeRefId: input.scopeRefId,
    payload: { targetMarkupPercent: input.targetMarkupPercent },
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
    changeNote: input.changeNote,
    // Authorship is taken from the session, never from the body: this column is the audit trail
    // that answers "who set the house margin to 84%".
    createdByUserId: actorFromContext(ctx),
  }
}

function applyUpdate(entity: PricingComponentParam, input: MarginRuleUpdateInput): void {
  entity.componentCode = input.componentCode
  entity.scope = input.scope
  entity.scopeRefId = input.scopeRefId
  entity.payload = { ...(entity.payload ?? {}), targetMarkupPercent: input.targetMarkupPercent }
  entity.validFrom = input.validFrom
  entity.validTo = input.validTo ?? null
  entity.changeNote = input.changeNote
}

const crud = makeCrudRoute<PricingRawBody, PricingRawBody, MarginRuleListQuery>({
  metadata,
  orm: { entity: PricingComponentParam, ...pricingOrmConfig },
  events: { module: 'pricing_engine', entity: 'component_param' },
  list: {
    schema: listSchema,
    buildFilters: async (query) => {
      const filters: Record<string, unknown> = {
        componentCode: query.componentCode ?? TARGET_MARGIN_COMPONENT_CODE,
      }
      buildIdFilter(filters, query)
      if (query.scope) filters.scope = query.scope
      if (query.scopeRefId) filters.scopeRefId = query.scopeRefId
      buildSearchFilter(filters, query.search, ['scopeRefId', 'changeNote'])
      return filters
    },
  },
  hooks: {
    ...pricingParameterEventHooks('component_param'),
    afterList: (payload: PricingListPayload, ctx) => {
      finalizePricingList<PricingComponentParam, MarginRuleRow>(payload, ctx.query, {
        mapItem: toMarginRuleRow,
        defaultSort: { field: 'validFrom', dir: 'desc' },
      })
    },
  },
  create: {
    schema: pricingRawBodySchema,
    mapToEntity: (input, ctx) => toEntityData(marginRuleCreateSchema.parse(input), ctx),
  },
  update: {
    schema: pricingRawBodySchema,
    getId: readBodyId,
    applyToEntity: (entity, input) => {
      applyUpdate(entity as PricingComponentParam, marginRuleUpdateSchema.parse(input))
    },
    response: () => ({ ok: true }),
  },
  del: { idFrom: 'query', softDelete: true, response: () => ({ ok: true }) },
})

export const GET = crud.GET
export const POST = crud.POST
export const PUT = crud.PUT
export const DELETE = crud.DELETE

const marginRuleItemSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  tenantId: z.string().uuid(),
  isDemo: z.boolean(),
  componentCode: z.string(),
  scope: pricingParamScopeSchema,
  scopeRefId: z.string().nullable(),
  targetMarkupPercent: z.string().nullable(),
  changeNote: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  isInForce: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Pricing Engine',
  summary: 'Margin rules',
  methods: {
    GET: {
      summary: 'List target-margin rules, newest effective version first',
      responses: [
        {
          status: 200,
          description: 'Margin rules',
          schema: z.object({
            items: z.array(marginRuleItemSchema),
            total: z.number().int(),
            page: z.number().int(),
            pageSize: z.number().int(),
            totalPages: z.number().int(),
          }),
        },
      ],
    },
    POST: {
      summary: 'Create a margin rule effective from a date',
      requestBody: { contentType: 'application/json', schema: marginRuleCreateSchema },
      responses: [{ status: 200, description: 'Created rule', schema: marginRuleItemSchema }],
    },
    PUT: {
      summary: 'Correct a margin rule in place, or close it out by setting validTo',
      requestBody: { contentType: 'application/json', schema: marginRuleUpdateSchema },
      responses: [
        { status: 200, description: 'Updated', schema: z.object({ ok: z.boolean() }) },
        {
          status: 409,
          description: 'The rule changed since it was loaded',
          schema: z.object({
            error: z.string(),
            code: z.string(),
            currentUpdatedAt: z.string(),
            expectedUpdatedAt: z.string(),
          }),
        },
      ],
    },
    DELETE: {
      summary: 'Soft-delete a margin rule',
      responses: [{ status: 200, description: 'Deleted', schema: z.object({ ok: z.boolean() }) }],
    },
  },
}
