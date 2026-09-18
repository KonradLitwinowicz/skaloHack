// The only money arithmetic in this module.
//
// Amounts move through the engine as decimal strings because the database stores them as
// `numeric(18,4)` and MikroORM maps `numeric` to `string`. Doing the eleven-step pipeline in
// IEEE-754 doubles would drift, and this ledger is meant to be reproducible to the grosz.
// Values are held as BigInt scaled by 10^SCALE and only formatted at the edges.

export const SCALE = 12
const SCALE_FACTOR = 10n ** BigInt(SCALE)

export const MONEY_DP = 4
export const RATE_DP = 4

export type Decimal = bigint

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/

export function toDecimal(value: string | number | null | undefined, fallback: string = '0'): Decimal {
  const raw = value === null || value === undefined ? fallback : String(value).trim()
  const normalized = raw === '' ? fallback : raw
  if (!DECIMAL_PATTERN.test(normalized)) {
    if (!DECIMAL_PATTERN.test(fallback)) return 0n
    return toDecimal(fallback, '0')
  }
  const negative = normalized.startsWith('-')
  const unsigned = negative ? normalized.slice(1) : normalized
  const [intPart, fracPart = ''] = unsigned.split('.')
  const paddedFrac = (fracPart + '0'.repeat(SCALE)).slice(0, SCALE)
  const magnitude = BigInt(intPart + paddedFrac)
  return negative ? -magnitude : magnitude
}

export function add(left: Decimal, right: Decimal): Decimal {
  return left + right
}

export function sub(left: Decimal, right: Decimal): Decimal {
  return left - right
}

export function mul(left: Decimal, right: Decimal): Decimal {
  return divideRoundHalfUp(left * right, SCALE_FACTOR)
}

export function div(left: Decimal, right: Decimal): Decimal {
  if (right === 0n) return 0n
  return divideRoundHalfUp(left * SCALE_FACTOR, right)
}

export function isZero(value: Decimal): boolean {
  return value === 0n
}

export function lt(left: Decimal, right: Decimal): boolean {
  return left < right
}

export function gt(left: Decimal, right: Decimal): boolean {
  return left > right
}

export function max(left: Decimal, right: Decimal): Decimal {
  return left > right ? left : right
}

export function min(left: Decimal, right: Decimal): Decimal {
  return left < right ? left : right
}

// Half-up on the absolute value, so -0.5 rounds to -1 and 0.5 rounds to 1.
// Symmetric rounding keeps a credit and its matching debit equal in magnitude.
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n
  const negative = numerator < 0n !== denominator < 0n
  const absNumerator = numerator < 0n ? -numerator : numerator
  const absDenominator = denominator < 0n ? -denominator : denominator
  const quotient = absNumerator / absDenominator
  const remainder = absNumerator % absDenominator
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient
  return negative ? -rounded : rounded
}

export function format(value: Decimal, decimalPlaces: number = MONEY_DP): string {
  const places = Math.max(0, Math.min(SCALE, Math.trunc(decimalPlaces)))
  const shift = 10n ** BigInt(SCALE - places)
  const scaled = divideRoundHalfUp(value, shift)
  const negative = scaled < 0n
  const digits = (negative ? -scaled : scaled).toString().padStart(places + 1, '0')
  const intPart = digits.slice(0, digits.length - places) || '0'
  const fracPart = places > 0 ? digits.slice(digits.length - places) : ''
  const body = places > 0 ? `${intPart}.${fracPart}` : intPart
  return negative ? `-${body}` : body
}

export function money(value: Decimal): string {
  return format(value, MONEY_DP)
}

export function rate(value: Decimal): string {
  return format(value, RATE_DP)
}

export const ONE: Decimal = SCALE_FACTOR
export const ZERO: Decimal = 0n
export const HUNDRED: Decimal = SCALE_FACTOR * 100n

// Percentages are stored as `numeric(7,4)` holding a whole-number percent (66.0000 = 66%),
// matching `sales_tax_rates.rate`. Converting once here keeps that convention out of the components.
export function percentToFactor(percentValue: string | number | null | undefined): Decimal {
  return div(toDecimal(percentValue), HUNDRED)
}

export function factorToPercent(factor: Decimal): Decimal {
  return mul(factor, HUNDRED)
}

// Snap a value to the money scale. The pipeline quantizes after every component so the reported
// running total is the value actually carried forward: without this, a component whose serialized
// value is rounded to 4dp diverges from the higher-precision running total, and the printed
// waterfall stops adding up to the printed price.
export function quantizeMoney(value: Decimal): Decimal {
  return toDecimal(format(value, MONEY_DP))
}

export function roundToStep(value: Decimal, step: Decimal): Decimal {
  if (step <= 0n) return value
  const steps = divideRoundHalfUp(value, step)
  return steps * step
}
