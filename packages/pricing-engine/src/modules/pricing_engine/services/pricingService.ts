import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  PricingCalculation,
  PricingCalculationLine,
  PricingCustomerIndicator,
  PricingSupplierProfile,
} from '../data/entities'
import { loadCatalogSnapshot } from '../lib/catalog'
import { add, money, mul, toDecimal, ZERO } from '../lib/decimal'
import { implementedComponents } from '../lib/components'
import { loadParameters } from '../lib/params'
import { buildAllocation, runPipeline } from '../lib/pipeline'
import type {
  ComponentDeps,
  IndicatorSnapshot,
  PricingContext,
  PricingQuoteResult,
  SupplierSnapshot,
} from '../lib/types'

export const CONTEXT_SNAPSHOT_VERSION = 1

export type QuoteOptions = {
  persist?: boolean
  triggeredBy?: 'api' | 'sales_hook' | 'cli' | 'simulate'
  triggeredByUserId?: string | null
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
      const scopeFilter = {
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        deletedAt: null,
      }

      const profile = await em.findOne(PricingSupplierProfile, scopeFilter)
      if (!profile) throw new SupplierProfileMissingError()
      const supplier = toSupplierSnapshot(profile)

      const [{ lookup, customerProfile }, catalog] = await Promise.all([
        loadParameters(
          em,
          { tenantId: context.tenantId, organizationId: context.organizationId, date: context.date },
          { customerId: context.customerId ?? null },
        ),
        loadCatalogSnapshot(
          em,
          container,
          { tenantId: context.tenantId, organizationId: context.organizationId },
          context.lines.map((line) => line.productId),
        ),
      ])

      const indicatorRows = context.customerId
        ? await em.find(PricingCustomerIndicator, { ...scopeFilter, customerId: context.customerId })
        : []
      const indicators: IndicatorSnapshot = { byCode: new Map() }
      for (const row of indicatorRows) {
        indicators.byCode.set(row.code, {
          value: row.value,
          normalizedValue: row.normalizedValue,
          confidence: row.confidence,
        })
      }

      const effectiveContext: PricingContext = {
        ...context,
        customerGroupCode: context.customerGroupCode ?? customerProfile?.customerGroupCode ?? null,
        orderScenarioCode:
          context.orderScenarioCode ?? customerProfile?.defaultOrderScenarioCode ?? null,
        deliveryZoneCode: context.deliveryZoneCode ?? customerProfile?.deliveryZoneCode ?? null,
        currencyCode: context.currencyCode || supplier.currencyCode,
      }

      const unitCostByLine = effectiveContext.lines.map((line) => {
        const purchase = catalog.byProductId.get(line.productId)?.purchase
        return purchase?.lastDeliveryUnitCost ?? '0'
      })

      const componentDeps: ComponentDeps = {
        supplier,
        params: lookup,
        catalog,
        indicators,
        allocation: { shareByLineIndex: buildAllocation(effectiveContext, unitCostByLine) },
      }

      const run = await runPipeline(effectiveContext, implementedComponents, componentDeps)
      const durationMs = Date.now() - startedAt

      const result: PricingQuoteResult = {
        calculationId: null,
        currencyCode: effectiveContext.currencyCode,
        mode: effectiveContext.mode,
        parameterSetVersion: supplier.parameterSetVersion,
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
        contextSnapshot: buildContextSnapshot(effectiveContext, supplier),
        finalUnitPriceNet: firstLine?.unitPriceNet ?? '0',
        finalTotalNet: run.totalNet,
        totalCostNet: run.totalCostNet,
        markupPercent: run.totalMarkupPercent,
        marginPercent: run.totalMarginPercent,
        mode: effectiveContext.mode,
        parameterSetVersion: supplier.parameterSetVersion,
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
