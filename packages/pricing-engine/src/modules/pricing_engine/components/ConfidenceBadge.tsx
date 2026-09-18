'use client'

import * as React from 'react'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { QuoteConfidence } from '../lib/frontend/quoteTypes'

// Data quality is a status, not a brand colour: a figure the engine measured must not look the same
// as one it assumed, because the operator's next move depends entirely on which of the two it is.
const CONFIDENCE_VARIANT: Record<QuoteConfidence, 'success' | 'warning' | 'neutral'> = {
  measured: 'success',
  estimated: 'warning',
  default: 'neutral',
}

const CONFIDENCE_FALLBACK: Record<QuoteConfidence, string> = {
  measured: 'Measured',
  estimated: 'Estimated',
  default: 'Assumed',
}

export type ConfidenceBadgeProps = {
  confidence: QuoteConfidence
  className?: string
}

export function ConfidenceBadge({ confidence, className }: ConfidenceBadgeProps) {
  const t = useT()
  const variant = CONFIDENCE_VARIANT[confidence] ?? 'neutral'
  const fallback = CONFIDENCE_FALLBACK[confidence] ?? confidence
  return (
    <Badge variant={variant} size="sm" className={className}>
      {t(`pricing_engine.confidence.${confidence}`, fallback)}
    </Badge>
  )
}

export default ConfidenceBadge
