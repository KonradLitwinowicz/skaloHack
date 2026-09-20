import { computeCarryingCost, forwardCarry, forwardCarryPerUnit, monthsFromDays } from '../lib/deadstock/carryingCost'
import { money, toDecimal, ZERO } from '../lib/decimal'
import type { WarehouseCostSnapshot } from '../lib/types'

// The single row seeded in `pricing_warehouse_costs`: a pallet slot at 95.00 a month with capital
// charged at 9% a year. Both are assumptions entered by the operator, which is why nothing computed
// from them is ever reported as measured.
const WAREHOUSE: WarehouseCostSnapshot = {
  basis: 'pallet_slot',
  costPerMonth: '95.0000',
  capitalCostAnnualRate: '9.0000',
  defaultTurnoverDays: 30,
}

function args(overrides: Partial<Parameters<typeof computeCarryingCost>[0]> = {}) {
  return {
    onHandQuantity: toDecimal('100'),
    unitCost: toDecimal('20'),
    occupancyShare: toDecimal('0.005'),
    warehouse: WAREHOUSE,
    monthsOnHand: toDecimal('6'),
    ...overrides,
  }
}

describe('computeCarryingCost', () => {
  it('charges rented space and frozen capital, per unit and per position', () => {
    const result = computeCarryingCost(args())

    // space:   0.005 of a slot x 95.00      = 0.4750 / unit / month
    // capital: 20.00 x 9% / 12              = 0.1500 / unit / month
    expect(money(result.spacePerUnitPerMonth)).toBe('0.4750')
    expect(money(result.capitalPerUnitPerMonth)).toBe('0.1500')
    expect(money(result.perUnitPerMonth)).toBe('0.6250')
    // 0.6250 x 100 units = 62.50 a month, and six months of it already spent.
    expect(money(result.positionPerMonth)).toBe('62.5000')
    expect(money(result.carriedToDate)).toBe('375.0000')
    expect(money(result.tiedCapital)).toBe('2000.0000')
  })

  it('never claims to be measured, because both rates are assumptions', () => {
    expect(computeCarryingCost(args()).confidence).toBe('estimated')
  })

  it('still charges capital when the occupancy is unknown, and says the total is short', () => {
    const result = computeCarryingCost(args({ occupancyShare: ZERO }))

    expect(money(result.spacePerUnitPerMonth)).toBe('0.0000')
    expect(money(result.capitalPerUnitPerMonth)).toBe('0.1500')
    expect(result.confidence).toBe('default')
    expect(result.warnings).toContain('pricing_engine.deadstock.warnings.occupancyUnknown')
  })

  it('reports nothing carried to date when the stock age is unknown, rather than guessing zero months', () => {
    const result = computeCarryingCost(args({ monthsOnHand: null }))

    expect(money(result.carriedToDate)).toBe('0.0000')
    expect(money(result.positionPerMonth)).toBe('62.5000')
    expect(result.warnings).toContain('pricing_engine.deadstock.warnings.stockAgeUnknown')
  })

  it('falls back to tied capital alone when no warehouse cost row exists', () => {
    const result = computeCarryingCost(args({ warehouse: null }))

    expect(money(result.perUnitPerMonth)).toBe('0.0000')
    expect(money(result.tiedCapital)).toBe('2000.0000')
    expect(result.confidence).toBe('default')
    expect(result.warnings).toContain('pricing_engine.deadstock.warnings.warehouseCostMissing')
  })
})

describe('forward carry', () => {
  it('prices the cost of doing nothing for a given number of months', () => {
    const carrying = computeCarryingCost(args())

    expect(money(forwardCarry(carrying, toDecimal('6')))).toBe('375.0000')
    expect(money(forwardCarryPerUnit(carrying, toDecimal('6')))).toBe('3.7500')
    expect(money(forwardCarryPerUnit(carrying, toDecimal('12')))).toBe('7.5000')
  })
})

describe('monthsFromDays', () => {
  it('converts on the same 30-day month the warehouse component uses', () => {
    expect(money(monthsFromDays(180)!)).toBe('6.0000')
    expect(money(monthsFromDays(45)!)).toBe('1.5000')
  })

  it('returns null rather than zero for an unknown age', () => {
    expect(monthsFromDays(null)).toBeNull()
    expect(monthsFromDays(-3)).toBeNull()
  })
})

describe('the three horizons', () => {
  // Derived from one rate, never measured separately, so a reader comparing the week against the
  // year can never be shown two figures that disagree.
  it('expresses one monthly rate as a week and a year', () => {
    const result = computeCarryingCost(args())

    // 62.50 a month on a 30-day month: 7/30 of it a week, twelve of it a year.
    expect(money(result.positionPerMonth)).toBe('62.5000')
    expect(money(result.positionPerWeek)).toBe('14.5833')
    expect(money(result.positionPerYear)).toBe('750.0000')
  })

  it('reports nothing over any horizon when no warehouse cost is configured', () => {
    const result = computeCarryingCost(args({ warehouse: null }))

    expect(money(result.positionPerWeek)).toBe('0.0000')
    expect(money(result.positionPerYear)).toBe('0.0000')
  })
})
