import { formatAmount, formatQuantity } from '../lib/frontend/deadstockTypes'

// The space Intl uses between groups is a NARROW NO-BREAK SPACE, not an ordinary one. Asserting on
// a typed space would fail for the right output, so the separator is normalised before comparing.
function normalise(value: string): string {
  return value.replace(/ | /g, ' ')
}

describe('formatAmount', () => {
  it('formats in the application locale, not the browser one', () => {
    expect(normalise(formatAmount('83794.7649', 'PLN', 'pl-PL'))).toBe('83 794,76 PLN')
    expect(normalise(formatAmount('83794.7649', 'PLN', 'en-US'))).toBe('PLN 83,794.76')
  })

  // Polish CLDR does not group four-digit numbers: the separator appearing on one row and not the
  // next is the rule, not a defect, and a "fix" that forced it would be wrong.
  it('leaves four-digit amounts ungrouped in Polish, as the locale requires', () => {
    expect(normalise(formatAmount('2702.59', 'PLN', 'pl-PL'))).toBe('2702,59 PLN')
  })

  it('shows the code rather than the symbol, so two currencies read the same way', () => {
    expect(normalise(formatAmount('520.94', 'PLN', 'pl-PL'))).toBe('520,94 PLN')
    expect(normalise(formatAmount('680', 'USD', 'pl-PL'))).toBe('680,00 USD')
  })

  // The defect that appending the code by hand could never have caught: a currency with no minor
  // unit must not be printed with two decimal places.
  it('respects currencies that have no decimal part', () => {
    expect(normalise(formatAmount('83794.7649', 'JPY', 'pl-PL'))).toBe('83 795 JPY')
  })

  it('still shows the number when the currency code is not one Intl knows', () => {
    expect(normalise(formatAmount('12.5', 'NOT-A-CURRENCY', 'pl-PL'))).toBe('12,50 NOT-A-CURRENCY')
  })

  it('passes a non-numeric value through untouched rather than printing NaN', () => {
    expect(formatAmount('', 'PLN', 'pl-PL')).toBe('')
  })
})

describe('formatQuantity', () => {
  it('drops the decimal part for whole units and keeps it otherwise', () => {
    expect(normalise(formatQuantity('208', 'pl-PL'))).toBe('208')
    expect(normalise(formatQuantity('208.5', 'pl-PL'))).toBe('208,50')
  })
})
