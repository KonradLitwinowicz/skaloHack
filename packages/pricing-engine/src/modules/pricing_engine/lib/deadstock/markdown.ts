import { max, money, mul, sub, toDecimal, ZERO } from '../decimal'
import type { Decimal } from '../decimal'
import { minPriceForMargin } from '../components/guardrails'
import type { PricingConfidence } from '../types'
import { forwardCarry, forwardCarryPerUnit, type CarryingCost } from './carryingCost'
import type { DeadstockClass, DeadstockSuppression } from './classify'
import type { DeadstockPolicy } from './policy'

/** The rungs that move a floor. `slow` is a warning, not yet a licence to discount. */
export type DeadstockMarkdownStage = 'dying' | 'dead' | 'never_sold'

export const DEADSTOCK_STAGE_LABEL_KEYS: Record<DeadstockMarkdownStage, string> = {
  dying: 'pricing_engine.deadstock.stage.dying',
  dead: 'pricing_engine.deadstock.stage.dead',
  never_sold: 'pricing_engine.deadstock.stage.neverSold',
}

export type DeadstockMarkdown = {
  stage: DeadstockMarkdownStage
  /** How low this product may go. Not a price — a permission. */
  floorUnitPrice: Decimal
  horizonMonths: Decimal
  forwardCarryPerUnit: Decimal
  /** Carry the whole position stops burning if it clears within the horizon. */
  carryingCostAvoided: Decimal
  /** Per unit, how far the floor sits below purchase cost. Zero when it does not. */
  belowCostPerUnit: Decimal
  confidence: PricingConfidence
  warnings: string[]
}

/**
 * The floor a dormant position justifies.
 *
 * ## Why this may sit below purchase cost, and by exactly how much
 *
 * Purchase cost is sunk: it is the same number whether the goods sell today, sell in a year, or are
 * skipped. What is NOT sunk is the carry — rent and frozen capital keep accruing for as long as the
 * pallet stands there. Selling today at `cost − carry over the clearing horizon` therefore leaves
 * the distributor exactly as well off as holding the goods for that horizon and selling at cost,
 * and strictly better off than the far likelier outcome of holding them and writing them off. The
 * forward carry is the entire licence to go below cost, which is why the floor is bounded by it and
 * by nothing else.
 *
 * ## Why `slow` gets no rung
 *
 * Slow-moving stock is selling, only too much of it was bought. Discounting it destroys margin on
 * demand that was going to arrive anyway. Slow belongs on the screen as a purchasing signal, not as
 * a markdown.
 *
 * ## Why a suppressed row gets no rung
 *
 * A verdict withheld because the product is new, out of season, or already judged by a human is not
 * a verdict. Granting the discount anyway would make the suppressors cosmetic.
 */
export type DeadstockMarkdownArgs = {
  productClass: DeadstockClass
  suppression: DeadstockSuppression | null
  /** Fully loaded cost to serve at the guardrail position — what a margin is measured against. */
  unitCostNet: Decimal
  /** Purchase cost after rebate. The sunk money, and the base the below-cost figure is read from. */
  purchaseUnitCost: Decimal
  onHandQuantity: Decimal
  carrying: CarryingCost
  policy: DeadstockPolicy
}

function stageOf(productClass: DeadstockClass): DeadstockMarkdownStage | null {
  if (productClass === 'dying' || productClass === 'dead' || productClass === 'never_sold') {
    return productClass
  }
  return null
}

export function computeDeadstockMarkdown(args: DeadstockMarkdownArgs): DeadstockMarkdown | null {
  const { policy, carrying, purchaseUnitCost, unitCostNet, onHandQuantity } = args
  if (args.suppression !== null) return null

  const stage = stageOf(args.productClass)
  if (stage === null) return null

  const warnings = [...carrying.warnings]

  if (stage === 'dying') {
    // The shallow rung: demand is fading, not gone, so the goods still have to earn something. A
    // real margin over the cost to serve, not over the purchase price — picking, packing and
    // delivering a dying product costs the same as delivering a healthy one.
    const floor = minPriceForMargin(unitCostNet, policy.dyingMarginPercent)
    if (floor === null) {
      warnings.push('pricing_engine.deadstock.warnings.marginUnreachable')
      return null
    }
    const horizon = policy.clearHorizonMonths
    return {
      stage,
      floorUnitPrice: floor,
      horizonMonths: horizon,
      forwardCarryPerUnit: forwardCarryPerUnit(carrying, horizon),
      carryingCostAvoided: forwardCarry(carrying, horizon),
      belowCostPerUnit: ZERO,
      confidence: carrying.confidence,
      warnings,
    }
  }

  const horizon = stage === 'never_sold' ? policy.neverSoldHorizonMonths : policy.clearHorizonMonths
  const carryPerUnit = forwardCarryPerUnit(carrying, horizon)
  // Clamped at zero: giving goods away is a disposal decision with its own arithmetic, and the
  // shelf-life ladder already owns the one case where a negative price is rational — hazardous
  // waste whose disposal costs more than the goods are worth.
  const floor = max(ZERO, sub(purchaseUnitCost, carryPerUnit))

  if (floor === ZERO) {
    warnings.push('pricing_engine.deadstock.warnings.floorClampedAtZero')
  }

  return {
    stage,
    floorUnitPrice: floor,
    horizonMonths: horizon,
    forwardCarryPerUnit: carryPerUnit,
    carryingCostAvoided: forwardCarry(carrying, horizon),
    belowCostPerUnit: max(ZERO, sub(purchaseUnitCost, floor)),
    confidence: carrying.confidence,
    warnings,
  }
}

/** Money recovered if the whole position cleared at its floor. The screen's "recoverable" total. */
export function recoverableAtFloor(markdown: DeadstockMarkdown | null, onHandQuantity: Decimal): Decimal {
  if (!markdown) return ZERO
  return mul(markdown.floorUnitPrice, onHandQuantity)
}

export function describeMarkdown(markdown: DeadstockMarkdown): Record<string, string> {
  return {
    stage: markdown.stage,
    stageLabelKey: DEADSTOCK_STAGE_LABEL_KEYS[markdown.stage],
    floorUnitPrice: money(markdown.floorUnitPrice),
    horizonMonths: money(markdown.horizonMonths),
    forwardCarryPerUnit: money(markdown.forwardCarryPerUnit),
    carryingCostAvoided: money(markdown.carryingCostAvoided),
    belowCostPerUnit: money(markdown.belowCostPerUnit),
  }
}

/**
 * Which of two open floors the engine should honour, and why it is the lower one.
 *
 * Both ladders grant permission, and permissions do not add up. Stacking them would compound two
 * discounts computed from the same purchase cost and land below cost roughly twice as fast as
 * either mechanism intended — the shelf-life ladder already weights its write-off by the share of
 * stock near its date, and subtracting a full deadstock carry from that result would be counting
 * the same goods twice. The deeper floor therefore wins outright: a product that is both dormant
 * and about to expire has two independent reasons to be cleared, and the stronger reason sets the
 * limit while the weaker one adds nothing.
 *
 * The caller must still report WHICH floor bound the price. Two mechanisms with the same semantics
 * and different causes produce, without a label, a number nobody can account for.
 */
export function resolveEffectiveFloor(
  shelfLifeFloor: Decimal | null,
  deadstockFloor: Decimal | null,
): { floor: Decimal; source: 'shelf_life' | 'deadstock' } | null {
  if (shelfLifeFloor === null && deadstockFloor === null) return null
  if (shelfLifeFloor === null) return { floor: deadstockFloor as Decimal, source: 'deadstock' }
  if (deadstockFloor === null) return { floor: shelfLifeFloor, source: 'shelf_life' }
  return deadstockFloor < shelfLifeFloor
    ? { floor: deadstockFloor, source: 'deadstock' }
    : { floor: shelfLifeFloor, source: 'shelf_life' }
}

export function toDecimalOrZero(value: string | null | undefined): Decimal {
  return value ? toDecimal(value) : ZERO
}
