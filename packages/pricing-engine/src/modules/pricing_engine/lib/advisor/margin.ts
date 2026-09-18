import {
  add,
  div,
  factorToPercent,
  mul,
  ONE,
  percentToFactor,
  sub,
  toDecimal,
  ZERO,
  type Decimal,
} from '../decimal'
import { minPriceForMargin } from '../components/guardrails'

export { minPriceForMargin }

export type ProfitLine = {
  totalPriceNet: string
  unitCostNet: string
  quantity: string
}

export function unitProfit(unitPriceNet: Decimal, unitCostNet: Decimal): Decimal {
  return sub(unitPriceNet, unitCostNet)
}

/** Margin is measured against PRICE; markup against COST. A zero price reports 0%, not infinity. */
export function marginPercent(unitPriceNet: Decimal, unitCostNet: Decimal): Decimal {
  if (unitPriceNet <= ZERO) return ZERO
  return factorToPercent(div(sub(unitPriceNet, unitCostNet), unitPriceNet))
}

export function markupPercent(unitPriceNet: Decimal, unitCostNet: Decimal): Decimal {
  if (unitCostNet <= ZERO) return ZERO
  return factorToPercent(div(sub(unitPriceNet, unitCostNet), unitCostNet))
}

/**
 * P1 = C1 + (P0 - C0): the customer receives the ENTIRE cost saving and the supplier's absolute
 * unit profit is unchanged, so margin percent rises rather than falls.
 *
 * This is the number the "better price without losing margin" question actually asks for. Re-applying
 * the old markup to the new cost (P1 = C1 x (1 + m0)) holds margin PERCENT but hands part of the
 * saving back to the supplier: at a 66% markup, a 100 -> 90 cost fall gives 149.40 and a profit of
 * 59.40 instead of 156.00 and the original 66.00.
 */
export function profitNeutralUnitPrice(newCost: Decimal, oldPrice: Decimal, oldCost: Decimal): Decimal {
  return add(newCost, sub(oldPrice, oldCost))
}

/**
 * The family between the two extremes: P1(phi) = P0 - phi x (C0 - C1) x (1 + m0).
 * phi = 0 holds the price (the supplier keeps the whole saving), phi = 1 holds the markup percent,
 * and phi = 1 / (1 + m0) is exactly `profitNeutralUnitPrice`.
 */
export function passThroughUnitPrice(
  oldPrice: Decimal,
  oldCost: Decimal,
  newCost: Decimal,
  markupPercentValue: string,
  passThroughFraction: string,
): Decimal {
  const markupFactor = add(ONE, percentToFactor(markupPercentValue))
  const saving = sub(oldCost, newCost)
  return sub(oldPrice, mul(mul(toDecimal(passThroughFraction), saving), markupFactor))
}

/** Sum(revenue - cost x quantity) across a priced basket — the zloty figure, not the percentage. */
export function basketProfit(lines: ProfitLine[]): Decimal {
  return lines.reduce((total, line) => {
    const revenue = toDecimal(line.totalPriceNet)
    const cost = mul(toDecimal(line.unitCostNet), toDecimal(line.quantity))
    return add(total, sub(revenue, cost))
  }, ZERO)
}

/**
 * How far a price may fall before the margin floor binds, as a percentage of the current price.
 * Returns null when no finite floor exists (margin >= 100) or the current price is zero.
 */
export function discountHeadroomPercent(
  currentUnitPriceNet: Decimal,
  unitCostNet: Decimal,
  minMarginPercentValue: string,
): Decimal | null {
  if (currentUnitPriceNet <= ZERO) return null
  const floor = minPriceForMargin(unitCostNet, minMarginPercentValue)
  if (floor === null) return null
  return factorToPercent(div(sub(currentUnitPriceNet, floor), currentUnitPriceNet))
}
