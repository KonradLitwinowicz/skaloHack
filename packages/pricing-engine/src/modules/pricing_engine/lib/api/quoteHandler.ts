import { NextResponse } from 'next/server'
import { z } from 'zod'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  quoteRequestSchema,
  type QuoteRequest,
  type SimulateRequest,
} from '../../data/validators'
import {
  SupplierProfileMissingError,
  type PriceOverrides,
  type PricingService,
  type QuoteOptions,
} from '../../services/pricingService'
import type { PricingContext, PricingQuoteResult } from '../types'
import { resolvePricingRouteContext } from './context'

const logger = createLogger('pricing_engine')

export function serializeQuoteResult(result: PricingQuoteResult) {
  return {
    calculationId: result.calculationId,
    currencyCode: result.currencyCode,
    mode: result.mode,
    parameterSetVersion: result.parameterSetVersion,
    lines: result.lines.map((line) => ({
      productId: line.line.productId,
      sku: line.line.sku ?? null,
      quantity: line.line.quantity,
      unitPriceNet: line.unitPriceNet,
      totalPriceNet: line.totalPriceNet,
      unitCostNet: line.unitCostNet,
      markupPercent: line.markupPercent,
      marginPercent: line.marginPercent,
      breakdown: line.breakdown,
      warnings: line.warnings,
    })),
    totalNet: result.totalNet,
    totalCostNet: result.totalCostNet,
    totalMarkupPercent: result.totalMarkupPercent,
    totalMarginPercent: result.totalMarginPercent,
    warnings: result.warnings,
    durationMs: result.durationMs,
  }
}

export type QuoteRequestHandlerOptions = {
  persist: boolean
  triggeredBy: QuoteOptions['triggeredBy']
  // `/pricing/simulate` documents an `overrides` object that `quoteRequestSchema` does not declare,
  // and zod strips undeclared keys: parsing every call with the quote schema silently discarded the
  // what-if and answered 200 with the unchanged price. Each route now passes its own schema.
  schema?: z.ZodType<QuoteRequest | SimulateRequest>
}

function readOverrides(parsed: QuoteRequest | SimulateRequest): PriceOverrides | undefined {
  return 'overrides' in parsed ? parsed.overrides : undefined
}

export async function handleQuoteRequest(
  req: Request,
  options: QuoteRequestHandlerOptions,
): Promise<Response> {
  try {
    const ctx = await resolvePricingRouteContext(req)
    const payload = await readJsonSafe(req, {})
    const parsed = (options.schema ?? quoteRequestSchema).parse(payload)

    const missingProductId = parsed.lines.find((line) => !line.productId)
    if (missingProductId) {
      // SKU resolution goes through catalog's public seam and lands in Step 2 together with
      // packaging. Until then the contract is explicit rather than silently half-working.
      throw new CrudHttpError(400, {
        error: ctx.translate(
          'pricing_engine.errors.productIdRequired',
          'Every line must carry a productId until SKU lookup ships.',
        ),
      })
    }

    const pricingService = ctx.container.resolve('pricingService') as PricingService
    const context: PricingContext = {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      currencyCode: parsed.currencyCode ?? '',
      customerId: parsed.customerId ?? null,
      customerGroupCode: parsed.customerGroupCode ?? null,
      orderScenarioCode: parsed.orderScenarioCode ?? null,
      deliveryZoneCode: parsed.deliveryZoneCode ?? null,
      lines: parsed.lines.map((line) => ({
        productId: line.productId as string,
        variantId: line.variantId ?? null,
        sku: line.sku ?? null,
        quantity: line.quantity,
        enteredQuantity: line.enteredQuantity ?? null,
        enteredUnitCode: line.enteredUnitCode ?? null,
      })),
      date: parsed.date ?? new Date(),
      mode: 'shadow',
    }

    // The desk re-prices on every keystroke and aborts the basket it has just replaced. Pricing a
    // basket whose client has already hung up is pure cost: it holds a pool connection that the
    // request the operator IS waiting for needs.
    if (isClientGone(req)) return abortedResponse()

    const result = await pricingService.quote(context, {
      persist: options.persist,
      triggeredBy: options.triggeredBy,
      triggeredByUserId: ctx.userId,
      overrides: readOverrides(parsed),
    })

    return NextResponse.json(serializeQuoteResult(result))
  } catch (err) {
    return toPricingErrorResponse(err, 'Pricing quote failed')
  }
}

/** True once the caller has hung up — `AbortSignal` from the browser, or a closed connection. */
export function isClientGone(req: Request): boolean {
  return req.signal?.aborted === true
}

/**
 * 499, the status nginx uses for "client closed request". Nothing reads this body — the caller is
 * gone — but the route has to answer something, and a 200 with an empty quote would be a lie.
 */
export function abortedResponse(): Response {
  return NextResponse.json({ error: 'pricing_engine.errors.clientAborted' }, { status: 499 })
}

// One error contract for every pipeline-backed route: the advise route answers with the same
// statuses and the same translation keys as quote and simulate.
export function toPricingErrorResponse(err: unknown, logMessage: string): Response {
  if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
  if (err instanceof SupplierProfileMissingError) {
    return NextResponse.json({ error: 'pricing_engine.errors.supplierProfileMissing' }, { status: 409 })
  }
  if (err instanceof z.ZodError) {
    return NextResponse.json({ error: 'pricing_engine.errors.invalidInput' }, { status: 400 })
  }
  logger.error(logMessage, { error: err })
  return NextResponse.json({ error: 'pricing_engine.errors.quoteFailed' }, { status: 500 })
}
