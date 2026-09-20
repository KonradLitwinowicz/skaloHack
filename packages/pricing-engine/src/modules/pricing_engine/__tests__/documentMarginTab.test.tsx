/** @jest-environment jsdom */

import * as React from 'react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { DocumentMarginPanel } from '../components/DocumentMarginPanel'
import { isDocumentPricingContext, toSimulateLines } from '../widgets/injection/document-margin-tab'
import { withRunningTotals } from '../lib/frontend/runningTotals'
import type { QuoteBreakdownComponent, QuoteResponse } from '../lib/frontend/quoteTypes'

function buildComponent(overrides: Partial<QuoteBreakdownComponent> = {}): QuoteBreakdownComponent {
  return {
    code: 'product_cost',
    labelKey: 'pricing_engine.components.productCost.label',
    effect: 'add',
    value: '100.0000',
    inputs: { sku: 'SKU-1' },
    params: { turnoverDays: '30' },
    explainKey: 'pricing_engine.components.productCost.explain.fresh',
    explainValues: { cost: '100.0000' },
    confidence: 'measured',
    ...overrides,
  }
}

function buildQuote(): QuoteResponse {
  const breakdown = withRunningTotals([
    buildComponent(),
    buildComponent({
      code: 'target_margin',
      labelKey: 'pricing_engine.components.targetMargin.label',
      effect: 'mul',
      value: '1.6600',
      confidence: 'default',
      params: { targetMarkupPercent: '66.0000' },
      explainKey: 'pricing_engine.components.targetMargin.explain',
      explainValues: { markupPercent: '66.0000' },
    }),
  ])
  return {
    calculationId: null,
    currencyCode: 'PLN',
    mode: 'shadow',
    parameterSetVersion: 1,
    lines: [
      {
        productId: '11111111-1111-1111-1111-111111111111',
        sku: 'SKU-1',
        quantity: '2',
        unitPriceNet: '166.0000',
        totalPriceNet: '332.0000',
        unitCostNet: '100.0000',
        markupPercent: '66.0000',
        marginPercent: '39.7590',
        breakdown,
        warnings: [],
      },
    ],
    totalNet: '332.0000',
    totalCostNet: '200.0000',
    totalMarkupPercent: '66.0000',
    totalMarginPercent: '39.7590',
    warnings: [],
    durationMs: 3,
  }
}

describe('document margin tab context guard', () => {
  it('rejects anything the sales detail page could hand over before a record exists', () => {
    expect(isDocumentPricingContext(undefined)).toBe(false)
    expect(isDocumentPricingContext({})).toBe(false)
    expect(isDocumentPricingContext({ kind: 'order' })).toBe(false)
    expect(isDocumentPricingContext({ kind: 'order', record: null })).toBe(false)
    expect(isDocumentPricingContext({ kind: 'invoice', record: { id: 'abc' } })).toBe(false)
    expect(isDocumentPricingContext({ kind: 'order', record: { id: '   ' } })).toBe(false)
  })

  it('accepts both document kinds once the record carries an id', () => {
    expect(isDocumentPricingContext({ kind: 'order', record: { id: 'order-1' } })).toBe(true)
    expect(
      isDocumentPricingContext({ kind: 'quote', record: { id: 'quote-1', currencyCode: 'PLN' } }),
    ).toBe(true)
  })
})

describe('sales line mapping', () => {
  it('keeps priceable lines and drops the ones the simulate endpoint would reject', () => {
    expect(
      toSimulateLines([
        { id: 'a', product_id: 'p-1', quantity: 3 },
        { id: 'b', productId: 'p-2', quantity: '1.5' },
        { id: 'c', product_id: null, quantity: 2 },
        { id: 'd', product_id: 'p-3', quantity: 0 },
      ]),
    ).toEqual([
      { productId: 'p-1', quantity: '3' },
      { productId: 'p-2', quantity: '1.5' },
    ])
  })
})

describe('DocumentMarginPanel states', () => {
  const emptyTitle = 'Nothing to price yet'

  it('renders the loading state first', () => {
    const { container } = renderWithProviders(
      <DocumentMarginPanel
        quote={null}
        currencyCode="PLN"
        loading
        error={null}
        emptyTitle={emptyTitle}
      />,
    )
    expect(container.textContent).toContain('Pricing this document')
  })

  it('renders the error over the empty state, because a failed simulation also has no lines', () => {
    const { getByText, queryByText } = renderWithProviders(
      <DocumentMarginPanel
        quote={null}
        currencyCode="PLN"
        loading={false}
        error="Pricing failed."
        emptyTitle={emptyTitle}
      />,
    )
    expect(getByText('Pricing failed.')).toBeTruthy()
    expect(queryByText(emptyTitle)).toBeNull()
  })

  it('renders the empty state when there is nothing priceable', () => {
    const { getByText } = renderWithProviders(
      <DocumentMarginPanel
        quote={null}
        currencyCode="PLN"
        loading={false}
        error={null}
        emptyTitle={emptyTitle}
      />,
    )
    expect(getByText(emptyTitle)).toBeTruthy()
  })

  it('renders profit, margin and the assumptions once a quote arrives', () => {
    const { container, getByText } = renderWithProviders(
      <DocumentMarginPanel
        quote={buildQuote()}
        currencyCode="PLN"
        loading={false}
        error={null}
        emptyTitle={emptyTitle}
      />,
    )
    const text = container.textContent ?? ''
    // 332 revenue - 200 cost: the API sends no profit field, the panel derives it.
    expect(text).toContain('132,00 PLN')
    expect(text).toContain('39.76')
    expect(getByText('What this price assumes')).toBeTruthy()
    // The target-margin component runs on a default, so it must not read as measured.
    expect(text).toContain('Assumed')
  })

  it('flags a margin under the floor', () => {
    const { getByText } = renderWithProviders(
      <DocumentMarginPanel
        quote={buildQuote()}
        currencyCode="PLN"
        loading={false}
        error={null}
        emptyTitle={emptyTitle}
        floorMarginPercent="45"
      />,
    )
    expect(getByText('Below the minimum margin')).toBeTruthy()
  })
})
