'use client'

import * as React from 'react'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { JsonDisplay } from '@open-mercato/ui/backend/JsonDisplay'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { QuoteBreakdownComponent } from '../lib/frontend/quoteTypes'
import { renderExplain } from '../lib/frontend/renderExplain'
import { formatMoney } from '../lib/frontend/marginMath'
import { ConfidenceBadge } from './ConfidenceBadge'

export type MarginAssumptionsProps = {
  breakdown: QuoteBreakdownComponent[]
  currencyCode: string
  /** Component codes whose raw inputs and parameters start expanded. */
  defaultExpandedCodes?: string[]
  className?: string
}

type ScalarEntry = { key: string; label: string; value: string }

// Parameter names come from the engine's payloads, not from a fixed list, so they cannot carry
// translation keys — a new cost parameter would otherwise render as a dotted identifier. They are
// displayed the same way JsonDisplay shows an object key: humanised, never invented.
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  if (!spaced) return key
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1).toLowerCase()}`
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function toScalarEntries(source: Record<string, unknown> | undefined): ScalarEntry[] {
  if (!source) return []
  return Object.entries(source)
    .filter(([, value]) => isScalar(value))
    .map(([key, value]) => ({ key, label: humanizeKey(key), value: String(value) }))
}

function hasRenderableDetail(source: Record<string, unknown> | undefined): boolean {
  return !!source && Object.keys(source).length > 0
}

export function MarginAssumptions({
  breakdown,
  currencyCode,
  defaultExpandedCodes,
  className,
}: MarginAssumptionsProps) {
  const t = useT()
  const [expandedCodes, setExpandedCodes] = React.useState<string[]>(() => defaultExpandedCodes ?? [])

  const toggle = React.useCallback((code: string) => {
    setExpandedCodes((previous) =>
      previous.includes(code) ? previous.filter((entry) => entry !== code) : [...previous, code],
    )
  }, [])

  if (breakdown.length === 0) {
    return (
      <p className={className ? `text-sm text-muted-foreground ${className}` : 'text-sm text-muted-foreground'}>
        {t('pricing_engine.margin.assumptions.empty', 'This line was priced without any recorded component.')}
      </p>
    )
  }

  return (
    <ul className={className ? `space-y-3 ${className}` : 'space-y-3'}>
      {breakdown.map((component) => {
        const expanded = expandedCodes.includes(component.code)
        const isMultiplier = component.effect === 'mul'
        const parameterEntries = toScalarEntries(component.params)
        const showDetails = hasRenderableDetail(component.inputs) || hasRenderableDetail(component.params)
        const warnings = component.warnings ?? []
        return (
          <li key={component.code} className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t(component.labelKey, component.code)}</span>
                <ConfidenceBadge confidence={component.confidence} />
              </div>
              <span className="text-sm tabular-nums text-muted-foreground">
                {isMultiplier ? `x ${component.value}` : formatMoney(component.value, currencyCode)}
              </span>
            </div>

            <p className="mt-2 text-sm text-muted-foreground">{renderExplain(t, component)}</p>

            {component.confidence === 'default' ? (
              <p className="mt-2 text-xs text-status-warning-text">
                {t(
                  'pricing_engine.margin.assumptions.assumedHint',
                  'Assumed, not measured: this component runs on a default until the real value is recorded.',
                )}
              </p>
            ) : null}

            {parameterEntries.length > 0 ? (
              <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {parameterEntries.map((entry) => (
                  <div key={entry.key} className="flex items-baseline justify-between gap-3 text-xs">
                    <dt className="text-muted-foreground">{entry.label}</dt>
                    <dd className="tabular-nums">{entry.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {warnings.length > 0 ? (
              <div className="mt-3 space-y-2">
                {warnings.map((warning) => (
                  <Alert key={warning} status="warning" style="lighter" size="sm">
                    <AlertDescription>{t(warning, warning)}</AlertDescription>
                  </Alert>
                ))}
              </div>
            ) : null}

            {showDetails ? (
              <div className="mt-3 space-y-3">
                <Button type="button" variant="ghost" size="2xs" onClick={() => toggle(component.code)}>
                  {expanded
                    ? t('pricing_engine.margin.assumptions.hideDetails', 'Hide the raw values')
                    : t('pricing_engine.margin.assumptions.showDetails', 'Show the raw values')}
                </Button>
                {expanded ? (
                  <div className="grid gap-3 lg:grid-cols-2">
                    {hasRenderableDetail(component.inputs) ? (
                      <JsonDisplay
                        data={component.inputs}
                        title={t('pricing_engine.margin.assumptions.inputs', 'Inputs')}
                        defaultExpanded
                        showCopy={false}
                      />
                    ) : null}
                    {hasRenderableDetail(component.params) ? (
                      <JsonDisplay
                        data={component.params}
                        title={t('pricing_engine.margin.assumptions.params', 'Parameters')}
                        defaultExpanded
                        showCopy={false}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

export default MarginAssumptions
