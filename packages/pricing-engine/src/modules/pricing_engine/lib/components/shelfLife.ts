import {
  add,
  div,
  min,
  money,
  mul,
  ONE,
  percentToFactor,
  sub,
  toDecimal,
  ZERO,
} from '../decimal'
import type { Decimal } from '../decimal'
import { lotExpiryDate, sortFefo } from '../inventory'
import type { PricingConfidence, ProductLotSnapshot } from '../types'
import { minPriceForMargin } from './guardrails'

/**
 * Parameter row this ladder is configured from.
 *
 * NOTE ON SCOPE: `params.componentPayload` returns the FIRST matching row in its entirety and does
 * not merge rows across the scope chain (`lib/params.ts:158-170`). A product-scoped row therefore
 * has to carry every field below — a row naming only `disposalRatePerKg` would silently take the
 * remaining four figures from the constants here, not from the global row it appears to refine.
 */
export const SHELF_LIFE_COMPONENT_CODE = 'shelf_life_markdown'

/** Remaining life above this fraction is ordinary stock: the normal guardrail applies untouched. */
export const DEFAULT_EARLY_THRESHOLD_PERCENT = '25'
export const DEFAULT_AT_COST_THRESHOLD_PERCENT = '10'
export const DEFAULT_SALVAGE_THRESHOLD_PERCENT = '5'

/** The shallow markdown: still profitable, just much less so. */
export const DEFAULT_EARLY_MARGIN_PERCENT = '5'

/** Assumed waste-contract rate, per `lib/seedDefaults.ts` conventions. Replaced by the real one. */
export const DEFAULT_DISPOSAL_RATE_PER_KG = '2.50'

/** Used only when a lot carries no manufacturing date, so its full life cannot be measured. */
export const DEFAULT_SHELF_LIFE_DAYS = 365

const MS_PER_DAY = 86_400_000

/** A disposal contract that charges more than this per kilogram is a typo, not a price. */
const MAX_DISPOSAL_RATE_PER_KG = toDecimal('1000')

export type ShelfLifeStage = 'none' | 'early' | 'at_cost' | 'salvage'

/** The stages that actually move a price. `none` is the absence of a ladder, not a rung of it. */
export type ShelfLifeMarkdownStage = Exclude<ShelfLifeStage, 'none'>

export type ShelfLifeReading = {
  expiryDate: Date
  totalDays: number
  remainingDays: number
  remainingFraction: Decimal
  confidence: PricingConfidence
}

export type ShelfLifeThresholds = {
  earlyThreshold: Decimal
  atCostThreshold: Decimal
  salvageThreshold: Decimal
}

export type ShelfLifeConfig = ShelfLifeThresholds & {
  earlyMarginPercent: string
  disposalRatePerKg: Decimal
  defaultShelfLifeDays: number
  /** True only when the payload carried every figure consumed here. */
  supplied: boolean
  thresholdsRejected: boolean
  disposalRateRejected: boolean
}

export type ShelfLifePortion = {
  lot: ProductLotSnapshot | null
  shelfLife: ShelfLifeReading | null
  quantity: Decimal
  stage: ShelfLifeStage
}

export type ShelfLifePricedPortion = ShelfLifePortion & {
  floorUnitPrice: Decimal
}

export type ShelfLifeMarkdown = {
  weightedFloorUnitPrice: Decimal
  leadLot: ProductLotSnapshot
  leadShelfLife: ShelfLifeReading
  stage: ShelfLifeMarkdownStage
  allocations: ShelfLifePricedPortion[]
  markdownQuantity: Decimal
  salvageFloorUnitPrice: Decimal
  disposalRatePerKg: Decimal
  weightKg: Decimal | null
  writeOffAvoided: Decimal
  confidence: PricingConfidence
  warnings: string[]
}

const CONFIDENCE_RANK: Record<PricingConfidence, number> = {
  default: 0,
  estimated: 1,
  measured: 2,
}

function weakestConfidence(left: PricingConfidence, right: PricingConfidence): PricingConfidence {
  return CONFIDENCE_RANK[left] <= CONFIDENCE_RANK[right] ? left : right
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY)
}

// The shape `toDecimal` accepts. Anything else must be REJECTED rather than passed on, because
// `toDecimal` falls back to zero on a string it cannot parse — so '6,00', the decimal comma a
// Polish operator types by reflex, would silently become a disposal rate of nothing while the row
// still counted as fully configured.
const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/

function readNumericField(source: Record<string, unknown> | null, key: string): string | null {
  const raw = source?.[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return DECIMAL_TEXT.test(trimmed) ? trimmed : null
}

/** True when the key is present but unreadable — the operator typed something we cannot honour. */
function isMalformedField(source: Record<string, unknown> | null, key: string): boolean {
  const raw = source?.[key]
  if (raw === undefined || raw === null) return false
  return readNumericField(source, key) === null
}

function readIntegerField(source: Record<string, unknown> | null, key: string): number | null {
  const raw = readNumericField(source, key)
  if (raw === null) return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.trunc(parsed)
}

export const DEFAULT_SHELF_LIFE_CONFIG: ShelfLifeConfig = {
  earlyThreshold: percentToFactor(DEFAULT_EARLY_THRESHOLD_PERCENT),
  atCostThreshold: percentToFactor(DEFAULT_AT_COST_THRESHOLD_PERCENT),
  salvageThreshold: percentToFactor(DEFAULT_SALVAGE_THRESHOLD_PERCENT),
  earlyMarginPercent: DEFAULT_EARLY_MARGIN_PERCENT,
  disposalRatePerKg: toDecimal(DEFAULT_DISPOSAL_RATE_PER_KG),
  defaultShelfLifeDays: DEFAULT_SHELF_LIFE_DAYS,
  supplied: false,
  thresholdsRejected: false,
  disposalRateRejected: false,
}

/**
 * Read the configured ladder, refusing anything that would make it incoherent.
 *
 * Thresholds that are not strictly descending inside (0, 1] would let a lot fall into a deeper
 * stage than its remaining life justifies — a misconfigured row must not be able to authorise a
 * salvage price on fresh stock, so the whole triple falls back to the defaults and says so.
 */
export function readShelfLifeConfig(payload: Record<string, unknown> | null): ShelfLifeConfig {
  const earlyRaw = readNumericField(payload, 'earlyThresholdPercent')
  const atCostRaw = readNumericField(payload, 'atCostThresholdPercent')
  const salvageRaw = readNumericField(payload, 'salvageThresholdPercent')
  const earlyMarginRaw = readNumericField(payload, 'earlyMarginPercent')
  const disposalRaw = readNumericField(payload, 'disposalRatePerKg')
  const defaultDays = readIntegerField(payload, 'defaultShelfLifeDays')

  let earlyThreshold = DEFAULT_SHELF_LIFE_CONFIG.earlyThreshold
  let atCostThreshold = DEFAULT_SHELF_LIFE_CONFIG.atCostThreshold
  let salvageThreshold = DEFAULT_SHELF_LIFE_CONFIG.salvageThreshold
  let thresholdsRejected = false

  if (
    isMalformedField(payload, 'earlyThresholdPercent') ||
    isMalformedField(payload, 'atCostThresholdPercent') ||
    isMalformedField(payload, 'salvageThresholdPercent')
  ) {
    thresholdsRejected = true
  } else if (earlyRaw !== null && atCostRaw !== null && salvageRaw !== null) {
    const configuredEarly = percentToFactor(earlyRaw)
    const configuredAtCost = percentToFactor(atCostRaw)
    const configuredSalvage = percentToFactor(salvageRaw)
    const ordered =
      configuredEarly > configuredAtCost &&
      configuredAtCost > configuredSalvage &&
      configuredSalvage > ZERO &&
      configuredEarly <= ONE
    if (ordered) {
      earlyThreshold = configuredEarly
      atCostThreshold = configuredAtCost
      salvageThreshold = configuredSalvage
    } else {
      thresholdsRejected = true
    }
  }

  let disposalRatePerKg = DEFAULT_SHELF_LIFE_CONFIG.disposalRatePerKg
  let disposalRateRejected = isMalformedField(payload, 'disposalRatePerKg')
  if (disposalRaw !== null) {
    const configured = toDecimal(disposalRaw)
    if (configured >= ZERO && configured <= MAX_DISPOSAL_RATE_PER_KG) disposalRatePerKg = configured
    else disposalRateRejected = true
  }

  const earlyMarginPercent =
    earlyMarginRaw !== null && toDecimal(earlyMarginRaw) >= ZERO && percentToFactor(earlyMarginRaw) < ONE
      ? earlyMarginRaw
      : DEFAULT_EARLY_MARGIN_PERCENT

  const suppliedAll =
    payload !== null &&
    earlyRaw !== null &&
    atCostRaw !== null &&
    salvageRaw !== null &&
    earlyMarginRaw !== null &&
    disposalRaw !== null &&
    defaultDays !== null &&
    !thresholdsRejected &&
    !disposalRateRejected

  return {
    earlyThreshold,
    atCostThreshold,
    salvageThreshold,
    earlyMarginPercent,
    disposalRatePerKg,
    defaultShelfLifeDays: defaultDays ?? DEFAULT_SHELF_LIFE_DAYS,
    supplied: suppliedAll,
    thresholdsRejected,
    disposalRateRejected,
  }
}

/**
 * How much life this lot has left, as a fraction of the life it started with.
 *
 * A fraction rather than a day count is what lets a 12-month disinfectant and a 24-month degreaser
 * be judged by the same rule. Returns null when the lot carries no date at all: no date means no
 * ladder, never a ladder at stage zero.
 */
export function resolveShelfLife(
  lot: ProductLotSnapshot,
  asOf: Date,
  defaultShelfLifeDays: number = DEFAULT_SHELF_LIFE_DAYS,
): ShelfLifeReading | null {
  const expiryDate = lotExpiryDate(lot)
  if (!expiryDate) return null

  const remainingDays = daysBetween(asOf, expiryDate)
  const measuredTotalDays = lot.manufacturedAt ? daysBetween(lot.manufacturedAt, expiryDate) : 0
  const measured = measuredTotalDays > 0
  const totalDays = measured ? measuredTotalDays : Math.max(1, Math.trunc(defaultShelfLifeDays))

  return {
    expiryDate,
    totalDays,
    remainingDays,
    remainingFraction: div(toDecimal(String(remainingDays)), toDecimal(String(totalDays))),
    confidence: measured ? 'measured' : 'estimated',
  }
}

/**
 * Bounds are lower-inclusive: 25% and 10% belong to the band beneath them, 5% is still `at_cost`.
 * The spec reads "above 25%", "25% to 10%", "10% to 5%", "below 5%", and a lot sitting exactly on a
 * printed number must land in one band deterministically or the same lot prices two ways.
 */
export function resolveStage(remainingFraction: Decimal, thresholds: ShelfLifeThresholds): ShelfLifeStage {
  if (remainingFraction > thresholds.earlyThreshold) return 'none'
  if (remainingFraction >= thresholds.atCostThreshold) return 'early'
  if (remainingFraction >= thresholds.salvageThreshold) return 'at_cost'
  return 'salvage'
}

/**
 * The floor this stage imposes, or null for `none` — where the caller's ordinary guardrail stands.
 *
 * The salvage floor is deliberately allowed to be negative. If destroying one unit of hazardous
 * stock costs 6 PLN, handing it over for 1 PLN is 7 PLN better than scrapping it; a floor of zero
 * would quietly forbid the best available outcome.
 */
export function stageFloorPrice(
  stage: ShelfLifeStage,
  unitCostNet: Decimal,
  weightKg: Decimal | null,
  params: ShelfLifeConfig,
): Decimal | null {
  if (stage === 'none') return null
  if (stage === 'early') return minPriceForMargin(unitCostNet, params.earlyMarginPercent)
  if (stage === 'at_cost') return unitCostNet
  if (weightKg === null) return ZERO
  return -mul(weightKg, params.disposalRatePerKg)
}

function isPickable(lot: ProductLotSnapshot, asOf: Date, config: ShelfLifeConfig): boolean {
  if (lot.status !== 'available') return false
  if (toDecimal(lot.quantityAvailable) <= ZERO) return false
  const shelfLife = resolveShelfLife(lot, asOf, config.defaultShelfLifeDays)
  // Already past its date: it cannot be sold at any price, so it must not depress the blend either.
  return shelfLife === null || shelfLife.remainingDays > 0
}

/**
 * Which lots FEFO would actually consume for this quantity, and what stage each one is in.
 *
 * When the order outruns the stock the surplus becomes one `none` portion with no lot: it is priced
 * from the ordinary guardrail, because goods that are not on the shelf are not expiring either.
 */
export function allocateFefo(
  lots: ProductLotSnapshot[],
  orderedQuantity: Decimal,
  asOf: Date,
  config: ShelfLifeConfig = DEFAULT_SHELF_LIFE_CONFIG,
): ShelfLifePortion[] {
  if (orderedQuantity <= ZERO) return []

  const portions: ShelfLifePortion[] = []
  let remaining = orderedQuantity

  for (const lot of sortFefo(lots.filter((candidate) => isPickable(candidate, asOf, config)))) {
    if (remaining <= ZERO) break
    const available = toDecimal(lot.quantityAvailable)
    const quantity = min(remaining, available)
    const shelfLife = resolveShelfLife(lot, asOf, config.defaultShelfLifeDays)
    portions.push({
      lot,
      shelfLife,
      quantity,
      stage: shelfLife === null ? 'none' : resolveStage(shelfLife.remainingFraction, config),
    })
    remaining = sub(remaining, quantity)
  }

  if (remaining > ZERO) {
    portions.push({ lot: null, shelfLife: null, quantity: remaining, stage: 'none' })
  }

  return portions
}

export type ShelfLifeMarkdownArgs = {
  lots: ProductLotSnapshot[]
  orderedQuantity: Decimal
  asOf: Date
  unitCostNet: Decimal
  weightKg: Decimal | null
  /**
   * What this line would be priced at with no markdown — the running value already clamped by the
   * ordinary guardrail. The portions FEFO leaves untouched contribute exactly this, so a line that
   * happens to contain one old crate does not give away the margin the rest of it never risked.
   */
  normalUnitPrice: Decimal
  /**
   * What the goods COST TO BUY, not what they cost to serve. The write-off figure answers "what is
   * lost if nobody buys this", and unsold stock never incurs picking, packing, delivery or the
   * handling labour that `unitCostNet` has accumulated by the time the guardrail runs.
   */
  purchaseUnitCost: Decimal
  config: ShelfLifeConfig
}

export function computeShelfLifeMarkdown(args: ShelfLifeMarkdownArgs): ShelfLifeMarkdown | null {
  const allocations = allocateFefo(args.lots, args.orderedQuantity, args.asOf, args.config)
  // No lot with a near date means no markdown at all. This is the boundary that keeps the ladder
  // from degenerating into a general-purpose discount with a plausible excuse.
  const lead = allocations.find((portion) => portion.stage !== 'none' && portion.lot !== null) ?? null
  if (!lead || !lead.lot || !lead.shelfLife || lead.stage === 'none') return null

  const warnings: string[] = []
  const priced: ShelfLifePricedPortion[] = allocations.map((portion) => {
    const floor = stageFloorPrice(portion.stage, args.unitCostNet, args.weightKg, args.config)
    return { ...portion, floorUnitPrice: floor ?? args.normalUnitPrice }
  })

  let weightedTotal = ZERO
  let markdownQuantity = ZERO
  for (const portion of priced) {
    weightedTotal = add(weightedTotal, mul(portion.quantity, portion.floorUnitPrice))
    if (portion.stage !== 'none') markdownQuantity = add(markdownQuantity, portion.quantity)
  }
  const weightedFloorUnitPrice = div(weightedTotal, args.orderedQuantity)

  if (!args.config.supplied) warnings.push('pricing_engine.warnings.shelfLifeRatesAssumed')
  if (args.config.thresholdsRejected) warnings.push('pricing_engine.warnings.shelfLifeThresholdsInvalid')
  if (args.config.disposalRateRejected) warnings.push('pricing_engine.warnings.shelfLifeDisposalRateInvalid')
  if (lead.shelfLife.confidence !== 'measured') warnings.push('pricing_engine.warnings.shelfLifeLengthAssumed')
  if (priced.some((portion) => portion.stage === 'salvage') && args.weightKg === null) {
    warnings.push('pricing_engine.warnings.shelfLifeWeightMissing')
  }
  if (weightedFloorUnitPrice < args.unitCostNet) {
    warnings.push('pricing_engine.warnings.shelfLifeBelowCost')
  }

  const salvageFloorUnitPrice =
    stageFloorPrice('salvage', args.unitCostNet, args.weightKg, args.config) ?? ZERO

  return {
    weightedFloorUnitPrice,
    leadLot: lead.lot,
    leadShelfLife: lead.shelfLife,
    stage: lead.stage,
    allocations: priced,
    markdownQuantity,
    salvageFloorUnitPrice,
    disposalRatePerKg: args.config.disposalRatePerKg,
    weightKg: args.weightKg,
    // What is lost if nobody buys it: the whole lot, at what it cost to buy.
    writeOffAvoided: mul(args.purchaseUnitCost, toDecimal(lead.lot.quantityAvailable)),
    confidence: weakestConfidence(
      args.config.supplied ? 'measured' : 'default',
      lead.shelfLife.confidence,
    ),
    warnings,
  }
}

export const SHELF_LIFE_STAGE_LABEL_KEYS: Record<ShelfLifeMarkdownStage, string> = {
  early: 'pricing_engine.components.guardrails.stage.early',
  at_cost: 'pricing_engine.components.guardrails.stage.atCost',
  salvage: 'pricing_engine.components.guardrails.stage.salvage',
}

export function describeAllocation(portion: ShelfLifePricedPortion): Record<string, unknown> {
  return {
    lotId: portion.lot?.lotId ?? null,
    lotNumber: portion.lot?.lotNumber ?? null,
    expiresAt: portion.shelfLife?.expiryDate.toISOString() ?? null,
    daysRemaining: portion.shelfLife?.remainingDays ?? null,
    remainingFraction: portion.shelfLife ? money(portion.shelfLife.remainingFraction) : null,
    stage: portion.stage,
    quantity: money(portion.quantity),
    unitPrice: money(portion.floorUnitPrice),
  }
}
