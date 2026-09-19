"use client"

import * as React from 'react'
import Link from 'next/link'
import { ArrowRight, CheckCircle2 } from 'lucide-react'
import { z } from 'zod'
import type { DashboardWidgetComponentProps } from '@open-mercato/shared/modules/dashboard/widgets'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { useOptionalLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { cn } from '@open-mercato/shared/lib/utils'
import { NEXT_ACTION_KINDS, type NextActionKind, type NextActionTone } from '../../../lib/nextActions'

const logger = createLogger('distributor_workspace').child({ component: 'next-actions-widget' })

const NEXT_ACTIONS_ENDPOINT = '/api/distributor_workspace/dashboard/next-actions'

const responseSchema = z.object({
  generatedAt: z.string(),
  actions: z.array(
    z.object({
      kind: z.enum(NEXT_ACTION_KINDS),
      count: z.number(),
      href: z.string(),
      tone: z.enum(['error', 'warning', 'info']),
      deadlineAt: z.string().nullable(),
      daysUntilDeadline: z.number().nullable(),
      amount: z.number().nullable(),
      currencyCode: z.string().nullable(),
    }),
  ),
})

type NextActionsResponse = z.infer<typeof responseSchema>
type NextActionRow = NextActionsResponse['actions'][number]

// Word for word the values of `distributor_workspace.widgets.nextActions.action.<kind>` in
// i18n/en.json. This map is the label the operator reads whenever the catalogue is missing
// (SSR without a dict, a failed `resolveTranslations`), so a fallback that drifts from the
// catalogue is a second, silently different product text. Two of them did drift: one promised
// "this week" for a window that is EXPIRING_SOON_DAYS (30) days wide, the other invented a
// "critical level" the rest of the product calls the safety level.
const ACTION_LABEL_FALLBACK: Record<NextActionKind, string> = {
  expiringStock: 'Stock running out of shelf life',
  quoteRequestsToAnswer: 'Quote requests waiting for your answer',
  quotesAwaitingReply: 'Quotes waiting for a customer reply',
  ordersToFulfil: 'Orders waiting to be picked',
  criticalStock: 'Stock below the safety level',
}

const TONE_ACCENT: Record<NextActionTone, string> = {
  error: 'border-l-status-error-border',
  warning: 'border-l-status-warning-border',
  info: 'border-l-status-info-border',
}

const TONE_COUNT: Record<NextActionTone, string> = {
  error: 'text-status-error-text',
  warning: 'text-status-warning-text',
  info: 'text-status-info-text',
}

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/

// Em dash, not a middot: `.ai/ds-rules.md` (Content & Copy) forbids the middot as a separator
// in UI text.
const DETAIL_SEPARATOR = ' — '

async function loadNextActions(): Promise<NextActionsResponse> {
  const call = await apiCall<unknown>(NEXT_ACTIONS_ENDPOINT)
  if (!call.ok) {
    throw new Error(`[internal] Next actions request failed with status ${call.status}`)
  }
  return responseSchema.parse(call.result)
}

/**
 * Dates and money follow the APP locale, not `navigator.language`.
 *
 * Measured on the live dashboard with the UI in Polish: the browser-locale version rendered this
 * row as "Sep 19, 2026 — PLN 520.94" while every neighbouring widget wrote "19 wrz 2026" and
 * "520,94 PLN". The separators are the dangerous half — "PLN 7,466.10" reads to a Polish speaker
 * as seven point four, not seven thousand. The operator picked the interface language; the numbers
 * in it have to obey that choice, whatever language their browser happens to be installed in.
 *
 * `useOptionalLocale` rather than `useLocale` so the widget still renders in tests and galleries
 * that mount it outside an `I18nProvider`; `undefined` then falls back to the runtime default,
 * which is the behaviour every other widget on this dashboard already has.
 */
function useAppLocale(): string | undefined {
  return useOptionalLocale()
}

const NextActionsWidget: React.FC<DashboardWidgetComponentProps> = ({
  mode,
  refreshToken,
  onRefreshStateChange,
}) => {
  const t = useT()
  const locale = useAppLocale()
  const [actions, setActions] = React.useState<NextActionRow[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const dateFormatter = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }),
    [locale],
  )

  // The count sits two centimetres from the value on the same row. Grouping one and not the
  // other reads as two different kinds of number, so both go through `Intl`, and both use the
  // same app locale the currency and the date use — one source for every number on the card.
  const countFormatter = React.useMemo(() => new Intl.NumberFormat(locale), [locale])

  const refresh = React.useCallback(async () => {
    onRefreshStateChange?.(true)
    setError(null)
    try {
      const payload = await loadNextActions()
      setActions(payload.actions)
    } catch (err) {
      logger.error('Failed to load next actions', { err })
      setError(t('distributor_workspace.widgets.nextActions.error', 'Could not load today’s to-do list'))
    } finally {
      onRefreshStateChange?.(false)
    }
  }, [onRefreshStateChange, t])

  React.useEffect(() => {
    refresh().catch(() => {})
  }, [refresh, refreshToken])

  const formatAmount = React.useCallback(
    (amount: number, currencyCode: string | null): string => {
      if (currencyCode && CURRENCY_CODE_PATTERN.test(currencyCode)) {
        return new Intl.NumberFormat(locale, { style: 'currency', currency: currencyCode }).format(amount)
      }
      return countFormatter.format(amount)
    },
    [countFormatter, locale],
  )

  const describeAction = React.useCallback(
    (action: NextActionRow): string | null => {
      const parts: string[] = []
      if (action.deadlineAt && action.daysUntilDeadline !== null) {
        const date = dateFormatter.format(new Date(action.deadlineAt))
        parts.push(
          action.daysUntilDeadline < 0
            ? t('distributor_workspace.widgets.nextActions.deadlinePassed', 'Deadline passed: {{date}}', { date })
            : t('distributor_workspace.widgets.nextActions.deadline', 'Nearest deadline: {{date}}', { date }),
        )
      }
      if (action.amount !== null) {
        parts.push(
          t('distributor_workspace.widgets.nextActions.amount', 'Value: {{amount}}', {
            amount: formatAmount(action.amount, action.currencyCode),
          }),
        )
      }
      return parts.length > 0 ? parts.join(DETAIL_SEPARATOR) : null
    },
    [dateFormatter, formatAmount, t],
  )

  if (mode === 'settings') {
    return (
      <p className="text-sm text-muted-foreground">
        {t(
          'distributor_workspace.widgets.nextActions.settings.none',
          'Nothing to configure — the order follows how irreversible each item is and how close its deadline sits.',
        )}
      </p>
    )
  }

  if (error) {
    return <ErrorMessage label={error} />
  }

  if (actions === null) {
    return <LoadingMessage label={t('distributor_workspace.widgets.nextActions.loading', 'Checking what needs you today…')} />
  }

  if (actions.length === 0) {
    return (
      <EmptyState
        variant="subtle"
        icon={<CheckCircle2 className="h-5 w-5 text-status-success-icon" aria-hidden />}
        title={t('distributor_workspace.widgets.nextActions.empty.title', 'Nothing urgent today')}
        description={t(
          'distributor_workspace.widgets.nextActions.empty.description',
          'No stock is close to its expiry date, every quote has an answer and every order is on its way.',
        )}
      />
    )
  }

  return (
    <ul className="space-y-2">
      {actions.map((action) => {
        const detail = describeAction(action)
        return (
          <li key={action.kind}>
            <Link
              href={action.href}
              className={cn(
                'group flex items-center gap-3 rounded-md border border-border border-l-4 bg-card px-3 py-2.5 transition-colors hover:bg-accent',
                TONE_ACCENT[action.tone],
              )}
            >
              {/* `min-w-14` keeps the column aligned across rows the way a fixed `w-10` did, but a
                  four-digit count grows the box instead of spilling out of it. */}
              <span className={cn('min-w-14 shrink-0 text-right text-2xl font-semibold tabular-nums', TONE_COUNT[action.tone])}>
                {countFormatter.format(action.count)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">
                  {t(`distributor_workspace.widgets.nextActions.action.${action.kind}`, ACTION_LABEL_FALLBACK[action.kind])}
                </span>
                {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
              </span>
              <ArrowRight
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

export default NextActionsWidget
