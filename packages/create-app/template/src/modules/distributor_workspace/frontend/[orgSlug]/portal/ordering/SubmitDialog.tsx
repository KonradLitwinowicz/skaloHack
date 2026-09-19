"use client"

import * as React from 'react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { useDialogKeyHandler } from '@open-mercato/ui/hooks/useDialogKeyHandler'
import { formatMoney, type PortalQuoteResponse, type SubmitKind } from './types'

type SubmitDialogProps = {
  open: boolean
  kind: SubmitKind
  quote: PortalQuoteResponse | null
  lineCount: number
  isSubmitting: boolean
  comments: string
  onCommentsChange: (value: string) => void
  onConfirm: () => void
  onClose: () => void
}

export function SubmitDialog({
  open,
  kind,
  quote,
  lineCount,
  isSubmitting,
  comments,
  onCommentsChange,
  onConfirm,
  onClose,
}: SubmitDialogProps) {
  const t = useT()
  const locale = useLocale()
  const handleKeyDown = useDialogKeyHandler({
    onConfirm,
    onCancel: onClose,
    disabled: isSubmitting || !quote,
  })

  const title =
    kind === 'order'
      ? t('distributor_workspace.portal.ordering.submit.orderTitle', 'Place this order?')
      : t('distributor_workspace.portal.ordering.submit.quoteTitle', 'Request a quote?')
  const description =
    kind === 'order'
      ? t(
          'distributor_workspace.portal.ordering.submit.orderDescription',
          'We recalculate the prices on our side before the order is created.',
        )
      : t(
          'distributor_workspace.portal.ordering.submit.quoteDescription',
          'Your sales representative receives the basket and confirms the prices.',
        )

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
            <span className="text-sm text-muted-foreground">
              {t('distributor_workspace.portal.ordering.submit.lineCount', '{count} products', {
                count: String(lineCount),
              })}
            </span>
            <span className="text-base font-semibold tabular-nums text-foreground">
              {quote ? formatMoney(quote.totalNet, quote.currencyCode, locale) : ''}
            </span>
          </div>
          <FormField
            id="portal-ordering-comments"
            label={t('distributor_workspace.portal.ordering.submit.commentsLabel', 'Note for the distributor')}
          >
            <Textarea
              id="portal-ordering-comments"
              rows={3}
              maxLength={4000}
              value={comments}
              onChange={(event) => onCommentsChange(event.target.value)}
              placeholder={t(
                'distributor_workspace.portal.ordering.submit.commentsPlaceholder',
                'Delivery window, purchase order number, anything else we should know',
              )}
              disabled={isSubmitting}
            />
          </FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
            {t('distributor_workspace.portal.ordering.submit.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={onConfirm} disabled={isSubmitting || !quote}>
            {kind === 'order'
              ? t('distributor_workspace.portal.ordering.submit.confirmOrder', 'Place order')
              : t('distributor_workspace.portal.ordering.submit.confirmQuote', 'Send request')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
