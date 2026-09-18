import { NextResponse } from 'next/server'
import { z } from 'zod'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { quoteRequestSchema } from '../../data/validators'
import {
  SupplierProfileMissingError,
  type PricingService,
  type QuoteOptions,
} from '../../services/pricingService'
import type { PricingContext, PricingQuoteResult } from '../types'
import { resolvePricingRouteContext } from './context'

const logger = createLogger('pricing_engine')

function serialize(result: PricingQuoteResult) {
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

export async function handleQuoteRequest(
  req: Request,
  options: { persist: boolean; triggeredBy: QuoteOptions['triggeredBy'] },
): Promise<Response> {
  try {
    const ctx = await resolvePricingRouteContext(req)
    const payload = await readJsonSafe(req, {})
    const parsed = quoteRequestSchema.parse(payload)

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

    const result = await pricingService.quote(context, {
      persist: options.persist,
      triggeredBy: options.triggeredBy,
      triggeredByUserId: ctx.userId,
    })

    return NextResponse.json(serialize(result))
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof SupplierProfileMissingError) {
      return NextResponse.json({ error: 'pricing_engine.errors.supplierProfileMissing' }, { status: 409 })
    }
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'pricing_engine.errors.invalidInput' }, { status: 400 })
    }
    logger.error('Pricing quote failed', { error: err })
    return NextResponse.json({ error: 'pricing_engine.errors.quoteFailed' }, { status: 500 })
  }
}
