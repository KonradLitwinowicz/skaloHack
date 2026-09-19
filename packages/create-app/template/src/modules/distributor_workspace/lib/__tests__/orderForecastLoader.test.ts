import type { EntityManager } from '@mikro-orm/postgresql'
import { loadPredictionFeedback } from '../orderForecastLoader'

/**
 * The branch that only exists between shipping the code and applying its migration.
 *
 * Once `distributor_order_prediction_feedback` is created it is unreachable in that environment
 * forever, so the only way it will ever be exercised again is here, against a stubbed connection.
 * That matters because it guards a failure mode with no visible symptom: a forecast computed
 * without the operator's notes looks exactly like a forecast with no notes recorded, and a product
 * the operator hid comes back with nothing to say it was ever hidden.
 */

const SCOPE = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
}
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333'

function emThatThrows(error: unknown): EntityManager {
  return {
    getConnection: () => ({
      execute: async () => {
        throw error
      },
    }),
  } as unknown as EntityManager
}

function emThatReturns(rows: unknown[]): EntityManager {
  return {
    getConnection: () => ({
      execute: async () => rows,
    }),
  } as unknown as EntityManager
}

/** The shape MikroORM produces: the driver error carrying the SQLSTATE sits on the cause. */
function wrappedDriverError(code: string, message: string): Error {
  const driverError = Object.assign(new Error(message), { code })
  return Object.assign(new Error('An error occurred while executing the query'), { cause: driverError })
}

describe('loadPredictionFeedback', () => {
  it('reads the notes back when the table is there', async () => {
    const em = emThatReturns([
      {
        product_id: 'p1',
        product_variant_id: 'v1',
        product_name: 'Towels',
        kind: 'dismissed',
        valid_until: null,
      },
    ])

    const notes = await loadPredictionFeedback(em, SCOPE, CUSTOMER_ID)

    expect(notes).toEqual([
      {
        productId: 'p1',
        productVariantId: 'v1',
        productName: 'Towels',
        kind: 'dismissed',
        validUntil: null,
      },
    ])
  })

  it('treats a missing table as "no notes recorded yet"', async () => {
    const em = emThatThrows(
      wrappedDriverError('42P01', 'relation "distributor_order_prediction_feedback" does not exist'),
    )

    await expect(loadPredictionFeedback(em, SCOPE, CUSTOMER_ID)).resolves.toEqual([])
  })

  it('finds the SQLSTATE however deeply the driver error is wrapped', async () => {
    const inner = Object.assign(new Error('undefined table'), { code: '42P01' })
    const middle = Object.assign(new Error('query failed'), { previous: inner })
    const outer = Object.assign(new Error('driver error'), { cause: middle })

    await expect(loadPredictionFeedback(emThatThrows(outer), SCOPE, CUSTOMER_ID)).resolves.toEqual([])
  })

  /**
   * The case the whole narrowing exists for. A blanket catch answers a dropped connection with an
   * empty list, and the forecast then silently ignores every note the operator ever left.
   */
  it('lets a dropped connection through instead of answering with an empty list', async () => {
    const error = wrappedDriverError('08006', 'connection terminated unexpectedly')

    await expect(loadPredictionFeedback(emThatThrows(error), SCOPE, CUSTOMER_ID)).rejects.toThrow(
      'An error occurred while executing the query',
    )
  })

  /**
   * The case that proves the match is on the code and not on the text: the same sentence a missing
   * table produces, with no SQLSTATE anywhere, must NOT be swallowed. Without this, matching on
   * `relation "…" does not exist` would pass every other test in this file — and then stop matching
   * the day the database server speaks a different language.
   */
  it('does not swallow the missing-table wording when no SQLSTATE says so', async () => {
    const error = new Error('relation "distributor_order_prediction_feedback" does not exist')

    await expect(loadPredictionFeedback(emThatThrows(error), SCOPE, CUSTOMER_ID)).rejects.toThrow(
      'does not exist',
    )
  })

  it('lets an unrelated failure through', async () => {
    await expect(
      loadPredictionFeedback(emThatThrows(new TypeError('em is not a function')), SCOPE, CUSTOMER_ID),
    ).rejects.toThrow(TypeError)
  })
})
