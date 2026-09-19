import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { PricingCustomerProfile } from '../../data/entities'
import {
  customerProfileCreateSchema,
  customerProfileUpdateSchema,
  type CustomerProfileCreateInput,
  type CustomerProfilePatchField,
  type CustomerProfileUpdateInput,
  type NegotiatedPrices,
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
  toTextOrNull,
  type PricingListPayload,
  type PricingRawBody,
} from '../../lib/crud/pricingCrudRoute'

// Pinned path: the auto-derived value would be `/pricing-engine/customer-profiles`.
// The generator resolves the served path by STATIC analysis: it reads `metadata.path` from an
// object literal and cannot evaluate a helper call. A computed metadata object therefore falls
// back to the module-id convention (`/api/pricing_engine/...`) and every caller 404s. The literal
// below is what pins `/api/pricing/*` — a frozen contract surface.
export const metadata = {
  path: '/pricing/customer-profiles',
  GET: { requireAuth: true, requireFeatures: ['pricing.params.read'] },
  POST: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  PUT: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
  DELETE: { requireAuth: true, requireFeatures: ['pricing.params.write'] },
}

// Exported for the unit tests: the CRUD factory's own handlers need a live container and ORM, so
// the route's pure parts (query schema, filter builder, row mapper) are verified directly.
export const customerProfileListSchema = pricingListSchema({
  // The primary access pattern is not the grid: a tab on one customer's card asks for that
  // customer's single profile. `lib/params.ts` resolves the same way (`findOne` by `customerId`).
  customerId: z.string().uuid().optional(),
})

type CustomerProfileListQuery = z.infer<typeof customerProfileListSchema>
type CustomerProfileRow = ReturnType<typeof toCustomerProfileRow>

const DUPLICATE_PROFILE_CODE = 'pricing_customer_profile_exists'

export function buildCustomerProfileFilters(
  query: CustomerProfileListQuery,
): Record<string, unknown> {
  const filters: Record<string, unknown> = {}
  buildIdFilter(filters, query)
  if (query.customerId) filters.customerId = query.customerId
  // `customerId` is intentionally absent from the search columns: the customer's NAME lives in an
  // encrypted column of another module, so a `LIKE` here would match ciphertext.
  buildSearchFilter(filters, query.search, [
    'customerGroupCode',
    'deliveryZoneCode',
    'defaultOrderScenarioCode',
  ])
  return filters
}

/**
 * Canonical storage form. `{}` and `null` are indistinguishable to the engine, so exactly one of
 * them reaches the column — see the note on `negotiatedPricesSchema` in `data/validators.ts`.
 */
export function toNegotiatedPricesOrNull(
  value: NegotiatedPrices | null | undefined,
): Record<string, string> | null {
  if (!value) return null
  return Object.keys(value).length > 0 ? value : null
}

export function toCustomerProfileRow(entity: PricingCustomerProfile) {
  const now = new Date()
  const negotiatedPrices = entity.negotiatedPrices ?? {}
  const negotiatedPriceCount = Object.keys(negotiatedPrices).length
  const expiresAt = entity.negotiatedPriceExpiresAt ?? null
  // Mirrors `negotiatedExpired` in `lib/params.ts`: a missing date never expires, and the one date
  // covers the whole map. Surfaced so a screen can say "these prices are live today" without
  // re-deriving the engine's rule — and so an expired book is visible rather than silently inert.
  const expired = expiresAt !== null && expiresAt.getTime() <= now.getTime()
  return {
    ...baseRow(entity),
    customerId: entity.customerId,
    customerGroupCode: entity.customerGroupCode ?? null,
    deliveryZoneCode: entity.deliveryZoneCode ?? null,
    defaultOrderScenarioCode: entity.defaultOrderScenarioCode ?? null,
    negotiatedPrices,
    negotiatedPriceCount,
    negotiatedPriceExpiresAt: toIso(expiresAt),
    negotiatedPricesInForce: negotiatedPriceCount > 0 && !expired,
  }
}

function toEntityData(input: CustomerProfileCreateInput, ctx: CrudCtx): Record<string, unknown> {
  return {
    ...scopeFromContext(ctx),
    customerId: input.customerId,
    customerGroupCode: toTextOrNull(input.customerGroupCode),
    deliveryZoneCode: toTextOrNull(input.deliveryZoneCode),
    defaultOrderScenarioCode: toTextOrNull(input.defaultOrderScenarioCode),
    negotiatedPrices: toNegotiatedPricesOrNull(input.negotiatedPrices),
    negotiatedPriceExpiresAt: input.negotiatedPriceExpiresAt ?? null,
  }
}

/**
 * True only when the caller actually SENT the field. `null` is a value — "clear this" — while an
 * absent key means "leave it alone"; JSON cannot carry `undefined`, so a key present with that
 * value can only come from a direct JS caller and is read as absent too.
 */
function isProvided(
  input: CustomerProfileUpdateInput,
  field: CustomerProfilePatchField,
): boolean {
  return Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined
}

/**
 * PUT is a PATCH over the five settable columns: the body may carry any subset of them.
 *
 * Assigning all five unconditionally made every partial PUT destructive — a body of `{ id,
 * customerId }` parsed cleanly and then wrote `null` over the negotiated price book, its expiry and
 * the three codes that route the customer to their pricing rules. The rep lost a negotiated
 * contract with a `200 {"ok":true}` and no trace of what had been there.
 *
 * `customerId` is deliberately not reassigned: it is the row's identity under the unique index, and
 * repointing a price book at a different customer is a create, not an edit.
 */
export function applyCustomerProfileUpdate(
  entity: PricingCustomerProfile,
  input: CustomerProfileUpdateInput,
): void {
  if (isProvided(input, 'customerGroupCode')) {
    entity.customerGroupCode = toTextOrNull(input.customerGroupCode)
  }
  if (isProvided(input, 'deliveryZoneCode')) {
    entity.deliveryZoneCode = toTextOrNull(input.deliveryZoneCode)
  }
  if (isProvided(input, 'defaultOrderScenarioCode')) {
    entity.defaultOrderScenarioCode = toTextOrNull(input.defaultOrderScenarioCode)
  }
  if (isProvided(input, 'negotiatedPrices')) {
    entity.negotiatedPrices = toNegotiatedPricesOrNull(input.negotiatedPrices)
  }
  if (isProvided(input, 'negotiatedPriceExpiresAt')) {
    entity.negotiatedPriceExpiresAt = input.negotiatedPriceExpiresAt ?? null
  }
}

/**
 * `pricing_customer_profiles_customer_unique` covers (tenant, organization, customer) and does NOT
 * exclude soft-deleted rows, so a second profile for the same customer would surface as a raw
 * Postgres unique violation — a 500 in front of a sales rep. Checked here so the answer is a
 * typed 409 carrying the id of the row that already exists.
 *
 * ACCEPTED RACE: this runs in `beforeCreate`, outside the transaction that inserts, so two POSTs
 * for the same customer issued inside the same millisecond can both pass and the loser gets the
 * raw 500 back. The window is deliberately left open:
 *  - data integrity is never at stake — `pricing_customer_profiles_customer_unique`
 *    (tenant_id, organization_id, customer_id) is the real guarantee and rejects the second row
 *    whatever this check does; only the STATUS CODE degrades from 409 to 500;
 *  - closing it needs either a lock held across the hook/insert boundary (the hook and the insert
 *    run on different transactions, so it would have to be a session-scoped advisory lock on a
 *    pooled connection — a deadlock risk far worse than the symptom) or catching the unique
 *    violation inside `makeCrudRoute`, which is shared contract surface this route does not own;
 *  - the only caller is the pricing tab on one customer's card, where the profile is created once
 *    per customer and `CrudForm` disables submit while the request is in flight, so a real
 *    collision needs two reps saving the same brand-new customer simultaneously.
 */
async function assertNoExistingProfile(
  input: CustomerProfileCreateInput,
  ctx: CrudCtx,
): Promise<void> {
  const scope = scopeFromContext(ctx)
  const em = ctx.container.resolve('em') as EntityManager
  const existing = await em.findOne(PricingCustomerProfile, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    customerId: input.customerId,
  })
  if (!existing) return
  throw new CrudHttpError(409, {
    // The module already travels i18n keys in its validation messages, so the client resolves this
    // the same way it resolves a zod issue from `data/validators.ts`.
    error: 'pricing_engine.params.errors.customerProfileExists',
    code: DUPLICATE_PROFILE_CODE,
    existingId: existing.id,
    deleted: existing.deletedAt != null,
  })
}

const crud = makeCrudRoute<PricingRawBody, PricingRawBody, CustomerProfileListQuery>({
  metadata,
  orm: { entity: PricingCustomerProfile, ...pricingOrmConfig },
  events: { module: 'pricing_engine', entity: 'customer_profile' },
  list: {
    schema: customerProfileListSchema,
    buildFilters: async (query) => buildCustomerProfileFilters(query),
  },
  hooks: {
    beforeCreate: async (input, ctx) => {
      await assertNoExistingProfile(customerProfileCreateSchema.parse(input), ctx)
    },
    afterList: (payload: PricingListPayload, ctx) => {
      finalizePricingList<PricingCustomerProfile, CustomerProfileRow>(payload, ctx.query, {
        mapItem: toCustomerProfileRow,
        defaultSort: { field: 'updatedAt', dir: 'desc' },
      })
    },
  },
  create: {
    schema: pricingRawBodySchema,
    mapToEntity: (input, ctx) => toEntityData(customerProfileCreateSchema.parse(input), ctx),
  },
  update: {
    schema: pricingRawBodySchema,
    getId: readBodyId,
    applyToEntity: (entity, input) => {
      applyCustomerProfileUpdate(
        entity as PricingCustomerProfile,
        customerProfileUpdateSchema.parse(input),
      )
    },
    response: () => ({ ok: true }),
  },
  del: { idFrom: 'query', softDelete: true, response: () => ({ ok: true }) },
})

export const GET = crud.GET
export const POST = crud.POST
export const PUT = crud.PUT
export const DELETE = crud.DELETE

export const customerProfileRowSchema = pricingBaseRowSchema.extend({
  customerId: z.string().uuid(),
  customerGroupCode: z.string().nullable(),
  deliveryZoneCode: z.string().nullable(),
  defaultOrderScenarioCode: z.string().nullable(),
  negotiatedPrices: z.record(z.string().uuid(), z.string()),
  negotiatedPriceCount: z.number().int(),
  negotiatedPriceExpiresAt: z.string().nullable(),
  negotiatedPricesInForce: z.boolean(),
})

export const customerProfileCreatedSchema = z.object({ id: z.string().uuid() })

const customerProfileDuplicateSchema = z.object({
  error: z.string(),
  code: z.literal(DUPLICATE_PROFILE_CODE),
  existingId: z.string().uuid(),
  deleted: z.boolean(),
})

const sharedOpenApi = pricingCrudOpenApi({
  summary: 'Customer pricing profiles',
  itemSchema: customerProfileRowSchema,
  createSchema: customerProfileCreateSchema,
  updateSchema: customerProfileUpdateSchema,
})

/**
 * The shared helper documents `200` plus the full row for POST, but `makeCrudRoute` answers `201`
 * with `{ id }` — a generated client typed off the published contract would read `row.customerId`
 * off an object that has only `id`. The two responses this route can actually return are declared
 * here instead: the `201` the factory sends, and the typed `409` `assertNoExistingProfile` raises.
 */
export const openApi: OpenApiRouteDoc = {
  ...sharedOpenApi,
  methods: {
    ...sharedOpenApi.methods,
    POST: {
      ...sharedOpenApi.methods.POST,
      responses: [
        { status: 201, description: 'Created', schema: customerProfileCreatedSchema },
        {
          status: 409,
          description: 'This customer already has a pricing profile',
          schema: customerProfileDuplicateSchema,
        },
      ],
    },
  },
}
