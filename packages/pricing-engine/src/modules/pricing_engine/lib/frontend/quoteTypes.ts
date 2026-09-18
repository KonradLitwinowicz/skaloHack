export type QuoteConfidence = 'measured' | 'estimated' | 'default'

export type QuoteBreakdownComponent = {
  code: string
  labelKey: string
  effect: 'add' | 'mul'
  value: string
  runningTotal?: string
  inputs: Record<string, unknown>
  params: Record<string, unknown>
  explainKey: string
  explainValues: Record<string, unknown>
  confidence: QuoteConfidence
  warnings?: string[]
}

export type QuoteLine = {
  productId: string
  sku: string | null
  quantity: string
  unitPriceNet: string
  totalPriceNet: string
  unitCostNet: string
  markupPercent: string
  marginPercent: string
  breakdown: QuoteBreakdownComponent[]
  warnings: string[]
}

export type QuoteResponse = {
  calculationId: string | null
  currencyCode: string
  mode: 'shadow' | 'advisory' | 'live'
  parameterSetVersion: number
  lines: QuoteLine[]
  totalNet: string
  totalCostNet: string
  totalMarkupPercent: string
  totalMarginPercent: string
  warnings: string[]
  durationMs: number
}

export type CoverageItem = {
  componentCode: string
  labelKey: string
  implemented: boolean
  sourceKind: string
  sourceRef: string | null
  freshnessDays: number | null
  confidence: QuoteConfidence
  missingReasonKey: string | null
  lastCheckedAt: string | null
}

export type CoverageResponse = { items: CoverageItem[] }
