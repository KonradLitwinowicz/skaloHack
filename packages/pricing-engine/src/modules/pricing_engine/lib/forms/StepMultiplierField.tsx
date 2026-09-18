'use client'

import * as React from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { CrudCustomFieldRenderProps } from '@open-mercato/ui/backend/CrudForm'
import { loadProcessStepCodeOptions } from './paramOptions'

/**
 * Editor for `pricing_order_scenarios.step_multipliers`, a `stepCode -> decimal` map. A raw JSON
 * textarea would let an operator save a key that matches no process step, which the engine ignores
 * without complaint; the step codes are offered from the live table instead.
 */

type MultiplierEntry = { stepCode: string; multiplier: string }

function toEntries(value: unknown): MultiplierEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>).map(([stepCode, multiplier]) => ({
    stepCode,
    multiplier: multiplier === null || multiplier === undefined ? '' : String(multiplier),
  }))
}

function toRecord(entries: MultiplierEntry[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const entry of entries) {
    const key = entry.stepCode.trim()
    if (!key) continue
    record[key] = entry.multiplier.trim()
  }
  return record
}

export function StepMultiplierField({ id, value, setValue, disabled }: CrudCustomFieldRenderProps) {
  const t = useT()
  const [entries, setEntries] = React.useState<MultiplierEntry[]>(() => toEntries(value))
  const [stepCodes, setStepCodes] = React.useState<string[]>([])
  const listId = `${id}-step-codes`

  React.useEffect(() => {
    let cancelled = false
    void loadProcessStepCodeOptions().then((options) => {
      if (!cancelled) setStepCodes(options.map((option) => option.value))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const commit = React.useCallback(
    (next: MultiplierEntry[]) => {
      setEntries(next)
      setValue(toRecord(next))
    },
    [setValue],
  )

  return (
    <div className="space-y-2">
      <datalist id={listId}>
        {stepCodes.map((code) => (
          <option key={code} value={code} />
        ))}
      </datalist>
      {entries.map((entry, index) => (
        <div key={`${id}-${index}`} className="flex items-center gap-2">
          <Input
            aria-label={t('pricing_engine.params.orderScenarios.field.stepCode', 'Process step code')}
            list={listId}
            value={entry.stepCode}
            disabled={disabled}
            onChange={(event) => {
              const next = [...entries]
              next[index] = { ...entry, stepCode: event.target.value }
              commit(next)
            }}
          />
          <Input
            aria-label={t('pricing_engine.params.orderScenarios.field.multiplier', 'Multiplier')}
            type="number"
            step="0.0001"
            className="max-w-40"
            value={entry.multiplier}
            disabled={disabled}
            onChange={(event) => {
              const next = [...entries]
              next[index] = { ...entry, multiplier: event.target.value }
              commit(next)
            }}
          />
          <IconButton
            type="button"
            variant="ghost"
            aria-label={t('pricing_engine.params.orderScenarios.field.removeStep', 'Remove step')}
            disabled={disabled}
            onClick={() => commit(entries.filter((_, position) => position !== index))}
          >
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => commit([...entries, { stepCode: '', multiplier: '1' }])}
      >
        {t('pricing_engine.params.orderScenarios.field.addStep', 'Add a step multiplier')}
      </Button>
    </div>
  )
}
