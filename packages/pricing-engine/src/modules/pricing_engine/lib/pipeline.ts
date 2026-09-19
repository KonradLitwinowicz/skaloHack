import {
  add,
  div,
  factorToPercent,
  money,
  mul,
  ONE,
  quantizeMoney,
  rate as formatRate,
  sub,
  toDecimal,
  ZERO,
} from './decimal'
import type {
  ComponentDeps,
  ComponentResult,
  PriceComponent,
  PricingContext,
  PricingLineResult,
} from './types'

export type PipelineRunResult = {
  lines: PricingLineResult[]
  totalNet: string
  totalCostNet: string
  totalMarkupPercent: string
  totalMarginPercent: string
  warnings: string[]
}

function sortComponents(components: PriceComponent[]): PriceComponent[] {
  return [...components].sort((left, right) => left.position - right.position)
}

// Line net value shares, used to attribute per-order and logistics costs (owner decision Q5).
// Computed from the pre-pipeline cost estimate so the allocation does not depend on the very
// components it feeds; falls back to an equal split when no cost is known yet.
export function buildAllocation(context: PricingContext, unitCostByLine: string[]): string[] {
  const lineValues = context.lines.map((line, index) =>
    mul(toDecimal(unitCostByLine[index] ?? '0'), toDecimal(line.quantity)),
  )
  const total = lineValues.reduce((acc, value) => add(acc, value), ZERO)
  if (total <= ZERO) {
    const equalShare = context.lines.length > 0 ? div(ONE, toDecimal(String(context.lines.length))) : ZERO
    return context.lines.map(() => money(equalShare))
  }
  return lineValues.map((value) => money(div(value, total)))
}

export async function runPipeline(
  context: PricingContext,
  components: PriceComponent[],
  deps: ComponentDeps,
): Promise<PipelineRunResult> {
  const ordered = sortComponents(components)
  const lines: PricingLineResult[] = []
  const aggregateWarnings = new Set<string>()

  let totalNet = ZERO
  let totalCostNet = ZERO

  for (let lineIndex = 0; lineIndex < context.lines.length; lineIndex += 1) {
    const line = context.lines[lineIndex]
    const quantity = toDecimal(line.quantity)
    const breakdown: ComponentResult[] = []
    const lineWarnings: string[] = []

    let runningUnitValue = ZERO
    let unitCostNet = ZERO
    const componentValues: Record<string, string> = {}

    for (const component of ordered) {
      const result = await component.compute({
        context,
        lineIndex,
        line,
        quantity,
        runningUnitValue,
        unitCostNet,
        componentValues,
        priorResults: breakdown,
        deps,
      })

      const value = toDecimal(result.value)
      const previous = runningUnitValue
      runningUnitValue = quantizeMoney(
        result.effect === 'add' ? add(previous, value) : mul(previous, value),
      )

      if (component.contributesToCost) {
        unitCostNet = quantizeMoney(
          result.effect === 'add' ? add(unitCostNet, value) : mul(unitCostNet, value),
        )
      }

      componentValues[result.code] = result.value

      for (const warning of result.warnings ?? []) {
        lineWarnings.push(warning)
        aggregateWarnings.add(warning)
      }

      breakdown.push(result)
    }

    const unitPriceNet = runningUnitValue
    const totalPriceNet = quantizeMoney(mul(unitPriceNet, quantity))
    const markupPercent =
      unitCostNet > ZERO ? factorToPercent(div(sub(unitPriceNet, unitCostNet), unitCostNet)) : ZERO
    const marginPercent =
      unitPriceNet > ZERO ? factorToPercent(div(sub(unitPriceNet, unitCostNet), unitPriceNet)) : ZERO

    totalNet = add(totalNet, totalPriceNet)
    totalCostNet = add(totalCostNet, quantizeMoney(mul(unitCostNet, quantity)))

    lines.push({
      line,
      unitPriceNet: money(unitPriceNet),
      totalPriceNet: money(totalPriceNet),
      unitCostNet: money(unitCostNet),
      markupPercent: formatRate(markupPercent),
      marginPercent: formatRate(marginPercent),
      breakdown,
      warnings: lineWarnings,
    })
  }

  const totalMarkupPercent =
    totalCostNet > ZERO ? factorToPercent(div(sub(totalNet, totalCostNet), totalCostNet)) : ZERO
  const totalMarginPercent =
    totalNet > ZERO ? factorToPercent(div(sub(totalNet, totalCostNet), totalNet)) : ZERO

  return {
    lines,
    totalNet: money(totalNet),
    totalCostNet: money(totalCostNet),
    totalMarkupPercent: formatRate(totalMarkupPercent),
    totalMarginPercent: formatRate(totalMarginPercent),
    warnings: Array.from(aggregateWarnings),
  }
}
