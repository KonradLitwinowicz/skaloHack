import fs from 'node:fs'
import path from 'node:path'

const MODULE_ROOT = path.resolve(__dirname, '..')

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(MODULE_ROOT, relativePath), 'utf8')
}

/**
 * A guard against a cross-tenant leak someone will one day introduce with the best intentions.
 *
 * `register(container)` runs on every request, `salesCalculations` is a process global, and
 * `registerLineCalculator` / `registerTotalsCalculator` are unconditional pushes with no dedup.
 * A hook registered from this module's DI therefore appends one closure per request, each pinning
 * the container — and the tenant — of the request that registered it. Decorating the
 * `salesCalculationService` binding is the only shape that keeps the wrapper's lifetime equal to
 * the request's.
 */
describe('pricing_engine DI never registers a sales calculation hook', () => {
  const diSource = readSource('di.ts')

  it.each(['registerSalesLineCalculator', 'registerSalesTotalsCalculator'])(
    'does not mention %s',
    (symbol) => {
      expect(diSource).not.toContain(symbol)
    },
  )

  it('decorates the salesCalculationService binding instead', () => {
    expect(diSource).toContain('salesCalculationService')
    expect(diSource).toContain('createShadowObservingCalculationService')
  })

  // The observer's own header explains why the hooks are refused, so the plain substring check
  // above would fire on the explanation. What must not appear there is a call or an import.
  it('keeps the hook registries out of the observer service as well', () => {
    const observerSource = readSource('services/salesShadowObserver.ts')

    expect(observerSource).not.toMatch(/registerSales(Line|Totals)Calculator\s*\(/)
    expect(observerSource).not.toContain('salesCalculations')
    expect(observerSource).not.toContain('sales/lib/calculations')
  })
})
