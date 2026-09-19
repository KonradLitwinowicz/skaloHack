import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import {
  CURRENCY_MISMATCH_ERROR_KEY,
  PricingCurrencyMismatchError,
  priceWithInputs,
  resolveEffectiveContext,
  type PricingInputs,
} from '../services/pricingService'
import { buildContext, buildDeps } from './fixtures'

const SCENARIO_CODES = ['ideal_file', 'nonstandard_file', 'email', 'sms', 'phone', 'rep_visit']

function buildInputs(supplierCurrencyCode = 'PLN'): PricingInputs {
  const deps = buildDeps({ supplier: { currencyCode: supplierCurrencyCode } })
  return {
    supplier: deps.supplier,
    params: deps.params,
    catalog: deps.catalog,
    indicators: deps.indicators,
    customerProfile: null,
    orderScenarioCodes: SCENARIO_CODES,
  }
}

async function catchQuoteError(currencyCode: string): Promise<unknown> {
  try {
    await priceWithInputs(buildContext({ customerId: null, currencyCode }), buildInputs())
    return null
  } catch (err) {
    return err
  }
}

describe('currency guard — a basket in the profile currency is untouched', () => {
  // The same numbers `pipeline.golden.test.ts` pins for this fixture. Repeated here on purpose:
  // the guard sits on the only path every quote takes, so the proof that it changed nothing has to
  // live next to it rather than one file away.
  it('prices a PLN basket over a PLN profile to the grosz', async () => {
    const run = await priceWithInputs(buildContext({ customerId: null }), buildInputs())
    const line = run.lines[0]

    expect(line.unitCostNet).toBe('21.7478')
    expect(line.unitPriceNet).toBe('36.1000')
    expect(line.totalPriceNet).toBe('866.4000')
    expect(line.markupPercent).toBe('65.9938')
    expect(line.marginPercent).toBe('39.7568')
    expect(run.totalNet).toBe('866.4000')
  })

  it('treats a lowercase code as the same currency, not a collision', async () => {
    const run = await priceWithInputs(
      buildContext({ customerId: null, currencyCode: ' pln ' }),
      buildInputs(),
    )
    expect(run.lines[0].unitPriceNet).toBe('36.1000')
  })
})

describe('currency guard — an absent code inherits the profile', () => {
  it('fills the supplier currency in and prices normally', async () => {
    const context = resolveEffectiveContext(
      buildContext({ customerId: null, currencyCode: '' }),
      buildInputs(),
    )
    expect(context.currencyCode).toBe('PLN')

    const run = await priceWithInputs(buildContext({ customerId: null, currencyCode: '' }), buildInputs())
    expect(run.lines[0].unitPriceNet).toBe('36.1000')
    expect(run.totalNet).toBe('866.4000')
  })
})

describe('currency guard — a foreign code is refused', () => {
  it('throws instead of relabelling zlotys as dollars', async () => {
    const err = await catchQuoteError('USD')
    expect(err).toBeInstanceOf(PricingCurrencyMismatchError)
    const mismatch = err as PricingCurrencyMismatchError
    expect(mismatch.contextCurrencyCode).toBe('USD')
    expect(mismatch.supplierCurrencyCode).toBe('PLN')
  })

  it('refuses at the context funnel, before any component runs', () => {
    expect(() =>
      resolveEffectiveContext(buildContext({ customerId: null, currencyCode: 'EUR' }), buildInputs()),
    ).toThrow(PricingCurrencyMismatchError)
  })

  // The routes answer `isCrudHttpError` before anything else, so this is what makes quote, simulate
  // and advise return 409 without a single new branch in `toPricingErrorResponse`.
  it('carries the 409 the pipeline routes already know how to answer', async () => {
    const err = await catchQuoteError('USD')
    expect(isCrudHttpError(err)).toBe(true)
    const mismatch = err as PricingCurrencyMismatchError
    expect(mismatch.status).toBe(409)
    expect(mismatch.body).toEqual({ error: CURRENCY_MISMATCH_ERROR_KEY })
  })

  // A portal caller may learn that the basket was refused; it may not learn how the tenant's
  // supplier profile is configured.
  it('keeps both currency codes out of the response body', async () => {
    const mismatch = (await catchQuoteError('USD')) as PricingCurrencyMismatchError
    expect(Object.keys(mismatch.body)).toEqual(['error'])
    expect(JSON.stringify(mismatch.body)).not.toContain('PLN')
    expect(JSON.stringify(mismatch.body)).not.toContain('USD')
  })

  it('reads the profile currency rather than assuming PLN', async () => {
    const context = buildContext({ customerId: null, currencyCode: 'USD' })
    const run = await priceWithInputs(context, buildInputs('USD'))
    expect(run.lines[0].unitPriceNet).toBe('36.1000')
  })
})
