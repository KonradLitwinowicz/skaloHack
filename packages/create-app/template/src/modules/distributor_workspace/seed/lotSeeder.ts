import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CatalogProduct, CatalogProductVariant } from '@open-mercato/core/modules/catalog/data/entities'
import {
  InventoryBalance,
  InventoryLot,
  ProductInventoryProfile,
} from '@open-mercato/core/modules/wms/data/entities'
import { HORECA_PRODUCTS, type HorecaProductSeed } from './horecaCatalogData'
import { bump, emptyReport, type DistributorSeedScope, type SeedReport, type SeedRunOptions } from './types'

/**
 * Shelf life by category, in months. Only goods that actually perish get a lot: paper, film and
 * disposable packaging do not expire, and giving them an expiry date would invent a markdown
 * pressure that does not exist.
 *
 * Numbers are the distributor's assumption, flagged demo like every other seeded rate, and replaced
 * from the supplier's own data through the purchase-position screen.
 */
const SHELF_LIFE_MONTHS: Record<string, number> = {
  'horeca-chemia-myjaca-do-naczyn': 24,
  'horeca-chemia-do-zmywarek': 18,
  'horeca-srodki-dezynfekcyjne': 12,
  'horeca-chemia-do-powierzchni-i-sanitariatow': 24,
  'horeca-srodki-do-podlog': 24,
  'horeca-chemia-do-prania': 18,
  'horeca-chemia-kuchenna-specjalistyczna': 12,
  'horeca-kosmetyki-i-higiena-rak': 18,
}

/**
 * Remaining shelf life is spread deliberately rather than randomly, so a re-run reproduces the same
 * picture and every markdown stage has cases to exercise. A demo where nothing is ever close to
 * expiry never tests the one path that loses real money.
 */
const REMAINING_LIFE_PATTERN = [
  0.92, 0.85, 0.74, 0.61, 0.55, 0.47, 0.38, 0.30, 0.22, 0.16, 0.11, 0.07, 0.04, 0.02,
]

const MS_PER_DAY = 86_400_000
const DAYS_PER_MONTH = 30

export function expiresAtFor(seed: HorecaProductSeed, index: number, now: Date): { manufacturedAt: Date; expiresAt: Date } | null {
  const months = SHELF_LIFE_MONTHS[seed.categorySlug]
  if (!months) return null
  const totalDays = months * DAYS_PER_MONTH
  const remainingFraction = REMAINING_LIFE_PATTERN[index % REMAINING_LIFE_PATTERN.length] ?? 0.5
  const remainingDays = Math.max(1, Math.round(totalDays * remainingFraction))
  const expiresAt = new Date(now.getTime() + remainingDays * MS_PER_DAY)
  const manufacturedAt = new Date(expiresAt.getTime() - totalDays * MS_PER_DAY)
  return { manufacturedAt, expiresAt }
}

export async function seedHorecaLots(
  em: EntityManager,
  scope: DistributorSeedScope,
  options: SeedRunOptions = {},
): Promise<SeedReport> {
  const report = emptyReport()
  const perishable = HORECA_PRODUCTS.filter((seed) => SHELF_LIFE_MONTHS[seed.categorySlug] !== undefined)
  const seeds = typeof options.limit === 'number' ? perishable.slice(0, options.limit) : perishable

  if (!seeds.length) {
    report.warnings.push('[internal] no perishable products in the seed set')
    return report
  }

  const products = await em.find(CatalogProduct, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    handle: { $in: seeds.map((seed) => seed.handle) },
  })
  if (!products.length) {
    report.warnings.push('[internal] no HoReCa products found — run seed-horeca-catalog first')
    return report
  }
  const productByHandle = new Map(products.map((row) => [(row.handle ?? '').toLowerCase(), row]))

  const variants = await em.find(CatalogProductVariant, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    product: { $in: products.map((row) => row.id) },
    isActive: true,
  })
  const variantByProduct = new Map<string, CatalogProductVariant>()
  for (const variant of variants) {
    const key = variant.product.id
    const current = variantByProduct.get(key)
    if (!current || (variant.isDefault && !current.isDefault)) variantByProduct.set(key, variant)
  }

  const variantIds = [...variantByProduct.values()].map((row) => row.id)
  const balances = variantIds.length
    ? await em.find(InventoryBalance, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        catalogVariantId: { $in: variantIds },
      })
    : []
  const balanceByVariant = new Map(balances.map((row) => [row.catalogVariantId, row]))

  const existingLots = variantIds.length
    ? await em.find(InventoryLot, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        catalogVariantId: { $in: variantIds },
      })
    : []
  const lotByVariant = new Map(existingLots.map((row) => [row.catalogVariantId, row]))

  // One shared "now" keeps every expiry deterministic within a run, so the markdown stage a product
  // lands in is a property of the data rather than of the moment the seeder happened to execute.
  const now = new Date()

  if (options.dryRun) {
    report.created = seeds.length
    report.warnings.push('[internal] dry run: nothing was written')
    return report
  }

  let index = 0
  for (const seed of seeds) {
    const product = productByHandle.get(seed.handle.toLowerCase())
    if (!product) continue
    const variant = variantByProduct.get(product.id)
    if (!variant) continue
    const dates = expiresAtFor(seed, index, now)
    index += 1
    if (!dates) continue

    const existing = lotByVariant.get(variant.id)
    if (existing) {
      existing.manufacturedAt = dates.manufacturedAt
      existing.bestBeforeAt = dates.expiresAt
      existing.expiresAt = dates.expiresAt
      existing.status = dates.expiresAt.getTime() <= now.getTime() ? 'expired' : 'available'
      report.skipped += 1
      bump(report, 'lotsUpdated')
      continue
    }

    const lot = em.create(InventoryLot, {
      id: randomUUID(),
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      catalogVariantId: variant.id,
      sku: variant.sku ?? seed.sku,
      lotNumber: `L-${seed.sku}-${dates.expiresAt.getUTCFullYear()}${String(dates.expiresAt.getUTCMonth() + 1).padStart(2, '0')}`,
      batchNumber: null,
      manufacturedAt: dates.manufacturedAt,
      bestBeforeAt: dates.expiresAt,
      expiresAt: dates.expiresAt,
      status: 'available',
    })
    em.persist(lot)
    report.created += 1
    bump(report, 'lotsCreated')

    const balance = balanceByVariant.get(variant.id)
    if (balance && !balance.lot) {
      balance.lot = lot
      bump(report, 'balancesLinkedToLot')
    }

    const profile = await em.findOne(ProductInventoryProfile, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      catalogProductId: product.id,
    })
    if (profile && !profile.trackExpiration) {
      profile.trackExpiration = true
      profile.trackLot = true
      profile.defaultStrategy = 'fefo'
      bump(report, 'profilesSwitchedToFefo')
    }
  }

  await em.flush()
  return report
}
