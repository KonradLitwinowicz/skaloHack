import { format, money, rate as formatRate, toDecimal } from '../lib/decimal'
import {
  basketProfit,
  discountHeadroomPercent,
  marginPercent,
  minPriceForMargin,
  passThroughUnitPrice,
  profitNeutralUnitPrice,
  unitProfit,
} from '../lib/advisor/margin'
import { minUnitPriceForMargin } from '../lib/frontend/marginMath'

const COST_BEFORE = toDecimal('100')
const PRICE_BEFORE = toDecimal('166')
const COST_AFTER = toDecimal('90')
const MARKUP = '66'

describe('advisor margin arithmetic', () => {
  it('reports the live 66% markup as a 39.7590% margin and a 66.00 unit profit', () => {
    expect(money(unitProfit(PRICE_BEFORE, COST_BEFORE))).toBe('66.0000')
    expect(formatRate(marginPercent(PRICE_BEFORE, COST_BEFORE))).toBe('39.7590')
  })

  it('prices a 100 -> 90 cost fall profit-neutrally at 156.00, holding profit and raising margin', () => {
    const profitNeutral = profitNeutralUnitPrice(COST_AFTER, PRICE_BEFORE, COST_BEFORE)
    expect(money(profitNeutral)).toBe('156.0000')
    expect(money(unitProfit(profitNeutral, COST_AFTER))).toBe('66.0000')
    expect(formatRate(marginPercent(profitNeutral, COST_AFTER))).toBe('42.3077')
  })

  it('loses 6.60 of profit when the saving is passed through at full markup instead', () => {
    const naive = passThroughUnitPrice(PRICE_BEFORE, COST_BEFORE, COST_AFTER, MARKUP, '1')
    expect(money(naive)).toBe('149.4000')
    expect(money(unitProfit(naive, COST_AFTER))).toBe('59.4000')
  })

  it('holds the price at phi = 0 and equals the profit-neutral price at phi = 1 / (1 + m)', () => {
    expect(money(passThroughUnitPrice(PRICE_BEFORE, COST_BEFORE, COST_AFTER, MARKUP, '0'))).toBe('166.0000')

    const profitNeutralFraction = format(toDecimal('1') * 10n ** 12n / toDecimal('1.66'), 12)
    expect(
      money(passThroughUnitPrice(PRICE_BEFORE, COST_BEFORE, COST_AFTER, MARKUP, profitNeutralFraction)),
    ).toBe(money(profitNeutralUnitPrice(COST_AFTER, PRICE_BEFORE, COST_BEFORE)))
  })

  it('agrees with the client-side minUnitPriceForMargin to four decimal places', () => {
    const cases: Array<[string, string]> = [
      ['100', '8'],
      ['27.1519', '8'],
      ['20', '39.759'],
      ['0', '8'],
      ['13.3333', '15'],
    ]
    for (const [unitCostNet, minMargin] of cases) {
      const server = minPriceForMargin(toDecimal(unitCostNet), minMargin)
      expect(server).not.toBeNull()
      expect(money(server as bigint)).toBe(minUnitPriceForMargin(unitCostNet, minMargin))
    }
  })

  it('has no finite floor at or above a 100% margin, on either side', () => {
    expect(minPriceForMargin(toDecimal('100'), '100')).toBeNull()
    expect(minUnitPriceForMargin('100', '100')).toBeNull()
    expect(minPriceForMargin(toDecimal('100'), '120')).toBeNull()
    expect(minUnitPriceForMargin('100', '120')).toBeNull()
  })

  it('measures discount headroom against the guardrail floor', () => {
    // At a 66% markup the 8% guardrail leaves 34.5207% of the price to give away.
    const headroom = discountHeadroomPercent(PRICE_BEFORE, COST_BEFORE, '8')
    expect(headroom).not.toBeNull()
    expect(formatRate(headroom as bigint)).toBe('34.5207')
  })

  it('sums basket profit as revenue minus cost times quantity', () => {
    expect(
      money(
        basketProfit([
          { totalPriceNet: '3984.0000', unitCostNet: '100.0000', quantity: '24' },
          { totalPriceNet: '166.0000', unitCostNet: '90.0000', quantity: '1' },
        ]),
      ),
    ).toBe('1660.0000')
  })
})
