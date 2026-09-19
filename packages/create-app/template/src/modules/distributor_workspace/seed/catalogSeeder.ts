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
import { resolveUnitDictionary } from '@open-mercato/core/modules/catalog/lib/unitResolution'
import { canonicalizeUnitCode } from '@open-mercato/shared/lib/units/unitCodes'
import { DictionaryEntry } from '@open-mercato/core/modules/dictionaries/data/entities'
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
 * Soft-retire demo purchase positions that belong to products this seeder does not own.
 *
 * `pricing_engine`'s own bootstrap seeder (`setup.ts`, `seedDemoPurchasePositions`) takes the first
 * N catalog products by id and hands each one a HoReCa-sounding `product_group_code`. On this tenant
 * that put chemistry and packaging costs on a sneaker, a wrap dress and two salon services — and the
 * portal lists exactly the products that HAVE a purchase position, so all four showed up in a
 * wholesale HoReCa catalogue.
 *
 * Retiring the POSITION rather than the product is deliberate: spec D1 says the existing USD demo
 * rows are left untouched, and the position is the row that makes a product orderable here.
 * Filtering the portal query by a `horeca-` handle prefix was rejected — it would weld the portal's
 * runtime contract to a seed naming convention, so a real distributor's own products would silently
 * vanish from their own portal.
 *
 * Soft delete, not `em.remove()`: the row is evidence of what the demo seeder did, and the pricing
 * ledger may already reference the cost it carried.
 */
export async function retireForeignDemoPositions(
  em: EntityManager,
  scope: DistributorSeedScope,
  ownedProductIds: string[],
): Promise<number> {
  // An empty owned set would retire EVERY demo position, including the 200 this seeder just wrote.
  // That can only happen if the seed data itself is empty, and silently wiping the catalogue is a
  // far worse outcome than doing nothing.
  if (ownedProductIds.length === 0) return 0

  const foreign = await em.find(PricingPurchasePosition, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    isDemo: true,
    deletedAt: null,
    catalogProductId: { $nin: ownedProductIds },
  })
  const now = new Date()
  for (const position of foreign) position.deletedAt = now
  return foreign.length
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

/**
 * Labels for the units this catalog introduces, in the "Name (dimension)" shape the platform's own
 * unit entries already use, so an operator opening the dictionary cannot tell which rows the
 * distributor seed added.
 */
const HORECA_UNIT_LABELS: Record<string, string> = {
  pack: 'Pack (piece)',
  pallet: 'Pallet (piece)',
}

/**
 * Registers every unit code this catalog sells in, because a product measured in a unit the tenant
 * dictionary has never heard of cannot be ordered at all.
 *
 * The failure it prevents is silent until the worst possible moment. The catalog accepts
 * `base_unit: 'pack'` without complaint and the product looks perfectly healthy on every screen —
 * but `assertUnitExists` (sales/commands/documents.ts) resolves the unit against the tenant's unit
 * dictionary when an ORDER LINE is written, and the platform's shipped dictionary carries `pkg`,
 * not `pack`. Measured on this dataset before the fix: 90 of 204 HoReCa products were unorderable
 * through `/api/sales/orders`, each failing with `uom.unit_not_found` at checkout.
 *
 * Codes come from the seed data rather than a list kept here, so adding a product in a new unit
 * cannot reintroduce the gap.
 */
async function ensureCatalogUnits(
  em: EntityManager,
  scope: DistributorSeedScope,
  report: SeedReport,
): Promise<void> {
  const required = new Set<string>()
  for (const seed of HORECA_PRODUCTS) {
    const base = canonicalizeUnitCode(seed.baseUnit)
    if (base) required.add(base)
    for (const conversion of seed.unitConversions) {
      const code = canonicalizeUnitCode(conversion.unitCode)
      if (code) required.add(code)
    }
  }
  if (required.size === 0) return

  const dictionary = await resolveUnitDictionary(em, scope.organizationId, scope.tenantId)
  if (!dictionary) {
    report.warnings.push(
      'No unit dictionary found for this tenant - products will not be orderable until one exists.',
    )
    return
  }

  const existing = await em.find(DictionaryEntry, {
    dictionary,
    organizationId: dictionary.organizationId,
    tenantId: dictionary.tenantId,
    normalizedValue: { $in: [...required] },
  })
  const known = new Set(existing.map((entry) => entry.normalizedValue))
  const now = new Date()

  for (const code of required) {
    if (known.has(code)) continue
    em.persist(
      em.create(DictionaryEntry, {
        id: randomUUID(),
        dictionary,
        organizationId: dictionary.organizationId,
        tenantId: dictionary.tenantId,
        value: code,
        normalizedValue: code,
        label: HORECA_UNIT_LABELS[code] ?? code,
        position: 0,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      }),
    )
    bump(report, 'unitsRegistered')
  }
  await em.flush()
}

export async function seedHorecaCatalog(
  em: EntityManager,
  scope: DistributorSeedScope,
  options: SeedRunOptions = {},
): Promise<SeedReport> {
  const report = emptyReport()
  const products = typeof options.limit === 'number' ? HORECA_PRODUCTS.slice(0, options.limit) : HORECA_PRODUCTS

  // The FULL seed set, never the `--count` slice: `ownedProductIds` is what decides which positions
  // are foreign, and a `--count 10` run must not conclude that the other 190 HoReCa products belong
  // to somebody else and retire them.
  const handles = HORECA_PRODUCTS.map((seed) => seed.handle)
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
    const plannedExisting = products.filter((seed) => existingByHandle.has(seed.handle.toLowerCase())).length
    report.skipped = plannedExisting
    report.created = products.length - plannedExisting
    bump(report, 'categoriesPlanned', HORECA_CATEGORIES.length)
    report.warnings.push('[internal] dry run: nothing was written')
    return report
  }

  await ensureCatalogUnits(em, scope, report)
  const priceKind = await ensurePriceKind(em, scope)
  const priceKindForBackfill = priceKind
  const categories = await ensureCategories(em, scope, report)

  // One shared timestamp keeps `last_delivery_at` deterministic within a run, so the
  // freshness warning in `product_cost` is a property of the data, not of the clock.
  const lastDeliveryAt = new Date()
  const now = new Date()

  // Every product this seeder owns, whether written now or on an earlier run. Built from the full
  // seed set rather than the loop, so `--count` narrows what is WRITTEN without narrowing what is
  // recognised as ours.
  const ownedProductIds = new Set<string>()
  for (const seed of HORECA_PRODUCTS) {
    const existing = existingByHandle.get(seed.handle.toLowerCase())
    if (existing) ownedProductIds.add(existing.id)
  }

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
    ownedProductIds.add(productId)
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

  const retired = await retireForeignDemoPositions(em, scope, [...ownedProductIds])
  if (retired) bump(report, 'foreignDemoPositionsRetired', retired)

  await em.flush()
  return report
}
