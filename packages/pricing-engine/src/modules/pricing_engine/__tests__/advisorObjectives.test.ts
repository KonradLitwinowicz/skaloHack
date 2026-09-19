import { money, toDecimal } from '../lib/decimal'
import {
  measureObjectiveMetrics,
  normaliseObjectiveDelta,
  objectiveCreateSchema,
  rankByObjectives,
  readObjectives,
  scoreObjectives,
  OBJECTIVE_WEIGHTS_COMPONENT_CODE,
  type ObjectiveMeasurement,
  type PricingObjective,
} from '../lib/advisor/objectives'
import { buildSuggestion, type AdvisorRun, type SuggestionDraft } from '../lib/advisor/runner'
import { generateVolumeThresholdSuggestions } from '../lib/advisor/suggestions/volumeThreshold'
import { priceWithInputs, type PricingInputs } from '../services/pricingService'
import type { Suggestion } from '../lib/advisor/schemas'
import type { PricingBasketLine, PricingContext } from '../lib/types'
import { buildContext, buildDeps, PRODUCT_ID } from './fixtures'

const SCENARIO_CODES = ['ideal_file', 'nonstandard_file', 'email', 'sms', 'phone', 'rep_visit']

type LookupOverrides = NonNullable<Parameters<typeof buildDeps>[0]>['lookup']

async function buildRun(options: { lookup?: LookupOverrides; context?: Partial<PricingContext> } = {}) {
  const deps = buildDeps({ lookup: options.lookup })
  const inputs: PricingInputs = {
    supplier: deps.supplier,
    params: deps.params,
    catalog: deps.catalog,
    indicators: deps.indicators,
    customerProfile: null,
    orderScenarioCodes: SCENARIO_CODES,
  }
  const context = buildContext({ customerId: null, ...options.context })
  const price = (lines: PricingBasketLine[]) => priceWithInputs({ ...context, lines }, inputs)
  const run: AdvisorRun = {
    context,
    baseline: await price(context.lines),
    inputs,
    price,
    options: {},
  }
  return run
}

/** A draft whose "after" side is the same basket at a different quantity — a real before/after pair. */
async function buildDraft(run: AdvisorRun, toQuantity: string): Promise<SuggestionDraft> {
  const variant = await run.price([{ ...run.context.lines[0], quantity: toQuantity }])
  return {
    code: 'volume_threshold',
    anchorLine: run.baseline.lines[0],
    variant,
    variantLine: variant.lines[0],
    change: { productId: PRODUCT_ID, fromQuantity: run.context.lines[0].quantity, toQuantity },
    explainKey: 'pricing_engine.advisor.suggestion.volumeThreshold.explain',
    explainValues: {},
  }
}

function objective(overrides: Partial<PricingObjective> = {}): PricingObjective {
  return {
    code: 'profit',
    label: 'Profit',
    metric: 'profitNet',
    direction: 'maximise',
    weight: '10',
    ...overrides,
  }
}

function measurement(pairs: Partial<Record<keyof ObjectiveMeasurement, [string, string]>>): ObjectiveMeasurement {
  const zero = { before: toDecimal('0'), after: toDecimal('0') }
  const base: ObjectiveMeasurement = {
    marginPercent: zero,
    profitNet: zero,
    revenueNet: zero,
    unitCostNet: zero,
    productCost: zero,
    operationalCost: zero,
    packagingCost: zero,
    warehouseCost: zero,
    logisticsCost: zero,
  }
  for (const [metric, pair] of Object.entries(pairs)) {
    if (!pair) continue
    base[metric as keyof ObjectiveMeasurement] = { before: toDecimal(pair[0]), after: toDecimal(pair[1]) }
  }
  return base
}

function suggestion(overrides: Partial<Suggestion>): Suggestion {
  return {
    code: 'volume_threshold',
    titleKey: 'pricing_engine.advisor.suggestion.volumeThreshold.title',
    subject: null,
    explainKey: 'pricing_engine.advisor.suggestion.volumeThreshold.explain',
    explainValues: {},
    breakEvenConditionKey: 'pricing_engine.advisor.breakEven.volumeThreshold',
    change: {},
    customerUnitPriceBefore: '166.0000',
    customerUnitPriceAfter: '156.0000',
    supplierProfitBefore: '66.0000',
    supplierProfitAfter: '60.0000',
    basketProfitBefore: '1584.0000',
    basketProfitAfter: '1800.0000',
    supplierMarginPercentBefore: '39.7590',
    supplierMarginPercentAfter: '38.4615',
    profitNeutralUnitPrice: '156.0000',
    guardrailFloorUnitPrice: null,
    confidence: 'measured',
    raisesCustomerPrice: false,
    objectiveScore: null,
    ...overrides,
  }
}

describe('objective payload', () => {
  it('reads a well-formed payload off a component param row', () => {
    const objectives = readObjectives({
      objectives: [
        { code: 'volume', label: 'Share of wallet', metric: 'revenueNet', direction: 'maximise', weight: '45' },
      ],
    })
    expect(objectives).toEqual([
      { code: 'volume', label: 'Share of wallet', metric: 'revenueNet', direction: 'maximise', weight: '45' },
    ])
  })

  it('yields nothing rather than throwing on a payload the operator cannot have produced', () => {
    expect(readObjectives({ objectives: [{ code: 'x', label: 'X', metric: 'karma', direction: 'up' }] })).toEqual([])
    expect(readObjectives(null)).toEqual([])
    expect(readObjectives({})).toEqual([])
  })

  it('rejects a scoped rule with nothing to point at, and duplicate objective codes', () => {
    const base = {
      objectives: [objective()],
      changeNote: 'because',
      validFrom: '2026-01-01',
    }
    expect(objectiveCreateSchema.safeParse({ ...base, scope: 'customer_group' }).success).toBe(false)
    expect(objectiveCreateSchema.safeParse({ ...base, scope: 'global' }).success).toBe(true)
    expect(
      objectiveCreateSchema.safeParse({
        ...base,
        scope: 'global',
        objectives: [objective(), objective({ label: 'Other' })],
      }).success,
    ).toBe(false)
  })
})

describe('normalisation', () => {
  it('scales a move against the before-value so metrics of different units compare', () => {
    // +10 on a base of 100 and +2 on a base of 20 are both a fifth... of their own base.
    expect(money(normaliseObjectiveDelta(toDecimal('100'), toDecimal('110'), 'maximise'))).toBe('0.1000')
    expect(money(normaliseObjectiveDelta(toDecimal('20'), toDecimal('22'), 'maximise'))).toBe('0.1000')
  })

  it('flips the sign for a minimise objective', () => {
    expect(money(normaliseObjectiveDelta(toDecimal('100'), toDecimal('90'), 'minimise'))).toBe('0.1000')
    expect(money(normaliseObjectiveDelta(toDecimal('100'), toDecimal('110'), 'minimise'))).toBe('-0.1000')
  })

  it('does not divide by a before-value of zero', () => {
    expect(money(normaliseObjectiveDelta(toDecimal('0'), toDecimal('0'), 'maximise'))).toBe('0.0000')
    expect(money(normaliseObjectiveDelta(toDecimal('0'), toDecimal('12.5'), 'maximise'))).toBe('1.0000')
    expect(money(normaliseObjectiveDelta(toDecimal('0'), toDecimal('12.5'), 'minimise'))).toBe('-1.0000')
  })
})

describe('scoring', () => {
  it('returns null when the operator configured nothing', () => {
    expect(scoreObjectives([], measurement({ profitNet: ['100', '200'] }))).toBeNull()
  })

  it('contributions sum to the total times the total weight', () => {
    const score = scoreObjectives(
      [
        objective({ code: 'profit', metric: 'profitNet', weight: '60' }),
        objective({ code: 'margin', metric: 'marginPercent', weight: '40' }),
      ],
      measurement({ profitNet: ['1000', '1100'], marginPercent: ['40', '38'] }),
    )
    expect(score).not.toBeNull()
    const contributions = score!.contributions
    expect(contributions.map((entry) => entry.code)).toEqual(['profit', 'margin'])
    expect(contributions[0].normalised).toBe('0.1000')
    expect(contributions[0].contribution).toBe('6.0000')
    expect(contributions[1].normalised).toBe('-0.0500')
    expect(contributions[1].contribution).toBe('-2.0000')

    const summed = contributions.reduce((total, entry) => total + Number(entry.contribution), 0)
    expect(Number(score!.total) * 100).toBeCloseTo(summed, 6)
  })

  it('treats a weight of zero as switched off without dropping the row', () => {
    const disabled = scoreObjectives(
      [objective({ weight: '0' }), objective({ code: 'margin', metric: 'marginPercent', weight: '40' })],
      measurement({ profitNet: ['1000', '9000'], marginPercent: ['40', '44'] }),
    )
    const withoutDisabled = scoreObjectives(
      [objective({ code: 'margin', metric: 'marginPercent', weight: '40' })],
      measurement({ profitNet: ['1000', '9000'], marginPercent: ['40', '44'] }),
    )
    expect(disabled!.total).toBe(withoutDisabled!.total)
    expect(disabled!.contributions).toHaveLength(2)
    expect(disabled!.contributions[0].contribution).toBe('0.0000')
  })

  it('does not divide by a total weight of zero', () => {
    const score = scoreObjectives(
      [objective({ weight: '0' }), objective({ code: 'margin', metric: 'marginPercent', weight: '0' })],
      measurement({ profitNet: ['1000', '9000'], marginPercent: ['40', '90'] }),
    )
    expect(score!.total).toBe('0.0000')
    expect(score!.contributions).toHaveLength(2)
  })
})

describe('ranking', () => {
  const cheaper = suggestion({ code: 'cheaper_equivalent', customerUnitPriceAfter: '120.0000' })
  const bigger = suggestion({ code: 'volume_threshold', customerUnitPriceAfter: '156.0000' })

  it('keeps the order untouched when no objective is configured', () => {
    const input = [cheaper, bigger]
    expect(rankByObjectives(input).map((entry) => entry.code)).toEqual(['cheaper_equivalent', 'volume_threshold'])
    expect(rankByObjectives([bigger, cheaper]).map((entry) => entry.code)).toEqual([
      'volume_threshold',
      'cheaper_equivalent',
    ])
  })

  it('promotes the suggestion that earns more when the objective maximises profit', () => {
    const objectives = [objective({ metric: 'profitNet', direction: 'maximise', weight: '100' })]
    const lowProfit = { ...cheaper, objectiveScore: scoreObjectives(objectives, measurement({ profitNet: ['1000', '1010'] })) }
    const highProfit = { ...bigger, objectiveScore: scoreObjectives(objectives, measurement({ profitNet: ['1000', '1400'] })) }

    expect(rankByObjectives([lowProfit, highProfit]).map((entry) => entry.code)).toEqual([
      'volume_threshold',
      'cheaper_equivalent',
    ])
  })

  it('promotes the cheaper-to-serve suggestion when the objective minimises unit cost', () => {
    const objectives = [objective({ code: 'cost', metric: 'unitCostNet', direction: 'minimise', weight: '100' })]
    const costFalls = { ...cheaper, objectiveScore: scoreObjectives(objectives, measurement({ unitCostNet: ['100', '80'] })) }
    const costRises = { ...bigger, objectiveScore: scoreObjectives(objectives, measurement({ unitCostNet: ['100', '104'] })) }

    expect(rankByObjectives([costRises, costFalls]).map((entry) => entry.code)).toEqual([
      'cheaper_equivalent',
      'volume_threshold',
    ])
  })
})

describe('guardrails outrank weights', () => {
  // Not by a filter in the objectives layer — by the pipeline itself. Every suggestion is priced by
  // a full run through the `guardrails` component, so an illegal price cannot be produced in the
  // first place. This test proves the guarantee on a REAL priced run rather than on a fixture,
  // because a fixture could assert the property of a mock instead of the property of the engine.
  it('cannot produce a suggestion priced below the floor the engine enforces', async () => {
    const run = await buildRun()
    const suggestions = await generateVolumeThresholdSuggestions(run)

    expect(suggestions.length).toBeGreaterThan(0)
    for (const entry of suggestions) {
      if (entry.guardrailFloorUnitPrice === null) continue
      expect(Number(entry.customerUnitPriceAfter)).toBeGreaterThanOrEqual(
        Number(entry.guardrailFloorUnitPrice),
      )
    }
  })

  // A weight cannot buy its way past the floor, because the floor was applied before the weight was
  // ever read: scoring only reorders a list every member of which is already legal.
  it('reorders only legal suggestions, whatever the weights say', async () => {
    const run = await buildRun()
    const suggestions = await generateVolumeThresholdSuggestions(run)
    const ranked = rankByObjectives(suggestions)

    expect(ranked).toHaveLength(suggestions.length)
    expect([...ranked].sort()).toEqual([...suggestions].sort())
  })
})

describe('measuring a real before/after pair', () => {
  it('reads every metric off two priced runs', async () => {
    const run = await buildRun()
    const draft = await buildDraft(run, '48')
    const measured = measureObjectiveMetrics({
      anchorLine: draft.anchorLine,
      variantLine: draft.variantLine,
      beforeRuns: [run.baseline],
      afterRuns: [draft.variant],
      basketProfitBefore: toDecimal('0'),
      basketProfitAfter: toDecimal('0'),
    })

    // Doubling the quantity spreads the per-order handling over twice the units, so the labour
    // component per unit must fall while revenue rises.
    expect(measured.operationalCost.after).toBeLessThan(measured.operationalCost.before)
    expect(measured.revenueNet.after).toBeGreaterThan(measured.revenueNet.before)
    expect(measured.productCost.before).toBeGreaterThan(toDecimal('0'))
    expect(measured.unitCostNet.after).toBeLessThan(measured.unitCostNet.before)
  })

  it('leaves objectiveScore null on a tenant that configured none', async () => {
    const run = await buildRun()
    const built = buildSuggestion(run, await buildDraft(run, '48'))
    expect(built.objectiveScore).toBeNull()
  })

  it('scores a suggestion against objectives stored under the synthetic component code', async () => {
    const run = await buildRun({
      lookup: {
        componentPayloads: {
          [OBJECTIVE_WEIGHTS_COMPONENT_CODE]: {
            objectives: [
              { code: 'cost', label: 'Cost to serve', metric: 'unitCostNet', direction: 'minimise', weight: '100' },
            ],
          },
        },
      },
    })
    const built = buildSuggestion(run, await buildDraft(run, '48'))

    expect(built.objectiveScore).not.toBeNull()
    expect(built.objectiveScore!.contributions).toHaveLength(1)
    expect(built.objectiveScore!.contributions[0].metric).toBe('unitCostNet')
    // Unit cost falls with the larger quantity, and the objective wants it to fall.
    expect(Number(built.objectiveScore!.total)).toBeGreaterThan(0)
  })
})
