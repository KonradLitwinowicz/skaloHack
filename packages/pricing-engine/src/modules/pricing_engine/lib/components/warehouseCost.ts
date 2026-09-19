import { add, div, format, gt, max, money, MONEY_DP, mul, percentToFactor, toDecimal, ZERO } from '../decimal'
import { PRODUCT_COST_CODE } from './productCost'
import type { Decimal } from '../decimal'
import type {
  CatalogProductSnapshot,
  ComponentComputeArgs,
  ComponentResult,
  InventoryRotationSource,
  PriceComponent,
  PricingConfidence,
  ProductRotation,
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

export type OccupancySource = 'dimensions' | 'weight' | 'configured' | 'none'

export type Occupancy = {
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

/**
 * Share of one storage unit that a single product unit takes up.
 *
 * Exported so the deadstock screen charges rent on exactly the same footprint a quote charges it
 * on. Two different occupancy figures for one product would make the two screens disagree about
 * what the warehouse costs, and the disagreement would be invisible.
 */
export function resolveOccupancy(
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

// Turnover days: measured where the facts exist, assumed where they do not.
//
// WMS records stock history in `wms_inventory_movements` and `deps.inventory` carries the cover
// days derived from it, so this figure is no longer an unconditional assumption. What a stock
// deployment still lacks is the ISSUE side of that history: `wms.inventory` writes `receipt`,
// `adjust` and `cycle_count`, and its `move` command relocates within a single warehouse, which
// nets to zero. Until picking and shipping are recorded, `computeRotation` returns one of the
// non-measured sources and this component stays on `defaultTurnoverDays` — and says so, through
// `turnoverSource`, a warning naming the reason, and the confidence it reports.
const ROTATION_WARNING_KEYS: Record<InventoryRotationSource, string | null> = {
  movements: null,
  no_movements: 'pricing_engine.warnings.warehouseRotationNoMovements',
  no_issues: 'pricing_engine.warnings.warehouseRotationNoIssues',
  no_stock: 'pricing_engine.warnings.warehouseRotationNoStock',
  short_history: 'pricing_engine.warnings.warehouseRotationShortHistory',
  unavailable: 'pricing_engine.warnings.warehouseRotationUnavailable',
}

const TURNOVER_DP = 1

type Turnover = {
  days: Decimal
  source: InventoryRotationSource
  measured: boolean
  observedDays: number
  dailyIssueRate: string
  onHandQuantity: string
  issuedQuantity: string
}

function resolveTurnover(warehouse: WarehouseCostSnapshot, rotation: ProductRotation | null): Turnover {
  const configuredDays = toDecimal(String(warehouse.defaultTurnoverDays))
  if (!rotation) {
    return {
      days: configuredDays,
      source: 'unavailable',
      measured: false,
      observedDays: 0,
      dailyIssueRate: '0.0000',
      onHandQuantity: '0.0000',
      issuedQuantity: '0.0000',
    }
  }
  // A snapshot that merely carries the `movements` label is not a measurement: only a cover figure
  // actually computed from issues may displace the configured default.
  const measured = rotation.source === 'movements' && rotation.coverDays !== null
  return {
    days: measured ? toDecimal(rotation.coverDays as string) : configuredDays,
    source: rotation.source,
    measured,
    observedDays: rotation.observedDays,
    dailyIssueRate: rotation.dailyIssueRate,
    onHandQuantity: rotation.onHandQuantity,
    issuedQuantity: rotation.issuedQuantity,
  }
}

const CONFIDENCE_RANK: Record<PricingConfidence, number> = { default: 0, estimated: 1, measured: 2 }

function lowerConfidence(left: PricingConfidence, right: PricingConfidence): PricingConfidence {
  return CONFIDENCE_RANK[left] <= CONFIDENCE_RANK[right] ? left : right
}

/**
 * The component reports the LOWER of its two dimensions, occupancy and rotation.
 *
 * Occupancy is capped at `estimated` even when the product carries real dimensions, because the
 * pallet-slot envelope those dimensions are divided by is an assumed geometry, not a survey of this
 * distributor's racking. That cap is the existing invariant of this file and the geometry has not
 * changed, so a measured rotation cannot lift the component to `measured` — taking the lower of the
 * two is exactly what keeps it from doing so, and that is the whole truth about the measurement.
 *
 * A non-measured rotation sits at `estimated` rather than `default`: the configured turnover is a
 * parameter row of the same standing as the rest of the warehouse configuration, and it is declared
 * through `warehouseTurnoverAssumed` instead. What drops this component to `default` is failing to
 * establish how much space the unit takes at all.
 */
function resolveConfidence(occupancy: OccupancySource, measuredRotation: boolean): PricingConfidence {
  const fromOccupancy: PricingConfidence =
    occupancy === 'dimensions' || occupancy === 'weight' ? 'estimated' : 'default'
  const fromRotation: PricingConfidence = measuredRotation ? 'measured' : 'estimated'
  return lowerConfidence(fromOccupancy, fromRotation)
}

function explainKeyFor(source: OccupancySource, measuredRotation: boolean): string {
  if (source === 'configured') {
    return measuredRotation
      ? 'pricing_engine.components.warehouseCost.explain.fallbackShareMeasured'
      : 'pricing_engine.components.warehouseCost.explain.fallbackShare'
  }
  if (source === 'none') {
    return measuredRotation
      ? 'pricing_engine.components.warehouseCost.explain.capitalOnlyMeasured'
      : 'pricing_engine.components.warehouseCost.explain.capitalOnly'
  }
  return measuredRotation
    ? 'pricing_engine.components.warehouseCost.explain.estimatedMeasured'
    : 'pricing_engine.components.warehouseCost.explain.estimated'
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

  const stock = deps.inventory?.byProductId.get(line.productId) ?? null
  const turnover = resolveTurnover(warehouse, stock?.rotation ?? null)
  if (!turnover.measured) {
    warnings.push('pricing_engine.warnings.warehouseTurnoverAssumed')
    const reasonKey = ROTATION_WARNING_KEYS[turnover.source]
    if (reasonKey) warnings.push(reasonKey)
  }

  const turnoverDays = turnover.days
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

  const confidence = resolveConfidence(occupancy.source, turnover.measured)

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
      turnoverDays: format(turnoverDays, MONEY_DP),
      turnoverSource: turnover.source,
      observedDays: turnover.observedDays,
      dailyIssueRate: turnover.dailyIssueRate,
      onHandQuantity: turnover.onHandQuantity,
      issuedQuantity: turnover.issuedQuantity,
    },
    params: {
      basis: warehouse.basis,
      costPerMonth: warehouse.costPerMonth,
      capitalCostAnnualRate: warehouse.capitalCostAnnualRate,
      defaultTurnoverDays: warehouse.defaultTurnoverDays,
      componentParamRef: deps.params.componentParamRef(WAREHOUSE_COST_CODE, scopeRefs),
    },
    explainKey: explainKeyFor(occupancy.source, turnover.measured),
    explainValues: {
      sku,
      occupancyShare: format(occupancy.share, SHARE_DP),
      turnoverDays: format(turnoverDays, TURNOVER_DP),
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
