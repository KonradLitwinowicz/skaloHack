import { opsUnitFromQuote, resolveOfferUnitPrice } from '../lib/offerPrice'

describe('resolveOfferUnitPrice', () => {
  /**
   * The rule the operator asked for: discount only where a margin actually exists. Before this,
   * every line of the document came back with the same percentage cut — the arithmetic forced it,
   * because ops cost was allocated in proportion to price.
   */
  it('offers nothing on a line already at or below the target price', () => {
    expect(
      resolveOfferUnitPrice({
        theirUnitPrice: 10,
        engineOfferUnitPrice: 10,
        profitNeutralUnitPrice: 9,
      }),
    ).toBeNull()

    expect(
      resolveOfferUnitPrice({
        theirUnitPrice: 8,
        engineOfferUnitPrice: 10,
        profitNeutralUnitPrice: 7,
      }),
    ).toBeNull()
  })

  it('offers the profit-neutral price when the line has headroom', () => {
    expect(
      resolveOfferUnitPrice({
        theirUnitPrice: 20,
        engineOfferUnitPrice: 12,
        profitNeutralUnitPrice: 18,
      }),
    ).toBe(18)
  })

  // Keeping yesterday's zloty of profit is a floor on the discount, never a reason to go under
  // the margin the tenant configured.
  it('never goes below the engine target price', () => {
    expect(
      resolveOfferUnitPrice({
        theirUnitPrice: 20,
        engineOfferUnitPrice: 15,
        profitNeutralUnitPrice: 11,
      }),
    ).toBe(15)
  })

  it('has no answer when the engine could not price the line', () => {
    expect(
      resolveOfferUnitPrice({ theirUnitPrice: 20, engineOfferUnitPrice: null, profitNeutralUnitPrice: 18 }),
    ).toBeNull()
    expect(
      resolveOfferUnitPrice({ theirUnitPrice: 20, engineOfferUnitPrice: 12, profitNeutralUnitPrice: null }),
    ).toBeNull()
  })

  /**
   * The regression this whole change exists for: two products whose prices differ by an order of
   * magnitude must not come back with an identical percentage cut.
   */
  it('gives two different products two different discounts', () => {
    const cheap = resolveOfferUnitPrice({
      theirUnitPrice: 1.7,
      engineOfferUnitPrice: 1.1,
      profitNeutralUnitPrice: 1.6,
    })
    const dear = resolveOfferUnitPrice({
      theirUnitPrice: 83.64,
      engineOfferUnitPrice: 60,
      profitNeutralUnitPrice: 70,
    })

    const cheapCut = (1.7 - (cheap as number)) / 1.7
    const dearCut = (83.64 - (dear as number)) / 83.64
    expect(cheapCut).not.toBeCloseTo(dearCut, 3)
  })
})

describe('opsUnitFromQuote', () => {
  it('is the engine unit cost minus the goods', () => {
    expect(opsUnitFromQuote(56.37, 38.41)).toBeCloseTo(17.96)
  })

  it('never reports a negative effort', () => {
    expect(opsUnitFromQuote(10, 12)).toBe(0)
  })

  it('reports nothing for a line the engine did not price', () => {
    expect(opsUnitFromQuote(null, 38.41)).toBe(0)
    expect(opsUnitFromQuote(56.37, null)).toBe(0)
  })
})
