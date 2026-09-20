import { add, format, money, mul, rate as formatRate, sub, toDecimal, ZERO } from '../decimal'
import { marginPercent, markupPercent, unitProfit } from './margin'
import { ceilToMultiple, packLadder, uniqueAscending } from './quantity'
import type { Decimal } from '../decimal'
import type { PricingBasketLine } from '../types'
import type { AdvisorRun } from './runner'
import type { VolumeSensitivity, VolumeSensitivityPoint } from './schemas'

// A spread wide enough to show the shape of the curve: fixed per-order cost amortises as 1/q, so the
// interesting collapse happens between 1 and roughly 100 units and the tail is nearly flat.
const DEFAULT_LADDER = ['1', '2', '6', '12', '24', '48', '96', '240']

/**
 * Price one product across a quantity ladder and report both sides at every rung.
 *
 * Each rung is priced INSIDE THE BASKET the operator is holding: the whole document is re-priced
 * with this line's quantity swapped for the rung's, and the rung reports that line's result.
 *
 * It used to price each rung as its own single-line basket, on the argument that sensitivity
 * should be a property of the product rather than of the document it happens to sit on. On the
 * desk that produced a straight contradiction. Per-order cost is charged per DOCUMENT (`perDocument`
 * plus `perStop` in `source_costing`), so a lone unit on its own document carries all of it: a line
 * priced at 7.62 PLN inside a two-line basket was offered a "×1" rung reading 93.58 PLN for the
 * quantity it already had — and clicking that rung set the quantity to 1 and showed 7.62 again.
 *
 * The rung is a button that changes this basket, so it has to quote this basket. Folding the other
 * lines in is not contamination; it is the document the customer is actually being quoted.
 *
 * A product that is not in the basket (an equivalent being explored) has no line to swap, so it is
 * priced as the single-line basket it would be.
 */
export async function computeVolumeSensitivity(
  run: AdvisorRun,
  productId: string,
): Promise<VolumeSensitivity | null> {
  const product = run.inputs.catalog.byProductId.get(productId) ?? null
  const currentLine = run.context.lines.find((line) => line.productId === productId) ?? null

  const packs = packLadder(product?.unitConversions ?? {})
  const requested = (run.options.quantityLadder ?? DEFAULT_LADDER).map((value) => toDecimal(value))
  const quantities = uniqueAscending([
    ...requested,
    ...packs.map((pack) => pack.factor),
    ...(currentLine ? [toDecimal(currentLine.quantity)] : []),
  ]).filter((value) => value > ZERO)

  if (quantities.length === 0) return null

  const basketIndex = run.context.lines.findIndex((line) => line.productId === productId)

  function basketAtQuantity(quantity: Decimal): PricingBasketLine[] {
    const asText = format(quantity, 0)
    if (basketIndex < 0) {
      return [
        {
          productId,
          variantId: currentLine?.variantId ?? null,
          sku: currentLine?.sku ?? product?.sku ?? null,
          quantity: asText,
        },
      ]
    }
    return run.context.lines.map((line, index) =>
      index === basketIndex ? { ...line, quantity: asText } : line,
    )
  }

  // `run.price` is in-process — it touches no EntityManager — so the rungs are priced together.
  const runs = await Promise.all(quantities.map((quantity) => run.price(basketAtQuantity(quantity))))

  const points: VolumeSensitivityPoint[] = []

  for (const [index, quantity] of quantities.entries()) {
    const run_ = runs[index]
    const line = run_?.lines[basketIndex < 0 ? 0 : basketIndex]
    if (!line) continue

    const unitPrice = toDecimal(line.unitPriceNet)
    const unitCost = toDecimal(line.unitCostNet)
    const purchase = product?.purchase ?? null

    points.push({
      quantity: line.line.quantity,
      unitPriceNet: line.unitPriceNet,
      unitCostNet: line.unitCostNet,
      totalPriceNet: line.totalPriceNet,
      marginPercent: formatRate(marginPercent(unitPrice, unitCost)),
      markupPercent: formatRate(markupPercent(unitPrice, unitCost)),
      unitProfitNet: money(unitProfit(unitPrice, unitCost)),
      lineProfitNet: money(sub(toDecimal(line.totalPriceNet), mul(unitCost, quantity))),
      crossesNextTierVolume:
        purchase?.nextTierVolume != null &&
        add(toDecimal(purchase.annualVolume), quantity) >= toDecimal(purchase.nextTierVolume),
      packBoundaryUnitCode:
        packs.find((pack) => ceilToMultiple(quantity, pack.factor) === quantity)?.unitCode ?? null,
    })
  }

  return {
    productId,
    sku: product?.sku ?? null,
    currencyCode: run.context.currencyCode,
    points,
  }
}
