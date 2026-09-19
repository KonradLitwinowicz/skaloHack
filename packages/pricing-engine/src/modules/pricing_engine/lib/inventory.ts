import type { EntityManager } from '@mikro-orm/postgresql'
import { add, div, format, min, toDecimal, ZERO, type Decimal } from './decimal'
import { tryResolve } from './catalog'
import type {
  InventoryRotationSource,
  InventorySnapshot,
  ProductInventorySnapshot,
  ProductLotSnapshot,
  ProductRotation,
} from './types'

// WMS is an OPTIONAL peer, reached through the entity classes it registers in DI — the same seam
// `catalog.ts` uses for CatalogProduct. No import from @open-mercato/core, no ORM relation between
// a pricing_* entity and a wms_* one, only foreign key uuids resolved by a second query.
const PROFILE_CLASS = 'ProductInventoryProfile'
const LOT_CLASS = 'InventoryLot'
const BALANCE_CLASS = 'InventoryBalance'
const MOVEMENT_CLASS = 'InventoryMovement'

/** Six months. Long enough that a slow mover shows a rate at all, short enough to track a real shift. */
export const ROTATION_WINDOW_DAYS = 180

/** Below this, the rate is noise — a product received last week has no measurable turnover. */
export const MIN_OBSERVED_DAYS = 30

/** A year of cover is already "this does not move"; beyond it the arithmetic stops being informative. */
export const MAX_COVER_DAYS = 365

const MS_PER_DAY = 86_400_000

type ProfileRow = {
  catalogProductId: string
  catalogVariantId?: string | null
  trackExpiration?: boolean
  defaultStrategy?: string | null
}

type LotRow = {
  id: string
  catalogVariantId: string
  lotNumber: string
  status?: string | null
  manufacturedAt?: Date | null
  bestBeforeAt?: Date | null
  expiresAt?: Date | null
}

type BalanceRow = {
  catalogVariantId: string
  lot?: { id?: string } | null
  quantityOnHand?: string | null
  quantityAvailable?: string | null
}

export type MovementRow = {
  catalogVariantId: string
  quantity?: string | null
  type?: string | null
  performedAt?: Date | null
  locationFrom?: { id?: string } | null
  locationTo?: { id?: string } | null
}

type ClassLike = new (...args: never[]) => unknown

// Types that take goods OUT of the building. `transfer`, `putaway`, `receipt` and `return_receive`
// never do. `adjust` and `cycle_count` go either way and are read from the sign.
const OUTBOUND_TYPES = new Set(['pick', 'ship', 'pack'])
const SIGNED_TYPES = new Set(['adjust', 'cycle_count'])

/**
 * How much this movement took off the shelf, as a non-negative quantity.
 *
 * Location decides before type does: `wms.inventory.move` writes whatever type the caller passes
 * while relocating stock between two locations of the SAME warehouse, so a movement carrying both
 * endpoints has a net effect of zero however it is labelled. Counting one as an issue would invent
 * demand out of a forklift trip and make every relocated product look fast-moving.
 */
export function issuedQuantityOf(row: MovementRow): Decimal {
  const quantity = toDecimal(row.quantity ?? '0')
  const from = row.locationFrom?.id ?? null
  const to = row.locationTo?.id ?? null
  if (from && to) return ZERO
  if (to && !from) return ZERO

  const type = row.type ?? ''
  if (OUTBOUND_TYPES.has(type)) return quantity < ZERO ? -quantity : quantity
  if (SIGNED_TYPES.has(type)) return quantity < ZERO ? -quantity : ZERO
  return ZERO
}

export type RotationArgs = {
  productId: string
  variantIds: string[]
  onHand: Decimal
  rows: MovementRow[]
  asOf: Date
  windowDays: number
  minObservedDays: number
  maxCoverDays: number
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY)
}

/**
 * Days of cover: how long the stock on hand lasts at the rate it has actually been leaving.
 *
 * `observedDays` is measured from the OLDEST movement in the window, not from the window width: a
 * product first received sixty days ago has sixty days of history, and dividing its issues by a
 * hundred and eighty would halve its apparent demand and triple its apparent cover.
 */
export function computeRotation(args: RotationArgs): ProductRotation {
  const windowStart = new Date(args.asOf.getTime() - args.windowDays * MS_PER_DAY)
  const inWindow = args.rows.filter((row) => row.performedAt != null && row.performedAt >= windowStart)

  let issued = ZERO
  let earliest: Date | null = null
  for (const row of inWindow) {
    issued = add(issued, issuedQuantityOf(row))
    const at = row.performedAt as Date
    if (!earliest || at < earliest) earliest = at
  }

  const observedDays = earliest ? Math.max(1, Math.min(args.windowDays, daysBetween(earliest, args.asOf))) : 0

  const base: Omit<ProductRotation, 'source' | 'coverDays'> = {
    productId: args.productId,
    variantIds: args.variantIds,
    onHandQuantity: format(args.onHand, 4),
    issuedQuantity: format(issued, 4),
    observedDays,
    dailyIssueRate: '0.0000',
  }

  if (inWindow.length === 0) return { ...base, coverDays: null, source: 'no_movements' }
  if (observedDays < args.minObservedDays) return { ...base, coverDays: null, source: 'short_history' }
  if (issued <= ZERO) return { ...base, coverDays: null, source: 'no_issues' }
  if (args.onHand <= ZERO) return { ...base, coverDays: null, source: 'no_stock' }

  const dailyRate = div(issued, toDecimal(String(observedDays)))
  const cover = min(div(args.onHand, dailyRate), toDecimal(String(args.maxCoverDays)))

  return {
    ...base,
    dailyIssueRate: format(dailyRate, 4),
    coverDays: format(cover, 4),
    source: 'movements',
  }
}

/** Expiry a lot is actually judged on. `best_before_at` stands in when no hard expiry is recorded. */
export function lotExpiryDate(lot: ProductLotSnapshot): Date | null {
  return lot.expiresAt ?? lot.bestBeforeAt ?? null
}

/**
 * FEFO order: earliest expiry first, lots without any expiry last. Ties break on lot number so two
 * runs of the same basket consume the same lots — a price that moves because a sort was unstable is
 * a price nobody can audit.
 */
export function sortFefo(lots: ProductLotSnapshot[]): ProductLotSnapshot[] {
  return [...lots].sort((left, right) => {
    const leftDate = lotExpiryDate(left)
    const rightDate = lotExpiryDate(right)
    if (leftDate && rightDate && leftDate.getTime() !== rightDate.getTime()) {
      return leftDate.getTime() - rightDate.getTime()
    }
    if (leftDate && !rightDate) return -1
    if (!leftDate && rightDate) return 1
    return left.lotNumber.localeCompare(right.lotNumber)
  })
}

function emptyRotation(productId: string, variantIds: string[], source: InventoryRotationSource): ProductRotation {
  return {
    productId,
    variantIds,
    onHandQuantity: '0.0000',
    issuedQuantity: '0.0000',
    observedDays: 0,
    dailyIssueRate: '0.0000',
    coverDays: null,
    source,
  }
}

export function emptyInventorySnapshot(): InventorySnapshot {
  return { byProductId: new Map(), rotationWindowDays: ROTATION_WINDOW_DAYS, available: false }
}

export type InventoryLoadOptions = {
  asOf: Date
  rotationWindowDays?: number
  minObservedDays?: number
  maxCoverDays?: number
}

/**
 * One prefetch for both consumers: the shelf-life ladder needs lots and their quantities, the
 * warehouse component needs issue history, and both need the same product-to-variant bridge. Four
 * queries, flat in basket size, in keeping with the O(1) rule ComponentDeps already follows.
 *
 * Every class comes through `tryResolve`, so a tenant running without WMS pays nothing: the
 * function returns an empty snapshot before issuing a single query, and both consumers fall back to
 * their configured defaults and say so on the assumptions panel.
 */
export async function loadInventorySnapshot(
  em: EntityManager,
  container: { resolve: (name: string) => unknown },
  scope: { tenantId: string; organizationId: string },
  productIds: string[],
  variantIdByProductId: Map<string, string>,
  options: InventoryLoadOptions,
): Promise<InventorySnapshot> {
  const uniqueIds = Array.from(new Set(productIds.filter(Boolean)))
  const windowDays = options.rotationWindowDays ?? ROTATION_WINDOW_DAYS
  if (uniqueIds.length === 0) return emptyInventorySnapshot()

  const profileClass = tryResolve<ClassLike>(container, PROFILE_CLASS)
  const lotClass = tryResolve<ClassLike>(container, LOT_CLASS)
  const balanceClass = tryResolve<ClassLike>(container, BALANCE_CLASS)
  const movementClass = tryResolve<ClassLike>(container, MOVEMENT_CLASS)
  if (!profileClass || !lotClass || !balanceClass || !movementClass) return emptyInventorySnapshot()

  const scopeFilter = { tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null }

  const profiles = (await em.find(profileClass, {
    ...scopeFilter,
    catalogProductId: { $in: uniqueIds },
  } as never)) as ProfileRow[]

  const variantsByProduct = new Map<string, string[]>()
  const productByVariant = new Map<string, string>()
  const profileByProduct = new Map<string, ProfileRow>()
  for (const profile of profiles) {
    profileByProduct.set(profile.catalogProductId, profile)
    // `catalog_variant_id` is nullable and a partial unique index exists for profiles without one.
    if (!profile.catalogVariantId) continue
    const list = variantsByProduct.get(profile.catalogProductId) ?? []
    list.push(profile.catalogVariantId)
    variantsByProduct.set(profile.catalogProductId, list)
    productByVariant.set(profile.catalogVariantId, profile.catalogProductId)
  }
  // The basket line may name a variant the profile table does not cover.
  for (const productId of uniqueIds) {
    const fromLine = variantIdByProductId.get(productId)
    if (!fromLine) continue
    const list = variantsByProduct.get(productId) ?? []
    if (!list.includes(fromLine)) list.push(fromLine)
    variantsByProduct.set(productId, list)
    productByVariant.set(fromLine, productId)
  }

  const allVariantIds = Array.from(productByVariant.keys())
  if (allVariantIds.length === 0) {
    const byProductId = new Map<string, ProductInventorySnapshot>()
    for (const productId of uniqueIds) {
      const profile = profileByProduct.get(productId) ?? null
      byProductId.set(productId, {
        productId,
        variantIds: [],
        trackExpiration: profile?.trackExpiration ?? false,
        defaultStrategy: (profile?.defaultStrategy as ProductInventorySnapshot['defaultStrategy']) ?? null,
        lots: [],
        rotation: emptyRotation(productId, [], 'unavailable'),
      })
    }
    return { byProductId, rotationWindowDays: windowDays, available: true }
  }

  const windowStart = new Date(options.asOf.getTime() - windowDays * MS_PER_DAY)
  const [lotRows, balanceRows, movementRows] = await Promise.all([
    em.find(lotClass, { ...scopeFilter, catalogVariantId: { $in: allVariantIds } } as never) as Promise<LotRow[]>,
    em.find(balanceClass, { ...scopeFilter, catalogVariantId: { $in: allVariantIds } } as never) as Promise<
      BalanceRow[]
    >,
    em.find(movementClass, {
      ...scopeFilter,
      catalogVariantId: { $in: allVariantIds },
      performedAt: { $gte: windowStart },
    } as never) as Promise<MovementRow[]>,
  ])

  const lotById = new Map<string, LotRow>()
  for (const row of lotRows) lotById.set(row.id, row)

  // `quantity_available` is a STORED generated column (on hand minus reserved minus allocated), so
  // it is only ever read. The ladder prices what can actually be picked, not what is on the shelf.
  const availableByLot = new Map<string, Decimal>()
  const onHandByProduct = new Map<string, Decimal>()
  for (const row of balanceRows) {
    const productId = productByVariant.get(row.catalogVariantId)
    if (!productId) continue
    onHandByProduct.set(
      productId,
      add(onHandByProduct.get(productId) ?? ZERO, toDecimal(row.quantityOnHand ?? '0')),
    )
    const lotId = row.lot?.id ?? null
    if (!lotId) continue
    availableByLot.set(lotId, add(availableByLot.get(lotId) ?? ZERO, toDecimal(row.quantityAvailable ?? '0')))
  }

  const movementsByProduct = new Map<string, MovementRow[]>()
  for (const row of movementRows) {
    const productId = productByVariant.get(row.catalogVariantId)
    if (!productId) continue
    const list = movementsByProduct.get(productId) ?? []
    list.push(row)
    movementsByProduct.set(productId, list)
  }

  const lotsByProduct = new Map<string, ProductLotSnapshot[]>()
  for (const [lotId, quantity] of availableByLot) {
    const lot = lotById.get(lotId)
    if (!lot) continue
    const productId = productByVariant.get(lot.catalogVariantId)
    if (!productId) continue
    const list = lotsByProduct.get(productId) ?? []
    list.push({
      lotId: lot.id,
      lotNumber: lot.lotNumber,
      status: (lot.status as ProductLotSnapshot['status']) ?? 'available',
      manufacturedAt: lot.manufacturedAt ?? null,
      bestBeforeAt: lot.bestBeforeAt ?? null,
      expiresAt: lot.expiresAt ?? null,
      quantityAvailable: format(quantity, 4),
    })
    lotsByProduct.set(productId, list)
  }

  const byProductId = new Map<string, ProductInventorySnapshot>()
  for (const productId of uniqueIds) {
    const profile = profileByProduct.get(productId) ?? null
    const variantIds = variantsByProduct.get(productId) ?? []
    byProductId.set(productId, {
      productId,
      variantIds,
      trackExpiration: profile?.trackExpiration ?? false,
      defaultStrategy: (profile?.defaultStrategy as ProductInventorySnapshot['defaultStrategy']) ?? null,
      lots: sortFefo(lotsByProduct.get(productId) ?? []),
      rotation: computeRotation({
        productId,
        variantIds,
        onHand: onHandByProduct.get(productId) ?? ZERO,
        rows: movementsByProduct.get(productId) ?? [],
        asOf: options.asOf,
        windowDays,
        minObservedDays: options.minObservedDays ?? MIN_OBSERVED_DAYS,
        maxCoverDays: options.maxCoverDays ?? MAX_COVER_DAYS,
      }),
    })
  }

  return { byProductId, rotationWindowDays: windowDays, available: true }
}
