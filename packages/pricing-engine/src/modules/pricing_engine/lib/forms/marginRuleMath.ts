/**
 * Client-side mirror of the scope resolution in `lib/params.ts`.
 *
 * The server decides which rule prices a quote; this file exists so a screen can answer "which of
 * these rules actually wins?" without a round trip, and so that answer can be tested against the
 * same precedence the engine uses. It is display logic only — nothing here is persisted.
 */

export type MarginScope =
  | 'global'
  | 'product_group'
  | 'product'
  | 'customer_group'
  | 'customer'

/** Most specific first. Identical to SCOPE_PRECEDENCE in `lib/params.ts`. */
export const SCOPE_PRECEDENCE: MarginScope[] = [
  'customer',
  'customer_group',
  'product',
  'product_group',
  'global',
]

export type ScopeRefs = {
  customerId?: string | null
  customerGroupCode?: string | null
  productId?: string | null
  productGroupCode?: string | null
}

export type ScopedVersionedRule = {
  id: string
  scope: string
  scopeRefId: string | null
  validFrom?: string | null
  validTo?: string | null
}

export function scopeRefValue(scope: MarginScope, refs: ScopeRefs): string | null {
  switch (scope) {
    case 'customer':
      return refs.customerId ?? null
    case 'customer_group':
      return refs.customerGroupCode ?? null
    case 'product':
      return refs.productId ?? null
    case 'product_group':
      return refs.productGroupCode ?? null
    case 'global':
      return null
  }
}

function time(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/** A rule has started and has not been closed out yet. `validTo` is exclusive, as in the engine. */
export function isValidAt(rule: ScopedVersionedRule, at: Date): boolean {
  const from = time(rule.validFrom)
  if (from === null || from > at.getTime()) return false
  const to = time(rule.validTo)
  return to === null || to > at.getTime()
}

function newestFirst<TRule extends ScopedVersionedRule>(rules: TRule[]): TRule[] {
  return [...rules].sort((left, right) => (time(right.validFrom) ?? 0) - (time(left.validFrom) ?? 0))
}

/**
 * The rule the engine would pick for these references: the most specific scope whose reference is
 * present, and within that scope the newest `valid_from`.
 */
export function resolveWinningRule<TRule extends ScopedVersionedRule>(
  rules: TRule[],
  refs: ScopeRefs,
  at: Date,
): TRule | null {
  const active = newestFirst(rules.filter((rule) => isValidAt(rule, at)))
  for (const scope of SCOPE_PRECEDENCE) {
    const wanted = scopeRefValue(scope, refs)
    // A scope whose reference is missing is skipped entirely, not matched against null.
    if (scope !== 'global' && !wanted) continue
    const match = active.find(
      (rule) => rule.scope === scope && (scope === 'global' || rule.scopeRefId === wanted),
    )
    if (match) return match
  }
  return null
}

export type ShadowedRule<TRule> = TRule & { isShadowed: boolean }

/**
 * Nothing stops two rules from existing for the same scope key — there is no unique constraint —
 * and the engine silently takes the newest `valid_from`. Flagging the losers is the only way an
 * operator finds out the rule they just edited is not the one being applied.
 */
export function markShadowedRules<TRule extends ScopedVersionedRule>(
  rules: TRule[],
  at: Date,
): Array<ShadowedRule<TRule>> {
  const winnerByKey = new Map<string, string>()
  for (const rule of newestFirst(rules.filter((rule) => isValidAt(rule, at)))) {
    const key = `${rule.scope}::${rule.scopeRefId ?? ''}`
    if (!winnerByKey.has(key)) winnerByKey.set(key, rule.id)
  }
  return rules.map((rule) => {
    const key = `${rule.scope}::${rule.scopeRefId ?? ''}`
    const winner = winnerByKey.get(key)
    return { ...rule, isShadowed: isValidAt(rule, at) && winner !== undefined && winner !== rule.id }
  })
}
