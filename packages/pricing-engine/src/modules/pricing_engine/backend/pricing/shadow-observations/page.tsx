'use client'

import * as React from 'react'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useOptionalLocale, useT, type TranslateFn } from '@open-mercato/shared/lib/i18n/context'

type ShadowObservationRow = {
  id: string
  observedAt: string
  salesDocumentKind: string | null
  salesDocumentId: string | null
  salesLineId: string | null
  customerId: string | null
  calculationId: string | null
  invoicedUnitPriceNet: string
  engineUnitPriceNet: string
  deltaAbsolute: string
  deltaPercent: string
  hasDeltaPercent: boolean
}

type ListResponse = {
  items: ShadowObservationRow[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

const PAGE_SIZE = 50
const EMPTY_RESPONSE: ListResponse = { items: [], total: 0, page: 1, pageSize: PAGE_SIZE, totalPages: 1 }

const DIVERGENCE_THRESHOLDS = ['1', '5', '10', '25']

function formatAmount(value: string): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed.toFixed(2) : value
}

function formatSignedPercent(value: string): string {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return value
  return `${parsed > 0 ? '+' : ''}${parsed.toFixed(2)}%`
}

/** Neutral below a grosz, then widening bands — the badge ranks divergence, it does not judge it. */
function divergenceVariant(deltaAbsolute: string, deltaPercent: string): 'neutral' | 'info' | 'warning' | 'error' {
  if (Math.abs(Number(deltaAbsolute)) < 0.01) return 'neutral'
  const magnitude = Math.abs(Number(deltaPercent))
  if (magnitude >= 25) return 'error'
  if (magnitude >= 10) return 'warning'
  return 'info'
}

function buildColumns(t: TranslateFn, locale: string | undefined): ColumnDef<ShadowObservationRow>[] {
  return [
    {
      accessorKey: 'observedAt',
      header: t('pricing_engine.shadowObservations.column.observedAt', 'Observed'),
      cell: ({ row }) => (
        <span className="whitespace-nowrap">{new Date(row.original.observedAt).toLocaleString(locale)}</span>
      ),
    },
    {
      accessorKey: 'salesDocumentKind',
      header: t('pricing_engine.shadowObservations.column.document', 'Document'),
      cell: ({ row }) => (
        <div>
          <div className="font-medium">
            {row.original.salesDocumentKind ??
              t('pricing_engine.shadowObservations.value.unknownDocument', 'Unknown')}
          </div>
          {row.original.salesLineId ? (
            <div className="max-w-[220px] truncate text-xs text-muted-foreground" title={row.original.salesLineId}>
              {row.original.salesLineId}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      accessorKey: 'invoicedUnitPriceNet',
      header: t('pricing_engine.shadowObservations.column.invoiced', 'Invoiced / unit'),
      cell: ({ row }) => (
        <span className="tabular-nums">{formatAmount(row.original.invoicedUnitPriceNet)}</span>
      ),
    },
    {
      accessorKey: 'engineUnitPriceNet',
      header: t('pricing_engine.shadowObservations.column.engine', 'Engine / unit'),
      cell: ({ row }) => (
        <span className="tabular-nums">{formatAmount(row.original.engineUnitPriceNet)}</span>
      ),
    },
    {
      accessorKey: 'deltaAbsolute',
      header: t('pricing_engine.shadowObservations.column.delta', 'Difference'),
      cell: ({ row }) => {
        const delta = Number(row.original.deltaAbsolute)
        const sign = delta > 0 ? '+' : ''
        return (
          <span className="tabular-nums font-medium">
            {Number.isFinite(delta) ? `${sign}${delta.toFixed(2)}` : row.original.deltaAbsolute}
          </span>
        )
      },
    },
    {
      accessorKey: 'deltaPercent',
      header: t('pricing_engine.shadowObservations.column.deltaPercent', 'Difference %'),
      cell: ({ row }) => {
        if (!row.original.hasDeltaPercent) {
          return (
            <span
              className="text-muted-foreground"
              title={t(
                'pricing_engine.shadowObservations.value.noRatioHint',
                'The invoiced amount was zero, so there is no percentage to compute.',
              )}
            >
              {t('pricing_engine.shadowObservations.value.noRatio', 'No base')}
            </span>
          )
        }
        return (
          <Badge variant={divergenceVariant(row.original.deltaAbsolute, row.original.deltaPercent)}>
            {formatSignedPercent(row.original.deltaPercent)}
          </Badge>
        )
      },
    },
  ]
}

function buildFilters(t: TranslateFn): FilterDef[] {
  return [
    {
      id: 'observedAt',
      type: 'dateRange',
      label: t('pricing_engine.shadowObservations.filter.observedAt', 'Observed between'),
    },
    {
      id: 'minAbsDeltaPercent',
      type: 'select',
      label: t('pricing_engine.shadowObservations.filter.threshold', 'Diverging by at least'),
      options: [
        { value: '', label: t('pricing_engine.shadowObservations.filter.thresholdAny', 'Any difference') },
        ...DIVERGENCE_THRESHOLDS.map((threshold) => ({
          value: threshold,
          label: t('pricing_engine.shadowObservations.filter.thresholdValue', '{percent}% or more', {
            percent: threshold,
          }),
        })),
      ],
    },
  ]
}

function buildQuery(page: number, filters: FilterValues): string {
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
  const range = filters.observedAt
  if (range && typeof range === 'object') {
    const { from, to } = range as { from?: string; to?: string }
    if (from) params.set('observedFrom', from)
    if (to) params.set('observedTo', to)
  }
  const threshold = filters.minAbsDeltaPercent
  if (typeof threshold === 'string' && threshold.length > 0) params.set('minAbsDeltaPercent', threshold)
  return params.toString()
}

/**
 * Read-only by design. These rows are a measurement of the gap between two numbers, never a price:
 * nothing on this screen has changed, or can change, what a customer was billed.
 */
export default function PricingShadowObservationsPage() {
  const t = useT()
  const locale = useOptionalLocale()
  const [rows, setRows] = React.useState<ShadowObservationRow[]>([])
  const [page, setPage] = React.useState(1)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [filters, setFilters] = React.useState<FilterValues>({})
  const [isLoading, setIsLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const scopeVersion = useOrganizationScopeVersion()

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      try {
        const call = await apiCall<ListResponse>(
          `/api/pricing/shadow-observations?${buildQuery(page, filters)}`,
          undefined,
          { fallback: EMPTY_RESPONSE },
        )
        if (cancelled) return
        if (!call.ok) {
          setLoadError(
            t(
              'pricing_engine.errors.shadowObservationsFailed',
              'Could not load the shadow observations.',
            ),
          )
          return
        }
        const payload = call.result ?? EMPTY_RESPONSE
        setLoadError(null)
        setRows(Array.isArray(payload.items) ? payload.items : [])
        setTotal(payload.total ?? 0)
        setTotalPages(payload.totalPages ?? 1)
      } catch {
        if (!cancelled) {
          setLoadError(
            t(
              'pricing_engine.errors.shadowObservationsFailed',
              'Could not load the shadow observations.',
            ),
          )
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [page, filters, scopeVersion, t])

  const columns = React.useMemo(() => buildColumns(t, locale), [t, locale])
  const filterDefs = React.useMemo(() => buildFilters(t), [t])
  const title = t('pricing_engine.shadowObservations.title', 'Shadow observations')

  return (
    <Page>
      <PageBody>
        <p className="text-sm text-muted-foreground">
          {t(
            'pricing_engine.shadowObservations.description',
            'Where the pricing engine and the invoice disagree, and by how much.',
          )}
        </p>

        <Alert status="warning" style="lighter" size="sm" className="mt-3">
          <AlertDescription>
            {t(
              'pricing_engine.shadowObservations.modeDisclaimer',
              'The pricing mode is a label the engine reports, not a safeguard: no component or pipeline stage reads it. Nothing here changed a sales amount — every figure below was invoiced exactly as sales calculated it, and these rows only record what the engine would have asked for instead.',
            )}
          </AlertDescription>
        </Alert>

        <div className="mt-4">
          <DataTable
            title={title}
            columns={columns}
            data={rows}
            error={loadError}
            filters={filterDefs}
            filterValues={filters}
            onFiltersApply={(values) => {
              setFilters(values)
              setPage(1)
            }}
            onFiltersClear={() => {
              setFilters({})
              setPage(1)
            }}
            emptyState={t(
              'pricing_engine.shadowObservations.empty',
              'No observations recorded yet. Observing is opt-in: set OM_PRICING_SHADOW_OBSERVE to enable it.',
            )}
            pagination={{ page, pageSize: PAGE_SIZE, total, totalPages, onPageChange: setPage }}
            isLoading={isLoading}
          />
        </div>
      </PageBody>
    </Page>
  )
}
