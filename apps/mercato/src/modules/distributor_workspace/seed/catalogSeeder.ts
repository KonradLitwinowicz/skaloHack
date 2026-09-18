import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CatalogPriceKind,
  CatalogProduct,
  CatalogProductCategory,
  CatalogProductCategoryAssignment,
  CatalogProductPrice,
  CatalogProductUnitConversion,
  CatalogProductVariant,
} from '@open-mercato/core/modules/catalog/data/entities'
import { rebuildCategoryHierarchyForOrganization } from '@open-mercato/core/modules/catalog/lib/categoryHierarchy'
import { PricingPurchasePosition } from '@open-mercato/pricing-engine/modules/pricing_engine/data/entities'
import {
  HORECA_CATEGORIES,
  HORECA_PRODUCTS,
  type HorecaCategorySeed,
  type HorecaProductSeed,
} from './horecaCatalogData'
import { bump, emptyReport, type DistributorSeedScope, type SeedReport, type SeedRunOptions } from './types'

/**
 * The catalog `regular` and `sale` price kinds are pinned to USD by the catalog module's own
 * defaults (catalog/lib/seeds.ts PRICE_KIND_DEFAULTS), and `seedCatalogPriceKinds` soft-deletes
 * any kind outside that list. A PLN distributor therefore needs its own kind, and this seeder
 * re-ensures it on every run so a later `mercato catalog seed-price-kinds` cannot leave the
 * HoReCa prices orphaned — it would only soft-delete the kind, and the next run restores it.
 */
export const HORECA_PRICE_KIND_CODE = 'horeca-pln'
export const HORECA_CURRENCY = 'PLN'

async function ensurePriceKind(em: EntityManager, scope: DistributorSeedScope): Promise<CatalogPriceKind> {
  const existing = await em.findOne(CatalogPriceKind, {
    tenantId: scope.tenantId,
    code: HORECA_PRICE_KIND_CODE,
  })
  const now = new Date()
  if (existing) {
    existing.title = 'HoReCa PLN'
    existing.currencyCode = HORECA_CURRENCY
    existing.displayMode = 'excluding-tax'
    existing.isPromotion = false
    existing.isActive = true
    existing.deletedAt = null
    existing.updatedAt = now
    return existing
  }
  const created = em.create(CatalogPriceKind, {
    id: randomUUID(),
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    code: HORECA_PRICE_KIND_CODE,
    title: 'HoReCa PLN',
    displayMode: 'excluding-tax',
    currencyCode: HORECA_CURRENCY,
    isPromotion: false,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  })
  em.persist(created)
  return created
}

async function ensureCategories(
  em: EntityManager,
  scope: DistributorSeedScope,
  report: SeedReport,
): Promise<Map<string, CatalogProductCategory>> {
  const map = new Map<string, CatalogProductCategory>()
  const now = new Date()

  const upsert = async (seed: HorecaCategorySeed, parent: CatalogProductCategory | null): Promise<void> => {
    let record = await em.findOne(CatalogProductCategory, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      slug: seed.slug,
    })
    if (!record) {
      record = em.create(CatalogProductCategory, {
        id: randomUUID(),
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        name: seed.name,
        slug: seed.slug,
        description: seed.description,
        parentId: parent ? parent.id : null,
        rootId: parent ? (parent.rootId ?? parent.id) : null,
        treePath: null,
        depth: parent ? (parent.depth ?? 0) + 1 : 0,
        ancestorIds: [],
        childIds: [],
        descendantIds: [],
        metadata: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      em.persist(record)
      bump(report, 'categoriesCreated')
    } else {
      record.name = seed.name
      record.description = seed.description
      record.parentId = parent ? parent.id : null
      record.isActive = true
      record.updatedAt = now
      bump(report, 'categoriesUpdated')
    }
    map.set(seed.slug, record)
    for (const child of seed.children ?? []) {
      await upsert(child, record)
    }
  }

  for (const root of HORECA_CATEGORIES) {
    await upsert(root, null)
  }
  await em.flush()
  await rebuildCategoryHierarchyForOrganization(em, scope.organizationId, scope.tenantId)
  return map
}

function createPriceRow(
  em: EntityManager,
  scope: DistributorSeedScope,
  priceKind: CatalogPriceKind,
  product: CatalogProduct,
  variant: CatalogProductVariant | null,
  priceNet: string,
): void {
  const now = new Date()
  em.persist(
    em.create(CatalogProductPrice, {
      id: randomUUID(),
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      product,
      variant,
      offer: null,
      priceKind,
      currencyCode: HORECA_CURRENCY,
      kind: priceKind.code,
      minQuantity: 1,
      unitPriceNet: priceNet,
      unitPriceGross: null,
      channelId: null,
      createdAt: now,
      updatedAt: now,
    }),
  )
}

/**
 * The next rebate tier is DERIVED, not invented per product: the supplier's next threshold sits a
 * quarter above today's annual volume and buys three more percentage points of discount. Without
 * these two columns the advisor's volume-threshold suggestion — "buy N more and your unit price
 * drops" — has nothing to compute against, and `product_cost` can never show headroom. The step is
 * uniform on purpose: it is an assumption, it is flagged `is_demo`, and a real supplier contract
 * replaces it through the purchase-position screen.
 */
const NEXT_TIER_VOLUME_STEP = 1.25
const NEXT_TIER_EXTRA_DISCOUNT_POINTS = 3

function deriveTiers(seed: HorecaProductSeed): {
  nextTierVolume: string | null
  nextTierDiscount: string | null
  soldQuantityPeriod: string | null
} {
  const annualVolume = Number(seed.annualVolume)
  const currentDiscount = Number(seed.tierDiscountPercent)
  return {
    nextTierVolume: Number.isFinite(annualVolume) ? (annualVolume * NEXT_TIER_VOLUME_STEP).toFixed(4) : null,
    nextTierDiscount: Number.isFinite(currentDiscount)
      ? (currentDiscount + NEXT_TIER_EXTRA_DISCOUNT_POINTS).toFixed(4)
      : null,
    // Sold quantity approximates a year of turnover at the seeded annual volume, so a
    // bought-vs-sold divergence check has a baseline to compare against.
    soldQuantityPeriod: Number.isFinite(annualVolume) ? (annualVolume * 0.92).toFixed(4) : null,
  }
}

function createPurchasePosition(
  em: EntityManager,
  scope: DistributorSeedScope,
  seed: HorecaProductSeed,
  productId: string,
  lastDeliveryAt: Date,
): void {
  const tiers = deriveTiers(seed)

  em.persist(
    em.create(PricingPurchasePosition, {
      id: randomUUID(),
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      isDemo: true,
      catalogProductId: productId,
      catalogVariantId: null,
      sku: seed.sku,
      annualVolume: seed.annualVolume,
      currentTierCode: seed.tierDiscountPercent === '0.0000' ? 'base' : 'tier_1',
      currentTierDiscount: seed.tierDiscountPercent,
      nextTierVolume: tiers.nextTierVolume,
      nextTierDiscount: tiers.nextTierDiscount,
      lastDeliveryUnitCost: seed.purchaseCostNet,
      lastDeliveryAt,
      lastDeliveryQuantity: null,
      // Sold quantity approximates a year of turnover at the seeded annual volume, so the
      // bought-vs-sold divergence check in `validate-supplier` has a baseline to compare against.
      soldQuantityPeriod: tiers.soldQuantityPeriod,
      productGroupCode: seed.categorySlug,
    }),
  )
}

function refreshPurchasePosition(
  position: PricingPurchasePosition,
  seed: HorecaProductSeed,
  lastDeliveryAt: Date,
): void {
  const tiers = deriveTiers(seed)
  position.sku = seed.sku
  position.annualVolume = seed.annualVolume
  position.currentTierCode = seed.tierDiscountPercent === '0.0000' ? 'base' : 'tier_1'
  position.currentTierDiscount = seed.tierDiscountPercent
  position.nextTierVolume = tiers.nextTierVolume
  position.nextTierDiscount = tiers.nextTierDiscount
  position.lastDeliveryUnitCost = seed.purchaseCostNet
  position.lastDeliveryAt = lastDeliveryAt
  position.soldQuantityPeriod = tiers.soldQuantityPeriod
  position.productGroupCode = seed.categorySlug
  position.deletedAt = null
}

/**
 * A product with no variant cannot hold stock: `wms_inventory_balances.catalog_variant_id` is NOT NULL,
 * and the sales line dialog walks product -> variant -> price. So every product gets at least one
 * variant, even when it has no real options — the standard "default variant" a catalog needs to be
 * sellable and stockable. It inherits the product's own weight and geometry, because that is what the
 * pricing engine's physical-aspect and warehouse components read.
 */
function createDefaultVariant(
  em: EntityManager,
  scope: DistributorSeedScope,
  seed: HorecaProductSeed,
  product: CatalogProduct,
  priceKind: CatalogPriceKind,
  now: Date,
): void {
  const variant = em.create(CatalogProductVariant, {
    id: randomUUID(),
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    product,
    name: seed.title,
    sku: `${seed.sku}-STD`,
    isDefault: true,
    optionValues: null,
    weightValue: seed.weightKg,
    weightUnit: 'kg',
    dimensions: {
      width: Number(seed.dimensionsCm.width),
      height: Number(seed.dimensionsCm.height),
      depth: Number(seed.dimensionsCm.length),
      unit: 'cm',
    },
    metadata: null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  })
  em.persist(variant)
  createPriceRow(em, scope, priceKind, product, variant, seed.priceNet)
}

export async function seedHorecaCatalog(
  em: EntityManager,
  scope: DistributorSeedScope,
  options: SeedRunOptions = {},
): Promise<SeedReport> {
  const report = emptyReport()
  const products = typeof options.limit === 'number' ? HORECA_PRODUCTS.slice(0, options.limit) : HORECA_PRODUCTS

  const handles = products.map((seed) => seed.handle)
  const existingRows = await em.find(CatalogProduct, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    handle: { $in: handles },
  })
  const existingByHandle = new Map(existingRows.map((row) => [(row.handle ?? '').toLowerCase(), row]))

  // Purchase positions for products this seeder already created, so a re-run refreshes costs and
  // rebate tiers in place instead of leaving them frozen at whatever the first run wrote.
  const existingPositions = existingRows.length
    ? await em.find(PricingPurchasePosition, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        catalogProductId: { $in: existingRows.map((row) => row.id) },
        deletedAt: null,
      })
    : []
  const positionsByProduct = new Map(existingPositions.map((row) => [row.catalogProductId, row]))

  // Which already-seeded products carry no variant at all. Stock cannot exist without one:
  // `wms_inventory_balances.catalog_variant_id` is NOT NULL, so a variant-less product can never
  // hold a balance, and the whole availability story stops at the catalog.
  const existingVariants = existingRows.length
    ? await em.find(CatalogProductVariant, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        product: { $in: existingRows.map((row) => row.id) },
      })
    : []
  const variantCountByProduct = new Map<string, number>()
  for (const variant of existingVariants) {
    const key = variant.product.id
    variantCountByProduct.set(key, (variantCountByProduct.get(key) ?? 0) + 1)
  }

  if (options.dryRun) {
    report.skipped = existingByHandle.size
    report.created = products.length - existingByHandle.size
    bump(report, 'categoriesPlanned', HORECA_CATEGORIES.length)
    report.warnings.push('[internal] dry run: nothing was written')
    return report
  }

  const priceKind = await ensurePriceKind(em, scope)
  const priceKindForBackfill = priceKind
  const categories = await ensureCategories(em, scope, report)

  // One shared timestamp keeps `last_delivery_at` deterministic within a run, so the
  // freshness warning in `product_cost` is a property of the data, not of the clock.
  const lastDeliveryAt = new Date()
  const now = new Date()

  for (const seed of products) {
    const alreadySeeded = existingByHandle.get(seed.handle.toLowerCase())
    if (alreadySeeded) {
      // Creation stays idempotent — nothing new is inserted. The physical attributes are refreshed
      // in place because the seeder owns them and because `product_aspects` and `warehouse_cost`
      // divide by them: a product seeded before a data correction would otherwise keep pricing off
      // stale geometry forever, with no signal that it is doing so.
      alreadySeeded.weightValue = seed.weightKg
      alreadySeeded.weightUnit = 'kg'
      alreadySeeded.dimensions = {
        width: Number(seed.dimensionsCm.width),
        height: Number(seed.dimensionsCm.height),
        depth: Number(seed.dimensionsCm.length),
        unit: 'cm',
      }
      if ((variantCountByProduct.get(alreadySeeded.id) ?? 0) === 0) {
        createDefaultVariant(em, scope, seed, alreadySeeded, priceKindForBackfill, now)
        bump(report, 'defaultVariantsBackfilled')
      }
      const existingPosition = positionsByProduct.get(alreadySeeded.id)
      if (existingPosition) {
        refreshPurchasePosition(existingPosition, seed, lastDeliveryAt)
        bump(report, 'purchasePositionsRefreshed')
      } else {
        createPurchasePosition(em, scope, seed, alreadySeeded.id, lastDeliveryAt)
        bump(report, 'purchasePositionsBackfilled')
      }
      report.skipped += 1
      bump(report, 'physicalAttributesRefreshed')
      continue
    }
    const category = categories.get(seed.categorySlug)
    if (!category) {
      report.warnings.push(`[internal] unknown categorySlug "${seed.categorySlug}" on product ${seed.handle}`)
      continue
    }

    const productId = randomUUID()
    const product = em.create(CatalogProduct, {
      id: productId,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      title: seed.title,
      description: seed.description,
      sku: seed.sku,
      handle: seed.handle,
      productType: seed.variants && seed.variants.length ? 'configurable' : 'simple',
      primaryCurrencyCode: HORECA_CURRENCY,
      defaultUnit: seed.baseUnit,
      weightValue: seed.weightKg,
      weightUnit: 'kg',
      // The catalog entity declares `{ width, height, depth, unit }` — there is no `length` key,
      // and `product_aspects` reads exactly those three to derive volume. Writing `length` here
      // would persist a shape nothing reads and leave the aspect component permanently blind.
      dimensions: {
        width: Number(seed.dimensionsCm.width),
        height: Number(seed.dimensionsCm.height),
        depth: Number(seed.dimensionsCm.length),
        unit: 'cm',
      },
      metadata: seed.hazmat ? { hazmat: true } : null,
      isConfigurable: Boolean(seed.variants && seed.variants.length),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    em.persist(product)
    report.created += 1
    bump(report, 'products')

    em.persist(
      em.create(CatalogProductCategoryAssignment, {
        id: randomUUID(),
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        product,
        category,
        position: 0,
        createdAt: now,
        updatedAt: now,
      }),
    )

    for (const conversion of seed.unitConversions) {
      em.persist(
        em.create(CatalogProductUnitConversion, {
          id: randomUUID(),
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          product,
          unitCode: conversion.unitCode,
          toBaseFactor: conversion.toBaseFactor,
          sortOrder: conversion.sortOrder,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        }),
      )
      bump(report, 'unitConversions')
    }

    createPriceRow(em, scope, priceKind, product, null, seed.priceNet)
    bump(report, 'prices')

    for (const variantSeed of seed.variants ?? []) {
      const variant = em.create(CatalogProductVariant, {
        id: randomUUID(),
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        product,
        name: variantSeed.name,
        sku: variantSeed.sku,
        isDefault: variantSeed.isDefault ?? false,
        optionValues: variantSeed.optionValues,
        weightValue: variantSeed.weightKg,
        weightUnit: 'kg',
        dimensions: {
          width: Number(variantSeed.dimensionsCm.width),
          height: Number(variantSeed.dimensionsCm.height),
          depth: Number(variantSeed.dimensionsCm.length),
          unit: 'cm',
        },
        metadata: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      em.persist(variant)
      bump(report, 'variants')
      createPriceRow(em, scope, priceKind, product, variant, variantSeed.priceNet)
      bump(report, 'prices')
    }

    if (!(seed.variants ?? []).length) {
      createDefaultVariant(em, scope, seed, product, priceKind, now)
      bump(report, 'defaultVariants')
    }

    createPurchasePosition(em, scope, seed, productId, lastDeliveryAt)
    bump(report, 'purchasePositions')
  }

  await em.flush()
  return report
}
