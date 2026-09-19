import { implementedComponents } from '../lib/components'
import { operationalCostBaseComponent } from '../lib/components/operationalCostBase'
import { money, sub, toDecimal, ZERO } from '../lib/decimal'
import { runPipeline } from '../lib/pipeline'
import {
  DEMO_ORDER_SCENARIOS,
  REPEAT_ORDER_MULTIPLIER_BAND,
  REPEAT_ORDER_SCENARIO_CODE,
} from '../lib/seedDefaults'
import { buildContext, buildDeps } from './fixtures'
import type { ComponentComputeArgs } from '../lib/types'

const CHEAPEST_MEASURED_CHANNEL = 'ideal_file'

// 6 min of sales-rep time at 85.00 PLN/h loaded with 22% overhead, at multiplier 1.00.
const INTAKE_COST_AT_UNIT_MULTIPLIER = 10.37

function scenario(code: string) {
  const row = DEMO_ORDER_SCENARIOS.find((entry) => entry.code === code)
  if (!row) throw new Error(`[internal] no seeded scenario ${code}`)
  return row
}

function multiplierOf(code: string, stepCode: string): number {
  const multipliers: Record<string, string> = { ...scenario(code).stepMultipliers }
  return Number(multipliers[stepCode] ?? '1')
}

function computeArgs(scenarioCode: string): ComponentComputeArgs {
  const context = buildContext({ orderScenarioCode: scenarioCode })
  return {
    context,
    lineIndex: 0,
    line: context.lines[0],
    quantity: toDecimal('24'),
    runningUnitValue: ZERO,
    unitCostNet: ZERO,
    componentValues: {},
    deps: buildDeps(),
  }
}

describe('repeat_order scenario', () => {
  it('ships with both multipliers inside the declared band', () => {
    const repeat = scenario(REPEAT_ORDER_SCENARIO_CODE)
    const multipliers: Record<string, string> = { ...repeat.stepMultipliers }

    for (const [stepCode, band] of Object.entries(REPEAT_ORDER_MULTIPLIER_BAND)) {
      const configured = Number(multipliers[stepCode])
      expect(Number.isFinite(configured)).toBe(true)
      expect(configured).toBeGreaterThanOrEqual(Number(band.min))
      expect(configured).toBeLessThanOrEqual(Number(band.max))
    }

    // Both steps are scaled down; a repeat order is never allowed to cost MORE to handle.
    expect(multiplierOf(REPEAT_ORDER_SCENARIO_CODE, 'order_intake')).toBeLessThan(
      multiplierOf(CHEAPEST_MEASURED_CHANNEL, 'order_intake'),
    )
    expect(multiplierOf(REPEAT_ORDER_SCENARIO_CODE, 'picking')).toBeLessThan(1)
  })

  it('keeps the intake saving smaller than the whole intake cost of the cheapest measured channel', () => {
    // The guard that fixes the multiplier. Against `ideal_file` the scenario removes
    // (0.35 - 0.25) x 10.37 = 1.0370 PLN, well under that channel's own 3.6295 PLN of intake work.
    // Against `email` (1.30) the same multiplier would remove 10.8885 PLN — three times the whole
    // cheapest measurement — which is why eligibility is restricted to the structured-file channel.
    const cheapestChannelIntakeCost =
      multiplierOf(CHEAPEST_MEASURED_CHANNEL, 'order_intake') * INTAKE_COST_AT_UNIT_MULTIPLIER
    const saving =
      (multiplierOf(CHEAPEST_MEASURED_CHANNEL, 'order_intake') -
        multiplierOf(REPEAT_ORDER_SCENARIO_CODE, 'order_intake')) *
      INTAKE_COST_AT_UNIT_MULTIPLIER

    expect(saving).toBeGreaterThan(0)
    expect(saving).toBeLessThan(cheapestChannelIntakeCost)

    const emailSaving =
      (multiplierOf('email', 'order_intake') -
        multiplierOf(REPEAT_ORDER_SCENARIO_CODE, 'order_intake')) *
      INTAKE_COST_AT_UNIT_MULTIPLIER
    expect(emailSaving).toBeGreaterThan(cheapestChannelIntakeCost)
  })

  it('lowers operational_cost_base against every seeded ordering channel', async () => {
    const repeat = await operationalCostBaseComponent.compute(computeArgs(REPEAT_ORDER_SCENARIO_CODE))

    for (const channel of DEMO_ORDER_SCENARIOS) {
      if (channel.code === REPEAT_ORDER_SCENARIO_CODE) continue
      const baseline = await operationalCostBaseComponent.compute(computeArgs(channel.code))
      expect(Number(repeat.value)).toBeLessThan(Number(baseline.value))
    }
  })

  it('removes exactly the intake and picking labour it claims to remove', async () => {
    const repeat = await operationalCostBaseComponent.compute(computeArgs(REPEAT_ORDER_SCENARIO_CODE))
    const structured = await operationalCostBaseComponent.compute(computeArgs(CHEAPEST_MEASURED_CHANNEL))

    // Line cost 16.0125 -> 14.7315: intake 3.6295 -> 2.5925 and picking 2.4400 -> 2.1960,
    // spread over the fixture's 24 units.
    expect(structured.value).toBe('0.6672')
    expect(repeat.value).toBe('0.6138')
    expect(money(sub(toDecimal(structured.value), toDecimal(repeat.value)))).toBe('0.0534')
  })

  it('cuts the price without cutting the percentage margin', async () => {
    const structured = await runPipeline(
      buildContext({ orderScenarioCode: CHEAPEST_MEASURED_CHANNEL }),
      implementedComponents,
      buildDeps(),
    )
    const repeat = await runPipeline(
      buildContext({ orderScenarioCode: REPEAT_ORDER_SCENARIO_CODE }),
      implementedComponents,
      buildDeps(),
    )

    const structuredLine = structured.lines[0]
    const repeatLine = repeat.lines[0]

    expect(Number(repeatLine.unitCostNet)).toBeLessThan(Number(structuredLine.unitCostNet))
    expect(Number(repeatLine.unitPriceNet)).toBeLessThan(Number(structuredLine.unitPriceNet))

    // The whole point of routing this through cost rather than through a discount: the percentage
    // margin survives. Tolerance, not equality — `rounding` snaps the price to a fixed 0.01 step
    // afterwards, so the ratio twitches in the third decimal of a percentage point.
    expect(Number(repeatLine.marginPercent)).toBeCloseTo(Number(structuredLine.marginPercent), 1)
    expect(Number(repeatLine.markupPercent)).toBeCloseTo(Number(structuredLine.markupPercent), 1)
  })
})
