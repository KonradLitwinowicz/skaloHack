import { div, floorToInteger, mul, ONE, toDecimal, type Decimal } from '../decimal'

/**
 * Round UP onto a whole number inside the decimal domain. `Math.ceil(Number(format(...)))` would
 * round the string to 4 dp first, so a quantity of 2.00004 cartons could become 2 instead of 3.
 */
export function ceilToInteger(value: Decimal): Decimal {
  const floored = floorToInteger(value)
  return floored === value ? value : floored + ONE
}

export function ceilToMultiple(value: Decimal, factor: Decimal): Decimal {
  if (factor <= 0n) return value
  return mul(ceilToInteger(div(value, factor)), factor)
}

/** Whole units only: the pipeline prices packs by flooring quantity / factor, so fractions mislead. */
export function scaleQuantity(quantity: Decimal, factor: string): Decimal {
  return ceilToInteger(mul(quantity, toDecimal(factor)))
}

export function uniqueAscending(values: Decimal[]): Decimal[] {
  const seen = new Set<string>()
  const result: Decimal[] = []
  for (const value of [...values].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))) {
    const key = value.toString()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

export type PackLadder = { unitCode: string; factor: Decimal }

/**
 * Pack conversions worth rounding to. A `to_base_factor` of 1 is degenerate — 21 of the 200 seeded
 * products carry one — and rounding to it can never change a quantity.
 */
export function packLadder(unitConversions: Record<string, string>): PackLadder[] {
  return Object.entries(unitConversions)
    .map(([unitCode, factor]) => ({ unitCode, factor: toDecimal(factor) }))
    .filter((entry) => entry.factor > ONE)
    .sort((left, right) => (left.factor === right.factor ? 0 : left.factor < right.factor ? -1 : 1))
}
