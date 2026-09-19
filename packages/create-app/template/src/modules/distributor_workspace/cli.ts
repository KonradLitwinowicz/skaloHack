import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'
import { seedHorecaCatalog } from './seed/catalogSeeder'
import { seedHorecaCustomers } from './seed/customerSeeder'
import { seedDistributorAccounts } from './seed/accountsSeeder'
import { seedHorecaDeliveryZones } from './seed/zoneSeeder'
import { seedHorecaMarginRules } from './seed/marginRuleSeeder'
import { seedHorecaWarehouse } from './seed/warehouseSeeder'
import { seedHorecaLots } from './seed/lotSeeder'
import { seedHorecaMovements } from './seed/movementSeeder'
import { seedHorecaOrderHistory } from './seed/orderHistorySeeder'
import type { DistributorSeedScope, SeedReport, SeedRunOptions } from './seed/types'

function parseArgs(rest: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 1) {
    const part = rest[i]
    if (!part) continue
    if (!part.startsWith('--')) continue
    const [rawKey, rawValue] = part.slice(2).split('=')
    if (rawValue !== undefined) {
      args[rawKey] = rawValue
      continue
    }
    const next = rest[i + 1]
    if (next && !next.startsWith('--')) {
      args[rawKey] = next
      i += 1
    } else {
      args[rawKey] = 'true'
    }
  }
  return args
}

function readScope(args: Record<string, string>): DistributorSeedScope | null {
  const tenantId = String(args.tenantId ?? args.tenant ?? '')
  const organizationId = String(args.organizationId ?? args.org ?? args.orgId ?? '')
  if (!tenantId || !organizationId) return null
  return { tenantId, organizationId }
}

function readOptions(args: Record<string, string>): SeedRunOptions {
  const dryRun = parseBooleanWithDefault(args['dry-run'] ?? args.dry, false)
  const rawLimit = args.count ?? args.limit
  const parsedLimit = rawLimit === undefined ? Number.NaN : Number.parseInt(rawLimit, 10)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined
  const parsedMonths = args.months === undefined ? Number.NaN : Number.parseInt(args.months, 10)
  const months = Number.isFinite(parsedMonths) && parsedMonths > 0 ? parsedMonths : undefined
  return { dryRun, limit, months }
}

function printReport(title: string, report: SeedReport): void {
  const details = Object.entries(report.details)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  console.log(`${title}: created=${report.created} skipped=${report.skipped}${details ? ` | ${details}` : ''}`)
  for (const warning of report.warnings) console.warn(`  ! ${warning}`)
}

async function withScope(
  usage: string,
  rest: string[],
  run: (em: EntityManager, scope: DistributorSeedScope, options: SeedRunOptions) => Promise<SeedReport>,
  title: string,
): Promise<void> {
  const args = parseArgs(rest)
  const scope = readScope(args)
  if (!scope) {
    console.error(usage)
    return
  }
  const options = readOptions(args)
  const container = await createRequestContainer()
  try {
    const em = container.resolve<EntityManager>('em')
    const report = await em.transactional(async (tem) => run(tem as EntityManager, scope, options))
    printReport(title, report)
  } finally {
    const disposable = container as unknown as { dispose?: () => Promise<void> }
    if (typeof disposable.dispose === 'function') await disposable.dispose()
  }
}

const seedCatalogCommand: ModuleCli = {
  command: 'seed-horeca-catalog',
  async run(rest) {
    await withScope(
      'Usage: mercato distributor_workspace seed-horeca-catalog --tenant <tenantId> --org <organizationId> [--count N] [--dry-run]',
      rest,
      seedHorecaCatalog,
      'HoReCa catalog',
    )
  },
}

const seedCustomersCommand: ModuleCli = {
  command: 'seed-horeca-customers',
  async run(rest) {
    await withScope(
      'Usage: mercato distributor_workspace seed-horeca-customers --tenant <tenantId> --org <organizationId> [--count N] [--dry-run]',
      rest,
      seedHorecaCustomers,
      'HoReCa customers',
    )
  },
}

const seedAccountsCommand: ModuleCli = {
  command: 'seed-distributor-accounts',
  async run(rest) {
    await withScope(
      'Usage: mercato distributor_workspace seed-distributor-accounts --tenant <tenantId> --org <organizationId> [--count N]',
      rest,
      seedDistributorAccounts,
      'Distributor accounts',
    )
  },
}

const seedZonesCommand: ModuleCli = {
  command: 'seed-horeca-zones',
  async run(rest) {
    await withScope(
      'Usage: mercato distributor_workspace seed-horeca-zones --tenant <tenantId> --org <organizationId> [--dry-run]',
      rest,
      seedHorecaDeliveryZones,
      'HoReCa delivery zones',
    )
  },
}

const seedRulesCommand: ModuleCli = {
  command: 'seed-margin-rules',
  async run(rest) {
    await withScope(
      'Usage: mercato distributor_workspace seed-margin-rules --tenant <tenantId> --org <organizationId> [--dry-run]',
      rest,
      seedHorecaMarginRules,
      'Margin rules',
    )
  },
}

const seedWarehouseCommand: ModuleCli = {
  command: 'seed-horeca-warehouse',
  async run(rest) {
    await withScope(
      'Usage: mercato distributor_workspace seed-horeca-warehouse --tenant <tenantId> --org <organizationId> [--count N] [--dry-run]',
      rest,
      seedHorecaWarehouse,
      'HoReCa warehouse',
    )
  },
}

const seedLotsCommand: ModuleCli = {
  command: 'seed-horeca-lots',
  async run(rest) {
    await withScope(
      'Usage: mercato distributor_workspace seed-horeca-lots --tenant <tenantId> --org <organizationId> [--dry-run]',
      rest,
      seedHorecaLots,
      'HoReCa lots',
    )
  },
}

const seedMovementsCommand: ModuleCli = {
  command: 'seed-horeca-movements',
  async run(rest) {
    await withScope(
      'Usage: mercato distributor_workspace seed-horeca-movements --tenant <tenantId> --org <organizationId> [--months N] [--count N] [--dry-run]',
      rest,
      seedHorecaMovements,
      'HoReCa stock movements',
    )
  },
}

const seedOrderHistoryCommand: ModuleCli = {
  command: 'seed-horeca-order-history',
  async run(rest) {
    await withScope(
      'Usage: mercato distributor_workspace seed-horeca-order-history --tenant <tenantId> --org <organizationId> [--months N] [--count N] [--dry-run]',
      rest,
      seedHorecaOrderHistory,
      'HoReCa order history',
    )
  },
}

const commands: ModuleCli[] = [
  seedCatalogCommand,
  seedCustomersCommand,
  seedZonesCommand,
  seedRulesCommand,
  seedWarehouseCommand,
  seedLotsCommand,
  seedMovementsCommand,
  seedOrderHistoryCommand,
  seedAccountsCommand,
]

export default commands
