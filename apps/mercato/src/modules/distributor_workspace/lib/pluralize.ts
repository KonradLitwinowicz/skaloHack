/**
 * Counted nouns that read correctly in languages with more than two plural forms.
 *
 * English needs two forms and a naive `${count} days` is fine there; Polish needs three and the
 * naive version produces "za 1 dni" and "2 pozycji" on a screen an operator reads all morning.
 * `Intl.PluralRules` already knows every locale's categories, so the only thing this adds is a
 * lookup from the category it returns to the phrase the dictionary holds, plus a fallback chain so
 * a locale whose forms were never filled in degrades to the plural rather than to a missing key.
 */

export type PluralForms = {
  one: string
  few?: string
  many?: string
  other: string
}

export function selectPluralForm(count: number, locale: string, forms: PluralForms): string {
  let category: Intl.LDMLPluralRule = 'other'
  try {
    category = new Intl.PluralRules(locale || 'en').select(count)
  } catch {
    category = count === 1 ? 'one' : 'other'
  }
  if (category === 'one') return forms.one
  if (category === 'few') return forms.few ?? forms.other
  if (category === 'many') return forms.many ?? forms.few ?? forms.other
  return forms.other
}

export function formatCounted(count: number, locale: string, forms: PluralForms): string {
  return `${count} ${selectPluralForm(count, locale, forms)}`
}
