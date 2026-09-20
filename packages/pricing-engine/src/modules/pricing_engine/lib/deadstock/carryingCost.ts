import { add, div, gt, mul, percentToFactor, toDecimal, ZERO } from '../decimal'
import type { Decimal } from '../decimal'
import type { PricingConfidence, WarehouseCostSnapshot } from '../types'

const MONTHS_PER_YEAR = toDecimal('12')
const DAYS_PER_MONTH = toDecimal('30')
const DAYS_PER_WEEK = toDecimal('7')

export type CarryingCostArgs = {
  onHandQuantity: Decimal
  /** Purchase cost per unit. Frozen capital is measured against what was paid, not what is asked. */
  unitCost: Decimal
  /** Share of one storage unit that one product unit occupies, from `resolveOccupancy`. */
  occupancyShare: Decimal
  warehouse: WarehouseCostSnapshot | null
  /** How long the stock has been on the shelf; null when no receipt date could be established. */
  monthsOnHand: Decimal | null
}

export type CarryingCost = {
  spacePerUnitPerMonth: Decimal
  capitalPerUnitPerMonth: Decimal
  perUnitPerMonth: Decimal
  positionPerMonth: Decimal
  /**
   * The same rate over the horizons people actually reason in.
   *
   * A monthly figure alone is the wrong unit for both ends of the decision. A warehouse manager
   * asking "can this wait until next week" needs the weekly number, and the argument that moves an
   * owner is the annual one: 2 702 PLN a month is an expense, 32 431 PLN a year is a decision.
   * Derived, never re-measured, so the three can never disagree.
   */
  positionPerWeek: Decimal
  positionPerYear: Decimal
  /** What this position has already cost since it arrived. Zero when the age is unknown. */
  carriedToDate: Decimal
  /** Purchase value of the stock on hand — the money asleep in the warehouse. */
  tiedCapital: Decimal
  confidence: PricingConfidence
  warnings: string[]
}

/**
 * What one position costs to keep, per month and to date.
 *
 * Same two terms as the `warehouse_cost` component — rented space plus frozen capital — and
 * deliberately the same arithmetic, because a distributor who sees one number in a quote and a
 * different number on this screen will trust neither. The difference is only the question: the
 * component asks what to charge a customer for storing goods until they sell, this asks what the
 * goods cost while they do not.
 *
 * Never reports better than `estimated`. The monthly rate is an assumption entered by the operator,
 * and the pallet envelope the occupancy share is measured against is a documented
 * `TODO(data-source)` — no module models racking. Both would have to become measurements before
 * this figure could claim to be one.
 */
export function computeCarryingCost(args: CarryingCostArgs): CarryingCost {
  const { onHandQuantity, unitCost, occupancyShare, warehouse, monthsOnHand } = args
  const warnings: string[] = []

  const tiedCapital = mul(onHandQuantity, unitCost)

  if (!warehouse) {
    warnings.push('pricing_engine.deadstock.warnings.warehouseCostMissing')
    return {
      spacePerUnitPerMonth: ZERO,
      capitalPerUnitPerMonth: ZERO,
      perUnitPerMonth: ZERO,
      positionPerMonth: ZERO,
      positionPerWeek: ZERO,
      positionPerYear: ZERO,
      carriedToDate: ZERO,
      tiedCapital,
      confidence: 'default',
      warnings,
    }
  }

  const spacePerUnitPerMonth = mul(occupancyShare, toDecimal(warehouse.costPerMonth))
  const capitalPerUnitPerMonth = div(
    mul(unitCost, percentToFactor(warehouse.capitalCostAnnualRate)),
    MONTHS_PER_YEAR,
  )
  const perUnitPerMonth = add(spacePerUnitPerMonth, capitalPerUnitPerMonth)
  const positionPerMonth = mul(perUnitPerMonth, onHandQuantity)

  if (!gt(occupancyShare, ZERO)) {
    // Capital still accrues, so the figure is not nothing — but the space half is missing and the
    // total understates the truth. Saying so is the difference between a low number and a wrong one.
    warnings.push('pricing_engine.deadstock.warnings.occupancyUnknown')
  }

  let carriedToDate = ZERO
  if (monthsOnHand === null) {
    warnings.push('pricing_engine.deadstock.warnings.stockAgeUnknown')
  } else {
    carriedToDate = mul(positionPerMonth, monthsOnHand)
  }

  const confidence: PricingConfidence = gt(occupancyShare, ZERO) ? 'estimated' : 'default'

  return {
    spacePerUnitPerMonth,
    capitalPerUnitPerMonth,
    perUnitPerMonth,
    positionPerMonth,
    positionPerWeek: div(mul(positionPerMonth, DAYS_PER_WEEK), DAYS_PER_MONTH),
    positionPerYear: mul(positionPerMonth, MONTHS_PER_YEAR),
    carriedToDate,
    tiedCapital,
    confidence,
    warnings,
  }
}

/** Carry this position will incur over `months` if nothing is done. The cost of doing nothing. */
export function forwardCarry(carrying: CarryingCost, months: Decimal): Decimal {
  return mul(carrying.positionPerMonth, months)
}

/** Per-unit carry over `months`, which is what a unit price has to be discounted against. */
export function forwardCarryPerUnit(carrying: CarryingCost, months: Decimal): Decimal {
  return mul(carrying.perUnitPerMonth, months)
}

export function monthsFromDays(days: number | null): Decimal | null {
  if (days === null || !Number.isFinite(days) || days < 0) return null
  return div(toDecimal(String(Math.floor(days))), DAYS_PER_MONTH)
}
