'use client'

import * as React from 'react'
import { Trash2 } from 'lucide-react'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Input } from '@open-mercato/ui/primitives/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { createCrudFormError } from '@open-mercato/ui/backend/utils/serverErrors'
import type { CrudCustomFieldRenderProps, CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { useT, type TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import {
  ALL_OBJECTIVE_METRICS,
  type PricingObjective,
  type PricingObjectiveDirection,
  type PricingObjectiveMetric,
} from '../advisor/objectives'
import {
  readScopeRef,
  scopeFields,
  scopeLabel,
  scopeOptions,
  scopePrecedenceRank,
  scopeValues,
} from './scopeFields'
import {
  demoColumn,
  isoToDateInput,
  optionalDate,
  requireDate,
  requireText,
  todayDateInput,
  versionColumns,
  type ParamFormMode,
  type ParamFormValues,
  type ParamRowBase,
  type ParamScreenDescriptor,
} from './paramScreens'

export type ObjectiveRuleRow = ParamRowBase & {
  scope: string
  scopeRefId: string | null
  objectives: PricingObjective[]
  objectiveCount: number
  changeNote: string | null
}

const METRIC_FALLBACK: Record<PricingObjectiveMetric, string> = {
  marginPercent: 'Margin on price',
  profitNet: 'Profit on the whole order',
  revenueNet: 'Revenue',
  unitCostNet: 'Cost to serve one unit',
  productCost: 'Purchase cost',
  operationalCost: 'Order handling labour',
  packagingCost: 'Packaging',
  warehouseCost: 'Warehousing',
  logisticsCost: 'Delivery',
}

const DIRECTIONS: PricingObjectiveDirection[] = ['maximise', 'minimise']

const DIRECTION_FALLBACK: Record<PricingObjectiveDirection, string> = {
  maximise: 'Higher is better',
  minimise: 'Lower is better',
}

export function metricLabel(t: TranslateFn, metric: PricingObjectiveMetric): string {
  return t(`pricing_engine.advisor.metric.${metric}`, METRIC_FALLBACK[metric])
}

type ObjectiveDraft = {
  code: string
  label: string
  metric: PricingObjectiveMetric
  direction: PricingObjectiveDirection
  weight: string
}

function isMetric(value: unknown): value is PricingObjectiveMetric {
  return typeof value === 'string' && (ALL_OBJECTIVE_METRICS as string[]).includes(value)
}

function isDirection(value: unknown): value is PricingObjectiveDirection {
  return value === 'maximise' || value === 'minimise'
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return value === null || value === undefined ? '' : String(value)
}

function toDrafts(value: unknown): ObjectiveDraft[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    return [
      {
        code: readString(record, 'code'),
        label: readString(record, 'label'),
        metric: isMetric(record.metric) ? record.metric : 'profitNet',
        direction: isDirection(record.direction) ? record.direction : 'maximise',
        weight: readString(record, 'weight'),
      },
    ]
  })
}

/**
 * Editor for the `objective_weights` payload — an array of rows, one per objective.
 *
 * The metric is a closed list rather than free text on purpose: an objective the engine cannot
 * measure on a before/after pair contributes nothing to the ranking while looking as though it
 * does, which is worse than having no objective at all.
 */
export function ObjectivesField({ id, value, setValue, disabled }: CrudCustomFieldRenderProps) {
  const t = useT()
  const [drafts, setDrafts] = React.useState<ObjectiveDraft[]>(() => toDrafts(value))

  const commit = React.useCallback(
    (next: ObjectiveDraft[]) => {
      setDrafts(next)
      setValue(next)
    },
    [setValue],
  )

  const patch = React.useCallback(
    (index: number, changes: Partial<ObjectiveDraft>) => {
      commit(drafts.map((draft, position) => (position === index ? { ...draft, ...changes } : draft)))
    },
    [commit, drafts],
  )

  return (
    <div className="space-y-3">
      {drafts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t(
            'pricing_engine.params.objectives.field.empty',
            'No objectives yet. Without one the advisor keeps the order it already produces.',
          )}
        </p>
      ) : null}

      {drafts.map((draft, index) => (
        <div key={`${id}-${index}`} className="grid gap-2 rounded-md border border-border p-3 md:grid-cols-12">
          <div className="md:col-span-3">
            <Input
              aria-label={t('pricing_engine.params.objectives.field.code', 'Objective code')}
              placeholder={t('pricing_engine.params.objectives.field.code', 'Objective code')}
              value={draft.code}
              disabled={disabled}
              onChange={(event) => patch(index, { code: event.target.value })}
            />
          </div>
          <div className="md:col-span-3">
            <Input
              aria-label={t('pricing_engine.params.objectives.field.label', 'What you call it')}
              placeholder={t('pricing_engine.params.objectives.field.label', 'What you call it')}
              value={draft.label}
              disabled={disabled}
              onChange={(event) => patch(index, { label: event.target.value })}
            />
          </div>
          <div className="md:col-span-3">
            <Select
              value={draft.metric}
              disabled={disabled}
              onValueChange={(next) => {
                if (isMetric(next)) patch(index, { metric: next })
              }}
            >
              <SelectTrigger
                aria-label={t('pricing_engine.params.objectives.field.metric', 'Measured on')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_OBJECTIVE_METRICS.map((metric) => (
                  <SelectItem key={metric} value={metric}>
                    {metricLabel(t, metric)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-2">
            <Select
              value={draft.direction}
              disabled={disabled}
              onValueChange={(next) => {
                if (isDirection(next)) patch(index, { direction: next })
              }}
            >
              <SelectTrigger
                aria-label={t('pricing_engine.params.objectives.field.direction', 'Which way is better')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIRECTIONS.map((direction) => (
                  <SelectItem key={direction} value={direction}>
                    {t(
                      `pricing_engine.params.objectives.direction.${direction}`,
                      DIRECTION_FALLBACK[direction],
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 md:col-span-1">
            <Input
              aria-label={t('pricing_engine.params.objectives.field.weight', 'Weight')}
              type="number"
              min="0"
              step="1"
              value={draft.weight}
              disabled={disabled}
              onChange={(event) => patch(index, { weight: event.target.value })}
            />
            <IconButton
              type="button"
              variant="ghost"
              aria-label={t('pricing_engine.params.objectives.field.remove', 'Remove this objective')}
              disabled={disabled}
              onClick={() => commit(drafts.filter((_, position) => position !== index))}
            >
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() =>
          commit([
            ...drafts,
            { code: '', label: '', metric: 'profitNet', direction: 'maximise', weight: '10' },
          ])
        }
      >
        {t('pricing_engine.params.objectives.field.add', 'Add an objective')}
      </Button>
    </div>
  )
}

function groups(t: TranslateFn, mode: ParamFormMode): CrudFormGroup[] {
  return [
    {
      id: 'scope',
      title: t('pricing_engine.params.objectives.group.scope', 'Who do these objectives apply to?'),
      fields: scopeFields(t),
    },
    {
      id: 'objectives',
      title: t('pricing_engine.params.objectives.group.objectives', 'Objectives and weights'),
      description: t(
        'pricing_engine.params.objectives.group.objectivesDescription',
        'The advisor scores each suggestion against every objective, scales the move against the current value so a percentage point and a zloty are comparable, then ranks by the weighted average. A weight of 0 switches an objective off without deleting it. A margin floor always wins: a suggestion that would breach one is never listed, whatever the weights say.',
      ),
      fields: [
        {
          id: 'objectives',
          type: 'custom',
          label: t('pricing_engine.params.objectives.field.objectives', 'Objectives'),
          required: true,
          component: ObjectivesField,
        },
      ],
    },
    {
      id: 'validity',
      title: t('pricing_engine.params.objectives.group.validity', 'When does it apply?'),
      fields: [
        {
          id: 'validFrom',
          type: 'date',
          label: t('pricing_engine.params.field.validFrom', 'Valid from'),
          required: true,
          description:
            mode === 'create'
              ? t(
                  'pricing_engine.params.objectives.field.validFromHint',
                  'Advice given before this date keeps the objectives that were in force then.',
                )
              : undefined,
          layout: 'half',
        },
        {
          id: 'validTo',
          type: 'date',
          label: t('pricing_engine.params.field.validTo', 'Valid to'),
          description: t('pricing_engine.params.field.validToHint', 'Leave empty to keep it open-ended.'),
          layout: 'half',
        },
        {
          id: 'changeNote',
          type: 'textarea',
          label: t('pricing_engine.params.objectives.field.changeNote', 'Why these priorities?'),
          required: true,
          rows: 3,
          description: t(
            'pricing_engine.params.objectives.field.changeNoteHint',
            'Recorded against the rule. It is the only explanation anyone will have in six months.',
          ),
        },
      ],
    },
  ]
}

function fail(t: TranslateFn, message: string): never {
  throw createCrudFormError(message, {
    objectives: t('pricing_engine.params.errors.objectiveInvalidField', 'Check these rows.'),
  })
}

/**
 * The single place form values become an API body. Every check below is one the server would answer
 * with a 400 — catching them here puts the error on the offending field instead of a toast.
 */
export function buildObjectivePayload(
  values: ParamFormValues,
  t: TranslateFn,
): Record<string, unknown> {
  const { scope, scopeRefId } = readScopeRef(values, t)
  const drafts = toDrafts(values.objectives)

  if (drafts.length === 0) {
    fail(
      t,
      t('pricing_engine.params.errors.objectivesRequired', 'Add at least one objective, or delete the rule.'),
    )
  }

  const objectives = drafts.map((draft) => {
    const code = draft.code.trim()
    const label = draft.label.trim()
    const weight = draft.weight.trim()
    if (!code || !label) {
      fail(
        t,
        t(
          'pricing_engine.params.errors.objectiveIncomplete',
          'Every objective needs a code and a name.',
        ),
      )
    }
    if (!/^\d+(\.\d+)?$/.test(weight)) {
      fail(
        t,
        t(
          'pricing_engine.params.errors.invalidWeight',
          'A weight has to be zero or a positive number. Use 0 to switch an objective off.',
        ),
      )
    }
    return { code, label, metric: draft.metric, direction: draft.direction, weight }
  })

  const codes = objectives.map((objective) => objective.code)
  if (new Set(codes).size !== codes.length) {
    fail(
      t,
      t(
        'pricing_engine.params.errors.duplicateObjectiveCode',
        'Two objectives share a code. Codes are the row key and have to be unique.',
      ),
    )
  }

  return {
    scope,
    scopeRefId,
    objectives,
    validFrom: requireDate(values, 'validFrom', t),
    validTo: optionalDate(values, 'validTo'),
    changeNote: requireText(
      values,
      'changeNote',
      t,
      t('pricing_engine.params.objectives.field.changeNote', 'Why these priorities?'),
    ),
  }
}

export const objectiveDescriptor: ParamScreenDescriptor<ObjectiveRuleRow> = {
  segment: 'objectives',
  apiPath: 'pricing/objectives',
  keyPrefix: 'pricing_engine.params.objectives',
  titleFallback: 'Objectives and weights',
  resourceKind: 'pricing_engine.component_param',
  timeVersioned: true,
  searchPlaceholderFallback: 'Search by scope reference or note',
  columns: (t) => [
    {
      accessorKey: 'scope',
      header: t('pricing_engine.params.field.scope', 'Applies to'),
      cell: ({ row }) => (
        <div className="space-y-0.5">
          <div className="font-medium">{scopeLabel(t, row.original.scope)}</div>
          {row.original.scopeRefId ? (
            <div className="font-mono text-xs text-muted-foreground">{row.original.scopeRefId}</div>
          ) : null}
        </div>
      ),
    },
    {
      accessorKey: 'precedence',
      header: t('pricing_engine.params.objectives.column.precedence', 'Beats'),
      cell: ({ row }) => (
        <Badge variant="outline">
          {t('pricing_engine.params.marginRules.column.precedenceValue', 'Rank {rank} of 5', {
            rank: String(scopePrecedenceRank(row.original.scope) + 1),
          })}
        </Badge>
      ),
    },
    {
      accessorKey: 'objectiveCount',
      header: t('pricing_engine.params.objectives.column.objectives', 'Objectives'),
      cell: ({ row }) => {
        const objectives = row.original.objectives ?? []
        if (objectives.length === 0) {
          return (
            <span className="text-sm text-muted-foreground">
              {t('pricing_engine.params.objectives.column.none', 'None')}
            </span>
          )
        }
        return (
          <div className="flex flex-wrap gap-1">
            {objectives.map((objective) => (
              <Badge
                key={objective.code}
                variant={Number(objective.weight) === 0 ? 'neutral' : 'info'}
                size="sm"
              >
                {`${objective.label} · ${objective.weight}`}
              </Badge>
            ))}
          </div>
        )
      },
    },
    ...versionColumns<ObjectiveRuleRow>(t),
    demoColumn<ObjectiveRuleRow>(t),
  ],
  filters: (t) => [
    {
      id: 'scope',
      type: 'select',
      label: t('pricing_engine.params.field.scope', 'Applies to'),
      options: scopeOptions(t).map((option) => ({ value: option.value, label: option.label })),
    },
  ] satisfies FilterDef[],
  filterParams: (values: FilterValues) => ({
    scope: typeof values.scope === 'string' ? values.scope : '',
  }),
  groups,
  createDefaults: () => ({
    scope: 'global',
    ...scopeValues('global', null),
    objectives: [
      { code: 'profit', label: 'Profit', metric: 'profitNet', direction: 'maximise', weight: '60' },
      { code: 'margin', label: 'Margin', metric: 'marginPercent', direction: 'maximise', weight: '40' },
    ],
    validFrom: todayDateInput(),
    validTo: '',
    changeNote: '',
  }),
  toValues: (row) => ({
    ...scopeValues(row.scope, row.scopeRefId),
    objectives: row.objectives ?? [],
    validFrom: isoToDateInput(row.validFrom),
    validTo: isoToDateInput(row.validTo),
    changeNote: row.changeNote ?? '',
  }),
  buildPayload: buildObjectivePayload,
  rowTitle: (row) => `${row.scope}${row.scopeRefId ? ` / ${row.scopeRefId}` : ''}`,
}
