import { add, div, format, gt, max, money, mul, percentToFactor, toDecimal, ZERO } from '../decimal'
import { PRODUCT_COST_CODE } from './productCost'
import type { Decimal } from '../decimal'
import type {
  CatalogProductSnapshot,
  ComponentComputeArgs,
  ComponentResult,
  PriceComponent,
  PricingConfidence,
  ScopeRefs,
  WarehouseCostSnapshot,
} from '../types'

export const WAREHOUSE_COST_CODE = 'warehouse_cost'

// Geometry of a racked EUR pallet slot: a 1.2 m x 0.8 m footprint with 1.8 m of stacking
// clearance, carrying 800 kg of dynamic load. These are physical defaults, not measurements of
// THIS distributor's racking — a warehouse with different racking gets different numbers, and
// they move a production price. They are therefore overridable through the component's parameter
// payload (`palletSlotVolumeM3` / `palletSlotCapacityKg`), and a component running on the
// defaults never reports better than `estimated`.
// TODO(data-source): no module in Open Mercato models racking geometry; until one does, this is
// a configured assumption and the coverage register reports it as such.
export const PALLET_SLOT_VOLUME_M3 = '1.728'
export const PALLET_SLOT_CAPACITY_KG = '800'

const DAYS_PER_MONTH = toDecimal('30')
const DAYS_PER_YEAR = toDecimal('365')

const METRES_PER_DIMENSION_UNIT: Record<string, string> = {
  mm: '0.001',
  cm: '0.01',
  dm: '0.1',
  m: '1',
  in: '0.0254',
}

const KILOGRAMS_PER_WEIGHT_UNIT: Record<string, string> = {
  g: '0.001',
  kg: '1',
  t: '1000',
  lb: '0.45359237',
}

const POSITIVE_NUMERIC_TEXT = /^\d+(\.\d+)?$/

const SHARE_DP = 6

type OccupancySource = 'dimensions' | 'weight' | 'configured' | 'none'

type Occupancy = {
  share: Decimal
  source: OccupancySource
  volumeM3: Decimal | null
  weightKg: Decimal | null
}

type UnitDimensions = {
  widthM: Decimal
  heightM: Decimal
  depthM: Decimal
}

function readPositiveDecimal(value: unknown): Decimal | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!POSITIVE_NUMERIC_TEXT.test(text)) return null
  const parsed = toDecimal(text)
  return gt(parsed, ZERO) ? parsed : null
}

function readUnitFactor(table: Record<string, string>, unit: unknown): Decimal | null {
  const key = typeof unit === 'string' ? unit.trim().toLowerCase() : ''
  const factor = key ? table[key] : undefined
  return factor ? toDecimal(factor) : null
}

// An unknown or absent unit makes the numbers unusable rather than merely imprecise: 5 could be
// 5 cm or 5 m. The component reports the gap instead of assuming a unit.
function readUnitDimensions(dimensions: Record<string, unknown> | null): UnitDimensions | null {
  if (!dimensions) return null
  const metres = readUnitFactor(METRES_PER_DIMENSION_UNIT, dimensions['unit'])
  if (!metres) return null
  const width = readPositiveDecimal(dimensions['width'])
  const height = readPositiveDecimal(dimensions['height'])
  const depth = readPositiveDecimal(dimensions['depth'] ?? dimensions['length'])
  if (!width || !height || !depth) return null
  return { widthM: mul(width, metres), heightM: mul(height, metres), depthM: mul(depth, metres) }
}

function readUnitWeightKg(product: CatalogProductSnapshot | null): Decimal | null {
  if (!product) return null
  const weight = readPositiveDecimal(product.weightValue)
  if (!weight) return null
  const kilograms = readUnitFactor(KILOGRAMS_PER_WEIGHT_UNIT, product.weightUnit)
  if (!kilograms) return null
  return mul(weight, kilograms)
}

function resolveOccupancy(
  warehouse: WarehouseCostSnapshot,
  product: CatalogProductSnapshot | null,
  configuredShare: Decimal | null,
): Occupancy {
  const dimensions = readUnitDimensions(product?.dimensions ?? null)
  const weightKg = readUnitWeightKg(product)

  if (warehouse.basis === 'm2') {
    // The rate is money per square metre per month, so the share is simply the floor area one
    // unit takes. Weight cannot stand in here: floor loading is a separate limit and no row in
    // pricing_warehouse_costs carries it.
    if (dimensions) {
      const footprintM2 = mul(dimensions.widthM, dimensions.depthM)
      return { share: footprintM2, source: 'dimensions', volumeM3: null, weightKg }
    }
    if (configuredShare) return { share: configuredShare, source: 'configured', volumeM3: null, weightKg }
    return { share: ZERO, source: 'none', volumeM3: null, weightKg }
  }

  const volumeM3 = dimensions ? mul(mul(dimensions.widthM, dimensions.depthM), dimensions.heightM) : null
  const volumeShare = volumeM3 ? div(volumeM3, toDecimal(PALLET_SLOT_VOLUME_M3)) : null
  const weightShare = weightKg ? div(weightKg, toDecimal(PALLET_SLOT_CAPACITY_KG)) : null

  // A slot is exhausted by whichever ceiling the goods hit first, so the binding share wins.
  if (volumeShare && weightShare) {
    return { share: max(volumeShare, weightShare), source: 'dimensions', volumeM3, weightKg }
  }
  if (volumeShare) return { share: volumeShare, source: 'dimensions', volumeM3, weightKg }
  if (weightShare) return { share: weightShare, source: 'weight', volumeM3, weightKg }
  if (configuredShare) return { share: configuredShare, source: 'configured', volumeM3, weightKg }
  return { share: ZERO, source: 'none', volumeM3, weightKg }
}

function explainKeyFor(source: OccupancySource): string {
  if (source === 'configured') return 'pricing_engine.components.warehouseCost.explain.fallbackShare'
  if (source === 'none') return 'pricing_engine.components.warehouseCost.explain.capitalOnly'
  return 'pricing_engine.components.warehouseCost.explain.estimated'
}

async function compute(args: ComponentComputeArgs): Promise<ComponentResult> {
  const { context, deps, line, unitCostNet } = args
  const product = deps.catalog.byProductId.get(line.productId) ?? null
  const warehouse = deps.params.warehouseCost()
  const warnings: string[] = []
  const sku = line.sku ?? product?.sku ?? line.productId

  if (!warehouse) {
    // TODO(data-source): no pricing_warehouse_costs row in scope. Space rent, the capital rate and
    // the turnover assumption all come from that single row, so there is nothing to fall back to.
    warnings.push('pricing_engine.warnings.warehouseCostMissing')
    return {
      code: WAREHOUSE_COST_CODE,
      labelKey: 'pricing_engine.components.warehouseCost.label',
      effect: 'add',
      value: '0.0000',
      inputs: { productId: line.productId, sku: line.sku ?? product?.sku ?? null },
      params: {},
      explainKey: 'pricing_engine.components.warehouseCost.explain.missing',
      explainValues: { sku },
      confidence: 'default',
      warnings,
    }
  }

  const scopeRefs: ScopeRefs = {
    productId: line.productId,
    productGroupCode: product?.productGroupCode ?? null,
    customerId: context.customerId ?? null,
    customerGroupCode: context.customerGroupCode ?? null,
  }
  const payload = deps.params.componentPayload(WAREHOUSE_COST_CODE, scopeRefs)
  const configuredShare = payload ? readPositiveDecimal(payload['occupancyShare']) : null
  const occupancy = resolveOccupancy(warehouse, product, configuredShare)

  if (occupancy.source === 'weight') warnings.push('pricing_engine.warnings.warehouseDimensionsMissing')
  if (occupancy.source === 'configured') warnings.push('pricing_engine.warnings.warehouseOccupancyFallback')
  if (occupancy.source === 'none') warnings.push('pricing_engine.warnings.warehouseOccupancyMissing')

  // TODO(data-source): no stock-history module exists yet, so days-on-hand can only come from the
  // configured default. Until receipts and issues are recorded per product this component is
  // `estimated` at best, never `measured`, however complete the rest of the configuration is.
  warnings.push('pricing_engine.warnings.warehouseTurnoverAssumed')

  const turnoverDays = toDecimal(String(warehouse.defaultTurnoverDays))
  const spaceCost = mul(
    mul(occupancy.share, toDecimal(warehouse.costPerMonth)),
    div(turnoverDays, DAYS_PER_MONTH),
  )
  // Frozen capital is the money tied up in GOODS. Charging it on the accumulated cost would
  // finance the picking labour and packaging that have not been paid out yet, and would compound
  // as more cost components land ahead of this one. The spec formula is explicit:
  // product_cost x capitalCostAnnualRate x turnoverDays / 365.
  const productCostValue = args.componentValues[PRODUCT_COST_CODE]
  const capitalBase = productCostValue === undefined ? unitCostNet : toDecimal(productCostValue)
  if (productCostValue === undefined) warnings.push('pricing_engine.warnings.capitalBaseFallback')
  const capitalCost = mul(
    mul(capitalBase, percentToFactor(warehouse.capitalCostAnnualRate)),
    div(turnoverDays, DAYS_PER_YEAR),
  )
  const perUnit = add(spaceCost, capitalCost)

  const confidence: PricingConfidence =
    occupancy.source === 'dimensions' || occupancy.source === 'weight' ? 'estimated' : 'default'

  return {
    code: WAREHOUSE_COST_CODE,
    labelKey: 'pricing_engine.components.warehouseCost.label',
    effect: 'add',
    value: money(perUnit),
    inputs: {
      productId: line.productId,
      sku: line.sku ?? product?.sku ?? null,
      occupancyShare: format(occupancy.share, SHARE_DP),
      occupancySource: occupancy.source,
      volumeM3: occupancy.volumeM3 ? format(occupancy.volumeM3, SHARE_DP) : null,
      weightKg: occupancy.weightKg ? format(occupancy.weightKg, SHARE_DP) : null,
      unitCostNet: money(unitCostNet),
      spaceCost: money(spaceCost),
      capitalCost: money(capitalCost),
    },
    params: {
      basis: warehouse.basis,
      costPerMonth: warehouse.costPerMonth,
      capitalCostAnnualRate: warehouse.capitalCostAnnualRate,
      defaultTurnoverDays: warehouse.defaultTurnoverDays,
      componentParamRef: deps.params.componentParamRef(WAREHOUSE_COST_CODE, scopeRefs),
    },
    explainKey: explainKeyFor(occupancy.source),
    explainValues: {
      sku,
      occupancyShare: format(occupancy.share, SHARE_DP),
      turnoverDays: warehouse.defaultTurnoverDays,
      spaceCost: money(spaceCost),
      capitalCost: money(capitalCost),
      perUnit: money(perUnit),
      currency: context.currencyCode,
    },
    confidence,
    warnings,
  }
}

export const warehouseCostComponent: PriceComponent = {
  code: WAREHOUSE_COST_CODE,
  position: 4,
  level: 'line',
  effect: 'add',
  labelKey: 'pricing_engine.components.warehouseCost.label',
  contributesToCost: true,
  compute,
}
