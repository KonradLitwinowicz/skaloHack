import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { PricingOrderScenario } from '../../data/entities'
import {
  orderScenarioCreateSchema,
  orderScenarioUpdateSchema,
  type OrderScenarioCreateInput,
  type OrderScenarioUpdateInput,
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

// Pinned path: the auto-derived value would be `/pricing-engine/order-scenarios`.
// The generator resolves the served path by STATIC analysis: it reads `metadata.path` from an
// object literal and cannot evaluate a helper call. A computed metadata object therefore falls
// back to the module-id convention (`/api/pricing_engine/...`) and every caller 404s. The literal
// below is what pins `/api/pricing/*` — a frozen contract surface.
export const metadata = {
  path: '/pricing/order-scenarios',
  GET: { requireAuth: true, requireFeatures: ['pricing.params.read'] },
  POST: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  PUT: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
}

const listSchema = pricingListSchema({})

type OrderScenarioListQuery = z.infer<typeof listSchema>
type OrderScenarioRow = ReturnType<typeof toOrderScenarioRow>

function toOrderScenarioRow(entity: PricingOrderScenario) {
  const now = new Date()
  return {
    ...baseRow(entity),
    ...versionRow(entity, now),
    code: entity.code,
    label: entity.label,
    stepMultipliers: entity.stepMultipliers ?? {},
    extraStepCodes: entity.extraStepCodes ?? [],
  }
}

// An empty map and an empty list are stored as NULL rather than `{}` / `[]` so the column reads
// the same whether the scenario was created before or after this screen existed.
function normalizeMultipliers(value: Record<string, string> | null | undefined): Record<string, string> | null {
  if (!value) return null
  const entries = Object.entries(value).filter(([key]) => key.trim().length > 0)
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

function normalizeStepCodes(value: string[] | null | undefined): string[] | null {
  const codes = (value ?? []).map((code) => code.trim()).filter(Boolean)
  return codes.length > 0 ? codes : null
}

function toEntityData(input: OrderScenarioCreateInput, ctx: CrudCtx): Record<string, unknown> {
  return {
    ...scopeFromContext(ctx),
    code: input.code,
    label: input.label,
    stepMultipliers: normalizeMultipliers(input.stepMultipliers),
    extraStepCodes: normalizeStepCodes(input.extraStepCodes),
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
  }
}

function applyUpdate(entity: PricingOrderScenario, input: OrderScenarioUpdateInput): void {
  entity.code = input.code
  entity.label = input.label
  entity.stepMultipliers = normalizeMultipliers(input.stepMultipliers)
  entity.extraStepCodes = normalizeStepCodes(input.extraStepCodes)
  entity.validFrom = input.validFrom
  entity.validTo = input.validTo ?? null
}

const crud = makeCrudRoute<PricingRawBody, PricingRawBody, OrderScenarioListQuery>({
  metadata,
  orm: { entity: PricingOrderScenario, ...pricingOrmConfig },
  events: { module: 'pricing_engine', entity: 'order_scenario' },
  list: {
    schema: listSchema,
    buildFilters: async (query) => {
      const filters: Record<string, unknown> = {}
      buildIdFilter(filters, query)
      buildSearchFilter(filters, query.search, ['code', 'label'])
      return filters
    },
  },
  hooks: {
    afterList: (payload: PricingListPayload, ctx) => {
      finalizePricingList<PricingOrderScenario, OrderScenarioRow>(payload, ctx.query, {
        mapItem: toOrderScenarioRow,
        defaultSort: { field: 'code', dir: 'asc' },
      })
    },
  },
  create: {
    schema: pricingRawBodySchema,
    mapToEntity: (input, ctx) => toEntityData(orderScenarioCreateSchema.parse(input), ctx),
  },
  update: {
    schema: pricingRawBodySchema,
    getId: readBodyId,
    applyToEntity: (entity, input) => {
      applyUpdate(entity as PricingOrderScenario, orderScenarioUpdateSchema.parse(input))
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
  summary: 'Order scenarios',
  itemSchema: pricingBaseRowSchema.extend(pricingVersionRowSchema.shape).extend({
    code: z.string(),
    label: z.string(),
    stepMultipliers: z.record(z.string(), z.string()),
    extraStepCodes: z.array(z.string()),
  }),
  createSchema: orderScenarioCreateSchema,
  updateSchema: orderScenarioUpdateSchema,
})
