import type { EntityManager } from '@mikro-orm/postgresql'
import { PricingPurchasePosition } from '../data/entities'
import type { CatalogProductSnapshot, CatalogSnapshot, PurchasePositionSnapshot } from './types'

// Catalog is an OPTIONAL peer. It is reached through the entity class the catalog module registers
// in DI (`CatalogProduct: asValue(...)`), never through a direct import or an ORM relation — the
// same seam `inbox_ops/lib/priceValidator.ts` uses. When catalog is absent the engine still prices;
// it just loses the physical attributes, and the coverage screen says so.
export type CatalogProductLike = {
  id: string
  sku?: string | null
  title?: string | null
  weightValue?: string | null
  weightUnit?: string | null
  dimensions?: Record<string, unknown> | null
}

type EntityClassLike = new (...args: never[]) => CatalogProductLike

export type CatalogResolver = {
  tryResolve<T>(name: string): T | undefined
}

export function tryResolve<T>(container: { resolve: (name: string) => unknown }, name: string): T | undefined {
  try {
    return container.resolve(name) as T
  } catch {
    return undefined
  }
}

export async function loadCatalogSnapshot(
  em: EntityManager,
  container: { resolve: (name: string) => unknown },
  scope: { tenantId: string; organizationId: string },
  productIds: string[],
): Promise<CatalogSnapshot> {
  const uniqueIds = Array.from(new Set(productIds.filter(Boolean)))
  const byProductId = new Map<string, CatalogProductSnapshot>()
  if (uniqueIds.length === 0) return { byProductId }

  const purchasePositions = await em.find(PricingPurchasePosition, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
    catalogProductId: { $in: uniqueIds },
  })

  const purchaseByProduct = new Map<string, PurchasePositionSnapshot>()
  for (const row of purchasePositions) {
    purchaseByProduct.set(row.catalogProductId, {
      lastDeliveryUnitCost: row.lastDeliveryUnitCost ?? null,
      lastDeliveryAt: row.lastDeliveryAt ?? null,
      lastDeliveryQuantity: row.lastDeliveryQuantity ?? null,
      soldQuantityPeriod: row.soldQuantityPeriod ?? null,
      currentTierCode: row.currentTierCode ?? null,
      currentTierDiscount: row.currentTierDiscount,
      nextTierVolume: row.nextTierVolume ?? null,
      nextTierDiscount: row.nextTierDiscount ?? null,
      annualVolume: row.annualVolume,
      productGroupCode: row.productGroupCode ?? null,
    })
  }

  const catalogProductClass = tryResolve<EntityClassLike>(container, 'CatalogProduct')
  const products = catalogProductClass
    ? await em.find(catalogProductClass, {
        id: { $in: uniqueIds },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      })
    : []

  const productById = new Map<string, CatalogProductLike>()
  for (const product of products as CatalogProductLike[]) productById.set(product.id, product)

  for (const productId of uniqueIds) {
    const product = productById.get(productId) ?? null
    const purchase = purchaseByProduct.get(productId) ?? null
    byProductId.set(productId, {
      productId,
      variantId: null,
      sku: product?.sku ?? null,
      title: product?.title ?? null,
      productGroupCode: purchase?.productGroupCode ?? null,
      weightValue: product?.weightValue ?? null,
      weightUnit: product?.weightUnit ?? null,
      dimensions: product?.dimensions ?? null,
      // TODO(data-source): packaging units come from `catalog_product_unit_conversions`, wired in
      // Step 2 together with `packaging_cost`. Empty here rather than guessed.
      unitConversions: {},
      purchase,
    })
  }

  return { byProductId }
}
