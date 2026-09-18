import type { EntityManager } from '@mikro-orm/postgresql'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { CatalogProductCategory } from '@open-mercato/core/modules/catalog/data/entities'
import { tryResolve } from '@open-mercato/pricing-engine/modules/pricing_engine/lib/catalog'
import { PricingPurchasePosition } from '@open-mercato/pricing-engine/modules/pricing_engine/data/entities'

/**
 * The portal catalog is the set of products the distributor has purchase data for, because a
 * product with no `PricingPurchasePosition` prices at a zero cost basis and would quote a
 * near-free price to the buyer. `product_group_code` on that row doubles as the browse category.
 */
const MAX_SELLABLE_POSITIONS = 5000

export type PortalCatalogScope = {
  em: EntityManager
  container: { resolve: (name: string) => unknown }
  tenantId: string
  organizationId: string
}

export type PortalCatalogItem = {
  productId: string
  sku: string | null
  title: string
  categoryCode: string | null
}

export type PortalCatalogCategory = {
  code: string
  label: string
  productCount: number
}

export type PortalCatalogPage = {
  items: PortalCatalogItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  categories: PortalCatalogCategory[]
}

export type PortalCatalogQuery = {
  search?: string
  categoryCode?: string
  page: number
  pageSize: number
}

type CatalogProductRow = {
  id: string
  tenantId: string
  organizationId: string
  sku?: string | null
  title?: string | null
  isActive?: boolean
  deletedAt?: Date | null
}

type CatalogProductClass = new (...args: never[]) => CatalogProductRow

type SellablePosition = {
  productId: string
  sku: string | null
  categoryCode: string | null
}

/**
 * Category codes are slugs the seeder copies from the catalog category tree. The real display
 * name lives on `catalog_product_categories`, which the catalog module does not expose through
 * DI, so the portal humanises the slug rather than reaching into another module's tables.
 */
export function humanizeCategoryCode(code: string): string {
  const words = code.split(/[-_]/g).filter(Boolean).join(' ')
  if (!words.length) return code
  return words.charAt(0).toUpperCase() + words.slice(1)
}

async function loadSellablePositions(scope: PortalCatalogScope): Promise<SellablePosition[]> {
  const rows = await scope.em.find(
    PricingPurchasePosition,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    },
    { limit: MAX_SELLABLE_POSITIONS },
  )
  return rows.map((row) => ({
    productId: row.catalogProductId,
    sku: row.sku ?? null,
    categoryCode: row.productGroupCode ?? null,
  }))
}


async function loadCategoryNames(
  scope: PortalCatalogScope,
  positions: SellablePosition[],
): Promise<Map<string, string>> {
  const slugs = Array.from(
    new Set(positions.map((position) => position.categoryCode).filter((code): code is string => Boolean(code))),
  )
  if (!slugs.length) return new Map()
  const rows = await scope.em.find(CatalogProductCategory, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    slug: { $in: slugs },
  })
  const named = new Map<string, string>()
  for (const row of rows) {
    // `slug` is nullable on the catalog entity; a category without one cannot be matched back to a
    // purchase position's group code, so it simply contributes no label.
    if (row.slug && row.name) named.set(row.slug, row.name)
  }
  return named
}

/**
 * Category labels come from the catalog's own `name`, not from prettifying the slug. The slug is a
 * machine key ('horeca-chemia-do-zmywarek'); humanising it produces 'Horeca chemia do zmywarek' —
 * no diacritics, a technical prefix, and a name the operator never chose. The real name is one
 * lookup away and is already translated by whoever created the category.
 */
function buildCategories(
  positions: SellablePosition[],
  namesBySlug: Map<string, string>,
): PortalCatalogCategory[] {
  const counts = new Map<string, number>()
  for (const position of positions) {
    if (!position.categoryCode) continue
    counts.set(position.categoryCode, (counts.get(position.categoryCode) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([code, productCount]) => ({ code, label: namesBySlug.get(code) ?? humanizeCategoryCode(code), productCount }))
    .sort((left, right) => left.label.localeCompare(right.label))
}

function matchesFallbackSearch(position: SellablePosition, search: string): boolean {
  if (!search) return true
  const needle = search.toLowerCase()
  return (position.sku ?? '').toLowerCase().includes(needle)
}

export async function listPortalCatalog(
  scope: PortalCatalogScope,
  query: PortalCatalogQuery,
): Promise<PortalCatalogPage> {
  const positions = await loadSellablePositions(scope)
  const categoryNames = await loadCategoryNames(scope, positions)
  const categories = buildCategories(positions, categoryNames)
  const scoped = query.categoryCode
    ? positions.filter((position) => position.categoryCode === query.categoryCode)
    : positions

  const positionByProductId = new Map<string, SellablePosition>()
  for (const position of scoped) positionByProductId.set(position.productId, position)
  const productIds = Array.from(positionByProductId.keys())

  const emptyPage: PortalCatalogPage = {
    items: [],
    total: 0,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: 1,
    categories,
  }
  if (!productIds.length) return emptyPage

  const search = (query.search ?? '').trim()
  const offset = (query.page - 1) * query.pageSize
  const catalogProductClass = tryResolve<CatalogProductClass>(scope.container, 'CatalogProduct')

  // Catalog is an optional peer reached through the class it registers in DI. Without it the
  // portal still lists what the distributor can price, identified by SKU instead of title.
  if (!catalogProductClass) {
    const matched = scoped
      .filter((position) => matchesFallbackSearch(position, search))
      .sort((left, right) => (left.sku ?? '').localeCompare(right.sku ?? ''))
    const items = matched.slice(offset, offset + query.pageSize).map((position) => ({
      productId: position.productId,
      sku: position.sku,
      title: position.sku ?? position.productId,
      categoryCode: position.categoryCode,
    }))
    return {
      items,
      total: matched.length,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(matched.length / query.pageSize)),
      categories,
    }
  }

  const where: Record<string, unknown> = {
    id: { $in: productIds },
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
    isActive: true,
  }
  if (search) {
    const pattern = `%${escapeLikePattern(search)}%`
    where.$or = [{ title: { $ilike: pattern } }, { sku: { $ilike: pattern } }]
  }

  const [rows, total] = await scope.em.findAndCount(catalogProductClass, where as never, {
    limit: query.pageSize,
    offset,
    orderBy: { title: 'asc' } as never,
  })

  const items = (rows as CatalogProductRow[]).map((row) => {
    const position = positionByProductId.get(row.id)
    return {
      productId: row.id,
      sku: row.sku ?? position?.sku ?? null,
      title: row.title ?? row.sku ?? row.id,
      categoryCode: position?.categoryCode ?? null,
    }
  })

  return {
    items,
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    categories,
  }
}

export type SellableProduct = { productId: string; sku: string | null; title: string | null }

/**
 * Narrows a client-supplied list of product ids to the ones this tenant can actually be quoted,
 * and returns the server's own SKU/title for each. A basket line naming anything else is rejected
 * rather than silently priced.
 */
export async function loadSellableProducts(
  scope: PortalCatalogScope,
  productIds: string[],
): Promise<Map<string, SellableProduct>> {
  const uniqueIds = Array.from(new Set(productIds.filter(Boolean)))
  const resolved = new Map<string, SellableProduct>()
  if (!uniqueIds.length) return resolved

  const positions = await scope.em.find(PricingPurchasePosition, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
    catalogProductId: { $in: uniqueIds },
  })
  for (const position of positions) {
    resolved.set(position.catalogProductId, {
      productId: position.catalogProductId,
      sku: position.sku ?? null,
      title: null,
    })
  }
  if (!resolved.size) return resolved

  const catalogProductClass = tryResolve<CatalogProductClass>(scope.container, 'CatalogProduct')
  if (!catalogProductClass) return resolved

  const rows = await scope.em.find(catalogProductClass, {
    id: { $in: Array.from(resolved.keys()) },
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
    isActive: true,
  } as never)

  const active = new Map<string, SellableProduct>()
  for (const row of rows as CatalogProductRow[]) {
    const position = resolved.get(row.id)
    active.set(row.id, {
      productId: row.id,
      sku: row.sku ?? position?.sku ?? null,
      title: row.title ?? null,
    })
  }
  return active
}
