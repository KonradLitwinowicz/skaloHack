import { add, money, toDecimal, ZERO } from '../decimal'
import type { Decimal } from '../decimal'
import { DEADSTOCK_AT_RISK_CLASSES, type DeadstockClass } from './classify'
import type { DeadstockPosition } from './loader'
import { DEADSTOCK_STAGE_LABEL_KEYS, recoverableAtFloor } from './markdown'
import { windowMetricsOf } from './metrics'
import type { DeadstockListQuery, DeadstockRow, DeadstockSortKey } from './schemas'
import type { PricingDeadstockDecision } from '../../data/entities'

function decisionInForce(decision: PricingDeadstockDecision | null, asOf: Date): boolean {
  if (!decision) return false
  if (decision.verdict !== 'dismissed') return true
  if (!decision.reviewAt) return true
  return decision.reviewAt.getTime() > asOf.getTime()
}

export function toDeadstockRow(position: DeadstockPosition, asOf: Date): DeadstockRow {
  const { metrics, assessment, carrying, markdown, decision } = position

  return {
    productId: position.productId,
    variantId: position.variantId,
    sku: position.sku,
    title: position.title,
    isActive: position.isActive,
    productClass: assessment.productClass,
    rawClass: assessment.rawClass,
    suppression: assessment.suppression,
    reasonKey: assessment.reasonKey,
    onHandQuantity: money(position.onHandQuantity),
    unitCost: money(position.unitCost),
    hasUnitCost: position.hasUnitCost,
    stockAgeDays: position.stockAgeDays,
    stockAgeSource: position.stockAgeSource,
    coverDays: assessment.coverDays === null ? null : money(assessment.coverDays),
    daysSinceLastSale: metrics.daysSinceLastSale,
    firstSaleAt: metrics.firstSaleAt ? metrics.firstSaleAt.toISOString() : null,
    lastSaleAt: metrics.lastSaleAt ? metrics.lastSaleAt.toISOString() : null,
    lifetimeUnits: metrics.lifetimeUnits,
    lifetimeRevenueNet: metrics.lifetimeRevenueNet,
    lifetimeOrderCount: metrics.lifetimeOrderCount,
    lifetimeCustomerCount: metrics.lifetimeCustomerCount,
    windows: metrics.windows,
    carrying: {
      perUnitPerMonth: money(carrying.perUnitPerMonth),
      positionPerMonth: money(carrying.positionPerMonth),
      carriedToDate: money(carrying.carriedToDate),
      tiedCapital: money(carrying.tiedCapital),
      confidence: carrying.confidence,
    },
    markdown: markdown
      ? {
          stage: markdown.stage,
          stageLabelKey: DEADSTOCK_STAGE_LABEL_KEYS[markdown.stage],
          floorUnitPrice: money(markdown.floorUnitPrice),
          horizonMonths: money(markdown.horizonMonths),
          forwardCarryPerUnit: money(markdown.forwardCarryPerUnit),
          belowCostPerUnit: money(markdown.belowCostPerUnit),
          carryingCostAvoided: money(markdown.carryingCostAvoided),
          recoverableAtFloor: money(recoverableAtFloor(markdown, position.onHandQuantity)),
          confidence: markdown.confidence,
        }
      : null,
    nearestExpiryAt: position.nearestExpiryAt ? position.nearestExpiryAt.toISOString() : null,
    seasonalityKnown: assessment.seasonalityKnown,
    peakMonths: assessment.peakMonths,
    nextPeakMonth: assessment.nextPeakMonth,
    decision: decision
      ? {
          id: decision.id,
          verdict: decision.verdict,
          reasonCode: decision.reasonCode ?? null,
          note: decision.note ?? null,
          decidedAt: decision.decidedAt.toISOString(),
          reviewAt: decision.reviewAt ? decision.reviewAt.toISOString() : null,
          inForce: decisionInForce(decision, asOf),
        }
      : null,
    warnings: Array.from(new Set([...assessment.warnings, ...carrying.warnings, ...(markdown?.warnings ?? [])])),
  }
}

function unitsIn(row: DeadstockRow, windowDays: number): Decimal {
  const window = row.windows.find((entry) => entry.windowDays === windowDays)
  return window ? toDecimal(window.unitsSold) : ZERO
}

function revenueIn(row: DeadstockRow, windowDays: number): Decimal {
  const window = row.windows.find((entry) => entry.windowDays === windowDays)
  return window ? toDecimal(window.revenueNet) : ZERO
}

function countIn(row: DeadstockRow, windowDays: number, field: 'orderCount' | 'distinctCustomers'): number {
  const window = row.windows.find((entry) => entry.windowDays === windowDays)
  return window ? window[field] : 0
}

/**
 * Sort keys resolve to a comparable, and an absent measurement resolves to null rather than to
 * zero.
 *
 * The distinction matters most on the column an operator reaches for first: sorted by days since
 * the last sale, a product that never sold once is not "zero days" — it belongs at the far end,
 * and `nullsLast` puts it there regardless of direction.
 */
function sortValue(row: DeadstockRow, key: DeadstockSortKey): string | number | bigint | null {
  switch (key) {
    case 'title': return (row.title ?? '').toLowerCase()
    case 'sku': return (row.sku ?? '').toLowerCase()
    case 'onHandQuantity': return toDecimal(row.onHandQuantity)
    case 'tiedCapital': return toDecimal(row.carrying.tiedCapital)
    case 'monthlyCarry': return toDecimal(row.carrying.positionPerMonth)
    case 'carriedToDate': return toDecimal(row.carrying.carriedToDate)
    case 'daysSinceLastSale': return row.daysSinceLastSale
    case 'stockAgeDays': return row.stockAgeDays
    case 'coverDays': return row.coverDays === null ? null : toDecimal(row.coverDays)
    case 'units7': return unitsIn(row, 7)
    case 'units30': return unitsIn(row, 30)
    case 'units90': return unitsIn(row, 90)
    case 'units365': return unitsIn(row, 365)
    case 'revenue365': return revenueIn(row, 365)
    case 'orders365': return countIn(row, 365, 'orderCount')
    case 'customers365': return countIn(row, 365, 'distinctCustomers')
    case 'floorUnitPrice': return row.markdown ? toDecimal(row.markdown.floorUnitPrice) : null
    case 'carryingCostAvoided': return row.markdown ? toDecimal(row.markdown.carryingCostAvoided) : null
    default: return null
  }
}

function compare(left: string | number | bigint | null, right: string | number | bigint | null): number {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right)
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function sortDeadstockRows(rows: DeadstockRow[], key: DeadstockSortKey, dir: 'asc' | 'desc'): DeadstockRow[] {
  const factor = dir === 'asc' ? 1 : -1
  return [...rows].sort((left, right) => {
    const leftValue = sortValue(left, key)
    const rightValue = sortValue(right, key)
    // Nulls stay last in BOTH directions: they are "not measured", not an extreme value.
    if (leftValue === null || rightValue === null) return compare(leftValue, rightValue)
    const ordered = compare(leftValue, rightValue) * factor
    if (ordered !== 0) return ordered
    return compare((left.title ?? '').toLowerCase(), (right.title ?? '').toLowerCase())
  })
}

function isAtRisk(productClass: DeadstockClass): boolean {
  return DEADSTOCK_AT_RISK_CLASSES.includes(productClass)
}

/**
 * `includeSuppressed` deliberately widens the worklist rather than narrowing it.
 *
 * A row suppressed as seasonal or too new is invisible by default, which is the point of a
 * suppressor — but an operator who wants to check WHAT the detector decided not to accuse has to be
 * able to see it, or the suppression is indistinguishable from the product simply not being there.
 */
export function filterDeadstockRows(rows: DeadstockRow[], query: DeadstockListQuery): DeadstockRow[] {
  const search = query.search?.toLowerCase() ?? null
  return rows.filter((row) => {
    if (query.productClass && row.productClass !== query.productClass) return false
    if (query.actionableOnly && row.markdown === null) return false
    if (query.atRiskOnly) {
      const suppressedButAccused =
        query.includeSuppressed === true && row.suppression !== null && isAtRisk(row.rawClass)
      if (!isAtRisk(row.productClass) && !suppressedButAccused) return false
    }
    if (search) {
      const haystack = `${row.title ?? ''} ${row.sku ?? ''}`.toLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })
}

export function deadstockTotals(rows: DeadstockRow[], stockedCount: number, catalogCount: number) {
  const byClass: Record<DeadstockClass, number> = {
    healthy: 0,
    slow: 0,
    dying: 0,
    dead: 0,
    never_sold: 0,
  }
  let tiedCapital = ZERO
  let monthlyCarry = ZERO
  let recoverable = ZERO
  let atRiskCount = 0
  let suppressedCount = 0

  for (const row of rows) {
    byClass[row.productClass] += 1
    if (row.suppression !== null) suppressedCount += 1
    // Totals count only positions that actually earned a verdict. Adding healthy stock to "tied
    // capital" would make the headline the value of the warehouse, which nobody needs a screen for.
    if (!row.markdown) continue
    atRiskCount += 1
    tiedCapital = add(tiedCapital, toDecimal(row.carrying.tiedCapital))
    monthlyCarry = add(monthlyCarry, toDecimal(row.carrying.positionPerMonth))
    recoverable = add(recoverable, toDecimal(row.markdown.recoverableAtFloor))
  }

  return {
    tiedCapital: money(tiedCapital),
    monthlyCarry: money(monthlyCarry),
    recoverableAtFloor: money(recoverable),
    atRiskCount,
    catalogCount,
    stockedCount,
    byClass,
    suppressedCount,
  }
}

export function paginate<T>(rows: T[], page: number, pageSize: number): { items: T[]; total: number; totalPages: number } {
  const total = rows.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const start = (page - 1) * pageSize
  return { items: rows.slice(start, start + pageSize), total, totalPages }
}
