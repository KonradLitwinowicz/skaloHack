import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import {
  PricingCalculation,
  PricingCalculationLine,
  PricingCustomerIndicator,
  PricingCustomerProfile,
  PricingOrderScenario,
  PricingSupplierProfile,
} from '../data/entities'
import { loadCatalogSnapshot } from '../lib/catalog'
import { loadInventorySnapshot } from '../lib/inventory'
import { loadAuthorisedDeadstockFloors } from '../lib/deadstock/authorisedFloor'
import type { AuthorisedDeadstockFloors } from '../lib/deadstock/authorisedFloor'
import { add, money, mul, toDecimal, ZERO } from '../lib/decimal'
import { implementedComponents, TARGET_MARGIN_CODE } from '../lib/components'
import { loadParameters } from '../lib/params'
import { buildAllocation, runPipeline, type PipelineRunResult } from '../lib/pipeline'
import type {
  CatalogSnapshot,
  ComponentDeps,
  IndicatorSnapshot,
  InventorySnapshot,
  ParameterLookup,
  PricingContext,
  PricingQuoteResult,
  SupplierSnapshot,
} from '../lib/types'

export const CONTEXT_SNAPSHOT_VERSION = 1

// What-if levers a caller may push into the pipeline without touching stored parameters.
// `targetMarkupPercent` is injected as if a `target_margin` component param existed at the most
// specific scope; `orderScenarioCode` replaces the context's channel before profile defaults apply.
export type PriceOverrides = {
  targetMarkupPercent?: string
  orderScenarioCode?: string
}

export type QuoteOptions = {
  persist?: boolean
  triggeredBy?: 'api' | 'sales_hook' | 'cli' | 'simulate'
  triggeredByUserId?: string | null
  overrides?: PriceOverrides
}

export interface PricingService {
  quote(context: PricingContext, options?: QuoteOptions): Promise<PricingQuoteResult>
}

export class SupplierProfileMissingError extends Error {
  constructor() {
    super('[internal] No pricing supplier profile for this tenant/organization')
    this.name = 'SupplierProfileMissingError'
  }
}

export const CURRENCY_MISMATCH_ERROR_KEY = 'pricing_engine.errors.currencyMismatch'

/**
 * Extends `CrudHttpError` rather than plain `Error` so the 409 needs no new arm in
 * `toPricingErrorResponse`: every pipeline-backed route already answers `isCrudHttpError` first,
 * and quote, simulate and advise therefore get one identical contract for free.
 *
 * The two codes live on the error for logs and tests only. The HTTP body carries the translation
 * key and nothing else, so a portal caller learns that the basket was refused without learning how
 * the tenant's supplier profile is configured.
 */
export class PricingCurrencyMismatchError extends CrudHttpError {
  readonly contextCurrencyCode: string
  readonly supplierCurrencyCode: string

  constructor(contextCurrencyCode: string, supplierCurrencyCode: string) {
    super(409, { error: CURRENCY_MISMATCH_ERROR_KEY })
    this.name = 'PricingCurrencyMismatchError'
    this.message = `[internal] Requested currency ${contextCurrencyCode} differs from supplier profile currency ${supplierCurrencyCode}`
    this.contextCurrencyCode = contextCurrencyCode
    this.supplierCurrencyCode = supplierCurrencyCode
  }
}

function normalizeCurrencyCode(code: string): string {
  return code.trim().toUpperCase()
}

/**
 * Refusal, not a warning, and this is the one place that can tell the difference.
 *
 * Every money input the pipeline reads is denominated in the supplier profile's currency by
 * construction: `pricing_purchase_positions`, labor rates, fuel prices, packaging, warehouse and
 * delivery-zone rows carry no currency column of their own, and no component converts anything.
 * So a caller-supplied currency does not select a price list — it only relabels the result. Asking
 * for USD over a PLN profile returns the PLN numbers with a USD sign in front of them.
 *
 * A warning was the alternative and was rejected: `quote()` persists `final_total_net` and
 * `currency_code` into an append-only ledger that is replayed and summed later, and a string in the
 * `warnings` column does not stop a report from adding USD-labelled zlotys to real dollars. The
 * shadow observer already refuses the same comparison at its own seam for the same reason, so a
 * soft path here would leave the package contradicting itself.
 *
 * An empty context currency is inheritance, not a collision — the caller named no currency and
 * `resolveEffectiveContext` fills in the profile's. Case and padding are normalized away because a
 * caller sending `pln` means the profile's currency, and refusing that would be a bug, not a guard.
 */
function assertCurrencyMatchesSupplier(contextCurrencyCode: string, supplier: SupplierSnapshot): void {
  const requested = normalizeCurrencyCode(contextCurrencyCode)
  if (requested.length === 0) return
  if (requested === normalizeCurrencyCode(supplier.currencyCode)) return
  throw new PricingCurrencyMismatchError(contextCurrencyCode, supplier.currencyCode)
}

// Everything one pricing run needs from the database, fetched once. Holding this makes a second,
// third or twentieth hypothetical basket free: `priceWithInputs` touches no EntityManager, so an
// advisory run that scores fifteen perturbations still costs one round of I/O rather than fifteen.
export type PricingInputs = {
  supplier: SupplierSnapshot
  params: ParameterLookup
  catalog: CatalogSnapshot
  indicators: IndicatorSnapshot
  customerProfile: PricingCustomerProfile | null
  // `ParameterLookup` resolves a scenario by code but cannot enumerate them, and the advisor has to
  // know which channels exist before it can price a move between them.
  orderScenarioCodes: string[]
  // Optional for the same reason the ComponentDeps field is: WMS is an optional peer, and this is
  // an exported type third-party code may already construct.
  inventory?: InventorySnapshot
  deadstock?: AuthorisedDeadstockFloors
}

/**
 * A basket line may name the variant being bought, which is the only variant hint that exists for a
 * product whose inventory profile carries none. First line wins — a basket that asks for two
 * variants of one product is already outside what the per-product cost model represents.
 */
export function variantIdsByProduct(lines: PricingContext['lines']): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of lines) {
    if (!line.variantId || map.has(line.productId)) continue
    map.set(line.productId, line.variantId)
  }
  return map
}

export type PricingInputsScope = {
  tenantId: string
  organizationId: string
  date: Date
  customerId?: string | null
}

function toSupplierSnapshot(profile: PricingSupplierProfile): SupplierSnapshot {
  return {
    id: profile.id,
    slug: profile.slug,
    currencyCode: profile.currencyCode,
    defaultTargetMarkup: profile.defaultTargetMarkup,
    mode: profile.mode,
    roundingPolicy: profile.roundingPolicy ?? null,
    parameterSetVersion: profile.parameterSetVersion,
  }
}

export async function loadPricingInputs(
  em: EntityManager,
  container: { resolve: (name: string) => unknown },
  scope: PricingInputsScope,
  productIds: string[],
  variantIdByProductId: Map<string, string> = new Map(),
): Promise<PricingInputs> {
  const scopeFilter = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
  }

  const profile = await em.findOne(PricingSupplierProfile, scopeFilter)
  if (!profile) throw new SupplierProfileMissingError()
  const supplier = toSupplierSnapshot(profile)

  const [{ lookup, customerProfile }, catalog, inventory, deadstock, scenarioRows] = await Promise.all([
    loadParameters(
      em,
      { tenantId: scope.tenantId, organizationId: scope.organizationId, date: scope.date },
      { customerId: scope.customerId ?? null },
    ),
    loadCatalogSnapshot(
      em,
      container,
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
      productIds,
    ),
    loadInventorySnapshot(
      em,
      container,
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
      productIds,
      variantIdByProductId,
      { asOf: scope.date },
    ),
    loadAuthorisedDeadstockFloors(
      em,
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
      productIds,
      scope.date,
    ),
    em.find(PricingOrderScenario, scopeFilter),
  ])

  const indicatorRows = scope.customerId
    ? await em.find(PricingCustomerIndicator, { ...scopeFilter, customerId: scope.customerId })
    : []
  const indicators: IndicatorSnapshot = { byCode: new Map() }
  for (const row of indicatorRows) {
    indicators.byCode.set(row.code, {
      value: row.value,
      normalizedValue: row.normalizedValue,
      confidence: row.confidence,
    })
  }

  // Codes only: validity windows and newest-wins precedence stay with `lookup.orderScenario`, so a
  // code listed here that is not in force today simply resolves to null and is skipped.
  const orderScenarioCodes = Array.from(new Set(scenarioRows.map((row) => row.code)))

  return { supplier, params: lookup, catalog, inventory, deadstock, indicators, customerProfile, orderScenarioCodes }
}

// Idempotent: resolving an already-resolved context returns the same context, so callers that need
// the effective values for persistence may call it before handing the context to `priceWithInputs`.
export function resolveEffectiveContext(
  context: PricingContext,
  inputs: PricingInputs,
  overrides?: PriceOverrides,
): PricingContext {
  const { customerProfile, supplier } = inputs
  assertCurrencyMatchesSupplier(context.currencyCode, supplier)
  return {
    ...context,
    customerGroupCode: context.customerGroupCode ?? customerProfile?.customerGroupCode ?? null,
    orderScenarioCode:
      overrides?.orderScenarioCode ??
      context.orderScenarioCode ??
      customerProfile?.defaultOrderScenarioCode ??
      null,
    deliveryZoneCode: context.deliveryZoneCode ?? customerProfile?.deliveryZoneCode ?? null,
    currencyCode: context.currencyCode || supplier.currencyCode,
  }
}

// A markup override behaves exactly like a stored `target_margin` param at the winning scope, so the
// component reports `source: 'component_param'` and confidence `measured` — the same path a real
// configured rule takes, rather than a second code path that could drift from it.
function withMarkupOverride(params: ParameterLookup, overrides?: PriceOverrides): ParameterLookup {
  const markupPercent = overrides?.targetMarkupPercent
  if (markupPercent === undefined) return params
  return {
    ...params,
    componentPayload(componentCode, scopeRefs) {
      if (componentCode === TARGET_MARGIN_CODE) return { targetMarkupPercent: markupPercent }
      return params.componentPayload(componentCode, scopeRefs)
    },
  }
}

/**
 * Pure with respect to the database. Rebuilds the basket allocation for THIS basket — shares are
 * basket-wide, so perturbing one line's quantity changes every other line's share and a whole
 * basket must be re-run rather than a single line.
 */
export async function priceWithInputs(
  context: PricingContext,
  inputs: PricingInputs,
  overrides?: PriceOverrides,
): Promise<PipelineRunResult> {
  const effectiveContext = resolveEffectiveContext(context, inputs, overrides)
  const unitCostByLine = effectiveContext.lines.map((line) => {
    const purchase = inputs.catalog.byProductId.get(line.productId)?.purchase
    return purchase?.lastDeliveryUnitCost ?? '0'
  })

  const componentDeps: ComponentDeps = {
    supplier: inputs.supplier,
    params: withMarkupOverride(inputs.params, overrides),
    catalog: inputs.catalog,
    indicators: inputs.indicators,
    allocation: { shareByLineIndex: buildAllocation(effectiveContext, unitCostByLine) },
    inventory: inputs.inventory,
    deadstock: inputs.deadstock,
  }

  return runPipeline(effectiveContext, implementedComponents, componentDeps)
}

function buildContextSnapshot(context: PricingContext, supplier: SupplierSnapshot): Record<string, unknown> {
  // Versioned, decimals as strings, provenance included — the same shape `SalesLineUomSnapshot`
  // uses, so a stored calculation can be replayed years later.
  return {
    version: CONTEXT_SNAPSHOT_VERSION,
    tenantId: context.tenantId,
    organizationId: context.organizationId,
    currencyCode: context.currencyCode,
    customerId: context.customerId ?? null,
    customerGroupCode: context.customerGroupCode ?? null,
    orderScenarioCode: context.orderScenarioCode ?? null,
    deliveryZoneCode: context.deliveryZoneCode ?? null,
    mode: context.mode,
    date: context.date.toISOString(),
    lines: context.lines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId ?? null,
      sku: line.sku ?? null,
      quantity: line.quantity,
      enteredQuantity: line.enteredQuantity ?? null,
      enteredUnitCode: line.enteredUnitCode ?? null,
    })),
    source: {
      supplierSlug: supplier.slug,
      parameterSetVersion: supplier.parameterSetVersion,
      resolvedAt: new Date().toISOString(),
    },
  }
}

export function createPricingService(deps: {
  em: EntityManager
  container: { resolve: (name: string) => unknown }
}): PricingService {
  const { em, container } = deps

  return {
    async quote(context: PricingContext, options: QuoteOptions = {}): Promise<PricingQuoteResult> {
      const startedAt = Date.now()

      const inputs = await loadPricingInputs(
        em,
        container,
        {
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          date: context.date,
          customerId: context.customerId ?? null,
        },
        context.lines.map((line) => line.productId),
        variantIdsByProduct(context.lines),
      )

      const effectiveContext = resolveEffectiveContext(context, inputs, options.overrides)
      const run = await priceWithInputs(effectiveContext, inputs, options.overrides)
      const durationMs = Date.now() - startedAt

      const result: PricingQuoteResult = {
        calculationId: null,
        currencyCode: effectiveContext.currencyCode,
        mode: effectiveContext.mode,
        parameterSetVersion: inputs.supplier.parameterSetVersion,
        lines: run.lines,
        totalNet: run.totalNet,
        totalCostNet: run.totalCostNet,
        totalMarkupPercent: run.totalMarkupPercent,
        totalMarginPercent: run.totalMarginPercent,
        warnings: run.warnings,
        durationMs,
      }

      // `simulate` never persists: a what-if must not pollute the audit ledger.
      if (options.persist === false) return result

      const firstLine = run.lines[0] ?? null
      // The primary key is generated by Postgres (`defaultRaw: gen_random_uuid()`), so
      // `calculation.id` stays undefined until flush. The ledger lines reference it, so the id is
      // assigned here instead — that keeps parent and children in ONE flush rather than forcing a
      // round trip just to learn the id.
      const calculationId = randomUUID()
      const calculation = em.create(PricingCalculation, {
        id: calculationId,
        tenantId: effectiveContext.tenantId,
        organizationId: effectiveContext.organizationId,
        customerId: effectiveContext.customerId ?? null,
        currencyCode: effectiveContext.currencyCode,
        contextSnapshot: buildContextSnapshot(effectiveContext, inputs.supplier),
        finalUnitPriceNet: firstLine?.unitPriceNet ?? '0',
        finalTotalNet: run.totalNet,
        totalCostNet: run.totalCostNet,
        markupPercent: run.totalMarkupPercent,
        marginPercent: run.totalMarginPercent,
        mode: effectiveContext.mode,
        parameterSetVersion: inputs.supplier.parameterSetVersion,
        triggeredBy: options.triggeredBy ?? 'api',
        triggeredByUserId: options.triggeredByUserId ?? null,
        durationMs,
        warnings: run.warnings.length > 0 ? run.warnings : null,
        calculatedAt: effectiveContext.date,
        isDemo: false,
      })
      em.persist(calculation)

      run.lines.forEach((lineResult, lineIndex) => {
        let running = ZERO
        lineResult.breakdown.forEach((component, position) => {
          const value = toDecimal(component.value)
          running = component.effect === 'add' ? add(running, value) : mul(running, value)
          em.persist(
            em.create(PricingCalculationLine, {
              tenantId: effectiveContext.tenantId,
              organizationId: effectiveContext.organizationId,
              calculationId,
              basketLineIndex: lineIndex,
              componentCode: component.code,
              position,
              effect: component.effect,
              value: component.value,
              runningTotal: money(running),
              inputs: component.inputs,
              params: component.params,
              explainKey: component.explainKey,
              explainValues: component.explainValues,
              confidence: component.confidence,
              warnings: component.warnings && component.warnings.length > 0 ? component.warnings : null,
            }),
          )
        })
      })

      await em.flush()
      result.calculationId = calculationId
      return result
    },
  }
}
