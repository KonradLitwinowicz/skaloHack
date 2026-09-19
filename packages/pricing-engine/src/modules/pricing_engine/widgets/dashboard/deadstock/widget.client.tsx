"use client"

import * as React from 'react'
import type { DashboardWidgetComponentProps } from '@open-mercato/shared/modules/dashboard/widgets'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import {
  WidgetEmpty,
  WidgetError,
  WidgetList,
  WidgetListRow,
  WidgetFooterLink,
  WidgetRowIcon,
  WidgetSkeleton,
} from '@open-mercato/ui/backend/dashboard/WidgetList'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { DeadstockListResponse } from '../../../lib/frontend/deadstockTypes'
import { formatAmount } from '../../../lib/frontend/deadstockTypes'

const logger = createLogger('pricing_engine')

const TOP_OFFENDERS = 5
const SCREEN_HREF = '/backend/pricing/deadstock'

/**
 * The headline is the money, not the count.
 *
 * "Twenty-three products are dormant" is a fact nobody acts on; "82 972 PLN is asleep and burning
 * 340 PLN a month" is the same fact with the consequence attached, and the consequence is what gets
 * the screen opened a second time.
 */
export default function PricingDeadstockWidget({ refreshToken }: DashboardWidgetComponentProps) {
  const t = useT()
  const locale = useLocale()
  const [data, setData] = React.useState<DeadstockListResponse | null>(null)
  const [failed, setFailed] = React.useState(false)
  // Tracked separately from `data === null`, because "still loading" and "loaded, and there is
  // nothing to show" are different things to put on a dashboard tile.
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const call = await apiCall<DeadstockListResponse>(
          // `actionableOnly`, not `atRiskOnly`: the headline counts positions carrying a floor, and
          // listing slow-movers underneath it put a product dormant for THREE DAYS under a heading
          // that says "not moving". Slow stock is a purchasing signal and belongs on the screen, not
          // on a tile whose whole claim is that this money is stuck.
          `/api/pricing/deadstock?actionableOnly=true&sort=tiedCapital&dir=desc&pageSize=${TOP_OFFENDERS}`,
        )
        if (cancelled) return
        if (!call.ok || !call.result) {
          setFailed(true)
          return
        }
        setFailed(false)
        setData(call.result)
      } catch (error) {
        logger.error('Deadstock widget failed to load', { error })
        if (!cancelled) setFailed(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  if (failed) {
    return <WidgetError message={t('pricing_engine.deadstock.widget.error', 'Could not measure deadstock.')} />
  }
  if (loading || !data) return <WidgetSkeleton />

  const { totals, currencyCode } = data
  if (totals.atRiskCount === 0) {
    return (
      <div className="flex flex-col gap-3">
        <WidgetEmpty title={t('pricing_engine.deadstock.widget.empty', 'Everything in stock is moving.')} />
        <WidgetFooterLink href={SCREEN_HREF}>
          {t('pricing_engine.deadstock.widget.seeAll', 'Open rotation and deadstock')}
        </WidgetFooterLink>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-2xl font-semibold">{formatAmount(totals.tiedCapital, currencyCode, locale)}</div>
        <div className="text-xs text-muted-foreground">
          {t(
            'pricing_engine.deadstock.widget.summary',
            '{count} positions not moving, burning {monthly} a month',
            {
              count: String(totals.atRiskCount),
              monthly: formatAmount(totals.monthlyCarry, currencyCode, locale),
            },
          )}
        </div>
      </div>
      <WidgetList>
        {data.items.map((row) => (
          <WidgetListRow
            key={row.productId}
            href={`/backend/catalog/products/${row.productId}`}
            leading={<WidgetRowIcon icon="package-x" />}
            title={row.title ?? row.sku ?? row.productId}
            subtitle={
              row.daysSinceLastSale === null
                ? t('pricing_engine.deadstock.widget.neverSold', 'never sold')
                : t('pricing_engine.deadstock.widget.dormantDays', 'dormant {days} days', {
                    days: String(row.daysSinceLastSale),
                  })
            }
            trailing={formatAmount(row.carrying.tiedCapital, currencyCode, locale)}
          />
        ))}
      </WidgetList>
      {/* Without this the tile is a dead end: the reader learns the number and has nowhere to act
          on it. The footer is the only route from the dashboard into the worklist. */}
      <WidgetFooterLink href={SCREEN_HREF}>
        {t('pricing_engine.deadstock.widget.seeAll', 'Open rotation and deadstock')}
      </WidgetFooterLink>
    </div>
  )
}
