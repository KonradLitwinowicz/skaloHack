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
import { DISTRIBUTOR_FEATURES, DISTRIBUTOR_ROLE } from '../lib/roleFeatures'

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
