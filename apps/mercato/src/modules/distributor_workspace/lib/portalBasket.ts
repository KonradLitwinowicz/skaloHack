import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  SupplierProfileMissingError,
  type PricingService,
} from '@open-mercato/pricing-engine/modules/pricing_engine/services/pricingService'
import { loadSellableProducts, type SellableProduct } from './portalCatalog'
import { toPortalQuote, type PortalQuoteResponse } from './portalPricing'
import type { PortalSession } from './portalSession'

const MAX_BASKET_LINES = 100
const MAX_LINE_QUANTITY = 1_000_000

/**
 * The ONLY shape a portal caller may submit. Customer, customer group, delivery zone, order
 * scenario, pricing date and currency are deliberately absent: the engine derives them from the
 * customer's own `PricingCustomerProfile`, so a buyer cannot shop for a cheaper delivery zone or
 * price as another company by editing a request body.
 */
export const portalBasketLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().positive().max(MAX_LINE_QUANTITY),
})

export const portalBasketSchema = z.object({
  lines: z.array(portalBasketLineSchema).min(1).max(MAX_BASKET_LINES),
})

export type PortalBasketInput = z.infer<typeof portalBasketSchema>

export type PortalBasketPricing =
  | { ok: true; quote: PortalQuoteResponse; products: Map<string, SellableProduct> }
  | { ok: false; response: NextResponse }

function errorResponse(key: string, status: number): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ ok: false, error: key }, { status }) }
}

export function parsePortalBasket(body: unknown): PortalBasketInput | null {
  const parsed = portalBasketSchema.safeParse(body)
  if (!parsed.success) return null
  const seen = new Set<string>()
  for (const line of parsed.data.lines) {
    if (seen.has(line.productId)) return null
    seen.add(line.productId)
  }
  return parsed.data
}

/**
 * Prices a basket for the authenticated customer and returns only the cost-free projection.
 * Both the quote endpoint and the submission endpoint go through here, so an order can never be
 * created from prices the browser sent — they are always recomputed server-side first.
 */
export async function priceBasket(
  session: PortalSession,
  input: PortalBasketInput,
): Promise<PortalBasketPricing> {
  const scope = {
    em: session.em,
    container: session.container,
    tenantId: session.tenantId,
    organizationId: session.organizationId,
  }
  const products = await loadSellableProducts(
    scope,
    input.lines.map((line) => line.productId),
  )
  const unknownLine = input.lines.find((line) => !products.has(line.productId))
  if (unknownLine) {
    return errorResponse('distributor_workspace.portal.errors.unknownProduct', 400)
  }

  const pricingService = session.container.resolve('pricingService') as PricingService
  try {
    const result = await pricingService.quote(
      {
        tenantId: session.tenantId,
        organizationId: session.organizationId,
        currencyCode: '',
        customerId: session.customerEntityId,
        customerGroupCode: null,
        orderScenarioCode: null,
        deliveryZoneCode: null,
        lines: input.lines.map((line) => ({
          productId: line.productId,
          variantId: null,
          sku: products.get(line.productId)?.sku ?? null,
          quantity: String(line.quantity),
          enteredQuantity: null,
          enteredUnitCode: null,
        })),
        date: new Date(),
        mode: 'shadow',
      },
      // A customer actor has no staff user id, and the calculation ledger's
      // `triggered_by_user_id` is a staff column — so a portal quote is never persisted.
      { persist: false, triggeredBy: 'simulate', triggeredByUserId: null },
    )
    return { ok: true, quote: toPortalQuote(result), products }
  } catch (err) {
    if (err instanceof SupplierProfileMissingError) {
      return errorResponse('distributor_workspace.portal.errors.pricingUnavailable', 409)
    }
    throw err
  }
}
