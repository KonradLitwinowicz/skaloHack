'use client'

import * as React from 'react'
import Link from 'next/link'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Button } from '@open-mercato/ui/primitives/button'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ConfidenceBadge } from '../../../components/ConfidenceBadge'
import type { AdviseResponse, AdvisorSuggestion } from '../../../lib/frontend/advisorTypes'
import { formatMoney } from '../../../lib/frontend/marginMath'
import { SuggestionCard } from '../advisor/SuggestionCard'

const OBJECTIVES_HREF = '/backend/pricing/params/objectives'

const KIND_FALLBACK: Record<AdvisorSuggestion['code'], string> = {
  volume_threshold: 'Order more and pay less per unit',
  full_pack_rounding: 'Round up to a whole pack',
  basket_consolidation: 'Merge these orders into one delivery',
  cheaper_equivalent: 'A cheaper product in the same group',
  order_channel_change: 'Move this customer to a cheaper ordering channel',
}

export type AdviceStripProps = {
  advice: AdviseResponse | null
  currencyCode: string
  pending: boolean
  /** Suggestion codes that are actionable on this basket; the rest render without an Apply button. */
  canApply: (suggestion: AdvisorSuggestion) => boolean
  onApply: (suggestion: AdvisorSuggestion) => void
}

function toNumber(value: string | null | undefined): number {
  const parsed = Number(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}

function subjectLabel(suggestion: AdvisorSuggestion): string | null {
  const subject = suggestion.subject
  if (!subject) return null
  const parts = [subject.title, subject.sku].filter((part): part is string => Boolean(part))
  return parts.length ? parts.join(' · ') : subject.productId
}

function Delta({ before, after, currencyCode, suffix }: { before: string; after: string; currencyCode?: string; suffix?: string }) {
  const delta = toNumber(after) - toNumber(before)
  const format = (value: string) =>
    currencyCode !== undefined ? formatMoney(value, currencyCode) : `${toNumber(value).toFixed(1)}${suffix ?? ''}`
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap tabular-nums">
      <span className="text-muted-foreground line-through">{format(before)}</span>
      <span className="font-medium">{format(after)}</span>
      <Badge variant={delta > 0 ? 'success' : delta < 0 ? 'error' : 'neutral'} size="sm">
        {delta > 0 ? '+' : ''}
        {currencyCode !== undefined ? formatMoney(String(delta), currencyCode) : `${delta.toFixed(1)}${suffix ?? ''}`}
      </Badge>
    </span>
  )
}

/**
 * The advisor's suggestions as one row of compact cards, each with the two numbers that matter on
 * the phone — what the customer pays and what you keep — and a button that makes the change in the
 * basket. The full card, objectives breakdown included, is one click away; it was the whole
 * advisor screen before and stays available.
 */
export function AdviceStrip({ advice, currencyCode, pending, canApply, onApply }: AdviceStripProps) {
  const t = useT()
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const suggestions = advice?.suggestions ?? []
  const isObjectiveRanked = suggestions.some((suggestion) => suggestion.objectiveScore !== null)

  return (
    <section className="space-y-3">
      <SectionHeader
        title={t('pricing_engine.desk.advice.title', 'How to give a better price')}
        count={suggestions.length}
        action={
          <Link className="text-xs text-muted-foreground underline" href={OBJECTIVES_HREF}>
            {t('pricing_engine.advisor.action.manageObjectives', 'Objectives and weights')}
          </Link>
        }
      />
      {suggestions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {pending
            ? t('pricing_engine.desk.advice.pending', 'Looking for a better price…')
            : advice
              ? t('pricing_engine.advisor.noSuggestions', 'Nothing here beats the current price without costing you money.')
              : t('pricing_engine.desk.advice.empty', 'Add a product and the advisor looks for a better price on its own.')}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {isObjectiveRanked
              ? t('pricing_engine.desk.advice.ranked', 'Ordered by your objectives and weights.')
              : t('pricing_engine.desk.advice.unranked', 'No objectives are set for this customer or product, so the list is in the order it was found.')}
          </p>
          <div className={`grid gap-3 md:grid-cols-2 xl:grid-cols-3 ${pending ? 'opacity-60' : ''}`}>
            {suggestions.map((suggestion, index) => {
              const id = `${suggestion.code}-${index}`
              const subject = subjectLabel(suggestion)
              const applicable = canApply(suggestion)
              const isOpen = expanded === id
              return (
                <div key={id} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{t(suggestion.titleKey, KIND_FALLBACK[suggestion.code])}</span>
                    <ConfidenceBadge confidence={suggestion.confidence} />
                    {suggestion.raisesCustomerPrice ? (
                      <Badge variant="warning" size="sm">
                        {t('pricing_engine.advisor.label.raisesPrice', 'Raises the customer price')}
                      </Badge>
                    ) : null}
                  </div>
                  {subject ? <div className="text-xs text-muted-foreground">{subject}</div> : null}
                  <dl className="space-y-1 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <dt className="text-muted-foreground">{t('pricing_engine.advisor.column.customerPrice', 'Customer unit price')}</dt>
                      <dd>
                        <Delta before={suggestion.customerUnitPriceBefore} after={suggestion.customerUnitPriceAfter} currencyCode={currencyCode} />
                      </dd>
                    </div>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <dt className="text-muted-foreground">{t('pricing_engine.advisor.column.basketProfit', 'Your profit on the whole order')}</dt>
                      <dd>
                        <Delta before={suggestion.basketProfitBefore} after={suggestion.basketProfitAfter} currencyCode={currencyCode} />
                      </dd>
                    </div>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <dt className="text-muted-foreground">{t('pricing_engine.advisor.column.margin', 'Margin on price')}</dt>
                      <dd>
                        <Delta before={suggestion.supplierMarginPercentBefore} after={suggestion.supplierMarginPercentAfter} suffix="%" />
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                    {applicable ? (
                      <Button type="button" size="sm" onClick={() => onApply(suggestion)} disabled={pending}>
                        {t('pricing_engine.desk.advice.apply', 'Apply to the basket')}
                      </Button>
                    ) : null}
                    <Button type="button" size="sm" variant="ghost" onClick={() => setExpanded(isOpen ? null : id)}>
                      {isOpen
                        ? t('pricing_engine.desk.advice.hideDetails', 'Hide details')
                        : t('pricing_engine.desk.advice.showDetails', 'Details')}
                    </Button>
                  </div>
                  {isOpen ? <SuggestionCard suggestion={suggestion} currencyCode={currencyCode} /> : null}
                </div>
              )
            })}
          </div>
        </>
      )}

      {(advice?.purchasingInsights.length ?? 0) > 0 ? (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {advice?.purchasingInsights.map((insight) => (
            <li key={insight.productId}>
              <span className="font-medium text-foreground">{insight.sku ?? insight.productId}</span>
              {': '}
              {t(
                'pricing_engine.advisor.purchasing.nextTier.explain',
                'You are {unitsToNextTier} units a year short of the {nextTierDiscount}% tier (you are on {currentTierDiscount}% today). Closing that gap takes {unitCostSaving} {currency} off every future unit, worth about {annualSavingAtNextTier} {currency} a year.',
                {
                  unitsToNextTier: insight.unitsToNextTier,
                  nextTierDiscount: insight.nextTierDiscount,
                  currentTierDiscount: insight.currentTierDiscount,
                  unitCostSaving: insight.unitCostSaving,
                  annualSavingAtNextTier: insight.annualSavingAtNextTier,
                  currency: currencyCode,
                },
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

export default AdviceStrip
