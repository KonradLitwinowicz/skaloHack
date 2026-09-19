'use client'

import * as React from 'react'
import { Badge } from '@open-mercato/ui/primitives/badge'
import type { CrudField, CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { assertMinMarginPercent, normalizeNegotiatedPrecedence } from './paramValues'
import { markShadowedRules } from './marginRuleMath'
import {
  readScopeRef,
  scopeFields,
  scopeLabel,
  scopeOptions,
  scopeValues,
} from './scopeFields'
import {
  demoColumn,
  isoToDateInput,
  optionalDate,
  optionalDecimal,
  readText,
  requireDate,
  requireText,
  todayDateInput,
  versionColumns,
  type ParamFormMode,
  type ParamFormValues,
  type ParamRowBase,
  type ParamScreenDescriptor,
} from './paramScreens'

export type GuardrailRow = ParamRowBase & {
  code: string
  scope: string
  scopeRefId: string | null
  minMarginPercent: string | null
  maxDiscountPercent: string | null
  floorPrice: string | null
  negotiatedPricePrecedence: string
  /** Set client-side: another guardrail with the same scope key and a newer validFrom wins. */
  isShadowed?: boolean
}

function formatPercent(value: string | null): string {
  if (!value) return '—'
  const parsed = Number(value)
  return Number.isFinite(parsed) ? `${Number(parsed.toFixed(4))}%` : value
}

function precedenceOptions(t: TranslateFn) {
  return [
    {
      value: 'negotiated_wins',
      label: t(
        'pricing_engine.params.guardrails.precedence.negotiated',
        'A negotiated price overrides the calculation',
      ),
    },
    {
      value: 'rules_win',
      label: t('pricing_engine.params.guardrails.precedence.rules', 'The calculation always wins'),
    },
  ]
}

function groups(t: TranslateFn, _mode: ParamFormMode): CrudFormGroup[] {
  const limitFields: CrudField[] = [
    {
      id: 'minMarginPercent',
      type: 'number',
      label: t('pricing_engine.params.guardrails.field.minMargin', 'Minimum margin on price (%)'),
      description: t(
        'pricing_engine.params.guardrails.field.minMarginHint',
        'The price is raised to cost / (1 - margin) whenever the calculation lands below this.',
      ),
      layout: 'half',
    },
    {
      id: 'floorPrice',
      type: 'number',
      label: t('pricing_engine.params.guardrails.field.floorPrice', 'Absolute floor price'),
      description: t(
        'pricing_engine.params.guardrails.field.floorPriceHint',
        'Applied before the margin floor, in the quote currency.',
      ),
      layout: 'half',
    },
  ]

  // Enforced by `lib/components/guardrails.ts` on negotiated prices only: a negotiated price is
  // raised to the engine's target less this percentage. Expiry and deadstock markdowns are not capped.
  limitFields.push({
    id: 'maxDiscountPercent',
    type: 'number',
    label: t('pricing_engine.params.guardrails.field.maxDiscount', 'Maximum discount (%)'),
    description: t(
      'pricing_engine.params.guardrails.hint.maxDiscount',
      'A negotiated price may not fall more than this far below the calculated price; lower ones are raised to that limit.',
    ),
    layout: 'half',
  })

  return [
    {
      id: 'identity',
      title: t('pricing_engine.params.guardrails.group.identity', 'Which guardrail is this?'),
      fields: [
        {
          id: 'code',
          type: 'text',
          label: t('pricing_engine.params.guardrails.field.code', 'Code'),
          required: true,
          description: t(
            'pricing_engine.params.guardrails.field.codeHint',
            'A short handle for this guardrail, for example floor-hospital.',
          ),
          layout: 'half',
        },
        ...scopeFields(t),
      ],
    },
    {
      id: 'limits',
      title: t('pricing_engine.params.guardrails.group.limits', 'Floors'),
      fields: limitFields,
    },
    {
      id: 'precedence',
      title: t('pricing_engine.params.guardrails.group.precedence', 'Negotiated prices'),
      fields: [
        {
          id: 'negotiatedPricePrecedence',
          type: 'select',
          label: t('pricing_engine.params.guardrails.field.precedence', 'When a negotiated price exists'),
          required: true,
          options: precedenceOptions(t),
        },
      ],
    },
    {
      id: 'validity',
      title: t('pricing_engine.params.guardrails.group.validity', 'When does it apply?'),
      fields: [
        {
          id: 'validFrom',
          type: 'date',
          label: t('pricing_engine.params.field.validFrom', 'Valid from'),
          required: true,
          layout: 'half',
        },
        {
          id: 'validTo',
          type: 'date',
          label: t('pricing_engine.params.field.validTo', 'Valid to'),
          description: t('pricing_engine.params.field.validToHint', 'Leave empty to keep it open-ended.'),
          layout: 'half',
        },
      ],
    },
  ]
}

function buildPayload(values: ParamFormValues, t: TranslateFn): Record<string, unknown> {
  const { scope, scopeRefId } = readScopeRef(values, t)
  const minMarginPercent = assertMinMarginPercent(
    optionalDecimal(
      values,
      'minMarginPercent',
      t,
      t('pricing_engine.params.guardrails.field.minMargin', 'Minimum margin on price (%)'),
    ),
    t,
  )
  return {
    code: requireText(values, 'code', t, t('pricing_engine.params.guardrails.field.code', 'Code')),
    scope,
    scopeRefId,
    minMarginPercent,
    maxDiscountPercent: optionalDecimal(
      values,
      'maxDiscountPercent',
      t,
      t('pricing_engine.params.guardrails.field.maxDiscount', 'Maximum discount (%)'),
    ),
    floorPrice: optionalDecimal(
      values,
      'floorPrice',
      t,
      t('pricing_engine.params.guardrails.field.floorPrice', 'Absolute floor price'),
    ),
    negotiatedPricePrecedence: normalizeNegotiatedPrecedence(
      readText(values, 'negotiatedPricePrecedence'),
    ),
    validFrom: requireDate(values, 'validFrom', t),
    validTo: optionalDate(values, 'validTo'),
  }
}

export const guardrailDescriptor: ParamScreenDescriptor<GuardrailRow> = {
  segment: 'guardrails',
  apiPath: 'pricing/guardrails',
  keyPrefix: 'pricing_engine.params.guardrails',
  titleFallback: 'Guardrails',
  resourceKind: 'pricing_engine.guardrail',
  timeVersioned: true,
  searchPlaceholderFallback: 'Search by code or scope reference',
  columns: (t) => [
    {
      accessorKey: 'code',
      header: t('pricing_engine.params.guardrails.field.code', 'Code'),
      cell: ({ row }) => <span className="font-medium">{row.original.code}</span>,
    },
    {
      accessorKey: 'scope',
      header: t('pricing_engine.params.field.scope', 'Applies to'),
      cell: ({ row }) => (
        <div className="space-y-0.5">
          <div>{scopeLabel(t, row.original.scope)}</div>
          {row.original.scopeRefId ? (
            <div className="font-mono text-xs text-muted-foreground">{row.original.scopeRefId}</div>
          ) : null}
          {row.original.isShadowed ? (
            <Badge variant="warning">
              {t(
                'pricing_engine.params.guardrails.shadowed',
                'A newer version of the same guardrail is winning',
              )}
            </Badge>
          ) : null}
        </div>
      ),
    },
    {
      accessorKey: 'minMarginPercent',
      header: t('pricing_engine.params.guardrails.column.minMargin', 'Minimum margin'),
      cell: ({ row }) => <span className="font-mono">{formatPercent(row.original.minMarginPercent)}</span>,
    },
    {
      accessorKey: 'floorPrice',
      header: t('pricing_engine.params.guardrails.column.floorPrice', 'Floor price'),
      cell: ({ row }) => <span className="font-mono">{row.original.floorPrice ?? '—'}</span>,
    },
    {
      accessorKey: 'negotiatedPricePrecedence',
      header: t('pricing_engine.params.guardrails.column.precedence', 'Negotiated price'),
      cell: ({ row }) =>
        row.original.negotiatedPricePrecedence === 'negotiated_wins' ? (
          <Badge variant="info">
            {t('pricing_engine.params.guardrails.precedence.negotiatedShort', 'Overrides')}
          </Badge>
        ) : (
          <Badge variant="outline">
            {t('pricing_engine.params.guardrails.precedence.rulesShort', 'Ignored')}
          </Badge>
        ),
    },
    ...versionColumns<GuardrailRow>(t),
    demoColumn<GuardrailRow>(t),
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
    code: '',
    ...scopeValues('global', null),
    minMarginPercent: '',
    maxDiscountPercent: '',
    floorPrice: '',
    negotiatedPricePrecedence: 'negotiated_wins',
    validFrom: todayDateInput(),
    validTo: '',
  }),
  toValues: (row) => ({
    code: row.code,
    ...scopeValues(row.scope, row.scopeRefId),
    minMarginPercent: row.minMarginPercent ?? '',
    maxDiscountPercent: row.maxDiscountPercent ?? '',
    floorPrice: row.floorPrice ?? '',
    negotiatedPricePrecedence: row.negotiatedPricePrecedence,
    validFrom: isoToDateInput(row.validFrom),
    validTo: isoToDateInput(row.validTo),
  }),
  buildPayload,
  rowTitle: (row) => row.code,
}

export { buildPayload as buildGuardrailPayload }
