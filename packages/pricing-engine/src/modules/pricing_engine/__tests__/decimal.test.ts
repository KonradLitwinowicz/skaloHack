import {
  add,
  div,
  factorToPercent,
  format,
  money,
  mul,
  ONE,
  percentToFactor,
  roundToStep,
  sub,
  toDecimal,
  ZERO,
} from '../lib/decimal'

describe('decimal', () => {
  it('parses and formats without drift', () => {
    expect(money(toDecimal('18.4200'))).toBe('18.4200')
    expect(money(toDecimal('0.1'))).toBe('0.1000')
    expect(money(toDecimal('-3.5'))).toBe('-3.5000')
  })

  it('falls back when the input is not a decimal', () => {
    expect(money(toDecimal('abc'))).toBe('0.0000')
    expect(money(toDecimal(undefined, '2.5'))).toBe('2.5000')
    expect(money(toDecimal(''))).toBe('0.0000')
  })

  it('adds 0.1 ten times to exactly 1', () => {
    let total = ZERO
    for (let index = 0; index < 10; index += 1) total = add(total, toDecimal('0.1'))
    expect(money(total)).toBe('1.0000')
  })

  it('multiplies and divides symmetrically', () => {
    const value = toDecimal('123.4567')
    const factor = toDecimal('1.66')
    expect(money(div(mul(value, factor), factor))).toBe('123.4567')
  })

  it('rounds half away from zero in both directions', () => {
    expect(format(toDecimal('0.00005'), 4)).toBe('0.0001')
    expect(format(toDecimal('-0.00005'), 4)).toBe('-0.0001')
  })

  it('converts whole-number percents to factors', () => {
    expect(money(percentToFactor('66'))).toBe('0.6600')
    expect(money(factorToPercent(toDecimal('0.3976')))).toBe('39.7600')
  })

  it('applies a 66% markup the way the distributor states it', () => {
    const cost = toDecimal('100')
    const price = mul(cost, add(ONE, percentToFactor('66')))
    expect(money(price)).toBe('166.0000')
    // The derived margin is a different number, and that is the point.
    expect(format(factorToPercent(div(sub(price, cost), price)), 2)).toBe('39.76')
  })

  it('rounds to a configured step', () => {
    expect(money(roundToStep(toDecimal('18.4267'), toDecimal('0.01')))).toBe('18.4300')
    expect(money(roundToStep(toDecimal('18.4231'), toDecimal('0.05')))).toBe('18.4000')
  })

  it('never divides by zero', () => {
    expect(money(div(toDecimal('10'), ZERO))).toBe('0.0000')
  })
})
