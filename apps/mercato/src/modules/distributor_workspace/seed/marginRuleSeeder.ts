import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  PricingComponentParam,
  PricingCustomerProfile,
  PricingGuardrail,
} from '@open-mercato/pricing-engine/modules/pricing_engine/data/entities'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { HORECA_SOURCE_PREFIX } from './customerSeeder'
import {
  CUSTOMER_GROUP_MARGIN_RULES,
  CUSTOMER_MARGIN_RULES,
  GUARDRAIL_RULES,
  PRODUCT_GROUP_MARGIN_RULES,
} from './marginRuleData'
import { bump, emptyReport, type DistributorSeedScope, type SeedReport, type SeedRunOptions } from './types'

/**
 * `target_margin` is the component code the engine executes at position 9
 * (`lib/components/targetMargin.ts`), and it resolves its payload through
 * `deps.params.componentPayload(code, refs)` with the precedence
 * customer → customer_group → product → product_group → global (`lib/params.ts`).
 * A rule is therefore one `pricing_component_params` row: component code + scope + scope ref + payload.
 */
const TARGET_MARGIN_CODE = 'target_margin'

/**
 * Rules are effective from the epoch rather than from "now": a rule dated at seed time would leave
 * every historical calculation resolving to the global default, which makes a replay of yesterday's
 * quote disagree with today's for reasons that have nothing to do with policy.
 */
const RULE_VALID_FROM = new Date('2020-01-01T00:00:00.000Z')

type RuleRow = {
  scope: 'global' | 'customer' | 'customer_group' | 'product' | 'product_group'
  scopeRefId: string | null
  payload: Record<string, unknown>
  changeNote: string
}

async function upsertRule(
  em: EntityManager,
  scope: DistributorSeedScope,
  row: RuleRow,
  report: SeedReport,
): Promise<void> {
  const existing = await em.findOne(PricingComponentParam, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    componentCode: TARGET_MARGIN_CODE,
    scope: row.scope,
    scopeRefId: row.scopeRefId,
    deletedAt: null,
  })
  if (existing) {
    existing.payload = row.payload
    existing.changeNote = row.changeNote
    existing.validFrom = RULE_VALID_FROM
    existing.validTo = null
    report.skipped += 1
    bump(report, `rulesUpdated:${row.scope}`)
    return
  }
  em.persist(
    em.create(PricingComponentParam, {
      id: randomUUID(),
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      isDemo: true,
      componentCode: TARGET_MARGIN_CODE,
      scope: row.scope,
      scopeRefId: row.scopeRefId,
      payload: row.payload,
      validFrom: RULE_VALID_FROM,
      validTo: null,
      createdByUserId: null,
      changeNote: row.changeNote,
    }),
  )
  report.created += 1
  bump(report, `rulesCreated:${row.scope}`)
}

export async function seedHorecaMarginRules(
  em: EntityManager,
  scope: DistributorSeedScope,
  options: SeedRunOptions = {},
): Promise<SeedReport> {
  const report = emptyReport()

  if (options.dryRun) {
    report.created =
      PRODUCT_GROUP_MARGIN_RULES.length +
      CUSTOMER_GROUP_MARGIN_RULES.length +
      CUSTOMER_MARGIN_RULES.length +
      GUARDRAIL_RULES.length
    report.warnings.push('[internal] dry run: nothing was written')
    return report
  }

  for (const rule of PRODUCT_GROUP_MARGIN_RULES) {
    await upsertRule(
      em,
      scope,
      {
        scope: 'product_group',
        scopeRefId: rule.productGroupCode,
        payload: { targetMarkupPercent: rule.targetMarkupPercent },
        changeNote: rule.rationale,
      },
      report,
    )
  }

  for (const rule of CUSTOMER_GROUP_MARGIN_RULES) {
    await upsertRule(
      em,
      scope,
      {
        scope: 'customer_group',
        scopeRefId: rule.customerGroupCode,
        payload: { targetMarkupPercent: rule.targetMarkupPercent },
        changeNote: rule.rationale,
      },
      report,
    )
  }

  // Customer-scoped rules key on the customer id, so the seed handle has to be resolved first.
  const handles = CUSTOMER_MARGIN_RULES.map((rule) => `${HORECA_SOURCE_PREFIX}${rule.customerHandle}`)
  const companies = await findWithDecryption(
    em,
    CustomerEntity,
    { tenantId: scope.tenantId, organizationId: scope.organizationId, source: { $in: handles }, deletedAt: null },
    {},
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  const idBySource = new Map(companies.map((row) => [row.source ?? '', row.id]))

  for (const rule of CUSTOMER_MARGIN_RULES) {
    const customerId = idBySource.get(`${HORECA_SOURCE_PREFIX}${rule.customerHandle}`)
    if (!customerId) {
      report.warnings.push(`[internal] customer "${rule.customerHandle}" not seeded — rule skipped`)
      continue
    }
    await upsertRule(
      em,
      scope,
      {
        scope: 'customer',
        scopeRefId: customerId,
        payload: { targetMarkupPercent: rule.targetMarkupPercent },
        changeNote: rule.rationale,
      },
      report,
    )
  }

  for (const guardrail of GUARDRAIL_RULES) {
    const existing = await em.findOne(PricingGuardrail, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      code: guardrail.code,
      deletedAt: null,
    })
    if (existing) {
      existing.minMarginPercent = guardrail.minMarginPercent
      existing.maxDiscountPercent = guardrail.maxDiscountPercent
      existing.scope = guardrail.scope
      existing.scopeRefId = guardrail.scopeRefId
      existing.validFrom = RULE_VALID_FROM
      existing.validTo = null
      report.skipped += 1
      bump(report, 'guardrailsUpdated')
      continue
    }
    em.persist(
      em.create(PricingGuardrail, {
        id: randomUUID(),
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        isDemo: true,
        code: guardrail.code,
        scope: guardrail.scope,
        scopeRefId: guardrail.scopeRefId,
        minMarginPercent: guardrail.minMarginPercent,
        maxDiscountPercent: guardrail.maxDiscountPercent,
        floorPrice: null,
        rounding: null,
        // Not nullable — the entity defaults to 'negotiated_wins', meaning an individually agreed
        // price outranks the guardrail clamp. Stated explicitly rather than left implicit, because
        // it decides who wins when a negotiated price sits below the margin floor.
        negotiatedPricePrecedence: 'negotiated_wins',
        validFrom: RULE_VALID_FROM,
        validTo: null,
      }),
    )
    report.created += 1
    bump(report, 'guardrailsCreated')
  }

  // Customer profiles carry the group code the customer_group rules key on; make sure it is set.
  const profiles = await em.count(PricingCustomerProfile, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
  })
  if (profiles === 0) {
    report.warnings.push('[internal] no customer pricing profiles — run seed-horeca-customers first')
  }

  await em.flush()
  return report
}
