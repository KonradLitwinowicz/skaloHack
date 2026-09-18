'use client'

import * as React from 'react'
import { Badge } from '@open-mercato/ui/primitives/badge'
import type { CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { TARGET_MARGIN_COMPONENT_CODE } from '../../data/validators'
import { marginFromMarkup } from '../frontend/marginMath'
import { MarkupMarginField } from './MarkupMarginField'
import { markShadowedRules } from './marginRuleMath'
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
  readText,
  requireDate,
  requireDecimal,
  requireText,
  todayDateInput,
  versionColumns,
  type ParamFormMode,
  type ParamFormValues,
  type ParamRowBase,
  type ParamScreenDescriptor,
} from './paramScreens'

export type MarginRuleRow = ParamRowBase & {
  componentCode: string
  scope: string
  scopeRefId: string | null
  targetMarkupPercent: string | null
  changeNote: string | null
  /** Set client-side: another rule with the same scope key and a newer validFrom wins over this one. */
  isShadowed?: boolean
}

function formatPercent(value: string | null): string {
  if (!value) return '—'
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return value
  return `${Number(parsed.toFixed(4))}%`
}

function groups(t: TranslateFn, mode: ParamFormMode): CrudFormGroup[] {
  return [
    {
      id: 'scope',
      title: t('pricing_engine.params.marginRules.group.scope', 'Who does this rule price?'),
      fields: scopeFields(t),
    },
    {
      id: 'margin',
      title: t('pricing_engine.params.marginRules.group.margin', 'Target margin'),
      description: t(
        'pricing_engine.params.marginRules.group.marginDescription',
        'The engine stores the markup on cost; the margin on price is shown alongside because that is what a contract is usually written in.',
      ),
      fields: [
        {
          id: 'targetMarkupPercent',
          type: 'custom',
          label: t('pricing_engine.params.marginRules.field.target', 'Target'),
          required: true,
          component: MarkupMarginField,
        },
      ],
    },
    {
      id: 'validity',
      title: t('pricing_engine.params.marginRules.group.validity', 'When does it apply?'),
      fields: [
        {
          id: 'validFrom',
          type: 'date',
          label: t('pricing_engine.params.field.validFrom', 'Valid from'),
          required: true,
          description:
            mode === 'create'
              ? t(
                  'pricing_engine.params.marginRules.field.validFromHint',
                  'Quotes dated before this keep the rule that was in force then. Backdate it to cover historical replays.',
                )
              : undefined,
          layout: 'half',
        },
        {
          id: 'validTo',
          type: 'date',
          label: t('pricing_engine.params.field.validTo', 'Valid to'),
          description: t(
            'pricing_engine.params.field.validToHint',
            'Leave empty to keep it open-ended.',
          ),
          layout: 'half',
        },
        {
          id: 'changeNote',
          type: 'textarea',
          label: t('pricing_engine.params.marginRules.field.changeNote', 'Why this number?'),
          required: true,
          rows: 3,
          description: t(
            'pricing_engine.params.marginRules.field.changeNoteHint',
            'Recorded against the rule. It is the only explanation anyone will have in six months.',
          ),
        },
      ],
    },
  ]
}

function buildPayload(values: ParamFormValues, t: TranslateFn): Record<string, unknown> {
  const { scope, scopeRefId } = readScopeRef(values, t)
  return {
    componentCode: TARGET_MARGIN_COMPONENT_CODE,
    scope,
    scopeRefId,
    targetMarkupPercent: requireDecimal(
      values,
      'targetMarkupPercent',
      t,
      t('pricing_engine.params.marginRules.field.markupOnCost', 'Markup on cost (%)'),
    ),
    validFrom: requireDate(values, 'validFrom', t),
    validTo: optionalDate(values, 'validTo'),
    changeNote: requireText(
      values,
      'changeNote',
      t,
      t('pricing_engine.params.marginRules.field.changeNote', 'Why this number?'),
    ),
  }
}

export const marginRuleDescriptor: ParamScreenDescriptor<MarginRuleRow> = {
  segment: 'margin-rules',
  apiPath: 'pricing/margin-rules',
  keyPrefix: 'pricing_engine.params.marginRules',
  titleFallback: 'Margin rules',
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
          {row.original.isShadowed ? (
            <Badge variant="warning">
              {t(
                'pricing_engine.params.marginRules.shadowed',
                'A newer version of the same rule is winning',
              )}
            </Badge>
          ) : null}
        </div>
      ),
    },
    {
      accessorKey: 'precedence',
      header: t('pricing_engine.params.marginRules.column.precedence', 'Beats'),
      cell: ({ row }) => (
        <Badge variant="outline">
          {t('pricing_engine.params.marginRules.column.precedenceValue', 'Rank {rank} of 5', {
            rank: String(scopePrecedenceRank(row.original.scope) + 1),
          })}
        </Badge>
      ),
    },
    {
      accessorKey: 'targetMarkupPercent',
      header: t('pricing_engine.params.marginRules.column.markup', 'Markup on cost'),
      cell: ({ row }) => (
        <span className="font-mono">{formatPercent(row.original.targetMarkupPercent)}</span>
      ),
    },
    {
      accessorKey: 'derivedMargin',
      header: t('pricing_engine.params.marginRules.column.margin', 'Margin on price'),
      cell: ({ row }) => (
        <span className="font-mono">
          {row.original.targetMarkupPercent
            ? formatPercent(marginFromMarkup(row.original.targetMarkupPercent))
            : '—'}
        </span>
      ),
    },
    ...versionColumns<MarginRuleRow>(t),
    demoColumn<MarginRuleRow>(t),
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
  decorateRows: (rows) => markShadowedRules(rows, new Date()),
  groups,
  createDefaults: () => ({
    scope: 'global',
    ...scopeValues('global', null),
    targetMarkupPercent: '',
    validFrom: todayDateInput(),
    validTo: '',
    changeNote: '',
  }),
  toValues: (row) => ({
    ...scopeValues(row.scope, row.scopeRefId),
    targetMarkupPercent: row.targetMarkupPercent ?? '',
    validFrom: isoToDateInput(row.validFrom),
    validTo: isoToDateInput(row.validTo),
    changeNote: row.changeNote ?? '',
  }),
  buildPayload,
  rowTitle: (row) => `${row.scope}${row.scopeRefId ? ` / ${row.scopeRefId}` : ''}`,
}

export { buildPayload as buildMarginRulePayload, formatPercent as formatMarginPercent, readText }
