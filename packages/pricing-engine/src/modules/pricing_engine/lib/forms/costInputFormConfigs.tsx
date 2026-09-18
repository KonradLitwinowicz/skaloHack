'use client'

import * as React from 'react'
import { Badge } from '@open-mercato/ui/primitives/badge'
import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { loadLaborRoleOptions, loadPackagingUnitOptions } from './paramOptions'
import { StepMultiplierField } from './StepMultiplierField'
import {
  demoColumn,
  isoToDateInput,
  optionalDate,
  readBoolean,
  readText,
  requireDate,
  requireDecimal,
  requireText,
  todayDateInput,
  versionColumns,
  type ParamFormValues,
  type ParamRowBase,
  type ParamScreenDescriptor,
} from './paramScreens'

/**
 * The cost inputs behind `operational_cost_base`, `packaging_cost` and `warehouse_cost`. All of
 * them are time-versioned, so every edit form gets the supersede/correct control from
 * `paramScreens` and every list shows which version is in force today.
 */

const validityFields = (t: TranslateFn) => [
  {
    id: 'validFrom' as const,
    type: 'date' as const,
    label: t('pricing_engine.params.field.validFrom', 'Valid from'),
    required: true,
    layout: 'half' as const,
  },
  {
    id: 'validTo' as const,
    type: 'date' as const,
    label: t('pricing_engine.params.field.validTo', 'Valid to'),
    description: t('pricing_engine.params.field.validToHint', 'Leave empty to keep it open-ended.'),
    layout: 'half' as const,
  },
]

function validityPayload(values: ParamFormValues, t: TranslateFn) {
  return {
    validFrom: requireDate(values, 'validFrom', t),
    validTo: optionalDate(values, 'validTo'),
  }
}

function validityValues(row: ParamRowBase) {
  return {
    validFrom: isoToDateInput(row.validFrom),
    validTo: isoToDateInput(row.validTo),
  }
}

// --- labour rates -----------------------------------------------------------

export type LaborRateRow = ParamRowBase & {
  roleCode: string
  label: string
  hourlyRate: string
  overheadRate: string
}

export const laborRateDescriptor: ParamScreenDescriptor<LaborRateRow> = {
  segment: 'labor-rates',
  apiPath: 'pricing/labor-rates',
  keyPrefix: 'pricing_engine.params.laborRates',
  titleFallback: 'Labour rates',
  resourceKind: 'pricing_engine.labor_rate',
  timeVersioned: true,
  searchPlaceholderFallback: 'Search by role',
  columns: (t) => [
    {
      accessorKey: 'roleCode',
      header: t('pricing_engine.params.laborRates.column.role', 'Role'),
      cell: ({ row }) => <span className="font-mono">{row.original.roleCode}</span>,
    },
    { accessorKey: 'label', header: t('pricing_engine.params.field.label', 'Name') },
    {
      accessorKey: 'hourlyRate',
      header: t('pricing_engine.params.laborRates.column.hourlyRate', 'Hourly rate'),
      cell: ({ row }) => <span className="font-mono">{row.original.hourlyRate}</span>,
    },
    {
      accessorKey: 'overheadRate',
      header: t('pricing_engine.params.laborRates.column.overhead', 'Overhead'),
      cell: ({ row }) => <span className="font-mono">{row.original.overheadRate}%</span>,
    },
    ...versionColumns<LaborRateRow>(t),
    demoColumn<LaborRateRow>(t),
  ],
  groups: (t) => [
    {
      id: 'rate',
      title: t('pricing_engine.params.laborRates.group.rate', 'Rate'),
      fields: [
        {
          id: 'roleCode',
          type: 'combobox',
          label: t('pricing_engine.params.laborRates.field.roleCode', 'Role code'),
          required: true,
          allowCustomValues: true,
          loadOptions: () => loadLaborRoleOptions(),
          description: t(
            'pricing_engine.params.laborRates.field.roleCodeHint',
            'Process steps, packaging and drivers all reference a role by this code.',
          ),
          layout: 'half',
        },
        {
          id: 'label',
          type: 'text',
          label: t('pricing_engine.params.field.label', 'Name'),
          required: true,
          layout: 'half',
        },
        {
          id: 'hourlyRate',
          type: 'number',
          label: t('pricing_engine.params.laborRates.field.hourlyRate', 'Hourly rate'),
          required: true,
          layout: 'half',
        },
        {
          id: 'overheadRate',
          type: 'number',
          label: t('pricing_engine.params.laborRates.field.overhead', 'Overhead (%)'),
          required: true,
          description: t(
            'pricing_engine.params.laborRates.field.overheadHint',
            'Added on top of the hourly rate, as a whole-number percent.',
          ),
          layout: 'half',
        },
        ...validityFields(t),
      ],
    },
  ],
  createDefaults: () => ({
    roleCode: '',
    label: '',
    hourlyRate: '',
    overheadRate: '0',
    validFrom: todayDateInput(),
    validTo: '',
  }),
  toValues: (row) => ({
    roleCode: row.roleCode,
    label: row.label,
    hourlyRate: row.hourlyRate,
    overheadRate: row.overheadRate,
    ...validityValues(row),
  }),
  buildPayload: (values, t) => ({
    roleCode: requireText(
      values,
      'roleCode',
      t,
      t('pricing_engine.params.laborRates.field.roleCode', 'Role code'),
    ),
    label: requireText(values, 'label', t, t('pricing_engine.params.field.label', 'Name')),
    hourlyRate: requireDecimal(
      values,
      'hourlyRate',
      t,
      t('pricing_engine.params.laborRates.field.hourlyRate', 'Hourly rate'),
    ),
    overheadRate: requireDecimal(
      values,
      'overheadRate',
      t,
      t('pricing_engine.params.laborRates.field.overhead', 'Overhead (%)'),
    ),
    ...validityPayload(values, t),
  }),
  rowTitle: (row) => row.label,
}

// --- process steps ----------------------------------------------------------

export type ProcessStepRow = ParamRowBase & {
  code: string
  label: string
  roleCode: string
  durationMinutes: string
  isPerLine: boolean
  isPerOrder: boolean
}

export const processStepDescriptor: ParamScreenDescriptor<ProcessStepRow> = {
  segment: 'process-steps',
  apiPath: 'pricing/process-steps',
  keyPrefix: 'pricing_engine.params.processSteps',
  titleFallback: 'Process steps',
  resourceKind: 'pricing_engine.process_step',
  timeVersioned: true,
  searchPlaceholderFallback: 'Search steps',
  columns: (t) => [
    {
      accessorKey: 'code',
      header: t('pricing_engine.params.field.code', 'Code'),
      cell: ({ row }) => <span className="font-mono">{row.original.code}</span>,
    },
    {
      accessorKey: 'roleCode',
      header: t('pricing_engine.params.laborRates.column.role', 'Role'),
    },
    {
      accessorKey: 'durationMinutes',
      header: t('pricing_engine.params.processSteps.column.duration', 'Minutes'),
      cell: ({ row }) => <span className="font-mono">{row.original.durationMinutes}</span>,
    },
    {
      accessorKey: 'appliesTo',
      header: t('pricing_engine.params.processSteps.column.appliesTo', 'Charged'),
      cell: ({ row }) => {
        const labels: string[] = []
        if (row.original.isPerOrder) {
          labels.push(t('pricing_engine.params.processSteps.perOrder', 'Per order'))
        }
        if (row.original.isPerLine) {
          labels.push(t('pricing_engine.params.processSteps.perLine', 'Per line'))
        }
        return labels.length > 0 ? (
          <span>{labels.join(' + ')}</span>
        ) : (
          <Badge variant="warning">
            {t('pricing_engine.params.processSteps.onDemand', 'Only via a scenario')}
          </Badge>
        )
      },
    },
    ...versionColumns<ProcessStepRow>(t),
    demoColumn<ProcessStepRow>(t),
  ],
  groups: (t) => [
    {
      id: 'step',
      title: t('pricing_engine.params.processSteps.group.step', 'Step'),
      fields: [
        {
          id: 'code',
          type: 'text',
          label: t('pricing_engine.params.field.code', 'Code'),
          required: true,
          layout: 'half',
        },
        {
          id: 'label',
          type: 'text',
          label: t('pricing_engine.params.field.label', 'Name'),
          required: true,
          layout: 'half',
        },
        {
          id: 'roleCode',
          type: 'combobox',
          label: t('pricing_engine.params.laborRates.field.roleCode', 'Role code'),
          required: true,
          allowCustomValues: true,
          loadOptions: () => loadLaborRoleOptions(),
          description: t(
            'pricing_engine.params.processSteps.field.roleCodeHint',
            'A step whose role has no labour rate costs nothing and is priced as free.',
          ),
          layout: 'half',
        },
        {
          id: 'durationMinutes',
          type: 'number',
          label: t('pricing_engine.params.processSteps.field.duration', 'Duration (minutes)'),
          required: true,
          layout: 'half',
        },
        {
          id: 'isPerOrder',
          type: 'checkbox',
          label: t('pricing_engine.params.processSteps.field.perOrder', 'Charged once per order'),
          layout: 'half',
        },
        {
          id: 'isPerLine',
          type: 'checkbox',
          label: t('pricing_engine.params.processSteps.field.perLine', 'Charged once per order line'),
          description: t(
            'pricing_engine.params.processSteps.field.appliesHint',
            'Leave both off for a step that only runs when a scenario adds it.',
          ),
          layout: 'half',
        },
        ...validityFields(t),
      ],
    },
  ],
  createDefaults: () => ({
    code: '',
    label: '',
    roleCode: '',
    durationMinutes: '',
    isPerOrder: true,
    isPerLine: false,
    validFrom: todayDateInput(),
    validTo: '',
  }),
  toValues: (row) => ({
    code: row.code,
    label: row.label,
    roleCode: row.roleCode,
    durationMinutes: row.durationMinutes,
    isPerOrder: row.isPerOrder,
    isPerLine: row.isPerLine,
    ...validityValues(row),
  }),
  buildPayload: (values, t) => ({
    code: requireText(values, 'code', t, t('pricing_engine.params.field.code', 'Code')),
    label: requireText(values, 'label', t, t('pricing_engine.params.field.label', 'Name')),
    roleCode: requireText(
      values,
      'roleCode',
      t,
      t('pricing_engine.params.laborRates.field.roleCode', 'Role code'),
    ),
    durationMinutes: requireDecimal(
      values,
      'durationMinutes',
      t,
      t('pricing_engine.params.processSteps.field.duration', 'Duration (minutes)'),
    ),
    isPerOrder: readBoolean(values, 'isPerOrder'),
    isPerLine: readBoolean(values, 'isPerLine'),
    ...validityPayload(values, t),
  }),
  rowTitle: (row) => row.label,
}

// --- order scenarios --------------------------------------------------------

export type OrderScenarioRow = ParamRowBase & {
  code: string
  label: string
  stepMultipliers: Record<string, string>
  extraStepCodes: string[]
}

export const orderScenarioDescriptor: ParamScreenDescriptor<OrderScenarioRow> = {
  segment: 'order-scenarios',
  apiPath: 'pricing/order-scenarios',
  keyPrefix: 'pricing_engine.params.orderScenarios',
  titleFallback: 'Order scenarios',
  resourceKind: 'pricing_engine.order_scenario',
  timeVersioned: true,
  searchPlaceholderFallback: 'Search scenarios',
  columns: (t) => [
    {
      accessorKey: 'code',
      header: t('pricing_engine.params.field.code', 'Code'),
      cell: ({ row }) => <span className="font-mono">{row.original.code}</span>,
    },
    { accessorKey: 'label', header: t('pricing_engine.params.field.label', 'Name') },
    {
      accessorKey: 'stepMultipliers',
      header: t('pricing_engine.params.orderScenarios.column.multipliers', 'Step multipliers'),
      cell: ({ row }) => {
        const entries = Object.entries(row.original.stepMultipliers ?? {})
        if (entries.length === 0) return '—'
        return (
          <span className="font-mono text-xs">
            {entries.map(([code, value]) => `${code} x${value}`).join(', ')}
          </span>
        )
      },
    },
    {
      accessorKey: 'extraStepCodes',
      header: t('pricing_engine.params.orderScenarios.column.extraSteps', 'Extra steps'),
      cell: ({ row }) => (row.original.extraStepCodes ?? []).join(', ') || '—',
    },
    ...versionColumns<OrderScenarioRow>(t),
    demoColumn<OrderScenarioRow>(t),
  ],
  groups: (t) => [
    {
      id: 'scenario',
      title: t('pricing_engine.params.orderScenarios.group.scenario', 'Scenario'),
      description: t(
        'pricing_engine.params.orderScenarios.group.scenarioHint',
        'A scenario reshapes the process steps for one kind of order: a phone order costs more intake time than an EDI one.',
      ),
      fields: [
        {
          id: 'code',
          type: 'text',
          label: t('pricing_engine.params.field.code', 'Code'),
          required: true,
          layout: 'half',
        },
        {
          id: 'label',
          type: 'text',
          label: t('pricing_engine.params.field.label', 'Name'),
          required: true,
          layout: 'half',
        },
        {
          id: 'stepMultipliers',
          type: 'custom',
          label: t('pricing_engine.params.orderScenarios.field.multipliers', 'Step multipliers'),
          component: StepMultiplierField,
        },
        {
          id: 'extraStepCodes',
          type: 'tags',
          label: t('pricing_engine.params.orderScenarios.field.extraSteps', 'Extra steps'),
          description: t(
            'pricing_engine.params.orderScenarios.field.extraStepsHint',
            'Step codes that only run under this scenario, such as dunning.',
          ),
        },
        ...validityFields(t),
      ],
    },
  ],
  createDefaults: () => ({
    code: '',
    label: '',
    stepMultipliers: {},
    extraStepCodes: [],
    validFrom: todayDateInput(),
    validTo: '',
  }),
  toValues: (row) => ({
    code: row.code,
    label: row.label,
    stepMultipliers: row.stepMultipliers ?? {},
    extraStepCodes: row.extraStepCodes ?? [],
    ...validityValues(row),
  }),
  buildPayload: (values, t) => {
    const rawMultipliers = values.stepMultipliers
    const multipliers =
      rawMultipliers && typeof rawMultipliers === 'object' && !Array.isArray(rawMultipliers)
        ? (rawMultipliers as Record<string, string>)
        : {}
    const rawExtras = values.extraStepCodes
    const extras = Array.isArray(rawExtras) ? rawExtras.map((code) => String(code).trim()) : []
    return {
      code: requireText(values, 'code', t, t('pricing_engine.params.field.code', 'Code')),
      label: requireText(values, 'label', t, t('pricing_engine.params.field.label', 'Name')),
      stepMultipliers: multipliers,
      extraStepCodes: extras.filter(Boolean),
      ...validityPayload(values, t),
    }
  },
  rowTitle: (row) => row.label,
}

// --- packaging costs --------------------------------------------------------

export type PackagingCostRow = ParamRowBase & {
  unitCode: string
  materialCost: string
  packMinutes: string
  roleCode: string
}

export const packagingCostDescriptor: ParamScreenDescriptor<PackagingCostRow> = {
  segment: 'packaging-costs',
  apiPath: 'pricing/packaging-costs',
  keyPrefix: 'pricing_engine.params.packagingCosts',
  titleFallback: 'Packaging costs',
  resourceKind: 'pricing_engine.packaging_cost',
  timeVersioned: true,
  searchPlaceholderFallback: 'Search by packaging unit',
  columns: (t) => [
    {
      accessorKey: 'unitCode',
      header: t('pricing_engine.params.packagingCosts.column.unit', 'Unit'),
      cell: ({ row }) => <span className="font-mono">{row.original.unitCode}</span>,
    },
    {
      accessorKey: 'materialCost',
      header: t('pricing_engine.params.packagingCosts.column.material', 'Material cost'),
      cell: ({ row }) => <span className="font-mono">{row.original.materialCost}</span>,
    },
    {
      accessorKey: 'packMinutes',
      header: t('pricing_engine.params.packagingCosts.column.minutes', 'Pack minutes'),
      cell: ({ row }) => <span className="font-mono">{row.original.packMinutes}</span>,
    },
    {
      accessorKey: 'roleCode',
      header: t('pricing_engine.params.laborRates.column.role', 'Role'),
    },
    ...versionColumns<PackagingCostRow>(t),
    demoColumn<PackagingCostRow>(t),
  ],
  groups: (t) => [
    {
      id: 'packaging',
      title: t('pricing_engine.params.packagingCosts.group.packaging', 'Packaging'),
      fields: [
        {
          id: 'unitCode',
          type: 'combobox',
          label: t('pricing_engine.params.packagingCosts.field.unit', 'Packaging unit'),
          required: true,
          allowCustomValues: true,
          loadOptions: () => loadPackagingUnitOptions(),
          layout: 'half',
        },
        {
          id: 'roleCode',
          type: 'combobox',
          label: t('pricing_engine.params.laborRates.field.roleCode', 'Role code'),
          required: true,
          allowCustomValues: true,
          loadOptions: () => loadLaborRoleOptions(),
          layout: 'half',
        },
        {
          id: 'materialCost',
          type: 'number',
          label: t('pricing_engine.params.packagingCosts.field.material', 'Material cost'),
          required: true,
          layout: 'half',
        },
        {
          id: 'packMinutes',
          type: 'number',
          label: t('pricing_engine.params.packagingCosts.field.minutes', 'Pack minutes'),
          required: true,
          layout: 'half',
        },
        ...validityFields(t),
      ],
    },
  ],
  createDefaults: () => ({
    unitCode: '',
    roleCode: '',
    materialCost: '',
    packMinutes: '',
    validFrom: todayDateInput(),
    validTo: '',
  }),
  toValues: (row) => ({
    unitCode: row.unitCode,
    roleCode: row.roleCode,
    materialCost: row.materialCost,
    packMinutes: row.packMinutes,
    ...validityValues(row),
  }),
  buildPayload: (values, t) => ({
    unitCode: requireText(
      values,
      'unitCode',
      t,
      t('pricing_engine.params.packagingCosts.field.unit', 'Packaging unit'),
    ),
    roleCode: requireText(
      values,
      'roleCode',
      t,
      t('pricing_engine.params.laborRates.field.roleCode', 'Role code'),
    ),
    materialCost: requireDecimal(
      values,
      'materialCost',
      t,
      t('pricing_engine.params.packagingCosts.field.material', 'Material cost'),
    ),
    packMinutes: requireDecimal(
      values,
      'packMinutes',
      t,
      t('pricing_engine.params.packagingCosts.field.minutes', 'Pack minutes'),
    ),
    ...validityPayload(values, t),
  }),
  rowTitle: (row) => row.unitCode,
}

// --- warehouse costs --------------------------------------------------------

export type WarehouseCostRow = ParamRowBase & {
  basis: string
  costPerMonth: string
  capitalCostAnnualRate: string
  defaultTurnoverDays: number
}

export const warehouseCostDescriptor: ParamScreenDescriptor<WarehouseCostRow> = {
  segment: 'warehouse-costs',
  apiPath: 'pricing/warehouse-costs',
  keyPrefix: 'pricing_engine.params.warehouseCosts',
  titleFallback: 'Warehouse costs',
  resourceKind: 'pricing_engine.warehouse_cost',
  timeVersioned: true,
  searchPlaceholderFallback: 'Search by basis',
  columns: (t) => [
    {
      accessorKey: 'basis',
      header: t('pricing_engine.params.warehouseCosts.column.basis', 'Basis'),
      cell: ({ row }) => <span className="font-mono">{row.original.basis}</span>,
    },
    {
      accessorKey: 'costPerMonth',
      header: t('pricing_engine.params.warehouseCosts.column.cost', 'Cost per month'),
      cell: ({ row }) => <span className="font-mono">{row.original.costPerMonth}</span>,
    },
    {
      accessorKey: 'capitalCostAnnualRate',
      header: t('pricing_engine.params.warehouseCosts.column.capital', 'Capital cost'),
      cell: ({ row }) => <span className="font-mono">{row.original.capitalCostAnnualRate}%</span>,
    },
    {
      accessorKey: 'defaultTurnoverDays',
      header: t('pricing_engine.params.warehouseCosts.column.turnover', 'Turnover (days)'),
    },
    ...versionColumns<WarehouseCostRow>(t),
    demoColumn<WarehouseCostRow>(t),
  ],
  groups: (t) => [
    {
      id: 'warehouse',
      title: t('pricing_engine.params.warehouseCosts.group.warehouse', 'Warehouse'),
      description: t(
        'pricing_engine.params.warehouseCosts.group.warehouseHint',
        'Only the newest version in force is used, whatever its basis — a second row does not add a second cost.',
      ),
      fields: [
        {
          id: 'basis',
          type: 'select',
          label: t('pricing_engine.params.warehouseCosts.field.basis', 'Basis'),
          required: true,
          options: [
            { value: 'm2', label: t('pricing_engine.params.warehouseCosts.basis.m2', 'Per square metre') },
            {
              value: 'pallet_slot',
              label: t('pricing_engine.params.warehouseCosts.basis.palletSlot', 'Per pallet slot'),
            },
          ],
          layout: 'half',
        },
        {
          id: 'costPerMonth',
          type: 'number',
          label: t('pricing_engine.params.warehouseCosts.field.cost', 'Cost per month'),
          required: true,
          layout: 'half',
        },
        {
          id: 'capitalCostAnnualRate',
          type: 'number',
          label: t('pricing_engine.params.warehouseCosts.field.capital', 'Capital cost per year (%)'),
          required: true,
          layout: 'half',
        },
        {
          id: 'defaultTurnoverDays',
          type: 'number',
          label: t('pricing_engine.params.warehouseCosts.field.turnover', 'Default turnover (days)'),
          required: true,
          layout: 'half',
        },
        ...validityFields(t),
      ],
    },
  ],
  createDefaults: () => ({
    basis: 'm2',
    costPerMonth: '',
    capitalCostAnnualRate: '0',
    defaultTurnoverDays: '30',
    validFrom: todayDateInput(),
    validTo: '',
  }),
  toValues: (row) => ({
    basis: row.basis,
    costPerMonth: row.costPerMonth,
    capitalCostAnnualRate: row.capitalCostAnnualRate,
    defaultTurnoverDays: String(row.defaultTurnoverDays),
    ...validityValues(row),
  }),
  buildPayload: (values, t) => ({
    basis: readText(values, 'basis') === 'pallet_slot' ? 'pallet_slot' : 'm2',
    costPerMonth: requireDecimal(
      values,
      'costPerMonth',
      t,
      t('pricing_engine.params.warehouseCosts.field.cost', 'Cost per month'),
    ),
    capitalCostAnnualRate: requireDecimal(
      values,
      'capitalCostAnnualRate',
      t,
      t('pricing_engine.params.warehouseCosts.field.capital', 'Capital cost per year (%)'),
    ),
    defaultTurnoverDays: Number(
      requireDecimal(
        values,
        'defaultTurnoverDays',
        t,
        t('pricing_engine.params.warehouseCosts.field.turnover', 'Default turnover (days)'),
      ),
    ),
    ...validityPayload(values, t),
  }),
  rowTitle: (row) => row.basis,
}
