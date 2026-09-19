import {
  applyCustomerProfileUpdate,
  buildCustomerProfileFilters,
  customerProfileCreatedSchema,
  customerProfileListSchema,
  customerProfileRowSchema,
  metadata,
  openApi,
  toCustomerProfileRow,
  toNegotiatedPricesOrNull,
} from '../api/customer-profiles/route'
import type { PricingCustomerProfile } from '../data/entities'
import {
  CUSTOMER_PROFILE_PATCH_FIELDS,
  canonicalNegotiatedPriceKey,
  customerProfileCreateSchema,
  customerProfileUpdateSchema,
} from '../data/validators'
import { finalizePricingList, type PricingListPayload } from '../lib/crud/pricingCrudRoute'

const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222'
const PRODUCT_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_PRODUCT_ID = '44444444-4444-4444-8444-444444444444'
const PROFILE_ID = '55555555-5555-4555-8555-555555555555'
const ORG_ID = '66666666-6666-4666-8666-666666666666'
const TENANT_ID = '77777777-7777-4777-8777-777777777777'

function profile(overrides: Partial<PricingCustomerProfile> = {}): PricingCustomerProfile {
  return {
    id: PROFILE_ID,
    organizationId: ORG_ID,
    tenantId: TENANT_ID,
    isDemo: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-01T00:00:00.000Z'),
    deletedAt: null,
    customerId: CUSTOMER_ID,
    customerGroupCode: 'horeca_premium',
    deliveryZoneCode: 'warszawa_poludnie',
    defaultOrderScenarioCode: 'ideal_file',
    negotiatedPrices: null,
    negotiatedPriceExpiresAt: null,
    ...overrides,
  } as PricingCustomerProfile
}

describe('customer profile route metadata', () => {
  // The generator reads this object literal statically; a helper call here would serve the route
  // at `/api/pricing_engine/...` and every caller of the frozen `/api/pricing/*` surface would 404.
  it('pins the frozen path and gates writes behind the write feature', () => {
    expect(metadata.path).toBe('/pricing/customer-profiles')
    expect(metadata.GET.requireFeatures).toEqual(['pricing.params.read'])
    for (const method of [metadata.POST, metadata.PUT, metadata.DELETE]) {
      expect(method.requireAuth).toBe(true)
      expect(method.requireFeatures).toEqual(['pricing.params.write'])
    }
  })
})

describe('negotiated price map validation', () => {
  it('accepts a map keyed by product id with decimal string prices', () => {
    const parsed = customerProfileCreateSchema.parse({
      customerId: CUSTOMER_ID,
      negotiatedPrices: { [PRODUCT_ID]: '25.0000', [OTHER_PRODUCT_ID]: '0' },
    })
    expect(parsed.negotiatedPrices).toEqual({ [PRODUCT_ID]: '25.0000', [OTHER_PRODUCT_ID]: '0' })
  })

  it('keeps prices as strings even when the form sends a number', () => {
    const parsed = customerProfileCreateSchema.parse({
      customerId: CUSTOMER_ID,
      negotiatedPrices: { [PRODUCT_ID]: 25.5 },
    })
    expect(parsed.negotiatedPrices).toEqual({ [PRODUCT_ID]: '25.5' })
  })

  it('rejects a key that is not a catalog product id', () => {
    const result = customerProfileCreateSchema.safeParse({
      customerId: CUSTOMER_ID,
      negotiatedPrices: { 'chleb-krojony': '25.00' },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    const issue = result.error.issues[0]
    expect(issue.path).toEqual(['negotiatedPrices', 'chleb-krojony'])
    expect(JSON.stringify(issue)).toContain('pricing_engine.params.errors.negotiatedPriceProductRequired')
  })

  it.each([
    ['a word', 'nie wiem'],
    ['an empty string', ''],
    ['a negative price', '-25.00'],
    ['scientific notation', '2.5e1'],
    ['a boolean', true],
  ])('rejects %s as a price', (_label, value) => {
    const result = customerProfileCreateSchema.safeParse({
      customerId: CUSTOMER_ID,
      negotiatedPrices: { [PRODUCT_ID]: value },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0].path).toEqual(['negotiatedPrices', PRODUCT_ID])
  })

  // `{}` and `null` are the same state to `negotiatedUnitPrice` in `lib/params.ts`, so both are
  // accepted at the edge and exactly one of them — `null` — reaches the column.
  it('accepts an empty map and stores it as null', () => {
    const parsed = customerProfileCreateSchema.parse({
      customerId: CUSTOMER_ID,
      negotiatedPrices: {},
    })
    expect(parsed.negotiatedPrices).toEqual({})
    expect(toNegotiatedPricesOrNull(parsed.negotiatedPrices)).toBeNull()
  })

  it('stores null for an omitted or explicitly cleared map', () => {
    expect(toNegotiatedPricesOrNull(undefined)).toBeNull()
    expect(toNegotiatedPricesOrNull(null)).toBeNull()
    expect(toNegotiatedPricesOrNull({ [PRODUCT_ID]: '25.00' })).toEqual({ [PRODUCT_ID]: '25.00' })
  })
})

describe('customer profile schemas', () => {
  it('requires the customer the profile belongs to', () => {
    expect(customerProfileCreateSchema.safeParse({}).success).toBe(false)
    expect(customerProfileCreateSchema.safeParse({ customerId: 'acme' }).success).toBe(false)
  })

  it('accepts a profile that only carries the routing codes', () => {
    const parsed = customerProfileCreateSchema.parse({
      customerId: CUSTOMER_ID,
      customerGroupCode: '  horeca_premium  ',
      deliveryZoneCode: 'warszawa_poludnie',
      defaultOrderScenarioCode: null,
    })
    expect(parsed.customerGroupCode).toBe('horeca_premium')
    expect(parsed.defaultOrderScenarioCode).toBeNull()
    expect(parsed.negotiatedPrices).toBeUndefined()
  })

  it('coerces the single expiry date that wipes the whole map', () => {
    const parsed = customerProfileCreateSchema.parse({
      customerId: CUSTOMER_ID,
      negotiatedPriceExpiresAt: '2026-12-31T23:59:59.000Z',
    })
    expect(parsed.negotiatedPriceExpiresAt).toEqual(new Date('2026-12-31T23:59:59.000Z'))
  })

  it('requires the row id on update', () => {
    expect(
      customerProfileUpdateSchema.safeParse({ customerId: CUSTOMER_ID }).success,
    ).toBe(false)
    expect(
      customerProfileUpdateSchema.safeParse({ id: PROFILE_ID, customerId: CUSTOMER_ID }).success,
    ).toBe(true)
  })
})

describe('list filters', () => {
  it('narrows to a single customer — the customer-card tab is the primary caller', () => {
    const query = customerProfileListSchema.parse({ customerId: CUSTOMER_ID })
    expect(buildCustomerProfileFilters(query)).toEqual({ customerId: CUSTOMER_ID })
  })

  it('refuses a customer id that is not a uuid instead of scanning the table', () => {
    expect(customerProfileListSchema.safeParse({ customerId: 'acme' }).success).toBe(false)
  })

  it('splits a comma-separated ids list into an $in filter', () => {
    const query = customerProfileListSchema.parse({ ids: `${PROFILE_ID},${CUSTOMER_ID}` })
    expect(buildCustomerProfileFilters(query)).toEqual({ id: { $in: [PROFILE_ID, CUSTOMER_ID] } })
  })

  it('prefers a single id over the ids list', () => {
    const query = customerProfileListSchema.parse({ id: PROFILE_ID, ids: `${CUSTOMER_ID}` })
    expect(buildCustomerProfileFilters(query)).toEqual({ id: PROFILE_ID })
  })

  it('searches the code columns only — the customer name is encrypted in another module', () => {
    const query = customerProfileListSchema.parse({ search: 'horeca' })
    expect(buildCustomerProfileFilters(query)).toEqual({
      $or: [
        { customerGroupCode: { $ilike: '%horeca%' } },
        { deliveryZoneCode: { $ilike: '%horeca%' } },
        { defaultOrderScenarioCode: { $ilike: '%horeca%' } },
      ],
    })
  })
})

describe('response row', () => {
  it('matches the schema the OpenAPI contract publishes', () => {
    const row = toCustomerProfileRow(
      profile({ negotiatedPrices: { [PRODUCT_ID]: '25.0000' } }),
    )
    expect(customerProfileRowSchema.safeParse(row).success).toBe(true)
  })

  // `CrudForm` derives its optimistic-lock header from `initialValues.updatedAt`, so a row without
  // it silently drops concurrency protection on both update and delete.
  it('carries updatedAt as an ISO string for the optimistic-lock header', () => {
    expect(toCustomerProfileRow(profile()).updatedAt).toBe('2026-02-01T00:00:00.000Z')
  })

  it('always returns an object for the map, never null', () => {
    const row = toCustomerProfileRow(profile())
    expect(row.negotiatedPrices).toEqual({})
    expect(row.negotiatedPriceCount).toBe(0)
  })

  // Mirrors `negotiatedExpired` in `lib/params.ts`: this is what the engine would do today.
  it.each([
    ['no prices at all', null, null, false],
    ['prices with no expiry', { [PRODUCT_ID]: '25.00' }, null, true],
    ['prices expiring in the future', { [PRODUCT_ID]: '25.00' }, '2999-01-01T00:00:00.000Z', true],
    ['prices already expired', { [PRODUCT_ID]: '25.00' }, '2020-01-01T00:00:00.000Z', false],
    ['an expiry but an empty map', {}, '2999-01-01T00:00:00.000Z', false],
  ])('reports %s as inForce=%s', (_label, prices, expiresAt, expected) => {
    const row = toCustomerProfileRow(
      profile({
        negotiatedPrices: prices as Record<string, string> | null,
        negotiatedPriceExpiresAt: expiresAt ? new Date(expiresAt as string) : null,
      }),
    )
    expect(row.negotiatedPricesInForce).toBe(expected)
  })
})

describe('list response shape', () => {
  it('pages and sorts the mapped rows the way DataTable expects', () => {
    const payload: PricingListPayload = {
      items: [
        profile({ id: PROFILE_ID, updatedAt: new Date('2026-01-01T00:00:00.000Z') }),
        profile({ id: CUSTOMER_ID, updatedAt: new Date('2026-03-01T00:00:00.000Z') }),
      ],
    }
    finalizePricingList<PricingCustomerProfile, ReturnType<typeof toCustomerProfileRow>>(
      payload,
      customerProfileListSchema.parse({ pageSize: '1' }),
      { mapItem: toCustomerProfileRow, defaultSort: { field: 'updatedAt', dir: 'desc' } },
    )
    expect(payload.total).toBe(2)
    expect(payload.page).toBe(1)
    expect(payload.pageSize).toBe(1)
    expect(payload.totalPages).toBe(2)
    expect(payload.items).toHaveLength(1)
    expect((payload.items?.[0] as { id: string }).id).toBe(CUSTOMER_ID)
  })
})

// The engine reads a line as `prices[productId]` and treats the stored instant as the moment the
// book is already dead; both rules are mirrored here so a change to `lib/params.ts` breaks a test
// rather than a customer's contract.
function engineNegotiatedUnitPrice(
  entity: PricingCustomerProfile,
  productId: string,
  quotedAt: Date,
): string | null {
  const expiresAt = entity.negotiatedPriceExpiresAt ?? null
  if (expiresAt !== null && expiresAt.getTime() <= quotedAt.getTime()) return null
  const prices = entity.negotiatedPrices ?? {}
  return prices[productId] ?? null
}

describe('partial update', () => {
  const stored = () =>
    profile({
      negotiatedPrices: { [PRODUCT_ID]: '25.0000' },
      negotiatedPriceExpiresAt: new Date('2026-12-31T23:59:59.999Z'),
    })

  // The whole point: a body that does not carry a field must leave that field alone. Assigning all
  // five columns unconditionally meant `{ id, customerId }` wiped a negotiated contract and
  // answered `200 {"ok":true}`.
  it('leaves every unsent field untouched — a bare {id, customerId} destroys nothing', () => {
    const entity = stored()
    applyCustomerProfileUpdate(
      entity,
      customerProfileUpdateSchema.parse({ id: PROFILE_ID, customerId: CUSTOMER_ID }),
    )
    expect(entity.negotiatedPrices).toEqual({ [PRODUCT_ID]: '25.0000' })
    expect(entity.negotiatedPriceExpiresAt).toEqual(new Date('2026-12-31T23:59:59.999Z'))
    expect(entity.customerGroupCode).toBe('horeca_premium')
    expect(entity.deliveryZoneCode).toBe('warszawa_poludnie')
    expect(entity.defaultOrderScenarioCode).toBe('ideal_file')
  })

  // The other direction has to keep working, or there is no way to end a negotiated deal.
  it('clears exactly the fields sent as null', () => {
    const entity = stored()
    applyCustomerProfileUpdate(
      entity,
      customerProfileUpdateSchema.parse({
        id: PROFILE_ID,
        customerId: CUSTOMER_ID,
        negotiatedPrices: null,
        negotiatedPriceExpiresAt: null,
      }),
    )
    expect(entity.negotiatedPrices).toBeNull()
    expect(entity.negotiatedPriceExpiresAt).toBeNull()
    expect(entity.customerGroupCode).toBe('horeca_premium')
  })

  it('clears a routing code sent as null and keeps the rest', () => {
    const entity = stored()
    applyCustomerProfileUpdate(
      entity,
      customerProfileUpdateSchema.parse({
        id: PROFILE_ID,
        customerId: CUSTOMER_ID,
        customerGroupCode: null,
      }),
    )
    expect(entity.customerGroupCode).toBeNull()
    expect(entity.deliveryZoneCode).toBe('warszawa_poludnie')
    expect(entity.negotiatedPrices).toEqual({ [PRODUCT_ID]: '25.0000' })
  })

  it('writes the fields the body does carry', () => {
    const entity = stored()
    applyCustomerProfileUpdate(
      entity,
      customerProfileUpdateSchema.parse({
        id: PROFILE_ID,
        customerId: CUSTOMER_ID,
        customerGroupCode: '  kawiarnia  ',
        negotiatedPrices: { [OTHER_PRODUCT_ID]: '30.00' },
      }),
    )
    expect(entity.customerGroupCode).toBe('kawiarnia')
    expect(entity.negotiatedPrices).toEqual({ [OTHER_PRODUCT_ID]: '30.00' })
    expect(entity.negotiatedPriceExpiresAt).toEqual(new Date('2026-12-31T23:59:59.999Z'))
  })

  // An empty map means "no negotiated prices" and has to reach the column as `null`, the same
  // canonical state a create writes.
  it('stores an explicitly emptied map as null', () => {
    const entity = stored()
    applyCustomerProfileUpdate(
      entity,
      customerProfileUpdateSchema.parse({
        id: PROFILE_ID,
        customerId: CUSTOMER_ID,
        negotiatedPrices: {},
      }),
    )
    expect(entity.negotiatedPrices).toBeNull()
  })

  // Every settable column, one at a time: sending it as null clears it and touches nothing else.
  it.each(CUSTOMER_PROFILE_PATCH_FIELDS)('clears %s alone when it is the only field sent', (field) => {
    const entity = stored()
    const before = { ...entity }
    applyCustomerProfileUpdate(
      entity,
      customerProfileUpdateSchema.parse({ id: PROFILE_ID, customerId: CUSTOMER_ID, [field]: null }),
    )
    for (const other of CUSTOMER_PROFILE_PATCH_FIELDS) {
      if (other === field) expect(entity[other]).toBeNull()
      else expect(entity[other]).toEqual(before[other])
    }
  })

  // `customerId` is the row's identity under the unique index; an edit never repoints it.
  it('never repoints the profile at another customer', () => {
    const entity = stored()
    applyCustomerProfileUpdate(
      entity,
      customerProfileUpdateSchema.parse({ id: PROFILE_ID, customerId: OTHER_PRODUCT_ID }),
    )
    expect(entity.customerId).toBe(CUSTOMER_ID)
  })
})

describe('negotiated price key canonicalisation', () => {
  // A uuid carrying hex LETTERS — `33333333-...` is case-invariant and would prove nothing.
  const LETTERED_PRODUCT_ID = 'aabbccdd-1122-4ccc-8ddd-eeffaabbccdd'
  const UPPERCASE_PRODUCT_ID = LETTERED_PRODUCT_ID.toUpperCase()

  it('lowercases a key so the engine can hit it — Postgres renders uuids in lowercase', () => {
    const parsed = customerProfileCreateSchema.parse({
      customerId: CUSTOMER_ID,
      negotiatedPrices: { [UPPERCASE_PRODUCT_ID]: '25.0000' },
    })
    expect(parsed.negotiatedPrices).toEqual({ [LETTERED_PRODUCT_ID]: '25.0000' })
  })

  it('trims a pasted key', () => {
    const parsed = customerProfileCreateSchema.parse({
      customerId: CUSTOMER_ID,
      negotiatedPrices: { [` ${LETTERED_PRODUCT_ID} `]: '25.0000' },
    })
    expect(parsed.negotiatedPrices).toEqual({ [LETTERED_PRODUCT_ID]: '25.0000' })
  })

  // Without canonicalisation the price sat in the jsonb column and the engine missed on every line.
  it('makes an uppercase key reach the engine lookup', () => {
    const parsed = customerProfileCreateSchema.parse({
      customerId: CUSTOMER_ID,
      negotiatedPrices: { [UPPERCASE_PRODUCT_ID]: '25.0000' },
    })
    const entity = profile({
      negotiatedPrices: toNegotiatedPricesOrNull(parsed.negotiatedPrices),
    })
    const quotedAt = new Date('2026-06-01T00:00:00.000Z')
    expect(engineNegotiatedUnitPrice(entity, LETTERED_PRODUCT_ID, quotedAt)).toBe('25.0000')
  })

  it('refuses two spellings of one product instead of dropping one price', () => {
    const result = customerProfileCreateSchema.safeParse({
      customerId: CUSTOMER_ID,
      negotiatedPrices: { [LETTERED_PRODUCT_ID]: '25.0000', [UPPERCASE_PRODUCT_ID]: '30.0000' },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0].message).toBe(
      'pricing_engine.params.errors.negotiatedPriceDuplicate',
    )
  })

  it('exposes the canonical form the engine matches on', () => {
    expect(canonicalNegotiatedPriceKey(` ${UPPERCASE_PRODUCT_ID} `)).toBe(LETTERED_PRODUCT_ID)
  })
})

describe('negotiated price error reporting', () => {
  // `normalizeCrudServerError` reads `issue.message` and keys the field error by the first string
  // path segment. A record-key rejection put zod's English "Invalid key in record" there and the
  // i18n key one level down, where nothing looks — the rep read untranslatable English.
  it('sends an i18n key as the message and names the offending product in the path', () => {
    const result = customerProfileCreateSchema.safeParse({
      customerId: CUSTOMER_ID,
      negotiatedPrices: { 'chleb-krojony': '25.00' },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    const issue = result.error.issues[0]
    expect(issue.message).toBe('pricing_engine.params.errors.negotiatedPriceProductRequired')
    expect(issue.path).toEqual(['negotiatedPrices', 'chleb-krojony'])
  })

  it('keeps the field error routed to the negotiated prices editor', () => {
    const result = customerProfileCreateSchema.safeParse({
      customerId: CUSTOMER_ID,
      negotiatedPrices: { [PRODUCT_ID]: 'nie wiem' },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0].path[0]).toBe('negotiatedPrices')
    expect(result.error.issues[0].message).toBe(
      'pricing_engine.params.errors.negotiatedPriceInvalid',
    )
  })
})

describe('negotiated price map limits', () => {
  // The map is re-read from jsonb on every quote, so its size is a per-quote cost.
  it('accepts a book the size of a large catalogue and refuses one past the cap', () => {
    const build = (count: number) => {
      const prices: Record<string, string> = {}
      for (let index = 0; index < count; index += 1) {
        prices[`33333333-3333-4333-8333-${String(index).padStart(12, '0')}`] = '25.00'
      }
      return { customerId: CUSTOMER_ID, negotiatedPrices: prices }
    }
    expect(customerProfileCreateSchema.safeParse(build(500)).success).toBe(true)
    const tooMany = customerProfileCreateSchema.safeParse(build(501))
    expect(tooMany.success).toBe(false)
    if (tooMany.success) return
    expect(tooMany.error.issues[0].message).toBe(
      'pricing_engine.params.errors.negotiatedPricesTooMany',
    )
  })

  // `numeric(18, 4)` — every money column in the module — tops out at 19 characters.
  it('accepts the widest storable amount and refuses a longer one', () => {
    const accepted = customerProfileCreateSchema.safeParse({
      customerId: CUSTOMER_ID,
      negotiatedPrices: { [PRODUCT_ID]: '99999999999999.9999' },
    })
    expect(accepted.success).toBe(true)
    const rejected = customerProfileCreateSchema.safeParse({
      customerId: CUSTOMER_ID,
      negotiatedPrices: { [PRODUCT_ID]: '999999999999999.9999' },
    })
    expect(rejected.success).toBe(false)
    if (rejected.success) return
    expect(rejected.error.issues[0].message).toBe(
      'pricing_engine.params.errors.negotiatedPriceTooLong',
    )
    expect(rejected.error.issues[0].path).toEqual(['negotiatedPrices', PRODUCT_ID])
  })
})

describe('negotiated price expiry semantics', () => {
  // "Expires on 31 December" has to leave the 31st priced as agreed.
  it('reads a date-only expiry as the END of that day', () => {
    const parsed = customerProfileCreateSchema.parse({
      customerId: CUSTOMER_ID,
      negotiatedPriceExpiresAt: '2026-12-31',
    })
    expect(parsed.negotiatedPriceExpiresAt).toEqual(new Date('2026-12-31T23:59:59.999Z'))
  })

  it.each([
    ['the morning of the last day', '2026-12-31T08:00:00.000Z', '25.0000'],
    ['the last second of the last day', '2026-12-31T23:59:59.000Z', '25.0000'],
    ['the day after', '2027-01-01T00:00:00.000Z', null],
  ])('prices %s as %s', (_label, quotedAt, expected) => {
    const parsed = customerProfileCreateSchema.parse({
      customerId: CUSTOMER_ID,
      negotiatedPrices: { [PRODUCT_ID]: '25.0000' },
      negotiatedPriceExpiresAt: '2026-12-31',
    })
    const entity = profile({
      negotiatedPrices: toNegotiatedPricesOrNull(parsed.negotiatedPrices),
      negotiatedPriceExpiresAt: parsed.negotiatedPriceExpiresAt ?? null,
    })
    expect(engineNegotiatedUnitPrice(entity, PRODUCT_ID, new Date(quotedAt as string))).toBe(
      expected,
    )
  })

  // An integration that means midnight keeps meaning midnight.
  it('takes a full timestamp literally', () => {
    const parsed = customerProfileCreateSchema.parse({
      customerId: CUSTOMER_ID,
      negotiatedPriceExpiresAt: '2026-12-31T00:00:00.000Z',
    })
    expect(parsed.negotiatedPriceExpiresAt).toEqual(new Date('2026-12-31T00:00:00.000Z'))
  })

  // The tab's `date` input re-reads the stored instant with `isoToDateInput`, a plain 10-char slice.
  it('round-trips to the date the rep typed', () => {
    const parsed = customerProfileCreateSchema.parse({
      customerId: CUSTOMER_ID,
      negotiatedPriceExpiresAt: '2026-12-31',
    })
    expect(parsed.negotiatedPriceExpiresAt?.toISOString().slice(0, 10)).toBe('2026-12-31')
  })

  it('still refuses a value that is not a date', () => {
    expect(
      customerProfileCreateSchema.safeParse({
        customerId: CUSTOMER_ID,
        negotiatedPriceExpiresAt: 'kiedys',
      }).success,
    ).toBe(false)
  })
})

describe('published contract', () => {
  // `makeCrudRoute` answers 201 `{ id }`; the shared helper's default said 200 with the full row,
  // so a client generated from the contract would read fields off an object that has only `id`.
  it('documents the 201 the create path actually returns', () => {
    const responses = openApi.methods.POST?.responses ?? []
    expect(responses.map((response) => response.status)).toEqual([201, 409])
    expect(customerProfileCreatedSchema.safeParse({ id: PROFILE_ID }).success).toBe(true)
  })

  it('keeps the shared GET, PUT and DELETE documentation', () => {
    expect(openApi.methods.GET?.responses?.[0]?.status).toBe(200)
    expect(openApi.methods.PUT?.responses?.map((response) => response.status)).toEqual([200, 409])
    expect(openApi.methods.DELETE?.responses?.[0]?.status).toBe(200)
  })
})
