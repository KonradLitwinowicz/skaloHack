import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import {
  actorFromContext,
  baseRow,
  buildIdFilter,
  buildSearchFilter,
  finalizePricingList,
  pricingListSchema,
  pricingRouteMetadata,
  readBodyId,
  scopeFromContext,
  toDecimalOrNull,
  toIso,
  toTextOrNull,
  versionRow,
  type PricingListPayload,
} from '../lib/crud/pricingCrudRoute'

function context(overrides: Partial<CrudCtx> = {}): CrudCtx {
  return {
    container: {} as CrudCtx['container'],
    auth: { sub: 'user-1', orgId: 'org-1', tenantId: 'tenant-1' } as CrudCtx['auth'],
    organizationScope: null,
    selectedOrganizationId: null,
    organizationIds: null,
    ...overrides,
  } as CrudCtx
}

describe('scopeFromContext', () => {
  it('prefers the explicitly selected organization over the session default', () => {
    expect(scopeFromContext(context({ selectedOrganizationId: 'org-2' }))).toEqual({
      organizationId: 'org-2',
      tenantId: 'tenant-1',
    })
  })

  it('falls back to the session organization', () => {
    expect(scopeFromContext(context())).toEqual({
      organizationId: 'org-1',
      tenantId: 'tenant-1',
    })
  })

  it('refuses to write an unscoped row when the tenant is missing', () => {
    const ctx = context({ auth: { sub: 'user-1', orgId: 'org-1' } as CrudCtx['auth'] })
    expect(() => scopeFromContext(ctx)).toThrow(CrudHttpError)
    try {
      scopeFromContext(ctx)
    } catch (error) {
      expect((error as CrudHttpError).status).toBe(400)
      expect(JSON.stringify((error as CrudHttpError).body)).toContain('[internal]')
    }
  })

  it('refuses to write an unscoped row when the organization is missing', () => {
    const ctx = context({ auth: { sub: 'user-1', tenantId: 'tenant-1' } as CrudCtx['auth'] })
    expect(() => scopeFromContext(ctx)).toThrow(CrudHttpError)
  })

  it('reads the acting user for the audit column, and tolerates its absence', () => {
    expect(actorFromContext(context())).toBe('user-1')
    expect(actorFromContext(context({ auth: null }))).toBeNull()
  })
})

describe('list query schema', () => {
  const schema = pricingListSchema({})

  it('defaults to the first page with a bounded page size', () => {
    const parsed = schema.parse({})
    expect(parsed.page).toBe(1)
    expect(parsed.pageSize).toBe(50)
  })

  it('coerces the query-string numbers', () => {
    const parsed = schema.parse({ page: '3', pageSize: '10' })
    expect(parsed.page).toBe(3)
    expect(parsed.pageSize).toBe(10)
  })

  it('caps the page size at 100 so a list cannot be used to dump a table', () => {
    expect(() => schema.parse({ pageSize: '500' })).toThrow()
  })

  it('splits a comma-separated ids parameter', () => {
    const parsed = schema.parse({
      ids: '11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222',
    })
    expect(parsed.ids).toHaveLength(2)
  })
})

describe('finalizePricingList', () => {
  type Row = { id: string; code: string; amount: string }
  const entities = [
    { id: '1', code: 'c', amount: '9' },
    { id: '2', code: 'a', amount: '10' },
    { id: '3', code: 'b', amount: '100' },
  ]

  function run(query: Partial<{ page: number; pageSize: number; sortField: string; sortDir: 'asc' | 'desc' }>) {
    const payload: PricingListPayload = { items: [...entities], total: entities.length }
    finalizePricingList<Row, Row>(
      payload,
      { page: 1, pageSize: 50, ...query },
      { mapItem: (entity) => entity, defaultSort: { field: 'code', dir: 'asc' } },
    )
    return payload
  }

  it('adds the pagination envelope DataTable needs', () => {
    const payload = run({})
    expect(payload).toMatchObject({ total: 3, page: 1, pageSize: 50, totalPages: 1 })
  })

  it('applies the default sort when the request asks for none', () => {
    expect((run({}).items as Row[]).map((row) => row.code)).toEqual(['a', 'b', 'c'])
  })

  it('sorts numeric strings by value, not lexically', () => {
    expect((run({ sortField: 'amount' }).items as Row[]).map((row) => row.amount)).toEqual([
      '9',
      '10',
      '100',
    ])
  })

  it('honours an explicit descending direction', () => {
    expect(
      (run({ sortField: 'code', sortDir: 'desc' }).items as Row[]).map((row) => row.code),
    ).toEqual(['c', 'b', 'a'])
  })

  it('pages the sorted rows', () => {
    const payload = run({ page: 2, pageSize: 2 })
    expect(payload.totalPages).toBe(2)
    expect((payload.items as Row[]).map((row) => row.code)).toEqual(['c'])
  })

  it('clamps a page past the end rather than returning nothing', () => {
    const payload = run({ page: 99, pageSize: 2 })
    expect(payload.page).toBe(2)
    expect(payload.items).toHaveLength(1)
  })

  it('survives an empty result', () => {
    const payload: PricingListPayload = { items: [], total: 0 }
    finalizePricingList<Row, Row>(
      payload,
      { page: 1, pageSize: 50 },
      { mapItem: (entity) => entity, defaultSort: { field: 'code', dir: 'asc' } },
    )
    expect(payload).toMatchObject({ items: [], total: 0, page: 1, totalPages: 1 })
  })
})

describe('row mapping', () => {
  const entity = {
    id: 'row-1',
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    isDemo: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-01T12:30:00.000Z'),
  }

  it('returns updatedAt as an ISO string, which CrudForm turns into the lock header', () => {
    expect(baseRow(entity).updatedAt).toBe('2026-02-01T12:30:00.000Z')
  })

  it('tolerates a missing timestamp', () => {
    expect(baseRow({ ...entity, updatedAt: null }).updatedAt).toBeNull()
    expect(toIso(undefined)).toBeNull()
    expect(toIso('not a date')).toBeNull()
  })

  it('marks the version that prices today, inclusive of validFrom and exclusive of validTo', () => {
    const now = new Date('2026-06-01T00:00:00.000Z')
    expect(
      versionRow({ ...entity, validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: null }, now)
        .isInForce,
    ).toBe(true)
    expect(
      versionRow(
        { ...entity, validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: now },
        now,
      ).isInForce,
    ).toBe(false)
    expect(
      versionRow({ ...entity, validFrom: new Date('2026-12-01T00:00:00.000Z'), validTo: null }, now)
        .isInForce,
    ).toBe(false)
  })

  it('normalizes blank text and decimals to null so a column keeps one empty representation', () => {
    expect(toTextOrNull('  ')).toBeNull()
    expect(toTextOrNull(' abc ')).toBe('abc')
    expect(toDecimalOrNull('')).toBeNull()
    expect(toDecimalOrNull(undefined)).toBeNull()
    expect(toDecimalOrNull(0)).toBe('0')
  })
})

describe('filter builders', () => {
  it('narrows by a single id, preferring it over an ids list', () => {
    const filters: Record<string, unknown> = {}
    buildIdFilter(filters, { id: 'one', ids: ['two'], page: 1, pageSize: 50 })
    expect(filters.id).toBe('one')
  })

  it('narrows by an ids list', () => {
    const filters: Record<string, unknown> = {}
    buildIdFilter(filters, { ids: ['a', 'b'], page: 1, pageSize: 50 })
    expect(filters.id).toEqual({ $in: ['a', 'b'] })
  })

  it('escapes SQL wildcards so a search for "50%" does not match everything', () => {
    const filters: Record<string, unknown> = {}
    buildSearchFilter(filters, '50%', ['code'])
    expect(filters.$or).toEqual([{ code: { $ilike: '%50\\%%' } }])
  })

  it('adds nothing when there is no search term', () => {
    const filters: Record<string, unknown> = {}
    buildSearchFilter(filters, undefined, ['code'])
    expect(filters).toEqual({})
  })
})

describe('route metadata', () => {
  it('pins the path and separates read from write features', () => {
    const metadata = pricingRouteMetadata('/pricing/margin-rules')
    expect(metadata.path).toBe('/pricing/margin-rules')
    expect(metadata.GET.requireFeatures).toEqual(['pricing.params.read'])
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      expect(metadata[method].requireFeatures).toEqual(['pricing.params.write'])
      expect(metadata[method].requireAuth).toBe(true)
    }
  })

  it('reads the update id from the body and refuses a non-string', () => {
    expect(readBodyId({ id: 'abc' })).toBe('abc')
    expect(readBodyId({ id: 42 })).toBe('')
    expect(readBodyId({})).toBe('')
  })
})
