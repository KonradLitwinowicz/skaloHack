import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { PricingCalculation, PricingCalculationLine } from './data/entities'
import setup from './setup'

function parseArgs(rest: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index]
    if (!part?.startsWith('--')) continue
    const [keyRaw, valueRaw] = part.slice(2).split('=')
    if (!keyRaw) continue
    if (valueRaw !== undefined) args[keyRaw] = valueRaw
    else if (index + 1 < rest.length && !rest[index + 1].startsWith('--')) args[keyRaw] = rest[index + 1]
    else args[keyRaw] = 'true'
  }
  return args
}

function readScope(args: Record<string, string>): { tenantId: string; organizationId: string } | null {
  const tenantId = String(args.tenantId ?? args.tenant ?? '')
  const organizationId = String(args.organizationId ?? args.orgId ?? args.org ?? '')
  if (!tenantId || !organizationId) return null
  return { tenantId, organizationId }
}

// `seedDefaults`/`seedExamples` only run when a tenant is created. A module enabled AFTER a tenant
// already exists therefore has no parameter rows at all, and the engine refuses to price. This
// command runs the same idempotent hooks against an existing tenant.
const seed: ModuleCli = {
  command: 'seed',
  async run(rest) {
    const args = parseArgs(rest)
    const scope = readScope(args)
    if (!scope) {
      console.error('Usage: mercato pricing_engine seed --tenant <tenantId> --org <organizationId> [--no-examples]')
      return
    }
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')
    const withExamples = args['no-examples'] !== 'true'

    await setup.seedDefaults?.({ em, container, ...scope } as never)
    console.log(`✅ pricing_engine defaults seeded for organization ${scope.organizationId}`)

    if (withExamples) {
      await setup.seedExamples?.({ em, container, ...scope } as never)
      console.log('✅ pricing_engine demo data seeded')
    }
  },
}

// Demo rows are flagged `is_demo`, so they can be removed without touching anything an operator
// entered by hand. The calculation ledger is append-only and is purged by calculation id.
const purgeDemo: ModuleCli = {
  command: 'purge-demo',
  async run(rest) {
    const args = parseArgs(rest)
    const scope = readScope(args)
    if (!scope) {
      console.error('Usage: mercato pricing_engine purge-demo --tenant <tenantId> --org <organizationId>')
      return
    }
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')

    const demoCalculations = await em.find(PricingCalculation, { ...scope, isDemo: true }, { fields: ['id'] })
    const calculationIds = demoCalculations.map((row) => row.id)
    if (calculationIds.length > 0) {
      await em.nativeDelete(PricingCalculationLine, { ...scope, calculationId: { $in: calculationIds } })
      await em.nativeDelete(PricingCalculation, { ...scope, isDemo: true })
    }

    const entities = await import('./data/entities')

    // Deleted child-first so nothing is orphaned mid-purge. Each entity is deleted in its own
    // call because `nativeDelete` is typed per entity, not over a heterogeneous list.
    let removed = calculationIds.length
    removed += await em.nativeDelete(entities.PricingPurchasePosition, { ...scope, isDemo: true })
    removed += await em.nativeDelete(entities.PricingGuardrail, { ...scope, isDemo: true })
    removed += await em.nativeDelete(entities.PricingDeliveryZone, { ...scope, isDemo: true })
    removed += await em.nativeDelete(entities.PricingFuelPrice, { ...scope, isDemo: true })
    removed += await em.nativeDelete(entities.PricingVehicle, { ...scope, isDemo: true })
    removed += await em.nativeDelete(entities.PricingWarehouseCost, { ...scope, isDemo: true })
    removed += await em.nativeDelete(entities.PricingPackagingCost, { ...scope, isDemo: true })
    removed += await em.nativeDelete(entities.PricingOrderScenario, { ...scope, isDemo: true })
    removed += await em.nativeDelete(entities.PricingProcessStep, { ...scope, isDemo: true })
    removed += await em.nativeDelete(entities.PricingLaborRate, { ...scope, isDemo: true })
    removed += await em.nativeDelete(entities.PricingSupplierProfile, { ...scope, isDemo: true })
    console.log(`🧹 removed ${removed} demo row(s) for organization ${scope.organizationId}`)
  },
}

export default [seed, purgeDemo]
