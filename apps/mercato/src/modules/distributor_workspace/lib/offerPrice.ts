export type OfferPriceInput = {
  /** What the customer actually paid on the WZ, per unit. The fixed point of the comparison. */
  theirUnitPrice: number
  /** The engine's own price for this line at the offer's volume and channel. Carries the target margin. */
  engineOfferUnitPrice: number | null
  /** The price that keeps exactly the zloty of profit the WZ earned, once serving got cheaper. */
  profitNeutralUnitPrice: number | null
}

/**
 * The lowest price we are willing to put in front of this customer for this line — or null when
 * there is nothing to give away.
 *
 * Two rules, in this order:
 *
 * 1. **Only where the margin is above target.** The engine's price already carries the configured
 *    target margin, so it is the line that decides: a WZ price above it has headroom, a WZ price
 *    at or below it is already at or under target and gets no discount at all. Before this, every
 *    line on the document got the same percentage cut — including the ones already selling too
 *    cheap.
 * 2. **Never below the engine's target price.** Keeping yesterday's zloty of profit is a floor on
 *    the discount, not a licence to sell under the margin the tenant configured. Whichever of the
 *    two is higher wins.
 */
export function resolveOfferUnitPrice(input: OfferPriceInput): number | null {
  const { theirUnitPrice, engineOfferUnitPrice, profitNeutralUnitPrice } = input
  if (engineOfferUnitPrice === null || profitNeutralUnitPrice === null) return null
  if (theirUnitPrice <= engineOfferUnitPrice) return null
  return Math.max(profitNeutralUnitPrice, engineOfferUnitPrice)
}

/**
 * Operational cost carried by one unit of a quoted line: the engine's unit cost minus the goods.
 *
 * Deliberately NOT a re-allocation of the document's cost by the line's share of its value. The
 * per-order costs (`perDocument`, `perStop`, `perLine`) are flat, and spreading them in proportion
 * to price made every line's handling cost a fixed percentage of its own price — which in turn
 * made every achievable price a fixed percentage below the WZ price, whatever the product.
 */
export function opsUnitFromQuote(unitCostNet: number | null, goodsUnitNet: number | null): number {
  if (unitCostNet === null || goodsUnitNet === null) return 0
  return Math.max(0, unitCostNet - goodsUnitNet)
}
