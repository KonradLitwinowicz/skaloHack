import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CatalogProduct, CatalogProductVariant } from '@open-mercato/core/modules/catalog/data/entities'
import {
  InventoryBalance,
  ProductInventoryProfile,
  Warehouse,
  WarehouseLocation,
  WarehouseZone,
} from '@open-mercato/core/modules/wms/data/entities'
import { HORECA_DEPOT } from './horecaCustomerData'
import { HORECA_PRODUCTS } from './horecaCatalogData'
import { bump, emptyReport, type DistributorSeedScope, type SeedReport, type SeedRunOptions } from './types'

/**
 * The distributor's single depot, its racking, and a stock position per product.
 *
 * This exists because three things downstream are blind without it: the portal cannot tell a customer
 * whether an item is available, `warehouse_cost` charges every product a flat 30-day occupancy because
 * it has no real days-on-hand to read, and nothing can reserve stock when an order is placed.
 *
 * The depot address is the same row the delivery-zone seeder measures distances from, so the origin
 * used for logistics and the origin stock ships from cannot drift apart.
 */
export const HORECA_WAREHOUSE_CODE = 'horeca-centralny'
const ZONE_CODE = 'horeca-strefa-skladowania'

/** Two weeks of cover at the seeded annual volume — the stock a distributor of this size would hold. */
const WEEKS_OF_COVER = 2
const WEEKS_PER_YEAR = 52

/**
 * Every 13th product is deliberately out of stock and every 7th sits below its reorder point.
 * A demo where everything is always available never exercises the availability path, and the first
 * time anyone sees an out-of-stock item would be in production. The selection is positional rather
 * than random so a re-run reproduces exactly the same picture.
 */
const OUT_OF_STOCK_EVERY = 13
const BELOW_REORDER_EVERY = 7

const RACK_COUNT = 12
const LEVELS_PER_RACK = 4

function locationCodeFor(index: number): string {
  const rack = (index % RACK_COUNT) + 1
  const level = (Math.floor(index / RACK_COUNT) % LEVELS_PER_RACK) + 1
  return `R${String(rack).padStart(2, '0')}-P${level}`
}

async function ensureWarehouse(em: EntityManager, scope: DistributorSeedScope, report: SeedReport): Promise<Warehouse> {
  const existing = await em.findOne(Warehouse, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    code: HORECA_WAREHOUSE_CODE,
  })
  if (existing) {
    bump(report, 'warehouseReused')
    return existing
  }
  const warehouse = em.create(Warehouse, {
    id: randomUUID(),
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    code: HORECA_WAREHOUSE_CODE,
    name: HORECA_DEPOT.label,
    isActive: true,
    isPrimary: true,
    addressLine1: HORECA_DEPOT.line1,
    city: HORECA_DEPOT.city,
    postalCode: HORECA_DEPOT.postalCode,
    country: HORECA_DEPOT.countryCode,
    timezone: 'Europe/Warsaw',
  })
  em.persist(warehouse)
  bump(report, 'warehouseCreated')
  return warehouse
}

async function ensureLocations(
  em: EntityManager,
  scope: DistributorSeedScope,
  warehouse: Warehouse,
  report: SeedReport,
): Promise<Map<string, WarehouseLocation>> {
  let zone = await em.findOne(WarehouseZone, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    code: ZONE_CODE,
  })
  if (!zone) {
    zone = em.create(WarehouseZone, {
      id: randomUUID(),
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      warehouse,
      code: ZONE_CODE,
      name: 'Strefa składowania',
      priority: 0,
    })
    em.persist(zone)
    bump(report, 'zonesCreated')
  }

  const wanted = new Set<string>()
  for (let index = 0; index < RACK_COUNT * LEVELS_PER_RACK; index += 1) wanted.add(locationCodeFor(index))

  const existing = await em.find(WarehouseLocation, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    code: { $in: [...wanted] },
  })
  const byCode = new Map(existing.map((row) => [row.code, row]))

  for (const code of wanted) {
    if (byCode.has(code)) continue
    const location = em.create(WarehouseLocation, {
      id: randomUUID(),
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      warehouse,
      code,
      type: 'rack',
      parent: null,
      isActive: true,
      capacityUnits: null,
      capacityWeight: null,
      constraints: null,
    })
    em.persist(location)
    byCode.set(code, location)
    bump(report, 'locationsCreated')
  }
  await em.flush()
  return byCode
}

type StockPlan = { onHand: string; reorderPoint: string; safetyStock: string; trackExpiration: boolean }

function planStock(annualVolume: string, index: number, hazmat: boolean): StockPlan {
  const yearly = Number(annualVolume)
  const weekly = Number.isFinite(yearly) && yearly > 0 ? yearly / WEEKS_PER_YEAR : 0
  const cover = Math.max(1, Math.round(weekly * WEEKS_OF_COVER))
  const reorderPoint = Math.max(1, Math.round(weekly))
  const safetyStock = Math.max(0, Math.round(weekly / 2))

  let onHand = cover
  if (index % OUT_OF_STOCK_EVERY === 0) onHand = 0
  else if (index % BELOW_REORDER_EVERY === 0) onHand = Math.max(0, Math.round(reorderPoint * 0.6))

  return {
    onHand: onHand.toFixed(4),
    reorderPoint: reorderPoint.toFixed(4),
    safetyStock: safetyStock.toFixed(4),
    // Chemicals carry a shelf life; packaging and paper do not.
    trackExpiration: hazmat,
  }
}

export async function seedHorecaWarehouse(
  em: EntityManager,
  scope: DistributorSeedScope,
  options: SeedRunOptions = {},
): Promise<SeedReport> {
  const report = emptyReport()
  const seeds = typeof options.limit === 'number' ? HORECA_PRODUCTS.slice(0, options.limit) : HORECA_PRODUCTS
  const handles = seeds.map((seed) => seed.handle)

  const products = await em.find(CatalogProduct, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    handle: { $in: handles },
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
  const defaultVariantByProduct = new Map<string, CatalogProductVariant>()
  for (const variant of variants) {
    const key = variant.product.id
    const current = defaultVariantByProduct.get(key)
    if (!current || (variant.isDefault && !current.isDefault)) defaultVariantByProduct.set(key, variant)
  }

  if (options.dryRun) {
    report.created = defaultVariantByProduct.size
    report.warnings.push('[internal] dry run: nothing was written')
    return report
  }

  const warehouse = await ensureWarehouse(em, scope, report)
  await em.flush()
  const locations = await ensureLocations(em, scope, warehouse, report)
  const locationList = [...locations.values()]

  const existingProfiles = await em.find(ProductInventoryProfile, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    catalogProductId: { $in: products.map((row) => row.id) },
  })
  const profileByProduct = new Map(existingProfiles.map((row) => [row.catalogProductId, row]))

  const variantIds = [...defaultVariantByProduct.values()].map((row) => row.id)
  const existingBalances = variantIds.length
    ? await em.find(InventoryBalance, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        catalogVariantId: { $in: variantIds },
      })
    : []
  const balanceByVariant = new Map(existingBalances.map((row) => [row.catalogVariantId, row]))

  let index = 0
  for (const seed of seeds) {
    const product = productByHandle.get(seed.handle.toLowerCase())
    if (!product) continue
    const variant = defaultVariantByProduct.get(product.id)
    if (!variant) {
      report.warnings.push(`[internal] product ${seed.handle} has no variant — stock cannot be recorded`)
      continue
    }

    const plan = planStock(seed.annualVolume, index, Boolean(seed.hazmat))
    const location = locationList[index % locationList.length]
    index += 1
    if (!location) continue

    const profile = profileByProduct.get(product.id)
    if (profile) {
      profile.reorderPoint = plan.reorderPoint
      profile.safetyStock = plan.safetyStock
      profile.trackExpiration = plan.trackExpiration
      bump(report, 'profilesUpdated')
    } else {
      em.persist(
        em.create(ProductInventoryProfile, {
          id: randomUUID(),
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          catalogProductId: product.id,
          catalogVariantId: variant.id,
          defaultUom: seed.baseUnit,
          trackLot: plan.trackExpiration,
          trackSerial: false,
          trackExpiration: plan.trackExpiration,
          // Chemicals with a shelf life ship earliest-expiry-first; everything else is first-in-first-out.
          defaultStrategy: plan.trackExpiration ? 'fefo' : 'fifo',
          reorderPoint: plan.reorderPoint,
          safetyStock: plan.safetyStock,
        }),
      )
      bump(report, 'profilesCreated')
    }

    const balance = balanceByVariant.get(variant.id)
    if (balance) {
      // `quantity_available` is a GENERATED STORED column (on hand - reserved - allocated) and must
      // never be written; setting the three inputs is the only way to move it.
      balance.quantityOnHand = plan.onHand
      bump(report, 'balancesUpdated')
    } else {
      em.persist(
        em.create(InventoryBalance, {
          id: randomUUID(),
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          warehouse,
          location,
          catalogVariantId: variant.id,
          lot: null,
          serialNumber: null,
          quantityOnHand: plan.onHand,
          quantityReserved: '0',
          quantityAllocated: '0',
        }),
      )
      bump(report, 'balancesCreated')
    }
    report.created += 1
  }

  await em.flush()
  return report
}
