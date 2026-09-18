import {
  isValidAt,
  markShadowedRules,
  resolveWinningRule,
  scopeRefValue,
  SCOPE_PRECEDENCE,
  type ScopedVersionedRule,
} from '../lib/forms/marginRuleMath'
import { marginFromMarkup, markupFromMargin } from '../lib/frontend/marginMath'
import {
  assertMinMarginPercent,
  normalizeNegotiatedPrecedence,
  requireDecimal,
  requireText,
} from '../lib/forms/paramValues'

const translate = (_key: string, fallbackOrParams?: unknown) =>
  typeof fallbackOrParams === 'string' ? fallbackOrParams : ''

const AT = new Date('2026-06-01T00:00:00.000Z')

function rule(
  id: string,
  scope: string,
  scopeRefId: string | null,
  validFrom = '2020-01-01T00:00:00.000Z',
  validTo: string | null = null,
): ScopedVersionedRule {
  return { id, scope, scopeRefId, validFrom, validTo }
}

describe('margin rule scope precedence', () => {
  const rules = [
    rule('global', 'global', null),
    rule('group', 'product_group', 'disinfectants'),
    rule('product', 'product', 'product-1'),
    rule('customerGroup', 'customer_group', 'hospital'),
    rule('customer', 'customer', 'customer-1'),
  ]

  it('orders scopes most specific first, matching lib/params.ts', () => {
    expect(SCOPE_PRECEDENCE).toEqual([
      'customer',
      'customer_group',
      'product',
      'product_group',
      'global',
    ])
  })

  it('picks the customer rule when every scope could match', () => {
    const winner = resolveWinningRule(
      rules,
      {
        customerId: 'customer-1',
        customerGroupCode: 'hospital',
        productId: 'product-1',
        productGroupCode: 'disinfectants',
      },
      AT,
    )
    expect(winner?.id).toBe('customer')
  })

  it('falls through the ladder as each reference drops away', () => {
    const refs = {
      customerId: 'customer-1',
      customerGroupCode: 'hospital',
      productId: 'product-1',
      productGroupCode: 'disinfectants',
    }
    expect(resolveWinningRule(rules, { ...refs, customerId: null }, AT)?.id).toBe('customerGroup')
    expect(
      resolveWinningRule(rules, { ...refs, customerId: null, customerGroupCode: null }, AT)?.id,
    ).toBe('product')
    expect(
      resolveWinningRule(
        rules,
        { ...refs, customerId: null, customerGroupCode: null, productId: null },
        AT,
      )?.id,
    ).toBe('group')
    expect(resolveWinningRule(rules, {}, AT)?.id).toBe('global')
  })

  it('skips a scope whose reference is missing instead of matching a null scopeRefId', () => {
    const onlyCustomerScoped = [rule('customer', 'customer', 'customer-1')]
    expect(resolveWinningRule(onlyCustomerScoped, {}, AT)).toBeNull()
  })

  it('does not match a scoped rule whose reference differs', () => {
    const winner = resolveWinningRule(rules, { customerId: 'someone-else' }, AT)
    expect(winner?.id).toBe('global')
  })

  it('returns null when no rule exists at all', () => {
    expect(resolveWinningRule([], { customerId: 'customer-1' }, AT)).toBeNull()
  })

  it('maps each scope to the reference it needs', () => {
    const refs = {
      customerId: 'c',
      customerGroupCode: 'cg',
      productId: 'p',
      productGroupCode: 'pg',
    }
    expect(scopeRefValue('customer', refs)).toBe('c')
    expect(scopeRefValue('customer_group', refs)).toBe('cg')
    expect(scopeRefValue('product', refs)).toBe('p')
    expect(scopeRefValue('product_group', refs)).toBe('pg')
    expect(scopeRefValue('global', refs)).toBeNull()
  })
})

describe('margin rule time versioning', () => {
  it('treats validTo as exclusive and validFrom as inclusive', () => {
    expect(isValidAt(rule('a', 'global', null, '2026-06-01T00:00:00.000Z'), AT)).toBe(true)
    expect(isValidAt(rule('b', 'global', null, '2026-06-02T00:00:00.000Z'), AT)).toBe(false)
    expect(
      isValidAt(
        rule('c', 'global', null, '2020-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
        AT,
      ),
    ).toBe(false)
    expect(
      isValidAt(
        rule('d', 'global', null, '2020-01-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z'),
        AT,
      ),
    ).toBe(true)
  })

  it('takes the newest validFrom within one scope', () => {
    const rules = [
      rule('old', 'global', null, '2020-01-01T00:00:00.000Z'),
      rule('new', 'global', null, '2026-01-01T00:00:00.000Z'),
    ]
    expect(resolveWinningRule(rules, {}, AT)?.id).toBe('new')
  })

  it('ignores a rule that has not started yet', () => {
    const rules = [
      rule('current', 'global', null, '2020-01-01T00:00:00.000Z'),
      rule('future', 'global', null, '2027-01-01T00:00:00.000Z'),
    ]
    expect(resolveWinningRule(rules, {}, AT)?.id).toBe('current')
  })

  it('flags the duplicate that the engine silently ignores', () => {
    const marked = markShadowedRules(
      [
        rule('old', 'product_group', 'disinfectants', '2020-01-01T00:00:00.000Z'),
        rule('new', 'product_group', 'disinfectants', '2026-01-01T00:00:00.000Z'),
        rule('other', 'product_group', 'gloves', '2020-01-01T00:00:00.000Z'),
      ],
      AT,
    )
    expect(marked.find((entry) => entry.id === 'old')?.isShadowed).toBe(true)
    expect(marked.find((entry) => entry.id === 'new')?.isShadowed).toBe(false)
    expect(marked.find((entry) => entry.id === 'other')?.isShadowed).toBe(false)
  })

  it('never flags a version that is already closed out', () => {
    const marked = markShadowedRules(
      [
        rule('closed', 'global', null, '2020-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
        rule('open', 'global', null, '2025-01-01T00:00:00.000Z'),
      ],
      AT,
    )
    expect(marked.find((entry) => entry.id === 'closed')?.isShadowed).toBe(false)
  })
})

describe('markup and margin conversion in the rule form', () => {
  it('derives the margin on price from the markup on cost', () => {
    // 66% markup means price = cost x 1.66, so profit/price = 0.66/1.66 = 39.7590%.
    expect(marginFromMarkup('66')).toBe('39.7590')
    expect(marginFromMarkup('0')).toBe('0.0000')
    expect(marginFromMarkup('100')).toBe('50.0000')
  })

  it('round-trips markup -> margin -> markup, which is what the two live inputs rely on', () => {
    for (const markup of ['12', '32', '66', '84', '150']) {
      expect(Number(markupFromMargin(marginFromMarkup(markup)))).toBeCloseTo(Number(markup), 3)
    }
  })

  it('never reports a margin of 100 percent or more', () => {
    expect(Number(marginFromMarkup('100000'))).toBeLessThan(100)
  })

  it('returns zero rather than infinity at an impossible margin', () => {
    expect(markupFromMargin('100')).toBe('0.0000')
    expect(markupFromMargin('120')).toBe('0.0000')
  })
})

describe('parameter form value guards', () => {
  it('accepts the decimal shapes the numeric columns hold', () => {
    expect(requireDecimal({ value: 66 }, 'value', translate, 'Markup')).toBe('66')
    expect(requireDecimal({ value: '66' }, 'value', translate, 'Markup')).toBe('66')
    expect(requireDecimal({ value: '66.0000' }, 'value', translate, 'Markup')).toBe('66.0000')
    expect(requireDecimal({ value: '-3.5' }, 'value', translate, 'Markup')).toBe('-3.5')
  })

  it('rejects anything the column cannot store, and names the field', () => {
    expect(() => requireDecimal({ value: 'abc' }, 'value', translate, 'Markup')).toThrow()
    expect(() => requireDecimal({ value: '' }, 'value', translate, 'Markup')).toThrow()
    try {
      requireDecimal({ value: '1,5' }, 'value', translate, 'Markup')
      throw new Error('[internal] expected a validation error')
    } catch (error) {
      expect((error as { fieldErrors?: Record<string, string> }).fieldErrors).toHaveProperty('value')
    }
  })

  it('requires a change note, because it is the only record of why a rule exists', () => {
    expect(() => requireText({ changeNote: '  ' }, 'changeNote', translate, 'Note')).toThrow()
    expect(requireText({ changeNote: ' contract ' }, 'changeNote', translate, 'Note')).toBe('contract')
  })

  it('refuses a minimum margin the floor-price formula cannot solve', () => {
    expect(assertMinMarginPercent('8', translate)).toBe('8')
    expect(assertMinMarginPercent(null, translate)).toBeNull()
    expect(() => assertMinMarginPercent('100', translate)).toThrow()
    expect(() => assertMinMarginPercent('-1', translate)).toThrow()
  })

  it('never lets a null reach the NOT NULL precedence column', () => {
    expect(normalizeNegotiatedPrecedence('rules_win')).toBe('rules_win')
    expect(normalizeNegotiatedPrecedence('negotiated_wins')).toBe('negotiated_wins')
    expect(normalizeNegotiatedPrecedence('')).toBe('negotiated_wins')
  })
})
