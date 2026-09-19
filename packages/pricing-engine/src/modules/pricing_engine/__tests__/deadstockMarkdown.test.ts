import { computeCarryingCost } from '../lib/deadstock/carryingCost'
import {
  computeDeadstockMarkdown,
  recoverableAtFloor,
  resolveEffectiveFloor,
  type DeadstockMarkdownArgs,
} from '../lib/deadstock/markdown'
import { defaultDeadstockPolicy } from '../lib/deadstock/policy'
import { money, toDecimal } from '../lib/decimal'
import type { WarehouseCostSnapshot } from '../lib/types'

const WAREHOUSE: WarehouseCostSnapshot = {
  basis: 'pallet_slot',
  costPerMonth: '95.0000',
  capitalCostAnnualRate: '9.0000',
  defaultTurnoverDays: 30,
}

// 0.6250 per unit per month: 0.005 of a slot at 95.00, plus 9% a year on a 20.00 purchase cost.
const CARRYING = computeCarryingCost({
  onHandQuantity: toDecimal('100'),
  unitCost: toDecimal('20'),
  occupancyShare: toDecimal('0.005'),
  warehouse: WAREHOUSE,
  monthsOnHand: toDecimal('6'),
})

function args(overrides: Partial<DeadstockMarkdownArgs> = {}): DeadstockMarkdownArgs {
  return {
    productClass: 'dead',
    suppression: null,
    unitCostNet: toDecimal('25'),
    purchaseUnitCost: toDecimal('20'),
    onHandQuantity: toDecimal('100'),
    carrying: CARRYING,
    policy: defaultDeadstockPolicy(),
    ...overrides,
  }
}

describe('computeDeadstockMarkdown — which classes earn a floor', () => {
  it('gives slow-moving stock no markdown, because it is still selling', () => {
    expect(computeDeadstockMarkdown(args({ productClass: 'slow' }))).toBeNull()
  })

  it('gives healthy stock no markdown', () => {
    expect(computeDeadstockMarkdown(args({ productClass: 'healthy' }))).toBeNull()
  })

  it('gives a suppressed row no markdown, so the suppressors are not cosmetic', () => {
    expect(computeDeadstockMarkdown(args({ suppression: 'seasonal' }))).toBeNull()
    expect(computeDeadstockMarkdown(args({ suppression: 'new_product' }))).toBeNull()
    expect(computeDeadstockMarkdown(args({ suppression: 'decision_dismissed' }))).toBeNull()
  })
})

describe('computeDeadstockMarkdown — the rungs', () => {
  it('holds a thin real margin over the cost to serve for a dying product', () => {
    const result = computeDeadstockMarkdown(args({ productClass: 'dying' }))!

    // 25.00 cost to serve at a 5% margin: 25 / (1 - 0.05) = 26.3158.
    expect(result.stage).toBe('dying')
    expect(money(result.floorUnitPrice)).toBe('26.3158')
    expect(money(result.belowCostPerUnit)).toBe('0.0000')
  })

  it('lets a dead product go below purchase cost by exactly the carry it saves', () => {
    const result = computeDeadstockMarkdown(args())!

    // Six months of carry at 0.6250 a unit is 3.75, so 20.00 - 3.75 = 16.25.
    expect(result.stage).toBe('dead')
    expect(money(result.forwardCarryPerUnit)).toBe('3.7500')
    expect(money(result.floorUnitPrice)).toBe('16.2500')
    expect(money(result.belowCostPerUnit)).toBe('3.7500')
    // The whole position stops burning 62.50 a month for six months.
    expect(money(result.carryingCostAvoided)).toBe('375.0000')
  })

  it('gives stock that never sold the longer horizon, and therefore the deeper floor', () => {
    const result = computeDeadstockMarkdown(args({ productClass: 'never_sold' }))!

    // Twelve months of carry: 7.50, so 20.00 - 7.50 = 12.50.
    expect(money(result.horizonMonths)).toBe('12.0000')
    expect(money(result.floorUnitPrice)).toBe('12.5000')
    expect(money(result.carryingCostAvoided)).toBe('750.0000')
  })

  it('clamps the floor at zero and says so, rather than proposing a negative price', () => {
    const heavyCarry = computeCarryingCost({
      onHandQuantity: toDecimal('100'),
      unitCost: toDecimal('20'),
      occupancyShare: toDecimal('0.5'),
      warehouse: WAREHOUSE,
      monthsOnHand: toDecimal('6'),
    })
    const result = computeDeadstockMarkdown(args({ carrying: heavyCarry }))!

    expect(money(result.floorUnitPrice)).toBe('0.0000')
    expect(result.warnings).toContain('pricing_engine.deadstock.warnings.floorClampedAtZero')
  })

  it('inherits the carrying cost confidence instead of claiming its own', () => {
    expect(computeDeadstockMarkdown(args())!.confidence).toBe('estimated')
  })
})

describe('recoverableAtFloor', () => {
  it('prices what clearing the whole position at its floor brings back', () => {
    const result = computeDeadstockMarkdown(args())

    expect(money(recoverableAtFloor(result, toDecimal('100')))).toBe('1625.0000')
    expect(money(recoverableAtFloor(null, toDecimal('100')))).toBe('0.0000')
  })
})

describe('resolveEffectiveFloor', () => {
  it('lets the deeper floor win rather than stacking two markdowns on one product', () => {
    const result = resolveEffectiveFloor(toDecimal('18'), toDecimal('16.25'))

    expect(money(result!.floor)).toBe('16.2500')
    expect(result!.source).toBe('deadstock')
  })

  it('names the shelf-life ladder when it is the deeper of the two', () => {
    const result = resolveEffectiveFloor(toDecimal('12'), toDecimal('16.25'))

    expect(money(result!.floor)).toBe('12.0000')
    expect(result!.source).toBe('shelf_life')
  })

  it('passes through whichever single ladder is open', () => {
    expect(resolveEffectiveFloor(null, toDecimal('16.25'))!.source).toBe('deadstock')
    expect(resolveEffectiveFloor(toDecimal('18'), null)!.source).toBe('shelf_life')
    expect(resolveEffectiveFloor(null, null)).toBeNull()
  })
})
