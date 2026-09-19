import { loadAuthorisedDeadstockFloors } from '../lib/deadstock/authorisedFloor'
import { isUndefinedTableError } from '../lib/deadstock/missingTable'

const SCOPE = {
  tenantId: '33333333-3333-4333-8333-333333333333',
  organizationId: '44444444-4444-4444-8444-444444444444',
}
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111'

function undefinedTableError(): Error & { code: string } {
  return Object.assign(new Error('relation "pricing_deadstock_decisions" does not exist'), { code: '42P01' })
}

/** MikroORM wraps the driver error, so the SQLSTATE is one or more frames down. */
function wrapped(depth: number): Error {
  let current: Error = undefinedTableError()
  for (let index = 0; index < depth; index += 1) {
    current = Object.assign(new Error('insert into ... - relation does not exist'), { previous: current })
  }
  return current
}

function throwingEm(error: unknown) {
  return {
    find: async () => {
      throw error
    },
  } as never
}

describe('isUndefinedTableError', () => {
  it('matches on the SQLSTATE code, not on the message text', () => {
    expect(isUndefinedTableError(undefinedTableError())).toBe(true)
    // The same sentence with no code: a localised server would produce a different sentence, so
    // matching text would be a bug waiting for somebody else's database.
    expect(isUndefinedTableError(new Error('relation "x" does not exist'))).toBe(false)
  })

  it('finds the code through the wrapper chain the ORM adds', () => {
    expect(isUndefinedTableError(wrapped(1))).toBe(true)
    expect(isUndefinedTableError(wrapped(3))).toBe(true)
  })

  it('does not mistake another database error for a missing table', () => {
    expect(isUndefinedTableError(Object.assign(new Error('deadlock'), { code: '40P01' }))).toBe(false)
    expect(isUndefinedTableError(null)).toBe(false)
    expect(isUndefinedTableError('42P01')).toBe(false)
  })
})

describe('loadAuthorisedDeadstockFloors when the table has not been migrated yet', () => {
  // The regression this exists for: `loadPricingInputs` calls this on EVERY quote, and before the
  // tolerance a missing table took down /api/pricing/quote, the margin calculator and the advisor —
  // the whole module — measured as 500 with `relation ... does not exist`. "Code deployed, migration
  // not applied" is a normal state of this repo, not an incident.
  it('reads the absence of the table as the absence of authorisations', async () => {
    const result = await loadAuthorisedDeadstockFloors(throwingEm(undefinedTableError()), SCOPE, [PRODUCT_ID], new Date())

    expect(result.byProductId.size).toBe(0)
  })

  it('tolerates it through the ORM wrapper too', async () => {
    const result = await loadAuthorisedDeadstockFloors(throwingEm(wrapped(2)), SCOPE, [PRODUCT_ID], new Date())

    expect(result.byProductId.size).toBe(0)
  })

  it('still lets a real database failure through, instead of pricing on silence', async () => {
    const connectionLost = Object.assign(new Error('connection terminated'), { code: '08006' })

    await expect(
      loadAuthorisedDeadstockFloors(throwingEm(connectionLost), SCOPE, [PRODUCT_ID], new Date()),
    ).rejects.toThrow('connection terminated')
  })

  it('asks for nothing at all when the basket names no products', async () => {
    const result = await loadAuthorisedDeadstockFloors(
      throwingEm(new Error('this em must not be called')),
      SCOPE,
      [],
      new Date(),
    )

    expect(result.byProductId.size).toBe(0)
  })
})
