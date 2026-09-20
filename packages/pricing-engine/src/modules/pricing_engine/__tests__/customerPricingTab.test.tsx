/** @jest-environment jsdom */

import * as React from 'react'
import { act, fireEvent } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import {
  CustomerPricingPanel,
  IMPACT_PROBE_UNIT_PRICE,
  NegotiatedPricesEditor,
  NegotiatedPricingContext,
  buildImpactRequestUrl,
  labelForCode,
  loadCustomerPricingImpact,
  parseImpactPayload,
  projectEngineOutcome,
  pricesFromRows,
  readCustomerId,
  rowsFromPrices,
  summarizeNegotiatedPrecedence,
  toProfileRow,
  type CustomerPricingProfileRow,
  type NegotiatedPricingContextValue,
  type NegotiatedRow,
  type PricingImpact,
  type PricingImpactItem,
} from '../widgets/injection/customer-pricing-tab/widget.client'

// `CrudForm` reaches for the app router; jsdom has none mounted.
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
  usePathname: () => '/backend/customers/companies-v2/company-1',
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}))

// CrudForm loads its injected field widgets asynchronously; let those settle before asserting.
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

const PRODUCT_ID = '145262d9-6fd6-423a-bfeb-9b9cc45619b6'
const OTHER_PRODUCT_ID = '22222222-2222-2222-2222-222222222222'
const CUSTOMER_ID = '30606e57-1949-482a-91fd-a32d360fddab'

/**
 * The literal body `/api/pricing/customer-pricing-impact` answered on the running server for
 * customer 30606e57 / product PACK-0056 at `proposedUnitPriceNet=25.00`. Every figure the tab
 * renders is read out of this shape, so the fixture is the response itself rather than a
 * hand-written approximation of it.
 */
function measuredPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true,
    unavailableReasonKeys: [],
    currencyCode: 'PLN',
    amountsAreNetOfVat: true,
    customerId: CUSTOMER_ID,
    productId: PRODUCT_ID,
    quantity: '1',
    unitCostNet: '92.3321',
    negotiatedPrice: {
      proposedUnitPriceNet: '25.0000',
      appliesToQuote: true,
      precedence: 'negotiated_wins',
      ignoredReasonKey: null,
      storedUnitPriceNet: null,
    },
    enginePrice: {
      unitPriceNet: '160.6600',
      marginOnPricePercent: '42.5295',
      marginUnavailableReasonKey: null,
      markupOnCostPercent: '74.0023',
      markupUnavailableReasonKey: null,
    },
    proposedPrice: {
      unitPriceNet: '25.0000',
      marginOnPricePercent: '-269.3284',
      marginUnavailableReasonKey: null,
      markupOnCostPercent: '-72.9238',
      markupUnavailableReasonKey: null,
    },
    appliedPrice: {
      unitPriceNet: '112.6100',
      marginOnPricePercent: '18.0072',
      marginUnavailableReasonKey: null,
      markupOnCostPercent: '21.9619',
      markupUnavailableReasonKey: null,
      raisedFromProposedPrice: true,
    },
    floor: {
      unitPriceNet: '112.6100',
      marginOnPricePercent: '18.0072',
      marginUnavailableReasonKey: null,
      markupOnCostPercent: '21.9619',
      markupUnavailableReasonKey: null,
      source: 'min_margin',
      unavailableReasonKey: null,
      guardrailCode: 'floor-kawiarnia',
      minMarginPercent: '18.0000',
      floorPriceParam: null,
    },
    warnings: [
      'pricing_engine.warnings.logisticsScheduleAssumed',
      'pricing_engine.warnings.productAspectsMultipliersAssumed',
      'pricing_engine.warnings.minMarginEnforced',
    ],
    engineWarnings: [],
    ...overrides,
  }
}

function measuredItem(overrides: Partial<PricingImpactItem> = {}): PricingImpactItem {
  const parsed = parseImpactPayload(measuredPayload())
  if (!parsed) throw new Error('[internal] the measured impact payload must parse')
  return { ...parsed, ...overrides }
}

function buildImpact(overrides: Partial<PricingImpact> = {}): PricingImpact {
  return {
    currencyCode: 'PLN',
    items: { [PRODUCT_ID]: measuredItem() },
    negotiatedPriceApplies: true,
    ...overrides,
  }
}

function buildProfile(overrides: Partial<CustomerPricingProfileRow> = {}): CustomerPricingProfileRow {
  return {
    id: 'profile-1',
    updatedAt: '2026-09-01T10:00:00.000Z',
    customerGroupCode: 'kawiarnia',
    deliveryZoneCode: 'warszawa_poludnie',
    defaultOrderScenarioCode: 'phone',
    negotiatedPrices: { [PRODUCT_ID]: '25.0000' },
    negotiatedPriceExpiresAt: '2026-12-31T00:00:00.000Z',
    ...overrides,
  }
}

function contextValue(overrides: Partial<NegotiatedPricingContextValue> = {}): NegotiatedPricingContextValue {
  return {
    currencyCode: 'PLN',
    impact: buildImpact(),
    impactUnavailable: false,
    productLabels: { [PRODUCT_ID]: 'Wieczko kopułkowe PET 100 szt (PACK-0056)' },
    canWrite: true,
    onProductAdded: () => {},
    ...overrides,
  }
}

function renderEditor(
  rows: NegotiatedRow[],
  onChange: (next: NegotiatedRow[]) => void,
  overrides: Partial<NegotiatedPricingContextValue> = {},
  fetchProducts: () => Promise<Array<{ id: string; title: string }>> = async () => [
    { id: OTHER_PRODUCT_ID, title: 'Cukier' },
  ],
  dict: Record<string, string> = {},
) {
  return renderWithProviders(
    <NegotiatedPricingContext.Provider value={contextValue(overrides)}>
      <NegotiatedPricesEditor rows={rows} onChange={onChange} fetchProducts={fetchProducts} />
    </NegotiatedPricingContext.Provider>,
    { dict },
  )
}

describe('customer id resolution', () => {
  it('reads the id the company detail page actually publishes', () => {
    expect(readCustomerId({ companyId: CUSTOMER_ID, resourceKind: 'customers.company' })).toBe(CUSTOMER_ID)
  })

  it('falls back to resourceId only while the host says the record is a company', () => {
    expect(readCustomerId({ resourceKind: 'customers.company', resourceId: CUSTOMER_ID })).toBe(CUSTOMER_ID)
    expect(readCustomerId({ resourceKind: 'customers.person', resourceId: CUSTOMER_ID })).toBeNull()
  })

  it('rejects everything the page hands over before the record has loaded', () => {
    expect(readCustomerId(undefined)).toBeNull()
    expect(readCustomerId({})).toBeNull()
    expect(readCustomerId({ companyId: '   ' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The request the route actually accepts.
//
// `/api/pricing/customer-pricing-impact` takes `productId` (SINGULAR) and a MANDATORY
// `proposedUnitPriceNet`; a `productIds` list with no proposed price is rejected with 400 and the
// whole comparison silently disappears from the tab. These assertions pin the wire shape.
// ---------------------------------------------------------------------------

describe('the impact request', () => {
  it('names one product and carries a proposed price', () => {
    expect(
      buildImpactRequestUrl({
        customerId: CUSTOMER_ID,
        productId: PRODUCT_ID,
        proposedUnitPriceNet: '25.0000',
      }),
    ).toBe(
      '/api/pricing/customer-pricing-impact' +
        '?customerId=30606e57-1949-482a-91fd-a32d360fddab' +
        '&productId=145262d9-6fd6-423a-bfeb-9b9cc45619b6' +
        '&proposedUnitPriceNet=25.0000',
    )
  })

  it('never sends a comma-separated product list or omits the proposed price', () => {
    const url = buildImpactRequestUrl({
      customerId: CUSTOMER_ID,
      productId: PRODUCT_ID,
      proposedUnitPriceNet: IMPACT_PROBE_UNIT_PRICE,
    })
    const params = new URL(url, 'http://localhost').searchParams
    expect(params.get('productIds')).toBeNull()
    expect(params.get('productId')).toBe(PRODUCT_ID)
    expect(params.get('proposedUnitPriceNet')).toBe('0')
  })

  it('asks once per product, each with that product’s own agreed price', async () => {
    const seen: string[] = []
    const impact = await loadCustomerPricingImpact({
      customerId: CUSTOMER_ID,
      products: [
        { productId: PRODUCT_ID, proposedUnitPriceNet: '25.0000' },
        { productId: OTHER_PRODUCT_ID, proposedUnitPriceNet: IMPACT_PROBE_UNIT_PRICE },
      ],
      fetcher: async (url) => {
        seen.push(url)
        const productId = new URL(url, 'http://localhost').searchParams.get('productId')
        return measuredPayload({ productId })
      },
    })

    expect(seen).toEqual([
      buildImpactRequestUrl({
        customerId: CUSTOMER_ID,
        productId: PRODUCT_ID,
        proposedUnitPriceNet: '25.0000',
      }),
      buildImpactRequestUrl({
        customerId: CUSTOMER_ID,
        productId: OTHER_PRODUCT_ID,
        proposedUnitPriceNet: '0',
      }),
    ])
    expect(Object.keys(impact.items)).toEqual([PRODUCT_ID, OTHER_PRODUCT_ID])
    expect(impact.currencyCode).toBe('PLN')
  })

  it('keeps the rest of the table when one product cannot be priced', async () => {
    const impact = await loadCustomerPricingImpact({
      customerId: CUSTOMER_ID,
      products: [
        { productId: PRODUCT_ID, proposedUnitPriceNet: '25.0000' },
        { productId: OTHER_PRODUCT_ID, proposedUnitPriceNet: '9.0000' },
      ],
      fetcher: async (url) => {
        if (url.includes(OTHER_PRODUCT_ID)) throw new Error('[internal] simulated network failure')
        return measuredPayload()
      },
    })
    expect(Object.keys(impact.items)).toEqual([PRODUCT_ID])
    expect(impact.items[PRODUCT_ID]?.enginePriceNet).toBe('160.6600')
  })
})

describe('profile and impact parsing', () => {
  it('keeps only string-valued negotiated prices, because the map is productId -> decimal string', () => {
    const row = toProfileRow({
      id: 'profile-1',
      updatedAt: '2026-09-01T10:00:00.000Z',
      customerGroupCode: 'hotel',
      negotiatedPrices: { [PRODUCT_ID]: '25.0000', '': '9', [OTHER_PRODUCT_ID]: null },
    })
    expect(row?.negotiatedPrices).toEqual({ [PRODUCT_ID]: '25.0000' })
    expect(row?.updatedAt).toBe('2026-09-01T10:00:00.000Z')
    expect(row?.deliveryZoneCode).toBeNull()
  })

  it('reads the measured response the running engine returned', () => {
    const item = parseImpactPayload(measuredPayload())
    expect(item).toEqual({
      productId: PRODUCT_ID,
      available: true,
      unavailableReasonKeys: [],
      currencyCode: 'PLN',
      unitCostNet: '92.3321',
      enginePriceNet: '160.6600',
      floorPriceNet: '112.6100',
      floorSource: 'min_margin',
      floorUnavailableReasonKey: null,
      negotiatedPriceApplies: true,
      negotiatedPricePrecedence: 'negotiated_wins',
    })
  })

  it('still parses a route that does not send the floor source yet', () => {
    const payload = measuredPayload()
    const floor = { ...(payload.floor as Record<string, unknown>) }
    delete floor.source
    const item = parseImpactPayload({ ...payload, floor })
    expect(item?.floorSource).toBeNull()
    expect(item?.floorPriceNet).toBe('112.6100')
  })

  it('refuses to read "unavailable" as a guardrail switching negotiated prices off', () => {
    const item = parseImpactPayload(
      measuredPayload({
        available: false,
        unavailableReasonKeys: ['pricing_engine.customerPricingImpact.unavailable.productMissing'],
        negotiatedPrice: {
          proposedUnitPriceNet: '25.0000',
          appliesToQuote: false,
          precedence: null,
          ignoredReasonKey: null,
          storedUnitPriceNet: null,
        },
      }),
    )
    expect(item?.negotiatedPriceApplies).toBeNull()
    expect(item?.unavailableReasonKeys).toEqual([
      'pricing_engine.customerPricingImpact.unavailable.productMissing',
    ])
  })

  it('rejects a payload that is not this route’s answer', () => {
    expect(parseImpactPayload({ items: [] })).toBeNull()
    expect(parseImpactPayload(null)).toBeNull()
  })

  it('claims a precedence for the customer only when every product agrees', () => {
    const applies = measuredItem()
    const ignored = measuredItem({ negotiatedPriceApplies: false })
    const unknown = measuredItem({ negotiatedPriceApplies: null })
    expect(summarizeNegotiatedPrecedence([applies, applies])).toBe(true)
    expect(summarizeNegotiatedPrecedence([applies, ignored])).toBe(false)
    expect(summarizeNegotiatedPrecedence([applies, unknown])).toBeNull()
    expect(summarizeNegotiatedPrecedence([])).toBeNull()
  })

  it('turns editor rows back into the stored map and drops rows with no price', () => {
    expect(
      pricesFromRows([
        { productId: PRODUCT_ID, label: 'a', price: '25.0000' },
        { productId: OTHER_PRODUCT_ID, label: 'b', price: '  ' },
      ]),
    ).toEqual({ [PRODUCT_ID]: '25.0000' })
  })

  it('labels a stored row by its id until the catalogue answers', () => {
    expect(rowsFromPrices({ [PRODUCT_ID]: '25.0000' })).toEqual([
      { productId: PRODUCT_ID, label: PRODUCT_ID, price: '25.0000' },
    ])
  })
})

describe('what the engine will do with an agreed price', () => {
  it('raises a price under the floor instead of rejecting it — the measured 25 -> 112.61 case', () => {
    const outcome = projectEngineOutcome('25.0000', measuredItem())
    expect(outcome.state).toBe('raisedToFloor')
    expect(outcome.effectivePriceNet).toBe('112.6100')
    expect(outcome.enginePriceNet).toBe('160.6600')
    expect(outcome.operatorMarginPercent).toBe('-269.3284')
  })

  it('applies a price that clears the floor', () => {
    const outcome = projectEngineOutcome('160.0000', measuredItem())
    expect(outcome.state).toBe('applied')
    expect(outcome.effectivePriceNet).toBe('160.0000')
  })

  // The regression that mattered: a second copy of the floor rule on this side disagreed with the
  // engine for every line the shelf-life ladder touches, and disagreed silently.
  it('never derives a floor of its own when the route reports none', () => {
    const outcome = projectEngineOutcome(
      '25.0000',
      measuredItem({ floorPriceNet: null, floorUnavailableReasonKey: null }),
    )
    expect(outcome.floorPriceNet).toBeNull()
    expect(outcome.floorState).toBe('unknown')
    expect(outcome.state).toBe('unknown')
  })

  it('says a price stands when the route says no floor is configured', () => {
    const outcome = projectEngineOutcome(
      '1.0000',
      measuredItem({
        floorPriceNet: null,
        floorSource: null,
        floorUnavailableReasonKey: 'pricing_engine.customerPricingImpact.floor.notConfigured',
      }),
    )
    expect(outcome.floorState).toBe('notConfigured')
    expect(outcome.state).toBe('applied')
  })

  // A floor the route could not MEASURE is not a floor that does not exist. Reading the two keys
  // as one would promise the operator a price the engine may still raise.
  it('refuses to call an unmeasurable floor an absent one', () => {
    const outcome = projectEngineOutcome(
      '1.0000',
      measuredItem({
        floorPriceNet: null,
        floorSource: null,
        floorUnavailableReasonKey: 'pricing_engine.customerPricingImpact.floor.notMeasurable',
      }),
    )
    expect(outcome.floorState).toBe('unknown')
    expect(outcome.state).toBe('unknown')
  })

  // Margin divides by the price, so it has no value at zero and no meaning below it — the same
  // rule the route applies through `marginUnavailableReasonKey`.
  it('reports no margin at all for a price of zero rather than a flat 0%', () => {
    expect(projectEngineOutcome('0', measuredItem()).operatorMarginPercent).toBeNull()
    expect(projectEngineOutcome('-5', measuredItem()).operatorMarginPercent).toBeNull()
    expect(projectEngineOutcome('25.0000', measuredItem()).operatorMarginPercent).toBe('-269.3284')
  })

  it('names the floor that bound the line', () => {
    expect(projectEngineOutcome('25.0000', measuredItem()).floorSource).toBe('min_margin')
  })

  it('reports the price as ignored when precedence is not negotiated_wins', () => {
    const outcome = projectEngineOutcome('25.0000', measuredItem({ negotiatedPriceApplies: false }))
    expect(outcome.state).toBe('ignored')
    expect(outcome.effectivePriceNet).toBe('160.6600')
  })

  it('refuses to guess when the precedence is unknown', () => {
    expect(projectEngineOutcome('25.0000', measuredItem({ negotiatedPriceApplies: null })).state).toBe(
      'unknown',
    )
    expect(projectEngineOutcome('25.0000', null).state).toBe('unknown')
  })
})

describe('code labels', () => {
  it('prefers the loaded option label, which loadCodeOptions has already resolved', () => {
    const t: TranslateFn = (_key, fallback) => (typeof fallback === 'string' ? fallback : _key)
    expect(labelForCode('phone', [{ code: 'phone', label: 'Phone' }], 'pricing_engine.scenarios', t)).toBe(
      'Phone',
    )
  })

  it('falls back to the scenario key convention rather than printing the bare code', () => {
    const t: TranslateFn = (key, fallback) =>
      key === 'pricing_engine.scenarios.idealFile'
        ? 'Structured file'
        : typeof fallback === 'string'
          ? fallback
          : key
    expect(labelForCode('ideal_file', [], 'pricing_engine.scenarios', t)).toBe('Structured file')
    expect(labelForCode(null, [], 'pricing_engine.scenarios', t)).toBeNull()
  })
})

describe('negotiated prices editor', () => {
  it('shows the three engine figures next to the agreed price', () => {
    const { container } = renderEditor([{ productId: PRODUCT_ID, label: PRODUCT_ID, price: '25.0000' }], () => {})
    const text = container.textContent ?? ''
    expect(text).toContain('160,66 PLN')
    expect(text).toContain('112,61 PLN')
    expect(text).toContain('Raised to the floor')
    expect(text).toContain('The engine quotes 112,61 PLN and adds a minimum-margin warning.')
  })

  it('says which floor bound the line beside the number', () => {
    const { container } = renderEditor(
      [{ productId: PRODUCT_ID, label: PRODUCT_ID, price: '25.0000' }],
      () => {},
      {},
      undefined,
      { 'pricing_engine.customerPricing.floorSource.minMargin': 'Minimum margin' },
    )
    expect(container.textContent).toContain('Minimum margin')
  })

  it('writes percentages with the same decimal separator as the money beside them', () => {
    const { container } = renderEditor([{ productId: PRODUCT_ID, label: PRODUCT_ID, price: '25.0000' }], () => {})
    const text = container.textContent ?? ''
    expect(text).toContain('-269,33%')
    expect(text).not.toContain('-269.33%')
  })

  it('names the product instead of printing its id once the catalogue answers', () => {
    const { container } = renderEditor([{ productId: PRODUCT_ID, label: PRODUCT_ID, price: '25.0000' }], () => {})
    expect(container.textContent).toContain('Wieczko kopułkowe PET 100 szt (PACK-0056)')
  })

  it('says outright that the price will not work when precedence disables it', () => {
    const { container } = renderEditor(
      [{ productId: PRODUCT_ID, label: PRODUCT_ID, price: '25.0000' }],
      () => {},
      {
        impact: buildImpact({
          items: { [PRODUCT_ID]: measuredItem({ negotiatedPriceApplies: false }) },
          negotiatedPriceApplies: false,
        }),
      },
    )
    const text = container.textContent ?? ''
    expect(text).toContain('Ignored by the engine')
    expect(text).toContain('The engine quotes 160,66 PLN instead.')
  })

  it('adds a picked product as a new row with an empty price', async () => {
    const onChange = jest.fn()
    const added: string[] = []
    const view = renderEditor([], onChange, { onProductAdded: (id: string) => added.push(id) })

    fireEvent.click(view.getByRole('button', { name: 'Add product' }))
    const option = await view.findByText('Cukier')
    fireEvent.click(option)

    expect(onChange).toHaveBeenCalledWith([
      { productId: OTHER_PRODUCT_ID, label: 'Cukier', price: '' },
    ])
    expect(added).toEqual([OTHER_PRODUCT_ID])
  })

  it('removes a row through the row action', () => {
    const onChange = jest.fn()
    const rows: NegotiatedRow[] = [
      { productId: PRODUCT_ID, label: 'Mąka', price: '25.0000' },
      { productId: OTHER_PRODUCT_ID, label: 'Cukier', price: '9.0000' },
    ]
    const view = renderEditor(rows, onChange)
    const removeButtons = view.getAllByRole('button', { name: 'Remove this product' })
    fireEvent.click(removeButtons[0])
    expect(onChange).toHaveBeenCalledWith([{ productId: OTHER_PRODUCT_ID, label: 'Cukier', price: '9.0000' }])
  })

  it('states that the comparison is missing rather than showing a bare price', () => {
    const { container } = renderEditor(
      [{ productId: PRODUCT_ID, label: 'Mąka', price: '25.0000' }],
      () => {},
      { impact: null, impactUnavailable: true },
    )
    expect(container.textContent).toContain('The engine comparison is unavailable right now')
    expect(container.textContent).toContain('Cannot be projected yet')
  })

  it('repeats the route’s own reason for a product it could not price', () => {
    const { container } = renderEditor(
      [{ productId: PRODUCT_ID, label: 'Mąka', price: '25.0000' }],
      () => {},
      {
        impact: buildImpact({
          items: {
            [PRODUCT_ID]: measuredItem({
              available: false,
              negotiatedPriceApplies: null,
              unavailableReasonKeys: [
                'pricing_engine.customerPricingImpact.unavailable.purchaseCostMissing',
              ],
            }),
          },
          negotiatedPriceApplies: null,
        }),
      },
    )
    expect(container.textContent).toContain(
      'pricing_engine.customerPricingImpact.unavailable.purchaseCostMissing',
    )
  })
})

describe('customer pricing panel', () => {
  const baseProps = {
    customerId: CUSTOMER_ID,
    impact: buildImpact(),
    impactUnavailable: false,
    hasNegotiatedPrices: true,
    productLabels: {},
    deliveryZones: [{ code: 'warszawa_poludnie', label: 'Warsaw South' }],
    orderScenarios: [{ code: 'phone', label: 'Phone' }],
    groupCodeSuggestions: ['szpital'],
    currencyCode: 'PLN',
    loading: false,
    error: null,
  }

  it('renders the editable form with the stored terms when the operator may write', async () => {
    const view = renderWithProviders(
      <CustomerPricingPanel {...baseProps} profile={buildProfile()} canWrite />,
    )
    await settle()
    expect(view.getByTestId('customer-pricing-form')).toBeTruthy()
    expect(view.container.textContent).toContain(
      'A price below the minimum-margin floor is not rejected',
    )
    expect(view.container.textContent).toContain('ONE date expires the WHOLE list at once.')
  })

  it('shows the terms but no form to an operator without write access', () => {
    const view = renderWithProviders(
      <CustomerPricingPanel {...baseProps} profile={buildProfile()} canWrite={false} />,
    )
    expect(view.getByTestId('customer-pricing-readonly')).toBeTruthy()
    expect(view.queryByTestId('customer-pricing-form')).toBeNull()
    expect(view.container.textContent).toContain('kawiarnia')
    expect(view.container.textContent).toContain('All negotiated prices expire on: 2026-12-31')
  })

  // Measured on the running server: profile 05f6751f stores `defaultOrderScenarioCode = "phone"`,
  // and `/api/pricing/order-scenarios` returns the i18n KEY in its `label` column. The read-only
  // view printed the bare code either way.
  it('labels the stored scenario and zone codes in the read-only view', () => {
    const view = renderWithProviders(
      <CustomerPricingPanel {...baseProps} profile={buildProfile()} canWrite={false} />,
    )
    const text = view.container.textContent ?? ''
    expect(text).toContain('Phone')
    expect(text).toContain('Warsaw South')
    expect(text).not.toContain('warszawa_poludnie')
  })

  it('labels a scenario the options list never loaded from the dictionary, not as a raw code', () => {
    const view = renderWithProviders(
      <CustomerPricingPanel
        {...baseProps}
        orderScenarios={[]}
        deliveryZones={[]}
        profile={buildProfile()}
        canWrite={false}
      />,
      { dict: { 'pricing_engine.scenarios.phone': 'Phone' } },
    )
    const text = view.container.textContent ?? ''
    expect(text).toContain('Phone')
    expect(text).not.toContain('>phone<')
  })

  it('opens an empty form for a customer that has no pricing profile row yet', async () => {
    const view = renderWithProviders(
      <CustomerPricingPanel
        {...baseProps}
        profile={null}
        impact={null}
        hasNegotiatedPrices={false}
        canWrite
      />,
    )
    await settle()
    expect(view.getByTestId('customer-pricing-form')).toBeTruthy()
    expect(view.container.textContent).toContain('No negotiated prices yet.')
  })

  // The banner claimed the projections were unverified on every customer card in the system,
  // including the ones with nothing to project.
  it('keeps the unverified-precedence banner off a customer with no agreed prices', async () => {
    const view = renderWithProviders(
      <CustomerPricingPanel
        {...baseProps}
        profile={buildProfile({ negotiatedPrices: {} })}
        impact={null}
        hasNegotiatedPrices={false}
        canWrite
      />,
    )
    await settle()
    expect(view.container.textContent).not.toContain(
      'It could not be confirmed whether the guardrail lets negotiated prices win',
    )
  })

  it('raises the unverified-precedence banner once there is a price it applies to', async () => {
    const view = renderWithProviders(
      <CustomerPricingPanel
        {...baseProps}
        profile={buildProfile()}
        impact={null}
        hasNegotiatedPrices
        canWrite
      />,
    )
    await settle()
    expect(view.container.textContent).toContain(
      'It could not be confirmed whether the guardrail lets negotiated prices win',
    )
  })
})
