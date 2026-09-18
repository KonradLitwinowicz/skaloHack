import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { PricingProcessStep } from '../../data/entities'
import {
  processStepCreateSchema,
  processStepUpdateSchema,
  type ProcessStepCreateInput,
  type ProcessStepUpdateInput,
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

// Pinned path: the auto-derived value would be `/pricing-engine/process-steps`.
// The generator resolves the served path by STATIC analysis: it reads `metadata.path` from an
// object literal and cannot evaluate a helper call. A computed metadata object therefore falls
// back to the module-id convention (`/api/pricing_engine/...`) and every caller 404s. The literal
// below is what pins `/api/pricing/*` — a frozen contract surface.
export const metadata = {
  path: '/pricing/process-steps',
  GET: { requireAuth: true, requireFeatures: ['pricing.params.read'] },
  POST: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  PUT: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
}

const listSchema = pricingListSchema({
  roleCode: z.string().trim().min(1).max(100).optional(),
})

type ProcessStepListQuery = z.infer<typeof listSchema>
type ProcessStepRow = ReturnType<typeof toProcessStepRow>

function toProcessStepRow(entity: PricingProcessStep) {
  const now = new Date()
  return {
    ...baseRow(entity),
    ...versionRow(entity, now),
    code: entity.code,
    label: entity.label,
    roleCode: entity.roleCode,
    durationMinutes: entity.durationMinutes,
    isPerLine: entity.isPerLine,
    isPerOrder: entity.isPerOrder,
  }
}

function toEntityData(input: ProcessStepCreateInput, ctx: CrudCtx): Record<string, unknown> {
  return {
    ...scopeFromContext(ctx),
    code: input.code,
    label: input.label,
    roleCode: input.roleCode,
    durationMinutes: input.durationMinutes,
    isPerLine: input.isPerLine,
    isPerOrder: input.isPerOrder,
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
  }
}

function applyUpdate(entity: PricingProcessStep, input: ProcessStepUpdateInput): void {
  entity.code = input.code
  entity.label = input.label
  entity.roleCode = input.roleCode
  entity.durationMinutes = input.durationMinutes
  entity.isPerLine = input.isPerLine
  entity.isPerOrder = input.isPerOrder
  entity.validFrom = input.validFrom
  entity.validTo = input.validTo ?? null
}

const crud = makeCrudRoute<PricingRawBody, PricingRawBody, ProcessStepListQuery>({
  metadata,
  orm: { entity: PricingProcessStep, ...pricingOrmConfig },
  events: { module: 'pricing_engine', entity: 'process_step' },
  list: {
    schema: listSchema,
    buildFilters: async (query) => {
      const filters: Record<string, unknown> = {}
      buildIdFilter(filters, query)
      if (query.roleCode) filters.roleCode = query.roleCode
      buildSearchFilter(filters, query.search, ['code', 'label', 'roleCode'])
      return filters
    },
  },
  hooks: {
    afterList: (payload: PricingListPayload, ctx) => {
      finalizePricingList<PricingProcessStep, ProcessStepRow>(payload, ctx.query, {
        mapItem: toProcessStepRow,
        defaultSort: { field: 'code', dir: 'asc' },
      })
    },
  },
  create: {
    schema: pricingRawBodySchema,
    mapToEntity: (input, ctx) => toEntityData(processStepCreateSchema.parse(input), ctx),
  },
  update: {
    schema: pricingRawBodySchema,
    getId: readBodyId,
    applyToEntity: (entity, input) => {
      applyUpdate(entity as PricingProcessStep, processStepUpdateSchema.parse(input))
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
  summary: 'Process steps',
  itemSchema: pricingBaseRowSchema.extend(pricingVersionRowSchema.shape).extend({
    code: z.string(),
    label: z.string(),
    roleCode: z.string(),
    durationMinutes: z.string(),
    isPerLine: z.boolean(),
    isPerOrder: z.boolean(),
  }),
  createSchema: processStepCreateSchema,
  updateSchema: processStepUpdateSchema,
})
