import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { SalesCalculationService } from '@open-mercato/core/modules/sales/services/salesCalculationService'
import { PricingShadowObservation } from '../data/entities'
import { div, isZero, lt, money, toDecimal, ZERO } from '../lib/decimal'
import { isShadowObservationEnabled } from '../lib/shadow/gate'
import { buildShadowObservationDraft, type ShadowObservationDraft } from '../lib/shadow/observation'
import type { PricingBasketLine, PricingContext } from '../lib/types'
import { loadPricingInputs, priceWithInputs, variantIdsByProduct } from './pricingService'

const logger = createLogger('pricing_engine')

type DocumentTotalsInput = Parameters<SalesCalculationService['calculateDocumentTotals']>[0]
type DocumentTotalsResult = Awaited<ReturnType<SalesCalculationService['calculateDocumentTotals']>>
type DocumentLineResult = DocumentTotalsResult['lines'][number]

export type ShadowObservingCalculationDeps = {
  base: SalesCalculationService
  container: { resolve: (name: string) => unknown }
}

type ObservationCandidate = {
  salesLineId: string | null
  /** Net of discount, per unit: what the document actually charges, not what the price list says. */
  invoicedUnitPriceNet: string
  basketLine: PricingBasketLine
}

/**
 * Wraps `salesCalculationService` so a sales calculation also records what the pricing engine would
 * have charged for the same basket.
 *
 * It decorates rather than hooks: `registerSalesLineCalculator` pushes onto a process-global array
 * on every request, with no dedup, so a hook registered from module DI accumulates one closure per
 * request and each closure pins a different tenant's container. A decorator's lifetime is the
 * binding's, and the binding is rebuilt per request, so exactly one tenant is ever in scope.
 *
 * It changes no amount. The decorated call's result object is returned by reference, untouched.
 */
export function createShadowObservingCalculationService(
  deps: ShadowObservingCalculationDeps,
): SalesCalculationService {
  const { base, container } = deps

  return {
    // A single line is not a basket: shared-cost allocation is computed across the whole basket
    // (`priceWithInputs` rebuilds `buildAllocation` per run), so a per-line observation would
    // compare an invoiced line against an engine price derived from a one-line basket it was never
    // part of. Delegated untouched, with nothing observed.
    calculateLine(opts) {
      return base.calculateLine(opts)
    },

    async calculateDocumentTotals(opts) {
      const result = await base.calculateDocumentTotals(opts)
      if (isShadowObservationEnabled()) await observeQuietly(container, opts, result)
      return result
    },
  }
}

/**
 * An observation that breaks a sale is worse than no observation, so every failure below — a
 * missing supplier profile, an absent catalog peer, a rejected write — stops here.
 */
async function observeQuietly(
  container: { resolve: (name: string) => unknown },
  opts: DocumentTotalsInput,
  result: DocumentTotalsResult,
): Promise<void> {
  try {
    await observe(container, opts, result)
  } catch (error) {
    logger.warn('Pricing shadow observation skipped', {
      documentKind: opts.documentKind,
      tenantId: opts.context?.tenantId ?? null,
      error,
    })
  }
}

async function observe(
  container: { resolve: (name: string) => unknown },
  opts: DocumentTotalsInput,
  result: DocumentTotalsResult,
): Promise<void> {
  const tenantId = opts.context?.tenantId
  const organizationId = opts.context?.organizationId
  if (!tenantId || !organizationId) return

  // Both fields are optional on `SalesCalculationContext`, so a caller written before they existed
  // hands over `undefined`. Normalised to `null` here once, because the row columns are nullable
  // and `undefined` would have MikroORM fall back to the column default rather than store "unknown".
  const salesDocumentId = opts.context?.documentId ?? null
  const customerId = opts.context?.customerId ?? null

  const candidates = collectCandidates(result.lines)
  if (candidates.length === 0) return

  // A fork carries its own UnitOfWork. Writing through the request EntityManager would enlist these
  // rows in whatever sales transaction is open — flushing half-built order entities on the way — or,
  // when none is open, commit them outside it so they survive a rollback of the order that caused
  // them. An observation is a separate unit of work by intent; the price ledger is not.
  const requestEm = container.resolve('em') as EntityManager
  const em = requestEm.fork({ clear: true })

  const observedAt = new Date()
  const basketLines = candidates.map((candidate) => candidate.basketLine)
  const inputs = await loadPricingInputs(
    em,
    container,
    // Passing the document's customer through makes the customer- and group-scoped parameters
    // reachable, so the engine price compared here is the one that customer would really be
    // quoted. When sales does not know the customer this stays null and the comparison falls back
    // to global scope — a narrower answer, never a wrong one.
    { tenantId, organizationId, date: observedAt, customerId },
    basketLines.map((line) => line.productId),
    variantIdsByProduct(basketLines),
  )

  const invoicedCurrency = result.currencyCode || opts.context.currencyCode || ''
  if (invoicedCurrency !== inputs.supplier.currencyCode) {
    // Skipped rather than stored: the row has no column that could mark a comparison invalid, and a
    // delta between two currencies written into `delta_absolute` would read as a real divergence.
    logger.info('Pricing shadow observation skipped on currency mismatch', {
      tenantId,
      organizationId,
      invoicedCurrency,
      engineCurrency: inputs.supplier.currencyCode,
      skippedLines: candidates.length,
    })
    return
  }

  const context: PricingContext = {
    tenantId,
    organizationId,
    currencyCode: invoicedCurrency,
    // Carried into the run as well as into the input load: component scope resolution reads the
    // customer off the context, so omitting it here would load customer-scoped parameters and then
    // never select them.
    customerId,
    lines: basketLines,
    date: observedAt,
    mode: inputs.supplier.mode,
  }
  const run = await priceWithInputs(context, inputs)

  const drafts = candidates
    .map((candidate, index) => {
      const priced = run.lines[index]
      if (!priced || !candidate.salesLineId) return null
      return {
        salesLineId: candidate.salesLineId,
        draft: buildShadowObservationDraft(candidate.invoicedUnitPriceNet, priced.unitPriceNet),
      }
    })
    .filter((entry): entry is { salesLineId: string; draft: ShadowObservationDraft } => entry !== null)

  // A line sales has not persisted yet has no id, so its observation could be neither attributed
  // nor recognised on the next pass. Recording it would add one unattributable row per redraw.
  const unattributable = candidates.length - drafts.length
  if (unattributable > 0) {
    logger.info('Pricing shadow observation skipped on lines with no id', {
      tenantId,
      organizationId,
      skippedLines: unattributable,
    })
  }
  if (drafts.length === 0) return

  // `calculateDocumentTotals` runs on nearly every mutation of a draft — sixty call sites across
  // the sales module — so a plain insert would write one row per line per redraw and bury the few
  // rows that mean something under hundreds that repeat them. The ledger is append-only, so the
  // answer is not to update in place but to write only what is NEW: a second observation is
  // recorded when the comparison itself changed, and silence is recorded as silence.
  const seen = await em.find(PricingShadowObservation, {
    tenantId,
    organizationId,
    salesLineId: { $in: drafts.map((entry) => entry.salesLineId) },
  })
  const alreadyRecorded = new Set(
    seen.map((row) => `${row.salesLineId}|${row.invoicedUnitPriceNet}|${row.engineUnitPriceNet}`),
  )

  let written = 0
  for (const { salesLineId, draft } of drafts) {
    const identity = `${salesLineId}|${draft.invoicedUnitPriceNet}|${draft.engineUnitPriceNet}`
    if (alreadyRecorded.has(identity)) continue
    alreadyRecorded.add(identity)

    if (draft.deltaPercentClamped) {
      // `delta_percent` is numeric(7,4), so anything past 999.9999 cannot be stored as itself. The
      // stored value is the ceiling and the screen reads it as "at least"; the real figure is only
      // recoverable from here, so it is logged rather than lost.
      logger.warn('Pricing shadow observation delta exceeds the stored range', {
        tenantId,
        organizationId,
        salesLineId,
        invoicedUnitPriceNet: draft.invoicedUnitPriceNet,
        engineUnitPriceNet: draft.engineUnitPriceNet,
        storedDeltaPercent: draft.deltaPercent,
      })
    }

    em.persist(
      em.create(PricingShadowObservation, {
        tenantId,
        organizationId,
        // Nothing was persisted by the engine for this run, so there is no calculation to point at.
        calculationId: null,
        customerId,
        salesDocumentKind: opts.documentKind,
        salesDocumentId,
        salesLineId,
        invoicedUnitPriceNet: draft.invoicedUnitPriceNet,
        engineUnitPriceNet: draft.engineUnitPriceNet,
        deltaAbsolute: draft.deltaAbsolute,
        deltaPercent: draft.deltaPercent,
        observedAt,
      }),
    )
    written += 1
  }

  if (written === 0) return
  await em.flush()
}

function collectCandidates(lines: DocumentLineResult[]): ObservationCandidate[] {
  const candidates: ObservationCandidate[] = []
  for (const entry of lines) {
    const productId = entry.line.productId
    if (typeof productId !== 'string' || productId.length === 0) continue

    const quantity = toDecimal(entry.line.quantity)
    if (isZero(quantity) || lt(quantity, ZERO)) continue

    candidates.push({
      salesLineId: typeof entry.line.id === 'string' ? entry.line.id : null,
      invoicedUnitPriceNet: money(div(toDecimal(entry.netAmount), quantity)),
      basketLine: {
        productId,
        variantId: entry.line.productVariantId ?? null,
        sku: null,
        quantity: money(quantity),
      },
    })
  }
  return candidates
}
