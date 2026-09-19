import {
  div,
  factorToPercent,
  max,
  money,
  mul,
  ONE,
  percentToFactor,
  rate as formatRate,
  sub,
  toDecimal,
  ZERO,
} from '../decimal'
import type { Decimal } from '../decimal'
import type {
  ComponentComputeArgs,
  ComponentResult,
  GuardrailSnapshot,
  PriceComponent,
  PricingConfidence,
} from '../types'
import {
  computeShelfLifeMarkdown,
  describeAllocation,
  readShelfLifeConfig,
  SHELF_LIFE_COMPONENT_CODE,
  SHELF_LIFE_STAGE_LABEL_KEYS,
  type ShelfLifeMarkdown,
} from './shelfLife'
import { PRODUCT_COST_CODE } from './productCost'
import { DEADSTOCK_STAGE_LABEL_KEYS, resolveEffectiveFloor } from '../deadstock/markdown'
import type { AuthorisedDeadstockFloor } from '../deadstock/authorisedFloor'
import { readWeightKilograms } from './weight'

export const GUARDRAILS_CODE = 'guardrails'

// The ladder clamped the price up to its floor.
const SHELF_LIFE_APPLIED = 'shelf_life_markdown'
// The ladder is open but the price sits above its floor: nothing moved, and the seller is being
// told how far down they MAY go and what the alternative costs.
const SHELF_LIFE_HEADROOM = 'shelf_life_headroom'
// The same two states for the deadstock floor. Separate labels rather than one shared pair,
// because the seller has to be able to tell WHICH problem lowered this floor: an approaching
// expiry and fourteen months of silence call for different conversations with the customer.
const DEADSTOCK_APPLIED = 'deadstock_markdown'
const DEADSTOCK_HEADROOM = 'deadstock_headroom'

/**
 * margin = (price - cost) / price  =>  price_min = cost / (1 - margin/100).
 * Returns null at margin >= 100, where the equation has no finite solution.
 *
 * Exported so the advisor answers "lowest price still holding margin X" with the SAME formula the
 * pipeline clamps with — a floor the engine would not honour is worse than no floor at all.
 */
export function minPriceForMargin(unitCostNet: Decimal, minMarginPercent: string): Decimal | null {
  const denominator = sub(ONE, percentToFactor(minMarginPercent))
  if (denominator <= ZERO) return null
  return div(unitCostNet, denominator)
}

type NormalFloorResult = {
  price: Decimal
  applied: string | null
  minMarginEnforced: boolean
}

function applyNormalFloors(
  target: Decimal,
  guardrail: GuardrailSnapshot | null,
  unitCostNet: Decimal,
): NormalFloorResult {
  let price = target
  let applied: string | null = null
  let minMarginEnforced = false
  if (!guardrail) return { price, applied, minMarginEnforced }

  if (guardrail.floorPrice !== null) {
    const floor = toDecimal(guardrail.floorPrice)
    if (price < floor) {
      price = floor
      applied = 'floor_price'
    }
  }

  if (guardrail.minMarginPercent !== null && unitCostNet > ZERO) {
    const minPrice = minPriceForMargin(unitCostNet, guardrail.minMarginPercent)
    if (minPrice !== null && price < minPrice) {
      price = minPrice
      applied = 'min_margin'
      minMarginEnforced = true
    }
  }

  return { price, applied, minMarginEnforced }
}

/**
 * The expiry ladder lives inside the guardrail rather than beside it as a twelfth component.
 *
 * A separate component that lowered the price would have to run before position 10, where
 * `min_margin` would immediately raise it back — the markdown and the floor are the same decision
 * about the same number, so they need one owner. Returns null whenever stock is unknown or nothing
 * in it is near its date, and every caller path then behaves exactly as it did before.
 */
function resolveLadder(
  args: ComponentComputeArgs,
  normalUnitPrice: Decimal,
): ShelfLifeMarkdown | null {
  const { context, deps, line, quantity, unitCostNet } = args
  const product = deps.catalog.byProductId.get(line.productId) ?? null
  const stock = deps.inventory?.byProductId.get(line.productId) ?? null
  if (!stock || stock.lots.length === 0) return null

  const config = readShelfLifeConfig(
    deps.params.componentPayload(SHELF_LIFE_COMPONENT_CODE, {
      productId: line.productId,
      productGroupCode: product?.productGroupCode ?? null,
      customerId: context.customerId ?? null,
      customerGroupCode: context.customerGroupCode ?? null,
    }),
  )

  // `product_cost` is the purchase cost after rebate; `unitCostNet` at position 10 has already
  // accumulated labour, packaging, warehouse and delivery. The write-off figure needs the former.
  const productCostValue = args.componentValues[PRODUCT_COST_CODE]

  return computeShelfLifeMarkdown({
    lots: stock.lots,
    orderedQuantity: quantity,
    asOf: context.date,
    unitCostNet,
    purchaseUnitCost: productCostValue === undefined ? unitCostNet : toDecimal(productCostValue),
    weightKg: readWeightKilograms(product?.weightValue ?? null, product?.weightUnit ?? null).kilograms,
    normalUnitPrice,
    config,
  })
}

// Guardrails clamp rather than add or scale. They are reported as a multiplier so the waterfall
// stays one consistent shape: 1.0000 means nothing was clamped, and any other value shows exactly
// how much the clamp moved the price.
async function compute(args: ComponentComputeArgs): Promise<ComponentResult> {
  const { context, deps, line, quantity, runningUnitValue, unitCostNet } = args
  const product = deps.catalog.byProductId.get(line.productId) ?? null
  const scopeRefs = {
    productId: line.productId,
    productGroupCode: product?.productGroupCode ?? null,
    customerId: context.customerId ?? null,
    customerGroupCode: context.customerGroupCode ?? null,
  }

  const guardrail = deps.params.guardrail(scopeRefs)
  const negotiated = deps.params.negotiatedUnitPrice(line.productId)
  const warnings: string[] = []

  let target = runningUnitValue
  let applied: string | null = null

  const negotiatedWins = (guardrail?.negotiatedPricePrecedence ?? 'negotiated_wins') === 'negotiated_wins'
  const negotiatedApplied = negotiated !== null && negotiatedWins
  if (negotiatedApplied) {
    target = toDecimal(negotiated)
    applied = 'negotiated_price'
  }

  // `max_discount_percent` is recorded and echoed in `params` but deliberately NOT enforced (owner
  // decision 2026-09-19): a hard cap silently overrode legitimate negotiated prices — strategic
  // customers, competitor matching, a customer's historical price. The minimum margin below stays
  // the hard floor. See `.ai/handoff/2026-09-19-pricing-engine-guardrail-gaps.md`.
  const normal = applyNormalFloors(target, guardrail, unitCostNet)
  const ladder = resolveLadder(args, normal.price)
  // Authorised on the deadstock screen by a person, never inferred here. See `authorisedFloor.ts`.
  const authorised: AuthorisedDeadstockFloor | null =
    deps.deadstock?.byProductId.get(line.productId) ?? null

  // Two ladders, one floor. The deeper wins and they do not stack: both are permissions computed
  // from the same purchase cost, and subtracting a deadstock carry from a floor that already
  // discounted for expiry would count the same goods twice and land below cost about twice as
  // fast as either mechanism intended.
  const effective = resolveEffectiveFloor(
    ladder?.weightedFloorUnitPrice ?? null,
    authorised?.floorUnitPrice ?? null,
  )

  // What the panel prints as "the floor". All four sources go through one field, because a reader
  // that has to work out which of several optional fields is populated will get it wrong — and the
  // commonest case by far is the third and fourth here, an ordinary floor raising a price with no
  // ladder open at all.
  let floorReport: {
    source: 'shelf_life' | 'deadstock' | 'min_margin' | 'floor_price'
    unitPrice: Decimal
  } | null = null

  if (effective === null) {
    target = normal.price
    applied = normal.applied ?? applied
    if (normal.applied === 'min_margin' || normal.applied === 'floor_price') {
      floorReport = { source: normal.applied, unitPrice: normal.price }
    }
    if (normal.minMarginEnforced) warnings.push('pricing_engine.warnings.minMarginEnforced')
  } else {
    // The ladder LOWERS THE FLOOR; it does not set the price.
    //
    // The spec's table is headed "Effective floor", and that is the whole of it. A ladder that
    // assigned the price would hand a cost-price quote to every customer who happens to ask about a
    // product with one ageing crate in the warehouse — including the customer who would gladly have
    // paid full price, and for the 90% of the line that was never at risk. What an approaching
    // expiry justifies is PERMISSION to go low, exercised by a person who knows whether this deal
    // needs it. The panel states the headroom and the write-off it avoids; the seller decides.
    //
    // For the same reason the ordinary floors do not also apply here: `weightedFloorUnitPrice`
    // already blends them in for every portion that is NOT near its date, so re-applying
    // `min_margin` on top would clamp the expiring portion straight back and undo the ladder.
    const beforeLadder = target
    target = max(target, effective.floor)
    const clamped = target > beforeLadder
    applied =
      effective.source === 'deadstock'
        ? clamped
          ? DEADSTOCK_APPLIED
          : DEADSTOCK_HEADROOM
        : clamped
          ? SHELF_LIFE_APPLIED
          : SHELF_LIFE_HEADROOM
    floorReport = { source: effective.source, unitPrice: effective.floor }
    if (ladder) warnings.push(...ladder.warnings)
  }

  const factor = runningUnitValue > ZERO ? div(target, runningUnitValue) : ONE

  // Every floor still in force after the clamp, not only the one that moved the price. `rounding`
  // runs after this component and must not round below any of them; nor may the 4dp serialisation
  // of `factor` leave the price a fraction of a grosz under the floor it was clamped to.
  const floorCandidates: Decimal[] = []
  if (effective !== null) {
    floorCandidates.push(effective.floor)
  } else if (guardrail) {
    if (guardrail.floorPrice !== null) floorCandidates.push(toDecimal(guardrail.floorPrice))
    if (guardrail.minMarginPercent !== null && unitCostNet > ZERO) {
      const minPrice = minPriceForMargin(unitCostNet, guardrail.minMarginPercent)
      if (minPrice !== null) floorCandidates.push(minPrice)
    }
  }
  const roundingFloor = floorCandidates.length > 0 ? floorCandidates.reduce((acc, value) => max(acc, value)) : null
  const resultingMargin =
    target > ZERO ? factorToPercent(div(sub(target, unitCostNet), target)) : ZERO

  // What the operator forgoes by selling now, and what they forgo by not selling at all. Printed
  // side by side because a price below cost without the alternative beside it reads as a bug.
  // Deadstock has no lot allocation: the whole line is dormant, so the whole line is eligible.
  const markdownQuantity =
    effective?.source === 'deadstock' ? quantity : ladder ? ladder.markdownQuantity : ZERO
  const belowCostAmount = effective ? mul(max(ZERO, sub(unitCostNet, target)), markdownQuantity) : ZERO
  // How much the seller MAY still take off this line before hitting the expiry floor. This is the
  // number the ladder actually produces when it does not clamp, and printing it is the whole point
  // of a floor that moves: "you can go down to X" is actionable, "a floor exists" is not.
  const floorHeadroom = effective ? max(ZERO, sub(target, effective.floor)) : ZERO

  const guardrailConfidence: PricingConfidence = guardrail ? 'measured' : 'default'
  // A deadstock floor rests on assumed storage rates and an assumed pallet envelope, so it can
  // never lift this component above `estimated` no matter how solid the guardrail row is.
  const ladderConfidence: PricingConfidence | null =
    effective?.source === 'deadstock' ? 'estimated' : ladder ? ladder.confidence : null
  const confidence: PricingConfidence =
    ladderConfidence && guardrailConfidence === 'measured' ? ladderConfidence : guardrailConfidence

  return {
    code: GUARDRAILS_CODE,
    labelKey: 'pricing_engine.components.guardrails.label',
    effect: 'mul',
    value: money(factor),
    inputs: {
      priceBefore: money(runningUnitValue),
      priceAfter: money(target),
      unitCostNet: money(unitCostNet),
      negotiatedUnitPrice: negotiated,
      ...(ladder
        ? {
            orderedQuantity: money(quantity),
            normalUnitPrice: money(normal.price),
            lotAllocations: ladder.allocations.map(describeAllocation),
          }
        : {}),
    },
    params: {
      guardrailCode: guardrail?.code ?? null,
      minMarginPercent: guardrail?.minMarginPercent ?? null,
      maxDiscountPercent: guardrail?.maxDiscountPercent ?? null,
      floorPrice: guardrail?.floorPrice ?? null,
      negotiatedPricePrecedence: guardrail?.negotiatedPricePrecedence ?? null,
      ...(roundingFloor !== null ? { roundingFloorUnitPrice: money(roundingFloor) } : {}),
      // Scalars only: the assumptions panel renders this map as dt/dd pairs, so the lot-by-lot
      // detail goes to `inputs` and the headline figures stay readable here.
      ...(ladder
        ? {
            shelfLifeStage: ladder.stage,
            shelfLifeStageLabelKey: SHELF_LIFE_STAGE_LABEL_KEYS[ladder.stage],
            leadLotId: ladder.leadLot.lotId,
            leadLotNumber: ladder.leadLot.lotNumber,
            leadLotExpiresAt: ladder.leadShelfLife.expiryDate.toISOString(),
            leadLotDaysRemaining: ladder.leadShelfLife.remainingDays,
            markdownQuantity: money(ladder.markdownQuantity),
            disposalRatePerKg: money(ladder.disposalRatePerKg),
            weightKg: ladder.weightKg === null ? null : money(ladder.weightKg),
            salvageFloorUnitPrice: money(ladder.salvageFloorUnitPrice),
            shelfLifeFloorUnitPrice: money(ladder.weightedFloorUnitPrice),
            floorHeadroomPerUnit: money(floorHeadroom),
            belowCostAmount: money(belowCostAmount),
            writeOffAvoided: money(ladder.writeOffAvoided),
          }
        : {}),
      // Which floor actually bound the price, always printed when any floor is open. Two
      // mechanisms with the same semantics and different causes produce, without this label, a
      // number the seller cannot account for.
      ...(floorReport
        ? {
            effectiveFloorSource: floorReport.source,
            effectiveFloorUnitPrice: money(floorReport.unitPrice),
            floorHeadroomPerUnit: money(floorHeadroom),
          }
        : {}),
      ...(authorised
        ? {
            deadstockStage: authorised.stage,
            deadstockStageLabelKey: DEADSTOCK_STAGE_LABEL_KEYS[authorised.stage],
            deadstockFloorUnitPrice: money(authorised.floorUnitPrice),
            deadstockDecisionId: authorised.decisionId,
            deadstockDecidedAt: authorised.decidedAt.toISOString(),
          }
        : {}),
    },
    explainKey: explainKeyFor(applied),
    explainValues: {
      priceBefore: money(runningUnitValue),
      priceAfter: money(target),
      marginPercent: formatRate(resultingMargin),
      currency: context.currencyCode,
      ...(effective
        ? {
            floorUnitPrice: money(effective.floor),
            floorHeadroomPerUnit: money(floorHeadroom),
            belowCostAmount: money(belowCostAmount),
          }
        : {}),
      ...(authorised
        ? {
            deadstockStage: authorised.stage,
            decidedAt: authorised.decidedAt.toISOString(),
          }
        : {}),
      ...(ladder
        ? {
            lotNumber: ladder.leadLot.lotNumber,
            daysRemaining: ladder.leadShelfLife.remainingDays,
            floorUnitPrice: money(ladder.weightedFloorUnitPrice),
            floorHeadroomPerUnit: money(floorHeadroom),
            belowCostAmount: money(belowCostAmount),
            writeOffAvoided: money(ladder.writeOffAvoided),
            markdownQuantity: money(ladder.markdownQuantity),
          }
        : {}),
    },
    confidence,
    warnings,
  }
}

const EXPLAIN_KEYS: Record<string, string> = {
  [SHELF_LIFE_APPLIED]: 'pricing_engine.components.guardrails.explain.shelfLifeMarkdown',
  [SHELF_LIFE_HEADROOM]: 'pricing_engine.components.guardrails.explain.shelfLifeHeadroom',
  [DEADSTOCK_APPLIED]: 'pricing_engine.components.guardrails.explain.deadstockMarkdown',
  [DEADSTOCK_HEADROOM]: 'pricing_engine.components.guardrails.explain.deadstockHeadroom',
}

function explainKeyFor(applied: string | null): string {
  if (!applied) return 'pricing_engine.components.guardrails.explain.none'
  return EXPLAIN_KEYS[applied] ?? `pricing_engine.components.guardrails.explain.${applied}`
}

export const guardrailsComponent: PriceComponent = {
  code: GUARDRAILS_CODE,
  position: 10,
  level: 'line',
  effect: 'mul',
  labelKey: 'pricing_engine.components.guardrails.label',
  contributesToCost: false,
  compute,
}
