import { createCrudFormError } from '@open-mercato/ui/backend/utils/serverErrors'
import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'

/**
 * Reading and validating the values a pricing parameter form produces.
 *
 * Kept free of React so the rules that decide what reaches the API can be tested on their own —
 * every one of these is a place where a wrong value is silently accepted by the database and then
 * silently ignored by the engine.
 */

export type ParamFormValues = Record<string, unknown>

export type ParamRowBase = {
  id: string
  isDemo: boolean
  updatedAt: string | null
  validFrom?: string | null
  validTo?: string | null
  isInForce?: boolean
}

export function readText(values: ParamFormValues, key: string): string {
  const value = values[key]
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

export function readBoolean(values: ParamFormValues, key: string): boolean {
  return values[key] === true || values[key] === 'true'
}

export function readOptionalText(values: ParamFormValues, key: string): string | null {
  const text = readText(values, key)
  return text.length > 0 ? text : null
}

/** Rejects anything the `numeric(p,s)` columns cannot hold, with the error on the offending field. */
export function requireDecimal(
  values: ParamFormValues,
  key: string,
  t: TranslateFn,
  label: string,
): string {
  const text = readText(values, key)
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw createCrudFormError(
      t('pricing_engine.params.errors.invalidNumber', 'Enter a number for {field}.', { field: label }),
      { [key]: t('pricing_engine.params.errors.invalidNumberField', 'Enter a number.') },
    )
  }
  return text
}

export function optionalDecimal(
  values: ParamFormValues,
  key: string,
  t: TranslateFn,
  label: string,
): string | null {
  const text = readText(values, key)
  if (!text) return null
  return requireDecimal(values, key, t, label)
}

export function requireDate(values: ParamFormValues, key: string, t: TranslateFn): string {
  const text = readText(values, key)
  if (!text) {
    throw createCrudFormError(t('pricing_engine.params.errors.dateRequired', 'Pick a date.'), {
      [key]: t('pricing_engine.params.errors.dateRequired', 'Pick a date.'),
    })
  }
  return text
}

export function optionalDate(values: ParamFormValues, key: string): string | null {
  const text = readText(values, key)
  return text.length > 0 ? text : null
}

export function requireText(
  values: ParamFormValues,
  key: string,
  t: TranslateFn,
  label: string,
): string {
  const text = readText(values, key)
  if (!text) {
    throw createCrudFormError(
      t('pricing_engine.params.errors.fieldRequired', '{field} is required.', { field: label }),
      { [key]: t('pricing_engine.params.errors.required', 'Required.') },
    )
  }
  return text
}

export function isoToDateInput(value: string | null | undefined): string {
  if (!value) return ''
  return value.slice(0, 10)
}

export function todayDateInput(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * `price_min = cost / (1 - margin/100)` has no finite solution at 100% and goes negative above it,
 * which would turn a floor into a ceiling. The database has no check constraint for this.
 */
export function assertMinMarginPercent(value: string | null, t: TranslateFn): string | null {
  if (value === null) return null
  const percent = Number(value)
  if (percent < 0 || percent >= 100) {
    throw createCrudFormError(
      t(
        'pricing_engine.params.errors.minMarginOutOfRange',
        'A minimum margin has to sit between 0 and 100 percent — at 100 the floor price is infinite.',
      ),
      {
        minMarginPercent: t(
          'pricing_engine.params.errors.minMarginOutOfRangeField',
          'Use a value below 100.',
        ),
      },
    )
  }
  return value
}

/**
 * `negotiated_price_precedence` is NOT NULL and only the literal 'negotiated_wins' has behaviour in
 * `lib/components/guardrails.ts`. Anything else means the calculated price wins.
 */
export function normalizeNegotiatedPrecedence(value: string): 'negotiated_wins' | 'rules_win' {
  return value === 'rules_win' ? 'rules_win' : 'negotiated_wins'
}
