'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { Plus } from 'lucide-react'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { ListEmptyState } from '@open-mercato/ui/backend/filters/ListEmptyState'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { Button } from '@open-mercato/ui/primitives/button'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { CrudForm, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { createCrud, updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { LoadingMessage, ErrorMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import {
  buildRecordInjectionContext,
  useSetCurrentRecordInjectionContext,
} from '@open-mercato/ui/backend/injection/recordContext'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT, type TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import {
  isoToDateInput,
  readText,
  requireDate,
  todayDateInput,
  type ParamFormValues,
  type ParamRowBase,
} from './paramValues'

export const PARAMS_BASE_PATH = '/backend/pricing/params'

export type {
  ParamFormValues,
  ParamRowBase,
} from './paramValues'

export {
  isoToDateInput,
  optionalDate,
  optionalDecimal,
  readBoolean,
  readOptionalText,
  readText,
  requireDate,
  requireDecimal,
  requireText,
  todayDateInput,
} from './paramValues'

export type ParamFormMode = 'create' | 'edit'

/**
 * One descriptor drives the list, the create form and the edit form for a parameter table, so the
 * three surfaces cannot drift apart. `buildPayload` is the single place a form's values become an
 * API body; it throws `createCrudFormError` for anything the server would reject with a 400.
 */
export type ParamScreenDescriptor<TRow extends ParamRowBase> = {
  segment: string
  /** CRUD path without the leading `/api`, e.g. `pricing/margin-rules`. */
  apiPath: string
  /** i18n key prefix, e.g. `pricing_engine.params.marginRules`. */
  keyPrefix: string
  titleFallback: string
  /** Matches the route's `events.module + '.' + events.entity`. Drives version history and 409s. */
  resourceKind: string
  timeVersioned: boolean
  searchPlaceholderFallback?: string
  columns: (t: TranslateFn) => ColumnDef<TRow>[]
  filters?: (t: TranslateFn) => FilterDef[]
  filterParams?: (values: FilterValues) => Record<string, string>
  /** Applied to a loaded page before it is rendered — used to flag rules a newer version shadows. */
  decorateRows?: (rows: TRow[]) => TRow[]
  groups: (t: TranslateFn, mode: ParamFormMode) => CrudFormGroup[]
  createDefaults: () => ParamFormValues
  toValues: (row: TRow) => ParamFormValues
  buildPayload: (values: ParamFormValues, t: TranslateFn) => Record<string, unknown>
  rowTitle: (row: TRow) => string
}

type ListResponse<TRow> = {
  items: TRow[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

const PAGE_SIZE = 50

export function paramListHref(segment: string): string {
  return `${PARAMS_BASE_PATH}/${segment}`
}

/** The three columns every time-versioned table shows: in force today, from, until. */
export function versionColumns<TRow extends ParamRowBase>(t: TranslateFn): ColumnDef<TRow>[] {
  return [
    {
      accessorKey: 'isInForce',
      header: t('pricing_engine.params.column.inForce', 'In force'),
      cell: ({ row }) =>
        row.original.isInForce ? (
          <Badge variant="success">{t('pricing_engine.params.version.active', 'Active today')}</Badge>
        ) : (
          <Badge variant="neutral">{t('pricing_engine.params.version.historical', 'Historical')}</Badge>
        ),
    },
    {
      accessorKey: 'validFrom',
      header: t('pricing_engine.params.column.validFrom', 'Valid from'),
      cell: ({ row }) => isoToDateInput(row.original.validFrom) || '—',
    },
    {
      accessorKey: 'validTo',
      header: t('pricing_engine.params.column.validTo', 'Valid to'),
      cell: ({ row }) =>
        isoToDateInput(row.original.validTo) ||
        t('pricing_engine.params.version.openEnded', 'Open-ended'),
    },
  ]
}

export function demoColumn<TRow extends ParamRowBase>(t: TranslateFn): ColumnDef<TRow> {
  return {
    accessorKey: 'isDemo',
    header: t('pricing_engine.params.column.origin', 'Origin'),
    cell: ({ row }) =>
      row.original.isDemo ? (
        <Badge variant="warning">{t('pricing_engine.params.origin.demo', 'Seeded demo data')}</Badge>
      ) : (
        <Badge variant="outline">{t('pricing_engine.params.origin.operator', 'Entered')}</Badge>
      ),
  }
}

/**
 * The versioning control every time-versioned edit form carries.
 *
 * Correcting a row in place rewrites history: `lib/params.ts` resolves parameters as of the quote
 * date, so a replayed past quote changes its answer. Superseding leaves the old row closed and
 * intact, which is why it is the default.
 */
function versioningGroup(t: TranslateFn): CrudFormGroup {
  return {
    id: 'versioning',
    title: t('pricing_engine.params.version.groupTitle', 'How should this change apply?'),
    description: t(
      'pricing_engine.params.version.groupDescription',
      'Quotes are priced with the parameters in force on their own date.',
    ),
    fields: [
      {
        id: 'versionMode',
        type: 'select',
        label: t('pricing_engine.params.version.mode', 'Change type'),
        required: true,
        options: [
          {
            value: 'supersede',
            label: t('pricing_engine.params.version.supersede', 'Supersede from a date (keeps history)'),
          },
          {
            value: 'correct',
            label: t('pricing_engine.params.version.correct', 'Correct this version (rewrites history)'),
          },
        ],
        layout: 'half',
      },
      {
        id: 'supersedeFrom',
        type: 'date',
        label: t('pricing_engine.params.version.supersedeFrom', 'New version effective from'),
        description: t(
          'pricing_engine.params.version.supersedeFromHint',
          'The current version is closed on this date and a new one starts.',
        ),
        visibleWhen: { field: 'versionMode', equals: 'supersede' },
        layout: 'half',
      },
    ],
  }
}

function hideValidFromWhenSuperseding(group: CrudFormGroup): CrudFormGroup {
  if (!group.fields) return group
  return {
    ...group,
    fields: group.fields.map((entry) =>
      typeof entry === 'string' || entry.id !== 'validFrom'
        ? entry
        : { ...entry, visibleWhen: { field: 'versionMode', equals: 'correct' } },
    ),
  }
}

export function ParamListScreen<TRow extends ParamRowBase>({
  descriptor,
}: {
  descriptor: ParamScreenDescriptor<TRow>
}) {
  const t = useT()
  const { confirm: confirmDialog, ConfirmDialogElement } = useConfirmDialog()
  const [rows, setRows] = React.useState<TRow[]>([])
  const [page, setPage] = React.useState(1)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [search, setSearch] = React.useState('')
  const [filters, setFilters] = React.useState<FilterValues>({})
  const [isLoading, setIsLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)
  const scopeVersion = useOrganizationScopeVersion()

  const listHref = paramListHref(descriptor.segment)
  const createHref = `${listHref}/create`
  const mutationContextId = `pricing-params-${descriptor.segment}:mutation`
  const { runMutation, retryLastMutation } = useGuardedMutation<{
    formId: string
    resourceKind: string
    resourceId: string
    retryLastMutation: () => Promise<boolean>
  }>({
    contextId: mutationContextId,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  const filterParams = descriptor.filterParams
  const extraParams = React.useMemo(
    () => (filterParams ? filterParams(filters) : {}),
    [filterParams, filters],
  )

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
        if (search) params.set('search', search)
        for (const [key, value] of Object.entries(extraParams)) {
          if (value) params.set(key, value)
        }
        const fallback: ListResponse<TRow> = {
          items: [],
          total: 0,
          page,
          pageSize: PAGE_SIZE,
          totalPages: 1,
        }
        const call = await apiCall<ListResponse<TRow>>(
          `/api/${descriptor.apiPath}?${params.toString()}`,
          undefined,
          { fallback },
        )
        if (cancelled) return
        if (!call.ok) {
          setLoadError(t('pricing_engine.params.errors.load', 'Could not load these parameters.'))
          return
        }
        const payload = call.result ?? fallback
        const items = Array.isArray(payload.items) ? payload.items : []
        setLoadError(null)
        setRows(descriptor.decorateRows ? descriptor.decorateRows(items) : items)
        setTotal(payload.total ?? 0)
        setTotalPages(payload.totalPages ?? 1)
      } catch {
        if (!cancelled) {
          setLoadError(t('pricing_engine.params.errors.load', 'Could not load these parameters.'))
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [descriptor, page, search, extraParams, reloadToken, scopeVersion, t])

  const handleDelete = React.useCallback(
    async (row: TRow) => {
      const confirmed = await confirmDialog({
        title: t('pricing_engine.params.confirmDelete', 'Delete {name}?', {
          name: descriptor.rowTitle(row),
        }),
        text: descriptor.timeVersioned
          ? t(
              'pricing_engine.params.confirmDeleteVersioned',
              'Deleting removes this version from every past quote replay. Close it out with a supersede instead when you only want it to stop applying from now on.',
            )
          : undefined,
        variant: 'destructive',
      })
      if (!confirmed) return
      try {
        await runMutation({
          operation: async () => {
            const call = await withScopedApiRequestHeaders(
              buildOptimisticLockHeader(row.updatedAt),
              () =>
                apiCall(`/api/${descriptor.apiPath}?id=${encodeURIComponent(row.id)}`, {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json' },
                }),
            )
            if (!call.ok) {
              throw Object.assign(new Error('[internal] pricing parameter delete failed'), {
                status: call.status,
                ...((call.result as Record<string, unknown> | null) ?? {}),
              })
            }
            return call
          },
          context: {
            formId: mutationContextId,
            resourceKind: descriptor.resourceKind,
            resourceId: row.id,
            retryLastMutation,
          },
          mutationPayload: { id: row.id },
        })
        flash(t('pricing_engine.params.flash.deleted', 'Deleted.'), 'success')
        setReloadToken((token) => token + 1)
      } catch (error) {
        if (surfaceRecordConflict(error, t, { onRefresh: () => setReloadToken((token) => token + 1) })) {
          return
        }
        flash(t('pricing_engine.params.flash.deleteError', 'Could not delete this entry.'), 'error')
      }
    },
    [confirmDialog, descriptor, mutationContextId, retryLastMutation, runMutation, t],
  )

  const columns = React.useMemo(() => descriptor.columns(t), [descriptor, t])
  const filterDefs = React.useMemo(
    () => (descriptor.filters ? descriptor.filters(t) : undefined),
    [descriptor, t],
  )
  const title = t(`${descriptor.keyPrefix}.title`, descriptor.titleFallback)
  const descriptionKey = `${descriptor.keyPrefix}.description`
  const description = t(descriptionKey, '')

  return (
    <Page>
      <PageBody>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        <DataTable
          title={title}
          columns={columns}
          data={rows}
          error={loadError}
          searchValue={search}
          onSearchChange={(value) => {
            setSearch(value)
            setPage(1)
          }}
          searchPlaceholder={t(
            `${descriptor.keyPrefix}.searchPlaceholder`,
            descriptor.searchPlaceholderFallback ?? 'Search',
          )}
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
          actions={
            <Button asChild>
              <Link href={createHref}>
                <Plus className="mr-2 h-4 w-4" />
                {t('pricing_engine.params.action.create', 'Add')}
              </Link>
            </Button>
          }
          rowActions={(row) => (
            <RowActions
              items={[
                { id: 'edit', label: t('common.edit', 'Edit'), href: `${listHref}/${row.id}` },
                {
                  id: 'delete',
                  label: t('common.delete', 'Delete'),
                  destructive: true,
                  onSelect: () => handleDelete(row),
                },
              ]}
            />
          )}
          emptyState={
            <ListEmptyState
              entityName={title}
              createHref={createHref}
              createLabel={t('pricing_engine.params.action.create', 'Add')}
            />
          }
          pagination={{ page, pageSize: PAGE_SIZE, total, totalPages, onPageChange: setPage }}
          isLoading={isLoading}
        />
      </PageBody>
      {ConfirmDialogElement}
    </Page>
  )
}

export function ParamCreateScreen<TRow extends ParamRowBase>({
  descriptor,
}: {
  descriptor: ParamScreenDescriptor<TRow>
}) {
  const t = useT()
  const router = useRouter()
  const listHref = paramListHref(descriptor.segment)
  const groups = React.useMemo(() => descriptor.groups(t, 'create'), [descriptor, t])
  const initialValues = React.useMemo(() => descriptor.createDefaults(), [descriptor])

  return (
    <Page>
      <PageBody>
        <CrudForm
          title={t(`${descriptor.keyPrefix}.create`, `Add ${descriptor.titleFallback}`)}
          backHref={listHref}
          cancelHref={listHref}
          fields={[]}
          groups={groups}
          initialValues={initialValues}
          submitLabel={t('pricing_engine.params.action.save', 'Save')}
          onSubmit={async (values) => {
            await createCrud(descriptor.apiPath, descriptor.buildPayload(values, t))
            flash(t('pricing_engine.params.flash.created', 'Created.'), 'success')
            router.push(listHref)
          }}
        />
      </PageBody>
    </Page>
  )
}

export function ParamEditScreen<TRow extends ParamRowBase>({
  descriptor,
  recordId,
}: {
  descriptor: ParamScreenDescriptor<TRow>
  recordId: string | undefined
}) {
  const t = useT()
  const router = useRouter()
  const pathname = usePathname()
  const [record, setRecord] = React.useState<TRow | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [isNotFound, setIsNotFound] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const listHref = paramListHref(descriptor.segment)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      if (!recordId) {
        setIsNotFound(true)
        setIsLoading(false)
        return
      }
      try {
        const call = await apiCall<{ items?: TRow[] }>(
          `/api/${descriptor.apiPath}?id=${encodeURIComponent(recordId)}`,
          undefined,
          { fallback: { items: [] } },
        )
        if (cancelled) return
        if (!call.ok) {
          setError(t('pricing_engine.params.errors.load', 'Could not load these parameters.'))
          return
        }
        const item = call.result?.items?.[0] ?? null
        if (!item) setIsNotFound(true)
        else setRecord(item)
      } catch {
        if (!cancelled) setError(t('pricing_engine.params.errors.load', 'Could not load these parameters.'))
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [descriptor.apiPath, recordId, t])

  const groups = React.useMemo(() => {
    const base = descriptor.groups(t, 'edit')
    if (!descriptor.timeVersioned) return base
    // Superseding derives the new row's start from the supersede date, so leaving an editable
    // "Valid from" on screen would show a value the save silently ignores.
    return [...base.map(hideValidFromWhenSuperseding), versioningGroup(t)]
  }, [descriptor, t])

  useSetCurrentRecordInjectionContext(
    buildRecordInjectionContext({
      resourceKind: descriptor.resourceKind,
      resourceId: record?.id ?? null,
      updatedAt: record?.updatedAt ?? null,
      data: record as Record<string, unknown> | null,
      path: pathname,
    }),
  )

  const initialValues = React.useMemo(() => {
    if (!record) return undefined
    return {
      ...descriptor.toValues(record),
      updatedAt: record.updatedAt,
      ...(descriptor.timeVersioned
        ? { versionMode: 'supersede', supersedeFrom: todayDateInput() }
        : {}),
    }
  }, [descriptor, record])

  if (isLoading) {
    return (
      <Page>
        <PageBody>
          <LoadingMessage label={t(`${descriptor.keyPrefix}.title`, descriptor.titleFallback)} />
        </PageBody>
      </Page>
    )
  }

  if (isNotFound) {
    return (
      <Page>
        <PageBody>
          <RecordNotFoundState
            label={t('pricing_engine.params.errors.notFound', 'This entry no longer exists.')}
            backHref={listHref}
            backLabel={t('pricing_engine.params.action.backToList', 'Back to the list')}
          />
        </PageBody>
      </Page>
    )
  }

  if (error || !record || !initialValues) {
    return (
      <Page>
        <PageBody>
          <ErrorMessage label={error ?? t('pricing_engine.params.errors.load', 'Could not load these parameters.')} />
        </PageBody>
      </Page>
    )
  }

  const currentRecord = record

  return (
    <Page>
      <PageBody>
        {currentRecord.isDemo ? (
          <Alert status="information" style="lighter" size="sm">
            {t(
              'pricing_engine.params.origin.demoHint',
              'This row came from the demo seed. Re-running the seeder can overwrite your edits.',
            )}
          </Alert>
        ) : null}
        <CrudForm
          title={t(`${descriptor.keyPrefix}.edit`, `Edit ${descriptor.titleFallback}`)}
          backHref={listHref}
          cancelHref={listHref}
          fields={[]}
          groups={groups}
          initialValues={initialValues}
          versionHistory={{ resourceKind: descriptor.resourceKind, resourceId: currentRecord.id }}
          submitLabel={t('pricing_engine.params.action.save', 'Save')}
          onSubmit={async (values) => {
            const payload = descriptor.buildPayload(values, t)
            const superseding =
              descriptor.timeVersioned && readText(values, 'versionMode') !== 'correct'

            if (!superseding) {
              await updateCrud(descriptor.apiPath, { id: currentRecord.id, ...payload })
              flash(t('pricing_engine.params.flash.updated', 'Saved.'), 'success')
              router.push(listHref)
              return
            }

            const effectiveFrom = requireDate(values, 'supersedeFrom', t)
            // Insert first. If the close-out then fails, both rows are live and the resolver picks
            // the newer `valid_from`, so pricing is still correct; closing first and failing here
            // would leave the scope with no rule at all.
            await createCrud(descriptor.apiPath, { ...payload, validFrom: effectiveFrom })
            // The parent optimistic-lock header CrudForm attaches belongs to this same row, so the
            // close-out is guarded correctly; the insert above is a POST, which the guard ignores.
            await updateCrud(descriptor.apiPath, {
              id: currentRecord.id,
              ...descriptor.buildPayload(descriptor.toValues(currentRecord), t),
              validTo: effectiveFrom,
            })
            flash(
              t('pricing_engine.params.flash.superseded', 'A new version is in force.'),
              'success',
            )
            router.push(listHref)
          }}
        />
      </PageBody>
    </Page>
  )
}
