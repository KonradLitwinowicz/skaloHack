import { add, div, floorToInteger, format, gt, money, mul, ONE, percentToFactor, toDecimal, ZERO } from '../decimal'
import type { Decimal } from '../decimal'
import type {
  ComponentComputeArgs,
  ComponentResult,
  LaborRateSnapshot,
  PackagingCostSnapshot,
} from '../types'
import type { PriceComponent } from '../types'

export const PACKAGING_COST_CODE = 'packaging_cost'

// The unit every catalog quantity is expressed in; `unitConversions` maps the larger pack units
// (box, pallet) onto it. A row for this code prices the per-item packaging every unit gets.
export const BASE_PACK_UNIT_CODE = 'pc'

const MINUTES_PER_HOUR = toDecimal('60')

type PackUnitDetail = {
  unitCode: string
  count: string
  toBaseFactor: string | null
  materialCost: string
  unitCost: string
  cost: string
}

function packUnitCost(row: PackagingCostSnapshot, rate: LaborRateSnapshot | null): Decimal {
  const materialCost = toDecimal(row.materialCost)
  if (!rate) return materialCost
  const hours = div(toDecimal(row.packMinutes), MINUTES_PER_HOUR)
  const loadedRate = mul(toDecimal(rate.hourlyRate), add(ONE, percentToFactor(rate.overheadRate)))
  return add(materialCost, mul(hours, loadedRate))
}

// Only whole packs the line actually fills are charged: billing a partial carton as a full one
// would invent a cost, and rounding a 24-unit line up to a pallet would invent a large one.
// The count stays inside the decimal domain — going through Number/format would round half-up
// first and bill a line filling 1.9999996 cartons for two.
function wholePackCount(quantity: Decimal, toBaseFactor: Decimal): Decimal {
  if (!gt(toBaseFactor, ZERO)) return ZERO
  const packs = floorToInteger(div(quantity, toBaseFactor))
  return gt(packs, ZERO) ? packs : ZERO
}

async function compute(args: ComponentComputeArgs): Promise<ComponentResult> {
  const { context, deps, line, quantity } = args
  const product = deps.catalog.byProductId.get(line.productId) ?? null
  const sku = line.sku ?? product?.sku ?? line.productId
  const unitConversions = product?.unitConversions ?? {}
  const warnings: string[] = []

  const packUnits: PackUnitDetail[] = []
  const missingUnitCodes: string[] = []
  let lineCost = ZERO
  let missingLaborRate = false

  const appendPackUnit = (
    row: PackagingCostSnapshot,
    count: Decimal,
    toBaseFactor: string | null,
  ): void => {
    const rate = deps.params.laborRate(row.roleCode)
    if (!rate) missingLaborRate = true
    const unitCost = packUnitCost(row, rate)
    const cost = mul(unitCost, count)
    lineCost = add(lineCost, cost)
    packUnits.push({
      unitCode: row.unitCode,
      count: money(count),
      toBaseFactor,
      materialCost: row.materialCost,
      unitCost: money(unitCost),
      cost: money(cost),
    })
  }

  const baseRow = deps.params.packagingCost(BASE_PACK_UNIT_CODE)
  if (baseRow) appendPackUnit(baseRow, quantity, null)
  else missingUnitCodes.push(BASE_PACK_UNIT_CODE)

  for (const [unitCode, toBaseFactor] of Object.entries(unitConversions)) {
    if (unitCode === BASE_PACK_UNIT_CODE) continue
    const count = wholePackCount(quantity, toDecimal(toBaseFactor))
    if (!gt(count, ZERO)) continue
    const row = deps.params.packagingCost(unitCode)
    if (!row) {
      missingUnitCodes.push(unitCode)
      continue
    }
    appendPackUnit(row, count, toBaseFactor)
  }

  const hasConversions = Object.keys(unitConversions).length > 0
  if (!hasConversions) {
    // TODO(data-source): `catalog_product_unit_conversions` is not prefetched into the catalog
    // snapshot yet, so `unitConversions` is always empty in Step 1. Until it is wired, only the
    // per-item packaging row can be priced and every carton/pallet material and pack minute on
    // this line is missing from the cost — the warning says so rather than reporting a clean zero.
    warnings.push('pricing_engine.warnings.packagingConversionsMissing')
  }
  if (missingUnitCodes.length > 0) warnings.push('pricing_engine.warnings.packagingUnitCostMissing')
  if (missingLaborRate) warnings.push('pricing_engine.warnings.laborRateMissing')

  const perUnit = gt(quantity, ZERO) ? div(lineCost, quantity) : ZERO

  const inputs: Record<string, unknown> = {
    productId: line.productId,
    sku: product?.sku ?? line.sku ?? null,
    quantity: money(quantity),
    packUnits,
    unitConversions,
  }
  const params: Record<string, unknown> = {
    baseUnitCode: BASE_PACK_UNIT_CODE,
    packUnitCount: packUnits.length,
    missingUnitCodes,
  }

  if (packUnits.length === 0) {
    // TODO(data-source): no `pricing_packaging_costs` row matches any unit this line consumes.
    // There is no other packaging model in Open Mercato to fall back to, so the engine reports
    // zero and says the cost basis is missing instead of assuming a material price.
    warnings.push('pricing_engine.warnings.packagingCostMissing')
    return {
      code: PACKAGING_COST_CODE,
      labelKey: 'pricing_engine.components.packagingCost.label',
      effect: 'add',
      value: money(ZERO),
      inputs,
      params,
      explainKey: 'pricing_engine.components.packagingCost.explain.missing',
      explainValues: { sku, currency: context.currencyCode },
      confidence: 'default',
      warnings,
    }
  }

  // A dropped labour rate or an unpriceable carton leaves part of the pack cost out of the number
  // entirely, which is an assumption-grade result like `operational_cost_base` treats it; a pack
  // unit that simply has no cost row still priced everything it could, so it only loses `measured`.
  let confidence: ComponentResult['confidence'] = 'measured'
  if (missingUnitCodes.length > 0) confidence = 'estimated'
  if (!hasConversions || missingLaborRate) confidence = 'default'

  return {
    code: PACKAGING_COST_CODE,
    labelKey: 'pricing_engine.components.packagingCost.label',
    effect: 'add',
    value: money(perUnit),
    inputs,
    params,
    explainKey: hasConversions
      ? 'pricing_engine.components.packagingCost.explain.packed'
      : 'pricing_engine.components.packagingCost.explain.perItemOnly',
    explainValues: {
      sku,
      packUnitCount: packUnits.length,
      lineCost: money(lineCost),
      perUnit: money(perUnit),
      currency: context.currencyCode,
    },
    confidence,
    warnings,
  }
}

export const packagingCostComponent: PriceComponent = {
  code: PACKAGING_COST_CODE,
  position: 3,
  level: 'line',
  effect: 'add',
  labelKey: 'pricing_engine.components.packagingCost.label',
  contributesToCost: true,
  compute,
}
