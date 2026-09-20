import { features as attachmentsFeatures } from '@open-mercato/core/modules/attachments/acl'
import { features as authFeatures } from '@open-mercato/core/modules/auth/acl'
import { features as catalogFeatures } from '@open-mercato/core/modules/catalog/acl'
import { features as currenciesFeatures } from '@open-mercato/core/modules/currencies/acl'
import { features as customersFeatures } from '@open-mercato/core/modules/customers/acl'
import { features as dashboardsFeatures } from '@open-mercato/core/modules/dashboards/acl'
import { features as dictionariesFeatures } from '@open-mercato/core/modules/dictionaries/acl'
import { features as messagesFeatures } from '@open-mercato/core/modules/messages/acl'
import { features as notificationsFeatures } from '@open-mercato/core/modules/notifications/acl'
import { features as perspectivesFeatures } from '@open-mercato/core/modules/perspectives/acl'
import { features as salesFeatures } from '@open-mercato/core/modules/sales/acl'
import { features as searchFeatures } from '@open-mercato/search/modules/search/acl'
import { features as shippingFeatures } from '@open-mercato/core/modules/shipping_carriers/acl'
import { features as wmsFeatures } from '@open-mercato/core/modules/wms/acl'
import { features as pricingFeatures } from '@open-mercato/pricing-engine/modules/pricing_engine/acl'
import { features as distributorFeatures } from '../acl'
import { DISTRIBUTOR_FEATURES, DISTRIBUTOR_ROLE } from '../lib/roleFeatures'
import fs from 'node:fs'
import path from 'node:path'

/**
 * A role is only a bundle of feature ids. Nothing in the platform validates that a granted id
 * was ever declared — `ensureRoleAclFor` merges whatever string it is handed — so a typo becomes
 * a permanently inert grant that nobody notices. These tests are that missing validation.
 */

type DeclaredFeature = { id: string; title: string; module: string; dependsOn?: readonly string[] }

const ALL_FEATURES: readonly DeclaredFeature[] = [
  ...attachmentsFeatures,
  ...authFeatures,
  ...catalogFeatures,
  ...currenciesFeatures,
  ...customersFeatures,
  ...dashboardsFeatures,
  ...dictionariesFeatures,
  ...distributorFeatures,
  ...messagesFeatures,
  ...notificationsFeatures,
  ...perspectivesFeatures,
  ...pricingFeatures,
  ...salesFeatures,
  ...searchFeatures,
  ...shippingFeatures,
  ...wmsFeatures,
] as readonly DeclaredFeature[]

const BY_ID = new Map(ALL_FEATURES.map((feature) => [feature.id, feature]))

describe(`${DISTRIBUTOR_ROLE} role features`, () => {
  it('grants only feature ids that a module actually declares', () => {
    const undeclared = DISTRIBUTOR_FEATURES.filter((id) => !BY_ID.has(id))
    expect(undeclared).toEqual([])
  })

  it('is dependency-closed — every dependsOn of a granted feature is also granted', () => {
    const granted = new Set<string>(DISTRIBUTOR_FEATURES)
    const missing: string[] = []
    for (const id of DISTRIBUTOR_FEATURES) {
      for (const dependency of BY_ID.get(id)?.dependsOn ?? []) {
        if (!granted.has(dependency)) missing.push(`${id} -> ${dependency}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('contains no duplicates and stays sorted so diffs stay reviewable', () => {
    expect(new Set(DISTRIBUTOR_FEATURES).size).toBe(DISTRIBUTOR_FEATURES.length)
    expect([...DISTRIBUTOR_FEATURES]).toEqual([...DISTRIBUTOR_FEATURES].sort())
  })

  it('withholds the privileged ids a distributor operator must not hold', () => {
    const forbidden = [
      'auth.acl.manage',
      'auth.roles.manage',
      'auth.users.create',
      'catalog.settings.manage',
      'directory.organizations.manage',
      'directory.tenants.manage',
      'pricing.mode.change',
      'pricing.supplier.import',
      'sales.documents.number.edit',
    ]
    const leaked = forbidden.filter((id) => (DISTRIBUTOR_FEATURES as readonly string[]).includes(id))
    expect(leaked).toEqual([])
  })

  it('can actually do the job: quote, sell and touch stock', () => {
    const required = [
      'catalog.products.view',
      'customers.companies.view',
      'pricing.quote',
      'pricing.view',
      'sales.orders.manage',
      'sales.quotes.manage',
      'wms.view',
    ]
    const absent = required.filter((id) => !(DISTRIBUTOR_FEATURES as readonly string[]).includes(id))
    expect(absent).toEqual([])
  })
})

/**
 * Structural, not behavioural: route files pull server-only dependencies into jest, so the gates
 * are read from source. Every backend gate in this module must carry one of the module's own ids
 * on top of the data-owning modules' ids — that is the whole point of `acl.ts`.
 */
describe('distributor_workspace own feature ids', () => {
  const moduleRoot = path.resolve(__dirname, '..')
  const gatedFiles = ['route.ts', 'page.meta.ts', 'widget.ts']
  // The sidebar entry only re-labels the core dashboard; it stays on `dashboards.view` alone.
  const exempt = new Set([path.join(moduleRoot, 'widgets', 'injection', 'sidebar-dashboard', 'widget.ts')])
  const ownIds = new Set(distributorFeatures.map((feature) => feature.id))

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      return entry.isDirectory() ? walk(full) : gatedFiles.includes(entry.name) ? [full] : []
    })
  const files = ['api', 'backend', 'widgets']
    .flatMap((dir) => walk(path.join(moduleRoot, dir)))
    .filter((file) => !exempt.has(file) && !file.includes(`${path.sep}portal${path.sep}`))

  const gates = files.flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8')
    const pattern = /\b(?:requireFeatures|features):\s*\[([^\]]*)\]/g
    return Array.from(source.matchAll(pattern), (match) => ({
      file: path.relative(moduleRoot, file),
      ids: Array.from(match[1].matchAll(/'([^']+)'/g), (idMatch) => idMatch[1]),
    }))
  })

  it('finds the gates it is meant to check', () => {
    expect(gates.length).toBeGreaterThanOrEqual(12)
  })

  it('every backend gate requires one of the module own ids on top of the data-owning ids', () => {
    const missingOwnId = gates.filter((gate) => !gate.ids.some((id) => ownIds.has(id)))
    expect(missingOwnId).toEqual([])
    const ownOnly = gates.filter((gate) => gate.ids.every((id) => ownIds.has(id)))
    expect(ownOnly).toEqual([])
  })

  it('grants the distributor role every own id', () => {
    const granted = new Set<string>(DISTRIBUTOR_FEATURES)
    expect(Array.from(ownIds).filter((id) => !granted.has(id))).toEqual([])
  })
})
