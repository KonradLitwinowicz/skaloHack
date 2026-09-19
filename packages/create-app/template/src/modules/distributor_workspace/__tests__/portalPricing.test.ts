import { toPortalQuote } from '../lib/portalPricing'
import type {
  ComponentResult,
  PricingQuoteResult,
} from '@open-mercato/pricing-engine/modules/pricing_engine/lib/types'

/**
 * Substrings that must never reach a buyer. The assertion scans the serialised payload rather
 * than the typed object so it still fails if someone widens `PortalQuoteResponse` or starts
 * spreading the engine result instead of building the response field by field.
 */
const FORBIDDEN_SUBSTRINGS = [
  'unitCostNet',
  'markupPercent',
  'marginPercent',
  'breakdown',
  'warnings',
  'calculationId',
  'parameterSetVersion',
  'totalCostNet',
  'labor',
  'purchase',
]

function componentResult(code: string, value: string): ComponentResult {
  return {
    code,
    labelKey: `pricing_engine.components.${code}.label`,
    effect: 'add',
    value,
    inputs: { lastDeliveryUnitCost: '26.0700', laborRatePerHour: '48.0000' },
    params: { targetMarkup: '0.3200' },
    explainKey: `pricing_engine.components.${code}.explain`,
    explainValues: { purchaseCost: '26.0700' },
    confidence: 'measured',
    warnings: ['pricing_engine.warnings.missingPurchasePosition'],
  }
}

function seededQuoteResult(): PricingQuoteResult {
  return {
    calculationId: '2f2b5f6c-2f0a-4c74-9d2e-0b9a1f5c1234',
    currencyCode: 'PLN',
    mode: 'shadow',
    parameterSetVersion: 7,
    lines: [
      {
        line: {
          productId: 'a1d3e0f2-11aa-4f0b-9f0c-9e1c2d3b4a55',
          variantId: null,
          sku: 'HOR-CHEM-0001',
          quantity: '12',
          enteredQuantity: null,
          enteredUnitCode: null,
        },
        unitPriceNet: '83.5200',
        totalPriceNet: '1002.2400',
        unitCostNet: '26.0700',
        markupPercent: '2.2036',
        marginPercent: '0.6879',
        breakdown: [
          componentResult('purchase_cost', '26.0700'),
          componentResult('labor_cost', '4.1200'),
          componentResult('packaging_cost', '1.9000'),
          componentResult('warehouse_cost', '2.4500'),
          componentResult('logistics_cost', '6.8000'),
          componentResult('customer_indicators', '0.5000'),
          componentResult('order_scenario', '1.1000'),
          componentResult('target_markup', '18.4000'),
          componentResult('guardrails', '0.0000'),
        ],
        warnings: ['pricing_engine.warnings.missingDeliveryZone'],
      },
    ],
    totalNet: '1002.2400',
    totalCostNet: '312.8400',
    totalMarkupPercent: '2.2036',
    totalMarginPercent: '0.6879',
    warnings: ['pricing_engine.warnings.missingDeliveryZone'],
    durationMs: 17,
  }
}

describe('toPortalQuote', () => {
  it('returns only the fields a buyer is allowed to see', () => {
    const portal = toPortalQuote(seededQuoteResult())

    expect(portal).toEqual({
      ok: true,
      currencyCode: 'PLN',
      totalNet: '1002.2400',
      lines: [
        {
          productId: 'a1d3e0f2-11aa-4f0b-9f0c-9e1c2d3b4a55',
          sku: 'HOR-CHEM-0001',
          quantity: '12',
          unitPriceNet: '83.5200',
          totalPriceNet: '1002.2400',
        },
      ],
    })
  })

  it('leaks no cost, markup, margin, breakdown or warning data into the serialised payload', () => {
    const serialised = JSON.stringify(toPortalQuote(seededQuoteResult()))

    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(serialised).not.toContain(forbidden)
    }
    expect(serialised).not.toContain('26.07')
    expect(serialised).toContain('83.5200')
  })

  it('keeps the allow-list stable when the engine result carries unknown extra fields', () => {
    const polluted = {
      ...seededQuoteResult(),
      futureCostField: '26.0700',
      lines: seededQuoteResult().lines.map((line) => ({ ...line, futureLineCost: '26.0700' })),
    } as PricingQuoteResult

    const serialised = JSON.stringify(toPortalQuote(polluted))

    expect(serialised).not.toContain('futureCostField')
    expect(serialised).not.toContain('futureLineCost')
    expect(serialised).not.toContain('26.07')
  })
})
