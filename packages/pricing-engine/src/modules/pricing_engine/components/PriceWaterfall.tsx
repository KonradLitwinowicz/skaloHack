'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@open-mercato/ui/primitives/table'
import type { QuoteBreakdownComponent } from '../lib/frontend/quoteTypes'
import { renderExplain } from '../lib/frontend/renderExplain'
import { ConfidenceBadge } from './ConfidenceBadge'
import { formatMoney } from '../lib/frontend/marginMath'

type PriceWaterfallProps = {
  breakdown: QuoteBreakdownComponent[]
  currencyCode: string
}

// A table-shaped waterfall: the bar is proportional to the component's contribution and the running
// total sits next to it, so a sales rep reads the numbers rather than decoding a chart.
export function PriceWaterfall({ breakdown, currencyCode }: PriceWaterfallProps) {
  const t = useT()
  const maxRunning = React.useMemo(() => {
    const values = breakdown.map((component) => Math.abs(Number(component.runningTotal ?? 0)))
    const peak = Math.max(0, ...values)
    return peak > 0 ? peak : 1
  }, [breakdown])

  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[720px]">
        <TableHeader>
          <TableRow className="border-b border-border text-left text-muted-foreground">
            <TableHead className="py-2 pr-4 font-medium">
              {t('pricing_engine.playground.waterfall.component', 'Component')}
            </TableHead>
            <TableHead className="py-2 pr-4 font-medium">
              {t('pricing_engine.playground.waterfall.effect', 'Effect')}
            </TableHead>
            <TableHead className="py-2 pr-4 text-right font-medium">
              {t('pricing_engine.playground.waterfall.runningTotal', 'Running total')}
            </TableHead>
            <TableHead className="py-2 font-medium">
              {t('pricing_engine.playground.waterfall.explanation', 'Explanation')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {breakdown.map((component) => {
            const running = Number(component.runningTotal ?? 0)
            const widthPercent = Math.min(100, Math.round((Math.abs(running) / maxRunning) * 100))
            const isMultiplier = component.effect === 'mul'
            return (
              <TableRow key={component.code} className="border-b border-border/60 align-top">
                <TableCell className="py-3 pr-4">
                  <div className="font-medium">{t(component.labelKey, component.code)}</div>
                  <ConfidenceBadge confidence={component.confidence} className="mt-1" />
                </TableCell>
                <TableCell className="py-3 pr-4 tabular-nums">
                  {isMultiplier ? `x ${component.value}` : formatMoney(component.value, currencyCode)}
                </TableCell>
                <TableCell className="py-3 pr-4 text-right tabular-nums">
                  <div>{formatMoney(component.runningTotal ?? '0', currencyCode)}</div>
                  <div
                    className="mt-1 h-1.5 rounded-sm bg-primary/70"
                    style={{ width: `${widthPercent}%`, marginLeft: 'auto' }}
                    aria-hidden="true"
                  />
                </TableCell>
                <TableCell className="py-3 text-muted-foreground">{renderExplain(t, component)}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
