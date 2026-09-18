'use client'

import * as React from 'react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@open-mercato/ui/primitives/table'
import type { CoverageItem, CoverageResponse } from '../../../lib/frontend/quoteTypes'

const CONFIDENCE_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  measured: 'default',
  estimated: 'secondary',
  default: 'outline',
}

// Deliberately unflattering: a component with no real data source must be visibly worse on this
// screen than one that has measurements behind it.
export default function PricingCoveragePage() {
  const t = useT()
  const [items, setItems] = React.useState<CoverageItem[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const call = await apiCall<CoverageResponse & { error?: string }>('/api/pricing/coverage')
        if (cancelled) return
        if (!call.ok || !call.result) {
          setError(
            t(
              call.result?.error ?? 'pricing_engine.errors.coverageFailed',
              'Could not load the coverage register.',
            ),
          )
          return
        }
        setItems(call.result.items)
      } catch {
        if (!cancelled) {
          setError(t('pricing_engine.errors.coverageFailed', 'Could not load the coverage register.'))
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [t])

  return (
    <Page>
      <PageBody>
        <p className="text-sm text-muted-foreground">
          {t(
            'pricing_engine.coverage.description',
            'What every price component actually stands on, and what is still assumed.',
          )}
        </p>

        {error ? <ErrorMessage label={error} /> : null}
        {!error && items === null ? (
          <LoadingMessage label={t('pricing_engine.coverage.title', 'Data coverage')} />
        ) : null}

        {items ? (
          <div className="mt-4 overflow-x-auto">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow className="border-b border-border text-left text-muted-foreground">
                  <TableHead className="py-2 pr-4 font-medium">
                    {t('pricing_engine.coverage.column.component', 'Component')}
                  </TableHead>
                  <TableHead className="py-2 pr-4 font-medium">
                    {t('pricing_engine.coverage.column.source', 'Data source')}
                  </TableHead>
                  <TableHead className="py-2 pr-4 font-medium">
                    {t('pricing_engine.coverage.column.confidence', 'Confidence')}
                  </TableHead>
                  <TableHead className="py-2 font-medium">
                    {t('pricing_engine.coverage.column.status', 'Status')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.componentCode} className="border-b border-border/60 align-top">
                    <TableCell className="py-3 pr-4 font-medium">{t(item.labelKey, item.componentCode)}</TableCell>
                    <TableCell className="py-3 pr-4 text-muted-foreground">
                      <div>{item.sourceKind}</div>
                      {item.sourceRef ? <div className="text-xs">{item.sourceRef}</div> : null}
                    </TableCell>
                    <TableCell className="py-3 pr-4">
                      <Badge variant={CONFIDENCE_VARIANT[item.confidence] ?? 'outline'}>
                        {t(`pricing_engine.confidence.${item.confidence}`, item.confidence)}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-3">
                      <Badge variant={item.implemented ? 'default' : 'outline'}>
                        {item.implemented
                          ? t('pricing_engine.coverage.status.implemented', 'Live')
                          : t('pricing_engine.coverage.status.pending', 'Not implemented')}
                      </Badge>
                      {item.missingReasonKey ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {t(item.missingReasonKey, item.missingReasonKey)}
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </PageBody>
    </Page>
  )
}
