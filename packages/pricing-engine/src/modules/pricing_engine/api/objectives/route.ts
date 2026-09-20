import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { PricingComponentParam } from '../../data/entities'
import { pricingParamScopeSchema } from '../../data/validators'
import {
  OBJECTIVE_WEIGHTS_COMPONENT_CODE,
  objectiveCreateSchema,
  objectiveUpdateSchema,
  pricingObjectiveSchema,
  readObjectives,
  type ObjectiveCreateInput,
  type ObjectiveUpdateInput,
} from '../../lib/advisor/objectives'
import {
  actorFromContext,
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

// Pinned path: the generator resolves the served path by STATIC analysis of this object literal and
// cannot evaluate a helper call, so a computed metadata object would fall back to
// `/api/pricing_engine/...` and every caller would 404. `/api/pricing/*` is a frozen surface.
export const metadata = {
  path: '/pricing/objectives',
  GET: { requireAuth: true, requireFeatures: ['pricing.params.read'] },
  POST: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  PUT: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
}

const listSchema = pricingListSchema({
  scope: pricingParamScopeSchema.optional(),
  scopeRefId: z.string().trim().min(1).max(200).optional(),
})

type ObjectiveListQuery = z.infer<typeof listSchema>

type ObjectiveRow = ReturnType<typeof toObjectiveRow>

function toObjectiveRow(entity: PricingComponentParam) {
  const objectives = readObjectives(entity.payload)
  return {
    ...baseRow(entity),
    ...versionRow(entity, new Date()),
    componentCode: entity.componentCode,
    scope: entity.scope,
    scopeRefId: entity.scopeRefId ?? null,
    objectives,
    // Sortable in the list without the client re-deriving it from the array on every render.
    objectiveCount: objectives.length,
    changeNote: entity.changeNote ?? null,
    createdByUserId: entity.createdByUserId ?? null,
  }
}

function toEntityData(input: ObjectiveCreateInput, ctx: CrudCtx): Record<string, unknown> {
  return {
    ...scopeFromContext(ctx),
    componentCode: OBJECTIVE_WEIGHTS_COMPONENT_CODE,
    scope: input.scope,
    scopeRefId: input.scopeRefId,
    payload: { objectives: input.objectives },
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
    changeNote: input.changeNote,
    // Authorship comes from the session, never the body: this column answers "who told the advisor
    // to rank volume above margin".
    createdByUserId: actorFromContext(ctx),
  }
}

function applyUpdate(entity: PricingComponentParam, input: ObjectiveUpdateInput): void {
  entity.componentCode = OBJECTIVE_WEIGHTS_COMPONENT_CODE
  entity.scope = input.scope
  entity.scopeRefId = input.scopeRefId
  entity.payload = { ...(entity.payload ?? {}), objectives: input.objectives }
  entity.validFrom = input.validFrom
  entity.validTo = input.validTo ?? null
  entity.changeNote = input.changeNote
}

const crud = makeCrudRoute<PricingRawBody, PricingRawBody, ObjectiveListQuery>({
  metadata,
  orm: { entity: PricingComponentParam, ...pricingOrmConfig },
  events: { module: 'pricing_engine', entity: 'component_param' },
  list: {
    schema: listSchema,
    buildFilters: async (query) => {
      // Objectives share `pricing_component_params` with every other rule, so the component code is
      // forced rather than defaulted: a caller must not be able to list margin rules through here.
      const filters: Record<string, unknown> = { componentCode: OBJECTIVE_WEIGHTS_COMPONENT_CODE }
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
      finalizePricingList<PricingComponentParam, ObjectiveRow>(payload, ctx.query, {
        mapItem: toObjectiveRow,
        defaultSort: { field: 'validFrom', dir: 'desc' },
      })
    },
  },
  create: {
    schema: pricingRawBodySchema,
    mapToEntity: (input, ctx) => toEntityData(objectiveCreateSchema.parse(input), ctx),
  },
  update: {
    schema: pricingRawBodySchema,
    getId: readBodyId,
    applyToEntity: (entity, input) => {
      applyUpdate(entity as PricingComponentParam, objectiveUpdateSchema.parse(input))
    },
    response: () => ({ ok: true }),
  },
  del: { idFrom: 'query', softDelete: true, response: () => ({ ok: true }) },
})

export const GET = crud.GET
export const POST = crud.POST
export const PUT = crud.PUT
export const DELETE = crud.DELETE

const objectiveItemSchema = pricingBaseRowSchema.extend(pricingVersionRowSchema.shape).extend({
  componentCode: z.string(),
  scope: pricingParamScopeSchema,
  scopeRefId: z.string().nullable(),
  objectives: z.array(pricingObjectiveSchema),
  objectiveCount: z.number().int(),
  changeNote: z.string().nullable(),
  createdByUserId: z.string().nullable(),
})

export const openApi: OpenApiRouteDoc = pricingCrudOpenApi({
  summary: 'Advisor objectives and weights',
  itemSchema: objectiveItemSchema,
  createSchema: objectiveCreateSchema,
  updateSchema: objectiveUpdateSchema,
})
