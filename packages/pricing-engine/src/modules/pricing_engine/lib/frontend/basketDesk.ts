// Pure helpers behind the pricing desk (`backend/pricing/calculator`): the URL contract every
// other screen links in with, how an advisor suggestion edits the basket, and how the engine's own
// target and floor are read back off a quote. No React, no fetch — everything here is unit-tested.

import type { AdviseResponse, AdvisorSuggestion } from './advisorTypes'
import { marginFromMarkup, minUnitPriceForMargin } from './marginMath'
import type { QuoteLine, QuoteResponse } from './quoteTypes'

export const DESK_PATH = '/backend/pricing/calculator'

const LINES_PARAM = 'lines'
const CUSTOMER_PARAM = 'customerId'
const SCENARIO_PARAM = 'scenario'
const ZONE_PARAM = 'zone'
const LINE_SEPARATOR = ','
const QUANTITY_SEPARATOR = ':'
const MAX_URL_LINES = 50

const GUARDRAILS_COMPONENT_CODE = 'guardrails'
const TARGET_MARGIN_COMPONENT_CODE = 'target_margin'

export type DeskLine = {
  key: string
  productId: string
  title: string
  sku: string | null
  quantity: number
}

export type DeskUrlLine = { productId: string; quantity: string }

export type DeskUrlState = {
  customerId: string | null
  orderScenarioCode: string | null
  deliveryZoneCode: string | null
  lines: DeskUrlLine[]
}

function isPositiveQuantity(value: string): boolean {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
}

function readParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)
  return value && value.trim().length > 0 ? value.trim() : null
}

/**
 * `?customerId=&scenario=&zone=&lines=<productId>:<qty>,<productId>:<qty>` — the shape predicted
 * orders, the margin tab, the comparison and the customer tabs link in with. A malformed entry is
 * skipped rather than failing the whole basket: a link with one bad line should still open with
 * the other nine.
 */
export function parseDeskSearch(source: URLSearchParams | string | null | undefined): DeskUrlState {
  const params = source instanceof URLSearchParams ? source : new URLSearchParams(source ?? '')
  const rawLines = readParam(params, LINES_PARAM)
  const lines: DeskUrlLine[] = []
  const seen = new Set<string>()
  for (const entry of (rawLines ?? '').split(LINE_SEPARATOR)) {
    if (lines.length >= MAX_URL_LINES) break
    const [productIdRaw, quantityRaw] = entry.split(QUANTITY_SEPARATOR)
    const productId = productIdRaw?.trim() ?? ''
    const quantity = quantityRaw?.trim() ?? '1'
    if (!productId || seen.has(productId) || !isPositiveQuantity(quantity)) continue
    seen.add(productId)
    lines.push({ productId, quantity: String(Number(quantity)) })
  }
  return {
    customerId: readParam(params, CUSTOMER_PARAM),
    orderScenarioCode: readParam(params, SCENARIO_PARAM),
    deliveryZoneCode: readParam(params, ZONE_PARAM),
    lines,
  }
}

export function buildDeskHref(state: Partial<DeskUrlState>): string {
  const params = new URLSearchParams()
  if (state.customerId) params.set(CUSTOMER_PARAM, state.customerId)
  if (state.orderScenarioCode) params.set(SCENARIO_PARAM, state.orderScenarioCode)
  if (state.deliveryZoneCode) params.set(ZONE_PARAM, state.deliveryZoneCode)
  const lines = (state.lines ?? [])
    .filter((line) => line.productId && isPositiveQuantity(line.quantity))
    .slice(0, MAX_URL_LINES)
    .map((line) => `${line.productId}${QUANTITY_SEPARATOR}${Number(line.quantity)}`)
  if (lines.length > 0) params.set(LINES_PARAM, lines.join(LINE_SEPARATOR))
  const query = params.toString()
  return query ? `${DESK_PATH}?${query}` : DESK_PATH
}

export type SuggestionApplication =
  | { kind: 'quantity'; lines: DeskLine[] }
  | { kind: 'product'; lines: DeskLine[]; productId: string }
  | { kind: 'channel'; orderScenarioCode: string }
  | { kind: 'none' }

function replaceLine(lines: DeskLine[], productId: string, patch: Partial<DeskLine>): DeskLine[] {
  return lines.map((line) => (line.productId === productId ? { ...line, ...patch } : line))
}

/**
 * What pressing "Apply" on a suggestion does to the basket. The advisor already priced the
 * changed basket, so the desk only has to reproduce the change it described in `change` and let
 * the auto-pricing confirm it. A swapped product arrives without a title — the caller resolves it.
 */
export function applySuggestion(lines: DeskLine[], suggestion: AdvisorSuggestion): SuggestionApplication {
  const change = suggestion.change
  const subjectId = change.productId ?? suggestion.subject?.productId ?? null
  switch (suggestion.code) {
    case 'volume_threshold':
    case 'full_pack_rounding': {
      if (!subjectId || !change.toQuantity || !isPositiveQuantity(change.toQuantity)) return { kind: 'none' }
      if (!lines.some((line) => line.productId === subjectId)) return { kind: 'none' }
      return { kind: 'quantity', lines: replaceLine(lines, subjectId, { quantity: Number(change.toQuantity) }) }
    }
    case 'cheaper_equivalent': {
      if (!subjectId || !change.toProductId) return { kind: 'none' }
      if (!lines.some((line) => line.productId === subjectId)) return { kind: 'none' }
      if (lines.some((line) => line.productId === change.toProductId)) return { kind: 'none' }
      const toSku = suggestion.explainValues.toSku ?? null
      return {
        kind: 'product',
        productId: change.toProductId,
        lines: replaceLine(lines, subjectId, {
          productId: change.toProductId,
          title: toSku ?? change.toProductId,
          sku: toSku,
        }),
      }
    }
    case 'order_channel_change':
      return change.toOrderScenarioCode
        ? { kind: 'channel', orderScenarioCode: change.toOrderScenarioCode }
        : { kind: 'none' }
    case 'basket_consolidation':
    default:
      return { kind: 'none' }
  }
}

function readDecimalParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key]
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) return value
  return null
}

export type MarginTargets = {
  targetMarginPercent: string | null
  floorMarginPercent: string | null
}

/**
 * The target and the floor the engine actually applied, read back off the breakdown so the KPI
 * colouring can never disagree with the price. Target: the `target_margin` component's
 * `targetMarginPercent`, or its markup converted (D5). Floor: the strictest `minMarginPercent` any
 * line's guardrails carried.
 */
export function deriveMarginTargets(quote: QuoteResponse | null): MarginTargets {
  if (!quote) return { targetMarginPercent: null, floorMarginPercent: null }
  let target: string | null = null
  let floor: number | null = null
  for (const line of quote.lines) {
    for (const component of line.breakdown) {
      if (component.code === TARGET_MARGIN_COMPONENT_CODE && target === null) {
        const explicit = readDecimalParam(component.params, 'targetMarginPercent')
          ?? readDecimalParam(component.explainValues, 'marginPercent')
        const markup = readDecimalParam(component.params, 'targetMarkupPercent')
          ?? readDecimalParam(component.explainValues, 'markupPercent')
        target = explicit ?? (markup ? marginFromMarkup(markup) : null)
      }
      if (component.code === GUARDRAILS_COMPONENT_CODE) {
        const minimum = readDecimalParam(component.params, 'minMarginPercent')
        if (minimum !== null) floor = floor === null ? Number(minimum) : Math.max(floor, Number(minimum))
      }
    }
  }
  return { targetMarginPercent: target, floorMarginPercent: floor === null ? null : String(floor) }
}

export type LineFloor = {
  productId: string
  minMarginPercent: string | null
  lowestUnitPrice: string | null
  discountHeadroomPercent: string | null
  source: 'guardrail' | 'requested' | null
}

/**
 * The lowest unit price that still respects the guardrails the engine applied to a line: the
 * minimum-margin clamp and, when configured, the hard floor price. Read off the guardrails
 * component of the simulated line, so the number can never disagree with the engine.
 */
export function toLineFloor(line: QuoteLine): LineFloor {
  const guardrails = line.breakdown.find((component) => component.code === GUARDRAILS_COMPONENT_CODE)
  const params = guardrails?.params ?? {}
  const minMarginPercent = readDecimalParam(params, 'minMarginPercent')
  const floorPrice = readDecimalParam(params, 'floorPrice')
  const marginFloor = minMarginPercent ? minUnitPriceForMargin(line.unitCostNet, minMarginPercent) : null
  const candidates = [marginFloor, floorPrice].filter((value): value is string => value !== null)
  const lowestUnitPrice = candidates.length
    ? candidates.reduce((highest, candidate) => (Number(candidate) > Number(highest) ? candidate : highest))
    : null
  const price = Number(line.unitPriceNet)
  const headroom = lowestUnitPrice !== null && price > 0
    ? (((price - Number(lowestUnitPrice)) / price) * 100).toFixed(2)
    : null
  return {
    productId: line.productId,
    minMarginPercent,
    lowestUnitPrice,
    discountHeadroomPercent: headroom,
    source: minMarginPercent || floorPrice ? 'guardrail' : null,
  }
}

/**
 * Per-product floors for the basket table. The advisor's `marginFloors` win when present — they
 * honour an operator-typed minimum and carry the headroom — and the simulate breakdown fills in
 * for any line the advisor did not cover (it can arrive later or fail independently).
 */
export function mergeLineFloors(quote: QuoteResponse | null, advice: AdviseResponse | null): Map<string, LineFloor> {
  const floors = new Map<string, LineFloor>()
  for (const line of quote?.lines ?? []) floors.set(line.productId, toLineFloor(line))
  for (const floor of advice?.marginFloors ?? []) {
    floors.set(floor.productId, {
      productId: floor.productId,
      minMarginPercent: floor.minMarginPercent,
      lowestUnitPrice: floor.lowestUnitPriceNet,
      discountHeadroomPercent: floor.discountHeadroomPercent,
      source: floor.source,
    })
  }
  return floors
}

export function toSimulateLines(lines: DeskLine[]): DeskUrlLine[] {
  return lines
    .filter((line) => line.productId && line.quantity > 0)
    .map((line) => ({ productId: line.productId, quantity: String(line.quantity) }))
}
