'use client'

import * as React from 'react'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@open-mercato/ui/primitives/card'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ConfidenceBadge } from '../../../components/ConfidenceBadge'
import { formatMoney } from '../../../lib/frontend/marginMath'
import type {
  AdvisorObjectiveContribution,
  AdvisorObjectiveMetric,
  AdvisorObjectiveScore,
  AdvisorSuggestion,
} from '../../../lib/frontend/advisorTypes'

export type SuggestionCardProps = {
  suggestion: AdvisorSuggestion
  currencyCode: string
}

type TranslateFn = (key: string, fallback?: string) => string

const KIND_FALLBACK: Record<AdvisorSuggestion['code'], string> = {
  volume_threshold: 'Order more and pay less per unit',
  full_pack_rounding: 'Round up to a whole pack',
  basket_consolidation: 'Merge these orders into one delivery',
  cheaper_equivalent: 'A cheaper product in the same group',
  order_channel_change: 'Move this customer to a cheaper ordering channel',
}

function renderTemplate(t: TranslateFn, key: string, values: Record<string, string>): string {
  return t(key, key).replace(/\{(\w+)\}/g, (match, token: string) => values[token] ?? match)
}

// A card that says "round up to a whole pack" over a five-line basket is unactionable until it
// says WHICH line. Title first, SKU second, id last — never an id alone when a name exists.
function subjectLabel(suggestion: AdvisorSuggestion): string | null {
  const subject = suggestion.subject
  if (!subject) return null
  const parts = [subject.title, subject.sku].filter((part): part is string => Boolean(part))
  if (parts.length === 0) return subject.productId
  return parts.join(' \u00b7 ')
}

function toNumber(value: string | null | undefined): number {
  const parsed = Number(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}

type ComparisonRowProps = {
  label: string
  before: string
  after: string
  currencyCode?: string
  suffix?: string
}

// Before and after sit on the same row on purpose: a suggestion that shows only the "after" is an
// assertion, and the whole point of this screen is that both sides are computed and visible.
function ComparisonRow({ label, before, after, currencyCode, suffix }: ComparisonRowProps) {
  const t = useT()
  const delta = toNumber(after) - toNumber(before)
  const format = (value: string) =>
    currencyCode !== undefined ? formatMoney(value, currencyCode) : `${toNumber(value).toFixed(2)}${suffix ?? ''}`
  const deltaVariant = delta > 0 ? 'success' : delta < 0 ? 'error' : 'neutral'

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border py-2 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-2 text-sm">
        <span className="text-muted-foreground line-through">{format(before)}</span>
        <span className="font-medium">{format(after)}</span>
        <Badge variant={deltaVariant} size="sm">
          {delta > 0 ? '+' : ''}
          {currencyCode !== undefined ? formatMoney(String(delta), currencyCode) : `${delta.toFixed(2)}${suffix ?? ''}`}
        </Badge>
        <span className="sr-only">{t('pricing_engine.advisor.label.delta', 'Change')}</span>
      </span>
    </div>
  )
}

export const OBJECTIVE_METRIC_FALLBACK: Record<AdvisorObjectiveMetric, string> = {
  marginPercent: 'Margin on price',
  profitNet: 'Profit on the whole order',
  revenueNet: 'Revenue',
  unitCostNet: 'Cost to serve one unit',
  productCost: 'Purchase cost',
  operationalCost: 'Order handling labour',
  packagingCost: 'Packaging',
  warehouseCost: 'Warehousing',
  logisticsCost: 'Delivery',
}

/**
 * The per-objective breakdown behind the ranking. A weighted score that arrives as one number is
 * an assertion; the operator configured these weights and has to be able to see each one paying
 * out, including the ones they switched off.
 */
function ObjectiveBreakdown({ score }: { score: AdvisorObjectiveScore }) {
  const t = useT()
  const contributionRow = (contribution: AdvisorObjectiveContribution) => {
    const isDisabled = toNumber(contribution.weight) === 0
    const value = toNumber(contribution.contribution)
    return (
      <div
        key={contribution.code}
        className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border py-2 last:border-b-0"
      >
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium">{contribution.label}</span>
          <span className="text-xs text-muted-foreground">
            {t(
              `pricing_engine.advisor.metric.${contribution.metric}`,
              OBJECTIVE_METRIC_FALLBACK[contribution.metric],
            )}
          </span>
          {isDisabled ? (
            <Badge variant="neutral" size="sm">
              {t('pricing_engine.advisor.objectives.disabled', 'Switched off')}
            </Badge>
          ) : (
            <Badge variant="outline" size="sm">
              {t('pricing_engine.advisor.objectives.weight', 'Weight {weight}', {
                weight: String(toNumber(contribution.weight)),
              })}
            </Badge>
          )}
        </span>
        <span className="flex items-baseline gap-3 font-mono text-sm">
          <span className="text-muted-foreground">
            {t('pricing_engine.advisor.objectives.delta', 'Moves by {delta}', {
              delta: contribution.delta,
            })}
          </span>
          <Badge variant={value > 0 ? 'success' : value < 0 ? 'error' : 'neutral'} size="sm">
            {value > 0 ? '+' : ''}
            {contribution.contribution}
          </Badge>
        </span>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-overline font-semibold uppercase tracking-widest text-muted-foreground">
          {t('pricing_engine.advisor.objectives.title', 'How this scores against your objectives')}
        </span>
        <span className="font-mono text-sm font-medium">
          {t('pricing_engine.advisor.objectives.total', 'Score {total}', { total: score.total })}
        </span>
      </div>
      <div className="mt-2">{score.contributions.map(contributionRow)}</div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t(
          'pricing_engine.advisor.objectives.hint',
          'Each objective is measured on this suggestion, scaled against the current value so a percentage point and a zloty are comparable, then weighted. A margin floor is never overridden by a weight — suggestions that would breach one are not listed at all.',
        )}
      </p>
    </div>
  )
}

export function SuggestionCard({ suggestion, currencyCode }: SuggestionCardProps) {
  const t = useT()
  const subject = subjectLabel(suggestion)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>{t(suggestion.titleKey, KIND_FALLBACK[suggestion.code])}</span>
          <ConfidenceBadge confidence={suggestion.confidence} />
          {suggestion.raisesCustomerPrice ? (
            <Badge variant="warning" size="sm">
              {t('pricing_engine.advisor.label.raisesPrice', 'Raises the customer price')}
            </Badge>
          ) : null}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {subject
            ? `${t('pricing_engine.advisor.label.subject', 'Product')}: ${subject}`
            : t('pricing_engine.advisor.label.subjectWholeOrder', 'Applies to the whole order')}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {renderTemplate(t, suggestion.explainKey, suggestion.explainValues)}
        </p>

        {suggestion.code === 'cheaper_equivalent' ? (
          <div className="rounded-md border-l-4 border-status-warning-border bg-status-warning-bg p-3 text-sm text-foreground">
            {t(
              'pricing_engine.advisor.suggestion.cheaperEquivalent.caution',
              'A product group is a category, not a list of substitutes. Confirm with the customer that the two products do the same job before you offer this.',
            )}
          </div>
        ) : null}

        <div>
          <ComparisonRow
            label={t('pricing_engine.advisor.column.customerPrice', 'Customer unit price')}
            before={suggestion.customerUnitPriceBefore}
            after={suggestion.customerUnitPriceAfter}
            currencyCode={currencyCode}
          />
          <ComparisonRow
            label={t('pricing_engine.advisor.column.supplierProfit', 'Your profit per unit')}
            before={suggestion.supplierProfitBefore}
            after={suggestion.supplierProfitAfter}
            currencyCode={currencyCode}
          />
          <ComparisonRow
            label={t('pricing_engine.advisor.column.basketProfit', 'Your profit on the whole order')}
            before={suggestion.basketProfitBefore}
            after={suggestion.basketProfitAfter}
            currencyCode={currencyCode}
          />
          <ComparisonRow
            label={t('pricing_engine.advisor.column.margin', 'Margin on price')}
            before={suggestion.supplierMarginPercentBefore}
            after={suggestion.supplierMarginPercentAfter}
            suffix="%"
          />
        </div>

        {suggestion.objectiveScore ? <ObjectiveBreakdown score={suggestion.objectiveScore} /> : null}

        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-overline font-semibold uppercase tracking-widest text-muted-foreground">
              {t('pricing_engine.advisor.label.profitNeutral', 'Profit-neutral price')}
            </dt>
            <dd className="text-sm font-medium">
              {formatMoney(suggestion.profitNeutralUnitPrice, currencyCode)}
            </dd>
            <dd className="text-xs text-muted-foreground">
              {t(
                'pricing_engine.advisor.label.profitNeutralHint',
                'Charge this and the customer keeps the whole saving while your profit in cash stays exactly where it was.',
              )}
            </dd>
          </div>
          <div>
            <dt className="text-overline font-semibold uppercase tracking-widest text-muted-foreground">
              {t('pricing_engine.advisor.label.guardrailFloor', 'Guardrail floor')}
            </dt>
            <dd className="text-sm font-medium">
              {suggestion.guardrailFloorUnitPrice
                ? formatMoney(suggestion.guardrailFloorUnitPrice, currencyCode)
                : t('pricing_engine.advisor.label.noFloor', 'No minimum margin configured')}
            </dd>
          </div>
        </dl>

        <p className="text-xs text-muted-foreground">
          {t('pricing_engine.advisor.label.breakEven', 'Stops being worth it when:')}{' '}
          {renderTemplate(t, suggestion.breakEvenConditionKey, suggestion.explainValues)}
        </p>
      </CardContent>
    </Card>
  )
}

export default SuggestionCard
