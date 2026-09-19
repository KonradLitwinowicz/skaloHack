import type {
  PricingLineResult,
  PricingQuoteResult,
} from '@open-mercato/pricing-engine/modules/pricing_engine/lib/types'

export type PortalQuoteLine = {
  productId: string
  sku: string | null
  quantity: string
  unitPriceNet: string
  totalPriceNet: string
}

export type PortalQuoteResponse = {
  ok: true
  currencyCode: string
  lines: PortalQuoteLine[]
  totalNet: string
}

/**
 * THE REDACTION BOUNDARY. `PricingQuoteResult` carries the distributor's cost basis —
 * `unitCostNet`, `markupPercent`, `marginPercent`, the eleven-component `breakdown` with its
 * purchase costs and labour rates, `totalCostNet`, `calculationId`, `parameterSetVersion` and
 * source-coverage `warnings`. A buyer must never receive any of it.
 *
 * Both functions build their output FIELD BY FIELD from an explicit allow-list. Never rewrite
 * this as a spread-and-delete: a field added to the engine result later would then leak by
 * default, and the whole point of this file is that it fails closed instead.
 *
 * `__tests__/portalPricing.test.ts` serialises the output and scans the JSON string for the
 * forbidden substrings, so the guarantee survives a refactor of the types above.
 */
export function toPortalQuoteLine(line: PricingLineResult): PortalQuoteLine {
  return {
    productId: line.line.productId,
    sku: line.line.sku ?? null,
    quantity: line.line.quantity,
    unitPriceNet: line.unitPriceNet,
    totalPriceNet: line.totalPriceNet,
  }
}

export function toPortalQuote(result: PricingQuoteResult): PortalQuoteResponse {
  return {
    ok: true,
    currencyCode: result.currencyCode,
    lines: result.lines.map(toPortalQuoteLine),
    totalNet: result.totalNet,
  }
}
