import { gt, isZero, money, mul, ONE, sub, toDecimal, ZERO } from '../decimal'
import type { Decimal } from '../decimal'
import type {
  ComponentComputeArgs,
  ComponentResult,
  PriceComponent,
  PricingConfidence,
} from '../types'

export const PRODUCT_ASPECTS_CODE = 'product_aspects'

// Widest surcharge a single aspect may apply. A configured factor outside (0, MAX] is treated as
// a configuration error, not as an instruction to zero or invert the price.
const MAX_ASPECT_FACTOR = toDecimal('5')

// Assumed surcharges, in the spirit of lib/seedDefaults.ts: a distributor that has never measured
// its handling premium still gets a defensible number, and the result says `default` until it
// configures its own through `pricing_component_params`.
export const DEFAULT_HEAVY_THRESHOLD_KG = '25.0000'
export const DEFAULT_HEAVY_FACTOR = '1.0400'
export const DEFAULT_OVERSIZE_THRESHOLD_M3 = '0.2500'
export const DEFAULT_OVERSIZE_FACTOR = '1.0600'

export const HEAVY_ASPECT_CODE = 'heavy'
export const OVERSIZE_ASPECT_CODE = 'oversize'
export const PRODUCT_GROUP_ASPECT_CODE = 'product_group'

const WEIGHT_UNIT_TO_KILOGRAM: Record<string, string> = {
  kg: '1',
  dag: '0.01',
  g: '0.001',
  t: '1000',
  lb: '0.45359237',
}

const LENGTH_UNIT_TO_METRE: Record<string, string> = {
  m: '1',
  cm: '0.01',
  mm: '0.001',
}

const CONFIDENCE_RANK: Record<PricingConfidence, number> = {
  default: 0,
  estimated: 1,
  measured: 2,
}

type ProductAspectsPayload = {
  heavyThresholdKg?: string | number
  heavyFactor?: string | number
  oversizeThresholdM3?: string | number
  oversizeFactor?: string | number
  productGroupFactors?: Record<string, string | number>
}

type AspectHit = {
  code: string
  labelKey: string
  factor: Decimal
}

type WeightReading = {
  kilograms: Decimal | null
  unitRecognized: boolean
}

type VolumeReading = {
  cubicMetres: Decimal | null
  unitRecognized: boolean
  complete: boolean
}

function weakestConfidence(left: PricingConfidence, right: PricingConfidence): PricingConfidence {
  return CONFIDENCE_RANK[left] <= CONFIDENCE_RANK[right] ? left : right
}

function readNumericField(source: Record<string, unknown> | null, key: string): string | null {
  const raw = source?.[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return null
}

function readUnitField(source: Record<string, unknown> | null, key: string): string | null {
  const raw = source?.[key]
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toLowerCase() : null
}

function readWeightKilograms(weightValue: string | null, weightUnit: string | null): WeightReading {
  if (weightValue === null || weightValue.trim() === '') return { kilograms: null, unitRecognized: true }
  // A null unit on a Polish distributor's catalog row is kilograms; that convention is recorded in
  // `inputs.weightUnit` so a reader can see what was assumed rather than having to infer it.
  const unit = (weightUnit ?? 'kg').trim().toLowerCase()
  const conversion = WEIGHT_UNIT_TO_KILOGRAM[unit]
  if (!conversion) return { kilograms: null, unitRecognized: false }
  return { kilograms: mul(toDecimal(weightValue), toDecimal(conversion)), unitRecognized: true }
}

function readVolumeCubicMetres(dimensions: Record<string, unknown> | null): VolumeReading {
  const width = readNumericField(dimensions, 'width')
  const height = readNumericField(dimensions, 'height')
  const depth = readNumericField(dimensions, 'depth')
  if (width === null || height === null || depth === null) {
    return { cubicMetres: null, unitRecognized: true, complete: false }
  }

  // Catalog stores box dimensions in centimetres when the unit is left empty.
  const unit = readUnitField(dimensions, 'unit') ?? 'cm'
  const conversion = LENGTH_UNIT_TO_METRE[unit]
  if (!conversion) return { cubicMetres: null, unitRecognized: false, complete: true }

  const toMetre = toDecimal(conversion)
  const volume = mul(
    mul(mul(toDecimal(width), toMetre), mul(toDecimal(height), toMetre)),
    mul(toDecimal(depth), toMetre),
  )
  return { cubicMetres: volume, unitRecognized: true, complete: true }
}

function readProductGroupFactor(
  payload: ProductAspectsPayload | null,
  productGroupCode: string | null,
): string | null {
  if (!payload || !productGroupCode) return null
  const factors = payload.productGroupFactors
  if (!factors || typeof factors !== 'object') return null
  const raw = (factors as Record<string, unknown>)[productGroupCode]
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return null
}

// TODO(data-source): `catalog_products` also carries `hazmat_class`, `requires_prescription` and
// `is_excise_good`, which are the fields that would separate a genuine fragile / regulated /
// excise storage regime from an ordinary heavy box. `CatalogProductSnapshot` (lib/catalog.ts) does
// not expose them yet, so those regimes currently ride on the configurable product-group factor.
async function compute(args: ComponentComputeArgs): Promise<ComponentResult> {
  const { context, deps, line } = args
  const product = deps.catalog.byProductId.get(line.productId) ?? null
  const productGroupCode = product?.productGroupCode ?? null
  const scopeRefs = {
    productId: line.productId,
    productGroupCode,
    customerId: context.customerId ?? null,
    customerGroupCode: context.customerGroupCode ?? null,
  }

  const payload = deps.params.componentPayload(PRODUCT_ASPECTS_CODE, scopeRefs) as ProductAspectsPayload | null
  const paramRef = deps.params.componentParamRef(PRODUCT_ASPECTS_CODE, scopeRefs)
  const warnings: string[] = []

  const weight = readWeightKilograms(product?.weightValue ?? null, product?.weightUnit ?? null)
  const volume = readVolumeCubicMetres(product?.dimensions ?? null)
  const groupFactorRaw = readProductGroupFactor(payload, productGroupCode)

  if (!weight.unitRecognized) warnings.push('pricing_engine.warnings.productAspectsWeightUnitUnknown')
  if (!volume.unitRecognized) warnings.push('pricing_engine.warnings.productAspectsDimensionUnitUnknown')
  else if (!volume.complete) warnings.push('pricing_engine.warnings.productAspectsDimensionsMissing')
  if (weight.kilograms === null && volume.cubicMetres === null) {
    warnings.push('pricing_engine.warnings.productAspectsPhysicalDataMissing')
  }
  if (!payload) warnings.push('pricing_engine.warnings.productAspectsMultipliersAssumed')

  const sku = line.sku ?? product?.sku ?? line.productId

  if (weight.kilograms === null && volume.cubicMetres === null && groupFactorRaw === null) {
    // TODO(data-source): nothing measurable about this product reached the engine — no weight, no
    // dimensions, no product-group factor. A multiplier is neutral at 1, so the line is priced as
    // an ordinary box and the gap is reported rather than filled with a guess.
    return {
      code: PRODUCT_ASPECTS_CODE,
      labelKey: 'pricing_engine.components.productAspects.label',
      effect: 'mul',
      value: '1.0000',
      inputs: {
        productId: line.productId,
        sku: product?.sku ?? null,
        weightValue: product?.weightValue ?? null,
        weightUnit: product?.weightUnit ?? null,
        productGroupCode,
      },
      params: { paramRef, source: 'none' },
      explainKey: 'pricing_engine.components.productAspects.explain.missing',
      explainValues: { sku },
      confidence: 'default',
      warnings,
    }
  }

  const heavyThresholdKg = toDecimal(payload?.heavyThresholdKg, DEFAULT_HEAVY_THRESHOLD_KG)
  const heavyFactor = toDecimal(payload?.heavyFactor, DEFAULT_HEAVY_FACTOR)
  const oversizeThresholdM3 = toDecimal(payload?.oversizeThresholdM3, DEFAULT_OVERSIZE_THRESHOLD_M3)
  const oversizeFactor = toDecimal(payload?.oversizeFactor, DEFAULT_OVERSIZE_FACTOR)

  const hits: AspectHit[] = []

  if (weight.kilograms !== null && gt(weight.kilograms, heavyThresholdKg)) {
    hits.push({
      code: HEAVY_ASPECT_CODE,
      labelKey: 'pricing_engine.components.productAspects.aspect.heavy',
      factor: heavyFactor,
    })
  }

  if (volume.cubicMetres !== null && gt(volume.cubicMetres, oversizeThresholdM3)) {
    hits.push({
      code: OVERSIZE_ASPECT_CODE,
      labelKey: 'pricing_engine.components.productAspects.aspect.oversize',
      factor: oversizeFactor,
    })
  }

  if (groupFactorRaw !== null) {
    const groupFactor = toDecimal(groupFactorRaw, '1')
    if (!isZero(sub(groupFactor, ONE))) {
      hits.push({
        code: PRODUCT_GROUP_ASPECT_CODE,
        labelKey: 'pricing_engine.components.productAspects.aspect.productGroup',
        factor: groupFactor,
      })
    }
  }

  // A 'mul' component is a loaded gun: a configured factor of 0 would zero the price outright and
  // a negative one would invert it. Anything outside a sane band is refused, the neutral 1.0000 is
  // used for that aspect instead, and the rejection is warned about rather than applied silently.
  let totalFactor = ONE
  const rejectedAspects: string[] = []
  for (const hit of hits) {
    if (!gt(hit.factor, ZERO) || gt(hit.factor, MAX_ASPECT_FACTOR)) {
      rejectedAspects.push(hit.code)
      continue
    }
    totalFactor = mul(totalFactor, hit.factor)
  }
  if (rejectedAspects.length > 0) warnings.push('pricing_engine.warnings.productAspectFactorRejected')

  const physicalConfidence: PricingConfidence =
    weight.kilograms !== null && volume.cubicMetres !== null
      ? 'measured'
      : weight.kilograms !== null || volume.cubicMetres !== null
        ? 'estimated'
        : 'default'

  // The thresholds decide which aspects fire, so an assumed threshold weakens the answer even when
  // no aspect fired: "nothing applies" is itself a claim made against an assumed limit.
  // A payload that is merely PRESENT proves nothing — it has to actually carry every figure this
  // component consumed, otherwise the missing ones silently fell back to invented defaults.
  const suppliedAll =
    payload !== null &&
    payload.heavyThresholdKg !== undefined &&
    payload.heavyThresholdKg !== null &&
    payload.heavyFactor !== undefined &&
    payload.heavyFactor !== null &&
    payload.oversizeThresholdM3 !== undefined &&
    payload.oversizeThresholdM3 !== null &&
    payload.oversizeFactor !== undefined &&
    payload.oversizeFactor !== null
  const multiplierConfidence: PricingConfidence = suppliedAll ? 'measured' : 'default'

  return {
    code: PRODUCT_ASPECTS_CODE,
    labelKey: 'pricing_engine.components.productAspects.label',
    effect: 'mul',
    value: money(totalFactor),
    inputs: {
      productId: line.productId,
      sku: product?.sku ?? null,
      weightValue: product?.weightValue ?? null,
      weightUnit: product?.weightUnit ?? null,
      weightKg: weight.kilograms === null ? null : money(weight.kilograms),
      volumeM3: volume.cubicMetres === null ? null : money(volume.cubicMetres),
      productGroupCode,
      aspects: hits.map((hit) => ({ code: hit.code, factor: money(hit.factor) })),
    },
    params: {
      heavyThresholdKg: money(heavyThresholdKg),
      heavyFactor: money(heavyFactor),
      oversizeThresholdM3: money(oversizeThresholdM3),
      oversizeFactor: money(oversizeFactor),
      productGroupFactor: groupFactorRaw,
      source: payload ? 'component_param' : 'assumed_defaults',
      paramRef,
      // Aspect codes are not user-facing copy; the UI renders these keys so a breakdown row stays
      // localizable without the component ever building a sentence.
      aspectLabelKeys: hits.map((hit) => hit.labelKey),
    },
    explainKey:
      hits.length > 0
        ? 'pricing_engine.components.productAspects.explain.applied'
        : 'pricing_engine.components.productAspects.explain.none',
    explainValues: {
      sku,
      factor: money(totalFactor),
      aspectCount: hits.length,
      aspects: hits.map((hit) => hit.code).join(', '),
      weightKg: weight.kilograms === null ? '' : money(weight.kilograms),
      volumeM3: volume.cubicMetres === null ? '' : money(volume.cubicMetres),
    },
    confidence: weakestConfidence(physicalConfidence, multiplierConfidence),
    warnings,
  }
}

export const productAspectsComponent: PriceComponent = {
  code: PRODUCT_ASPECTS_CODE,
  position: 6,
  level: 'line',
  effect: 'mul',
  labelKey: 'pricing_engine.components.productAspects.label',
  contributesToCost: true,
  compute,
}
