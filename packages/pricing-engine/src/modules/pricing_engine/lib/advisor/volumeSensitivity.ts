import { add, format, money, mul, rate as formatRate, sub, toDecimal, ZERO } from '../decimal'
import { marginPercent, markupPercent, unitProfit } from './margin'
import { ceilToMultiple, packLadder, uniqueAscending } from './quantity'
import type { AdvisorRun } from './runner'
import type { VolumeSensitivity, VolumeSensitivityPoint } from './schemas'

// A spread wide enough to show the shape of the curve: fixed per-order cost amortises as 1/q, so the
// interesting collapse happens between 1 and roughly 100 units and the tail is nearly flat.
const DEFAULT_LADDER = ['1', '2', '6', '12', '24', '48', '96', '240']

/**
 * Price one product across a quantity ladder and report both sides at every rung.
 *
 * Each rung is priced as its own SINGLE-line basket. Basket allocation shares are computed across
 * all lines (`buildAllocation`), so measuring one product's sensitivity inside a multi-line basket
 * would fold the other lines' quantities into the answer and stop being a property of the product.
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

  const points: VolumeSensitivityPoint[] = []

  for (const quantity of quantities) {
    const run_ = await run.price([
      {
        productId,
        variantId: currentLine?.variantId ?? null,
        sku: currentLine?.sku ?? product?.sku ?? null,
        quantity: format(quantity, 0),
      },
    ])
    const line = run_.lines[0]
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
