'use client'

import * as React from 'react'
import { BooleanIcon } from '@open-mercato/ui/backend/ValueIcons'
import type { CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { loadFuelTypeOptions, loadLaborRoleOptions, loadVehicleCodeOptions } from './paramOptions'
import {
  demoColumn,
  isoToDateInput,
  optionalDecimal,
  readBoolean,
  readOptionalText,
  readText,
  requireDate,
  requireDecimal,
  requireText,
  todayDateInput,
  type ParamFormValues,
  type ParamRowBase,
  type ParamScreenDescriptor,
} from './paramScreens'

/**
 * The three tables that make a delivery cost computable: the zone (how far and how many stops), the
 * vehicle (what it burns and who drives it) and the fuel price observed on a date. A mismatch
 * between them is silent in the engine — a vehicle whose `fuel_type` has no observation, or whose
 * `driver_role_code` has no labour rate, simply contributes nothing — so each form offers the codes
 * that actually exist rather than a free text box.
 */

export type DeliveryZoneRow = ParamRowBase & {
  code: string
  label: string
  avgDistanceKm: string
  avgDriveMinutes: string
  typicalStops: number
  defaultVehicleCode: string | null
}

export type VehicleRow = ParamRowBase & {
  code: string
  label: string
  capacityKg: string | null
  capacityM3: string | null
  capacityPallets: number | null
  fuelType: string
  consumptionLPer100Km: string
  fixedCostMonth: string
  driverRoleCode: string
  isActive: boolean
}

export type FuelPriceRow = ParamRowBase & {
  fuelType: string
  pricePerLitre: string
  observedOn: string | null
}

function zoneGroups(t: TranslateFn): CrudFormGroup[] {
  return [
    {
      id: 'identity',
      title: t('pricing_engine.params.deliveryZones.group.identity', 'Zone'),
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
      ],
    },
    {
      id: 'route',
      title: t('pricing_engine.params.deliveryZones.group.route', 'Typical run'),
      description: t(
        'pricing_engine.params.deliveryZones.group.routeHint',
        'Re-running the demo zone seeder overwrites these figures from customer geography.',
      ),
      fields: [
        {
          id: 'avgDistanceKm',
          type: 'number',
          label: t('pricing_engine.params.deliveryZones.field.distance', 'Average distance (km)'),
          required: true,
          layout: 'third',
        },
        {
          id: 'avgDriveMinutes',
          type: 'number',
          label: t('pricing_engine.params.deliveryZones.field.driveMinutes', 'Average drive (minutes)'),
          required: true,
          layout: 'third',
        },
        {
          id: 'typicalStops',
          type: 'number',
          label: t('pricing_engine.params.deliveryZones.field.stops', 'Stops per run'),
          required: true,
          description: t(
            'pricing_engine.params.deliveryZones.field.stopsHint',
            "The run's cost is divided across this many deliveries.",
          ),
          layout: 'third',
        },
        {
          id: 'defaultVehicleCode',
          type: 'combobox',
          label: t('pricing_engine.params.deliveryZones.field.vehicle', 'Default vehicle'),
          allowCustomValues: true,
          loadOptions: () => loadVehicleCodeOptions(),
        },
      ],
    },
  ]
}

export const deliveryZoneDescriptor: ParamScreenDescriptor<DeliveryZoneRow> = {
  segment: 'delivery-zones',
  apiPath: 'pricing/delivery-zones',
  keyPrefix: 'pricing_engine.params.deliveryZones',
  titleFallback: 'Delivery zones',
  resourceKind: 'pricing_engine.delivery_zone',
  timeVersioned: false,
  searchPlaceholderFallback: 'Search zones',
  columns: (t) => [
    {
      accessorKey: 'code',
      header: t('pricing_engine.params.field.code', 'Code'),
      cell: ({ row }) => <span className="font-mono">{row.original.code}</span>,
    },
    { accessorKey: 'label', header: t('pricing_engine.params.field.label', 'Name') },
    {
      accessorKey: 'avgDistanceKm',
      header: t('pricing_engine.params.deliveryZones.column.distance', 'Distance (km)'),
      cell: ({ row }) => <span className="font-mono">{row.original.avgDistanceKm}</span>,
    },
    {
      accessorKey: 'avgDriveMinutes',
      header: t('pricing_engine.params.deliveryZones.column.driveMinutes', 'Drive (min)'),
      cell: ({ row }) => <span className="font-mono">{row.original.avgDriveMinutes}</span>,
    },
    {
      accessorKey: 'typicalStops',
      header: t('pricing_engine.params.deliveryZones.column.stops', 'Stops'),
    },
    {
      accessorKey: 'defaultVehicleCode',
      header: t('pricing_engine.params.deliveryZones.column.vehicle', 'Vehicle'),
      cell: ({ row }) => row.original.defaultVehicleCode ?? '—',
    },
    demoColumn<DeliveryZoneRow>(t),
  ],
  groups: (t) => zoneGroups(t),
  createDefaults: () => ({
    code: '',
    label: '',
    avgDistanceKm: '',
    avgDriveMinutes: '',
    typicalStops: '1',
    defaultVehicleCode: '',
  }),
  toValues: (row) => ({
    code: row.code,
    label: row.label,
    avgDistanceKm: row.avgDistanceKm,
    avgDriveMinutes: row.avgDriveMinutes,
    typicalStops: String(row.typicalStops),
    defaultVehicleCode: row.defaultVehicleCode ?? '',
  }),
  buildPayload: (values, t) => ({
    code: requireText(values, 'code', t, t('pricing_engine.params.field.code', 'Code')),
    label: requireText(values, 'label', t, t('pricing_engine.params.field.label', 'Name')),
    avgDistanceKm: requireDecimal(
      values,
      'avgDistanceKm',
      t,
      t('pricing_engine.params.deliveryZones.field.distance', 'Average distance (km)'),
    ),
    avgDriveMinutes: requireDecimal(
      values,
      'avgDriveMinutes',
      t,
      t('pricing_engine.params.deliveryZones.field.driveMinutes', 'Average drive (minutes)'),
    ),
    typicalStops: Number(
      requireDecimal(
        values,
        'typicalStops',
        t,
        t('pricing_engine.params.deliveryZones.field.stops', 'Stops per run'),
      ),
    ),
    defaultVehicleCode: readOptionalText(values, 'defaultVehicleCode'),
  }),
  rowTitle: (row) => row.label,
}

function vehicleGroups(t: TranslateFn): CrudFormGroup[] {
  return [
    {
      id: 'identity',
      title: t('pricing_engine.params.vehicles.group.identity', 'Vehicle'),
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
          id: 'isActive',
          type: 'checkbox',
          label: t('pricing_engine.params.vehicles.field.isActive', 'In the fleet'),
          description: t(
            'pricing_engine.params.vehicles.field.isActiveHint',
            'Only active vehicles are considered when a delivery cost is computed.',
          ),
        },
      ],
    },
    {
      id: 'capacity',
      title: t('pricing_engine.params.vehicles.group.capacity', 'Capacity'),
      description: t(
        'pricing_engine.params.vehicles.group.capacityHint',
        'At least one capacity is needed — it is the divisor that spreads a run across a load.',
      ),
      fields: [
        {
          id: 'capacityKg',
          type: 'number',
          label: t('pricing_engine.params.vehicles.field.capacityKg', 'Payload (kg)'),
          layout: 'third',
        },
        {
          id: 'capacityM3',
          type: 'number',
          label: t('pricing_engine.params.vehicles.field.capacityM3', 'Volume (m3)'),
          layout: 'third',
        },
        {
          id: 'capacityPallets',
          type: 'number',
          label: t('pricing_engine.params.vehicles.field.capacityPallets', 'Pallet slots'),
          layout: 'third',
        },
      ],
    },
    {
      id: 'running',
      title: t('pricing_engine.params.vehicles.group.running', 'Running cost'),
      fields: [
        {
          id: 'fuelType',
          type: 'combobox',
          label: t('pricing_engine.params.vehicles.field.fuelType', 'Fuel type'),
          required: true,
          allowCustomValues: true,
          loadOptions: () => loadFuelTypeOptions(),
          description: t(
            'pricing_engine.params.vehicles.field.fuelTypeHint',
            'Needs a matching fuel price observation, otherwise the delivery cost is skipped.',
          ),
          layout: 'half',
        },
        {
          id: 'consumptionLPer100Km',
          type: 'number',
          label: t('pricing_engine.params.vehicles.field.consumption', 'Consumption (l/100 km)'),
          required: true,
          layout: 'half',
        },
        {
          id: 'fixedCostMonth',
          type: 'number',
          label: t('pricing_engine.params.vehicles.field.fixedCost', 'Fixed cost per month'),
          required: true,
          layout: 'half',
        },
        {
          id: 'driverRoleCode',
          type: 'combobox',
          label: t('pricing_engine.params.vehicles.field.driverRole', 'Driver role'),
          required: true,
          allowCustomValues: true,
          loadOptions: () => loadLaborRoleOptions(),
          description: t(
            'pricing_engine.params.vehicles.field.driverRoleHint',
            'Needs a matching labour rate, otherwise the driver costs nothing.',
          ),
          layout: 'half',
        },
      ],
    },
  ]
}

export const vehicleDescriptor: ParamScreenDescriptor<VehicleRow> = {
  segment: 'vehicles',
  apiPath: 'pricing/vehicles',
  keyPrefix: 'pricing_engine.params.vehicles',
  titleFallback: 'Vehicles',
  resourceKind: 'pricing_engine.vehicle',
  timeVersioned: false,
  searchPlaceholderFallback: 'Search vehicles',
  columns: (t) => [
    {
      accessorKey: 'code',
      header: t('pricing_engine.params.field.code', 'Code'),
      cell: ({ row }) => <span className="font-mono">{row.original.code}</span>,
    },
    { accessorKey: 'label', header: t('pricing_engine.params.field.label', 'Name') },
    {
      accessorKey: 'fuelType',
      header: t('pricing_engine.params.vehicles.column.fuelType', 'Fuel'),
    },
    {
      accessorKey: 'consumptionLPer100Km',
      header: t('pricing_engine.params.vehicles.column.consumption', 'l/100 km'),
      cell: ({ row }) => <span className="font-mono">{row.original.consumptionLPer100Km}</span>,
    },
    {
      accessorKey: 'driverRoleCode',
      header: t('pricing_engine.params.vehicles.column.driverRole', 'Driver role'),
    },
    {
      accessorKey: 'isActive',
      header: t('pricing_engine.params.vehicles.column.isActive', 'In fleet'),
      cell: ({ row }) => <BooleanIcon value={row.original.isActive} />,
    },
    demoColumn<VehicleRow>(t),
  ],
  filters: (t) => [
    {
      id: 'isActive',
      type: 'select',
      label: t('pricing_engine.params.vehicles.column.isActive', 'In fleet'),
      options: [
        { value: 'true', label: t('pricing_engine.params.filter.yes', 'Yes') },
        { value: 'false', label: t('pricing_engine.params.filter.no', 'No') },
      ],
    },
  ] satisfies FilterDef[],
  filterParams: (values: FilterValues) => ({
    isActive: typeof values.isActive === 'string' ? values.isActive : '',
  }),
  groups: (t) => vehicleGroups(t),
  createDefaults: () => ({
    code: '',
    label: '',
    capacityKg: '',
    capacityM3: '',
    capacityPallets: '',
    fuelType: '',
    consumptionLPer100Km: '',
    fixedCostMonth: '0',
    driverRoleCode: '',
    isActive: true,
  }),
  toValues: (row) => ({
    code: row.code,
    label: row.label,
    capacityKg: row.capacityKg ?? '',
    capacityM3: row.capacityM3 ?? '',
    capacityPallets: row.capacityPallets === null ? '' : String(row.capacityPallets),
    fuelType: row.fuelType,
    consumptionLPer100Km: row.consumptionLPer100Km,
    fixedCostMonth: row.fixedCostMonth,
    driverRoleCode: row.driverRoleCode,
    isActive: row.isActive,
  }),
  buildPayload: (values: ParamFormValues, t) => {
    const pallets = readText(values, 'capacityPallets')
    return {
      code: requireText(values, 'code', t, t('pricing_engine.params.field.code', 'Code')),
      label: requireText(values, 'label', t, t('pricing_engine.params.field.label', 'Name')),
      capacityKg: optionalDecimal(
        values,
        'capacityKg',
        t,
        t('pricing_engine.params.vehicles.field.capacityKg', 'Payload (kg)'),
      ),
      capacityM3: optionalDecimal(
        values,
        'capacityM3',
        t,
        t('pricing_engine.params.vehicles.field.capacityM3', 'Volume (m3)'),
      ),
      capacityPallets: pallets
        ? Number(
            requireDecimal(
              values,
              'capacityPallets',
              t,
              t('pricing_engine.params.vehicles.field.capacityPallets', 'Pallet slots'),
            ),
          )
        : null,
      fuelType: requireText(
        values,
        'fuelType',
        t,
        t('pricing_engine.params.vehicles.field.fuelType', 'Fuel type'),
      ),
      consumptionLPer100Km: requireDecimal(
        values,
        'consumptionLPer100Km',
        t,
        t('pricing_engine.params.vehicles.field.consumption', 'Consumption (l/100 km)'),
      ),
      fixedCostMonth: requireDecimal(
        values,
        'fixedCostMonth',
        t,
        t('pricing_engine.params.vehicles.field.fixedCost', 'Fixed cost per month'),
      ),
      driverRoleCode: requireText(
        values,
        'driverRoleCode',
        t,
        t('pricing_engine.params.vehicles.field.driverRole', 'Driver role'),
      ),
      isActive: readBoolean(values, 'isActive'),
    }
  },
  rowTitle: (row) => row.label,
}

export const fuelPriceDescriptor: ParamScreenDescriptor<FuelPriceRow> = {
  segment: 'fuel-prices',
  apiPath: 'pricing/fuel-prices',
  keyPrefix: 'pricing_engine.params.fuelPrices',
  titleFallback: 'Fuel prices',
  resourceKind: 'pricing_engine.fuel_price',
  timeVersioned: false,
  searchPlaceholderFallback: 'Search by fuel type',
  columns: (t) => [
    {
      accessorKey: 'observedOn',
      header: t('pricing_engine.params.fuelPrices.column.observedOn', 'Observed on'),
      cell: ({ row }) => isoToDateInput(row.original.observedOn) || '—',
    },
    {
      accessorKey: 'fuelType',
      header: t('pricing_engine.params.fuelPrices.column.fuelType', 'Fuel'),
    },
    {
      accessorKey: 'pricePerLitre',
      header: t('pricing_engine.params.fuelPrices.column.price', 'Price per litre'),
      cell: ({ row }) => <span className="font-mono">{row.original.pricePerLitre}</span>,
    },
    demoColumn<FuelPriceRow>(t),
  ],
  groups: (t) => [
    {
      id: 'observation',
      title: t('pricing_engine.params.fuelPrices.group.observation', 'Observation'),
      description: t(
        'pricing_engine.params.fuelPrices.group.observationHint',
        'A quote uses the most recent observation at or before its own date, so editing an old row changes what past quotes replay to. Record a new observation instead.',
      ),
      fields: [
        {
          id: 'fuelType',
          type: 'combobox',
          label: t('pricing_engine.params.vehicles.field.fuelType', 'Fuel type'),
          required: true,
          allowCustomValues: true,
          loadOptions: () => loadFuelTypeOptions(),
          layout: 'third',
        },
        {
          id: 'pricePerLitre',
          type: 'number',
          label: t('pricing_engine.params.fuelPrices.field.price', 'Price per litre'),
          required: true,
          layout: 'third',
        },
        {
          id: 'observedOn',
          type: 'date',
          label: t('pricing_engine.params.fuelPrices.field.observedOn', 'Observed on'),
          required: true,
          layout: 'third',
        },
      ],
    },
  ],
  createDefaults: () => ({ fuelType: '', pricePerLitre: '', observedOn: todayDateInput() }),
  toValues: (row) => ({
    fuelType: row.fuelType,
    pricePerLitre: row.pricePerLitre,
    observedOn: isoToDateInput(row.observedOn),
  }),
  buildPayload: (values, t) => ({
    fuelType: requireText(
      values,
      'fuelType',
      t,
      t('pricing_engine.params.vehicles.field.fuelType', 'Fuel type'),
    ),
    pricePerLitre: requireDecimal(
      values,
      'pricePerLitre',
      t,
      t('pricing_engine.params.fuelPrices.field.price', 'Price per litre'),
    ),
    observedOn: requireDate(values, 'observedOn', t),
  }),
  rowTitle: (row) => `${row.fuelType} ${isoToDateInput(row.observedOn)}`,
}

