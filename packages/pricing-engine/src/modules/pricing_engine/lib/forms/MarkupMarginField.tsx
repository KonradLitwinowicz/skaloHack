'use client'

import * as React from 'react'
import { Input } from '@open-mercato/ui/primitives/input'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { CrudCustomFieldRenderProps } from '@open-mercato/ui/backend/CrudForm'
import { marginFromMarkup, markupFromMargin } from '../frontend/marginMath'

/**
 * The engine stores a MARKUP ON COST (66 means price = cost x 1.66) and people negotiate in
 * MARGIN ON PRICE (66% markup is a 39.76% margin). Showing only one of the two is how a rule gets
 * entered a third too high. Both boxes are live and each rewrites the other; the markup is what is
 * persisted, because that is the only key `lib/components/targetMargin.ts` reads.
 */

const MAX_MARGIN_PERCENT = 100
const DISPLAY_DECIMALS = 4

function toDisplay(value: string): string {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return ''
  return String(Number(parsed.toFixed(DISPLAY_DECIMALS)))
}

function readValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

export function MarkupMarginField({
  id,
  value,
  setValue,
  disabled,
  autoFocus,
}: CrudCustomFieldRenderProps) {
  const t = useT()
  const markup = readValue(value)
  // While the margin box has focus its raw text wins, so a half-typed "3" does not get rewritten
  // to "3.0000" by the round trip through markupFromMargin.
  const [marginDraft, setMarginDraft] = React.useState<string | null>(null)

  const derivedMargin = React.useMemo(() => {
    if (!markup || !Number.isFinite(Number(markup))) return ''
    return toDisplay(marginFromMarkup(markup))
  }, [markup])

  /** 100% margin implies an infinite price; anything at or above it is not a target but a mistake. */
  const marginOutOfRange = (() => {
    const raw = marginDraft ?? derivedMargin
    if (!raw) return false
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= MAX_MARGIN_PERCENT
  })()

  const multiplier = React.useMemo(() => {
    const parsed = Number(markup)
    if (!markup || !Number.isFinite(parsed)) return null
    return (1 + parsed / 100).toFixed(DISPLAY_DECIMALS)
  }, [markup])

  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1" htmlFor={`${id}-markup`}>
          <span className="block text-xs text-muted-foreground">
            {t('pricing_engine.params.marginRules.field.markupOnCost', 'Markup on cost (%)')}
          </span>
          <Input
            id={`${id}-markup`}
            type="number"
            step="0.0001"
            inputMode="decimal"
            value={markup}
            disabled={disabled}
            autoFocus={autoFocus}
            onChange={(event) => {
              setMarginDraft(null)
              setValue(event.target.value)
            }}
          />
        </label>
        <label className="space-y-1" htmlFor={`${id}-margin`}>
          <span className="block text-xs text-muted-foreground">
            {t('pricing_engine.params.marginRules.field.marginOnPrice', 'Margin on price (%)')}
          </span>
          <Input
            id={`${id}-margin`}
            type="number"
            step="0.0001"
            inputMode="decimal"
            value={marginDraft ?? derivedMargin}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value
              setMarginDraft(next)
              // A margin of 100% or more is unreachable: price = cost / (1 - margin) diverges, and
              // `markupFromMargin` defends itself by returning a markup of 0 — which would silently
              // persist a rule that sells AT COST while the operator believes they set the maximum.
              // Refuse the value instead of converting it.
              if (next !== '' && Number(next) >= MAX_MARGIN_PERCENT) {
                setValue('')
                return
              }
              setValue(next === '' ? '' : markupFromMargin(next))
            }}
            onBlur={() => setMarginDraft(null)}
          />
        </label>
      </div>
      {marginOutOfRange ? (
        <p className="text-xs text-status-error-text">
          {t(
            'pricing_engine.params.marginRules.field.marginTooHigh',
            'Margin must stay below 100%. A margin of 100% would mean an infinite price.',
          )}
        </p>
      ) : null}
      {multiplier ? (
        <p className="text-xs text-muted-foreground">
          {t('pricing_engine.params.marginRules.field.multiplierHint', 'Sells at cost x {factor}.', {
            factor: multiplier,
          })}
        </p>
      ) : null}
    </div>
  )
}
