import {
  basketMargin,
  formatMoney,
  lineMargin,
  marginFromMarkup,
  markupFromMargin,
  minUnitPriceForMargin,
  profitNeutralUnitPrice,
} from '../lib/frontend/marginMath'

// The distributor's live number is a 66% markup on cost. Every case below is anchored to it so a
// regression shows up as the wrong business figure, not just a failed assertion.
const LIVE_MARKUP_PERCENT = '66'
const LIVE_COST = '100.0000'
const LIVE_PRICE = '166.0000'

describe('lineMargin', () => {
  const cases: Array<{
    name: string
    unitPriceNet: string
    unitCostNet: string
    quantity: string
    expected: ReturnType<typeof lineMargin>
  }> = [
    {
      name: 'the live 66% markup case',
      unitPriceNet: LIVE_PRICE,
      unitCostNet: LIVE_COST,
      quantity: '1',
      expected: {
        revenueNet: '166.0000',
        costNet: '100.0000',
        profitNet: '66.0000',
        marginPercent: '39.7590',
        markupPercent: '66.0000',
      },
    },
    {
      name: 'scales linearly with quantity and leaves the percentages untouched',
      unitPriceNet: LIVE_PRICE,
      unitCostNet: LIVE_COST,
      quantity: '12',
      expected: {
        revenueNet: '1992.0000',
        costNet: '1200.0000',
        profitNet: '792.0000',
        marginPercent: '39.7590',
        markupPercent: '66.0000',
      },
    },
    {
      name: 'a zero cost yields a 100% margin and no markup blow-up',
      unitPriceNet: '50',
      unitCostNet: '0',
      quantity: '3',
      expected: {
        revenueNet: '150.0000',
        costNet: '0.0000',
        profitNet: '150.0000',
        marginPercent: '100.0000',
        markupPercent: '0.0000',
      },
    },
    {
      name: 'a zero quantity collapses to zeros rather than NaN',
      unitPriceNet: LIVE_PRICE,
      unitCostNet: LIVE_COST,
      quantity: '0',
      expected: {
        revenueNet: '0.0000',
        costNet: '0.0000',
        profitNet: '0.0000',
        marginPercent: '0.0000',
        markupPercent: '0.0000',
      },
    },
    {
      name: 'a loss-making line reports negative profit and margin',
      unitPriceNet: '80',
      unitCostNet: '100',
      quantity: '1',
      expected: {
        revenueNet: '80.0000',
        costNet: '100.0000',
        profitNet: '-20.0000',
        marginPercent: '-25.0000',
        markupPercent: '-20.0000',
      },
    },
    {
      name: 'garbage input degrades to zero instead of NaN',
      unitPriceNet: 'not-a-number',
      unitCostNet: '',
      quantity: '2',
      expected: {
        revenueNet: '0.0000',
        costNet: '0.0000',
        profitNet: '0.0000',
        marginPercent: '0.0000',
        markupPercent: '0.0000',
      },
    },
  ]

  it.each(cases)('$name', ({ unitPriceNet, unitCostNet, quantity, expected }) => {
    expect(lineMargin(unitPriceNet, unitCostNet, quantity)).toEqual(expected)
  })

  it('never emits NaN or Infinity for any of the degenerate cases', () => {
    const degenerate = [
      lineMargin('0', '0', '0'),
      lineMargin('0', '100', '5'),
      lineMargin('100', '0', '0'),
    ]
    for (const result of degenerate) {
      for (const value of Object.values(result)) {
        expect(value).toMatch(/^-?\d+\.\d{4}$/)
      }
    }
  })
})

describe('basketMargin', () => {
  it('sums revenue and cost across lines before deriving the percentages', () => {
    expect(
      basketMargin([
        { unitPriceNet: LIVE_PRICE, unitCostNet: LIVE_COST, quantity: '2' },
        { unitPriceNet: '250', unitCostNet: '150', quantity: '3' },
      ]),
    ).toEqual({
      revenueNet: '1082.0000',
      costNet: '650.0000',
      profitNet: '432.0000',
      marginPercent: '39.9261',
      markupPercent: '66.4615',
    })
  })

  it('treats an empty basket as zero rather than as a division by zero', () => {
    expect(basketMargin([])).toEqual({
      revenueNet: '0.0000',
      costNet: '0.0000',
      profitNet: '0.0000',
      marginPercent: '0.0000',
      markupPercent: '0.0000',
    })
  })

  it('agrees with lineMargin when the basket holds a single line', () => {
    const line = { unitPriceNet: LIVE_PRICE, unitCostNet: LIVE_COST, quantity: '7' }
    expect(basketMargin([line])).toEqual(lineMargin(line.unitPriceNet, line.unitCostNet, line.quantity))
  })
})

describe('minUnitPriceForMargin', () => {
  const cases: Array<{ cost: string; margin: string; expected: string | null }> = [
    { cost: '100', margin: '8', expected: '108.6957' },
    { cost: '100', margin: '0', expected: '100.0000' },
    { cost: '100', margin: '50', expected: '200.0000' },
    { cost: '0', margin: '30', expected: '0.0000' },
    { cost: '100', margin: '100', expected: null },
    { cost: '100', margin: '150', expected: null },
  ]

  it.each(cases)('cost $cost at min margin $margin%', ({ cost, margin, expected }) => {
    expect(minUnitPriceForMargin(cost, margin)).toBe(expected)
  })

  it('produces a price whose own margin equals the requested floor', () => {
    const minPrice = minUnitPriceForMargin('100', '8')
    expect(minPrice).not.toBeNull()
    expect(Number(lineMargin(minPrice as string, '100', '1').marginPercent)).toBeCloseTo(8, 3)
  })
})

describe('profitNeutralUnitPrice', () => {
  it('hands the entire cost saving to the customer and leaves absolute profit unchanged', () => {
    const newPrice = profitNeutralUnitPrice('90', LIVE_PRICE, LIVE_COST)
    expect(newPrice).toBe('156.0000')

    const before = lineMargin(LIVE_PRICE, LIVE_COST, '1')
    const after = lineMargin(newPrice, '90', '1')
    expect(after.profitNet).toBe(before.profitNet)
    expect(Number(after.marginPercent)).toBeGreaterThan(Number(before.marginPercent))
  })

  it('gives away less than re-applying the old markup would', () => {
    const naiveFullMarkup = 90 * 1.66
    expect(Number(profitNeutralUnitPrice('90', LIVE_PRICE, LIVE_COST))).toBeGreaterThan(naiveFullMarkup)
  })

  it('raises the price when the cost rises', () => {
    expect(profitNeutralUnitPrice('110', LIVE_PRICE, LIVE_COST)).toBe('176.0000')
  })

  it('stays finite when every input is zero', () => {
    expect(profitNeutralUnitPrice('0', '0', '0')).toBe('0.0000')
  })
})

describe('marginFromMarkup / markupFromMargin', () => {
  const cases: Array<{ markup: string; margin: string }> = [
    { markup: '0', margin: '0.0000' },
    { markup: LIVE_MARKUP_PERCENT, margin: '39.7590' },
    { markup: '100', margin: '50.0000' },
    { markup: '900', margin: '90.0000' },
  ]

  it.each(cases)('markup $markup% is margin $margin%', ({ markup, margin }) => {
    expect(marginFromMarkup(markup)).toBe(margin)
  })

  it('inverts a 40% margin into a 66.6667% markup', () => {
    expect(markupFromMargin('40')).toBe('66.6667')
  })

  it('refuses to blow up at or above a 100% margin, where no finite markup exists', () => {
    expect(markupFromMargin('100')).toBe('0.0000')
    expect(markupFromMargin('140')).toBe('0.0000')
  })

  // Exact string equality is not available here: each direction quantizes to 4 dp, so the
  // round trip loses roughly 1e-4 of a percentage point. Anything worse means a wrong formula.
  it.each(['5', '20', '40', LIVE_MARKUP_PERCENT, '150'])(
    'round-trips a %s%% markup back to itself within a rounding step',
    (markup) => {
      expect(Number(markupFromMargin(marginFromMarkup(markup)))).toBeCloseTo(Number(markup), 3)
    },
  )

  it('agrees with lineMargin on the same pair of figures', () => {
    const derived = lineMargin(LIVE_PRICE, LIVE_COST, '1')
    expect(marginFromMarkup(derived.markupPercent)).toBe(derived.marginPercent)
  })
})

describe('formatMoney', () => {
  const cases: Array<{ value: string; currencyCode: string; expected: string }> = [
    { value: '1234.56', currencyCode: 'PLN', expected: '1 234,5600 PLN' },
    { value: '0', currencyCode: 'PLN', expected: '0,0000 PLN' },
    { value: '999.9999', currencyCode: 'EUR', expected: '999,9999 EUR' },
    { value: '1234567.891', currencyCode: 'PLN', expected: '1 234 567,8910 PLN' },
    { value: '-1234.5', currencyCode: 'PLN', expected: '-1 234,5000 PLN' },
    { value: 'not-a-number', currencyCode: 'PLN', expected: '0,0000 PLN' },
    { value: '12.34', currencyCode: '', expected: '12,3400' },
  ]

  it.each(cases)('formats $value as $expected', ({ value, currencyCode, expected }) => {
    expect(formatMoney(value, currencyCode)).toBe(expected)
  })
})
