import { createHash } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { User } from '@open-mercato/core/modules/auth/data/entities'
import { computeEmailHash } from '@open-mercato/core/modules/auth/lib/emailHash'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  InventoryBalance,
  InventoryMovement,
  Warehouse,
  type InventoryMovementReferenceType,
  type InventoryMovementType,
} from '@open-mercato/core/modules/wms/data/entities'
import { DISTRIBUTOR_BACKEND_ACCOUNT } from './accountsSeeder'
import { HORECA_WAREHOUSE_CODE } from './warehouseSeeder'
import {
  DAYS_PER_WEEK,
  historyWeeksFor,
  MOVEMENT_HISTORY_MONTHS,
  MOVEMENT_IDEMPOTENCY_PREFIX,
  MOVEMENT_REFERENCE_NAMESPACE,
  RECEIPT_EVERY_WEEKS,
  seasonalMultiplierFor,
  targetCoverDaysFor,
} from './movementPlanData'
import { bump, emptyReport, type DistributorSeedScope, type SeedReport, type SeedRunOptions } from './types'

/**
 * Historia przyjęć i wydań dla depotu HoReCa.
 *
 * Bez niej tabela wms_inventory_movements jest pusta, a komponent warehouse_cost nie ma z czego
 * policzyć rotacji i każdemu produktowi liczy domyślne 30 dni składowania. Seeder odtwarza taki
 * ruch, jaki wytłumaczyłby stan, który już leży na półce - stan i lokalizacja pochodzą z
 * istniejących bilansów tego magazynu, a nie z drugiego, równoległego wyliczenia.
 */
const MS_PER_DAY = 86_400_000
const QUANTITY_DP = 4

export type MovementPlanBalance = {
  catalogVariantId: string
  locationId: string
  quantityOnHand: string
}

export type PlannedMovement = {
  catalogVariantId: string
  locationId: string
  type: InventoryMovementType
  referenceType: InventoryMovementReferenceType
  referenceId: string
  quantity: string
  weeksAgo: number
  performedAt: Date
  receivedAt: Date
  idempotencyKey: string
}

function hexToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

/**
 * Identyfikator dokumentu źródłowego liczony z nazwy, a nie losowany.
 *
 * To RFC 4122 v5: SHA-1 z przestrzeni nazw i nazwy, z ustawionymi bitami wersji i wariantu.
 * randomUUID() zerwałby determinizm dokładnie tak samo jak Math.random - drugi przebieg
 * wyprodukowałby inne reference_id przy tym samym kluczu idempotencji.
 */
function deterministicUuid(name: string): string {
  const digest = createHash('sha1').update(hexToBytes(MOVEMENT_REFERENCE_NAMESPACE)).update(name, 'utf8').digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

/**
 * Klucz idempotencji celowo NIE zawiera daty kalendarzowej.
 *
 * Oś jest względna - numer tygodnia wstecz - więc przebieg jutrzejszy trafia w te same klucze co
 * dzisiejszy i nie dokłada historii drugi raz. Gdyby klucz niósł dzisiejszą datę, każde kolejne
 * uruchomienie podwajałoby wydania i zaniżało rotację o tyle, ile razy ktoś odpalił seeder.
 */
function idempotencyKeyFor(variantId: string, type: InventoryMovementType, weeksAgo: number): string {
  return `${MOVEMENT_IDEMPOTENCY_PREFIX}:${variantId}:${type}:w${weeksAgo}`
}

function quantityText(value: number): string {
  return value.toFixed(QUANTITY_DP)
}

/**
 * Czysta funkcja planująca: te same bilanse i ta sama chwila dają ten sam plan, co do bajtu.
 * Kolejność wejścia nie ma znaczenia - bilanse są sortowane po wariancie, więc pozycyjny rozrzut
 * docelowych dni pokrycia nie zależy od tego, w jakiej kolejności baza zwróciła wiersze.
 */
export function planMovements(
  balances: MovementPlanBalance[],
  now: Date,
  months: number,
): PlannedMovement[] {
  const ordered = [...balances].sort((left, right) =>
    left.catalogVariantId.localeCompare(right.catalogVariantId),
  )
  const totalWeeks = historyWeeksFor(months)
  const planned: PlannedMovement[] = []

  let index = 0
  for (const balance of ordered) {
    const onHand = Number(balance.quantityOnHand)
    const position = index
    index += 1
    // Produkt bez stanu nie wydał niczego, co dałoby się uczciwie zaksięgować - wymyślone wydanie
    // zrobiłoby z pozycji wyprzedanej pozycję szybko rotującą.
    if (!Number.isFinite(onHand) || onHand <= 0) continue

    const targetCoverDays = targetCoverDaysFor(position)
    const weeklyBase = (onHand / targetCoverDays) * DAYS_PER_WEEK

    for (let weeksAgo = totalWeeks; weeksAgo >= 1; weeksAgo -= 1) {
      const performedAt = new Date(now.getTime() - weeksAgo * DAYS_PER_WEEK * MS_PER_DAY)

      if (weeksAgo % RECEIPT_EVERY_WEEKS === 0) {
        const received = Math.round(weeklyBase * RECEIPT_EVERY_WEEKS)
        if (received > 0) {
          const key = idempotencyKeyFor(balance.catalogVariantId, 'receipt', weeksAgo)
          planned.push({
            catalogVariantId: balance.catalogVariantId,
            locationId: balance.locationId,
            type: 'receipt',
            referenceType: 'po',
            referenceId: deterministicUuid(key),
            quantity: quantityText(received),
            weeksAgo,
            performedAt,
            receivedAt: performedAt,
            idempotencyKey: key,
          })
        }
      }

      const issued = Math.round(weeklyBase * seasonalMultiplierFor(weeksAgo))
      if (issued <= 0) continue
      const key = idempotencyKeyFor(balance.catalogVariantId, 'pick', weeksAgo)
      planned.push({
        catalogVariantId: balance.catalogVariantId,
        locationId: balance.locationId,
        type: 'pick',
        referenceType: 'so',
        referenceId: deterministicUuid(key),
        quantity: quantityText(issued),
        weeksAgo,
        performedAt,
        receivedAt: performedAt,
        idempotencyKey: key,
      })
    }
  }

  return planned
}

async function resolvePerformedBy(
  em: EntityManager,
  scope: DistributorSeedScope,
): Promise<string | null> {
  const emailHash = computeEmailHash(DISTRIBUTOR_BACKEND_ACCOUNT.email)
  const user = await findOneWithDecryption(
    em,
    User,
    { emailHash, tenantId: scope.tenantId, deletedAt: null },
    {},
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  return user?.id ?? null
}

export async function seedHorecaMovements(
  em: EntityManager,
  scope: DistributorSeedScope,
  options: SeedRunOptions = {},
): Promise<SeedReport> {
  const report = emptyReport()

  const warehouse = await em.findOne(Warehouse, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    code: HORECA_WAREHOUSE_CODE,
  })
  if (!warehouse) {
    report.warnings.push('[internal] no HoReCa warehouse found — run seed-horeca-warehouse first')
    return report
  }

  const allBalances = await em.find(InventoryBalance, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    warehouse: warehouse.id,
  })
  const usable = allBalances.filter((row) => Boolean(row.location))
  if (!usable.length) {
    report.warnings.push('[internal] no stock balances with a location — run seed-horeca-warehouse first')
    return report
  }
  const balances = typeof options.limit === 'number' ? usable.slice(0, options.limit) : usable
  const balanceByVariant = new Map(balances.map((row) => [row.catalogVariantId, row]))

  // Jedno wspólne "teraz" na przebieg: historia ma być spójna w obrębie uruchomienia, a nie
  // przesuwać się o milisekundy między kolejnymi wierszami.
  const now = new Date()
  const plan = planMovements(
    balances.map((row) => ({
      catalogVariantId: row.catalogVariantId,
      locationId: row.location.id,
      quantityOnHand: row.quantityOnHand,
    })),
    now,
    options.months ?? MOVEMENT_HISTORY_MONTHS,
  )

  if (options.dryRun) {
    report.created = plan.length
    bump(report, 'plannedMovements', plan.length)
    report.warnings.push('[internal] dry run: nothing was written')
    return report
  }

  const performedBy = await resolvePerformedBy(em, scope)
  if (!performedBy) {
    report.warnings.push(
      '[internal] distributor backend user is missing — run seed-distributor-accounts first',
    )
    return report
  }

  const keys = plan.map((row) => row.idempotencyKey)
  const existing = keys.length
    ? await em.find(InventoryMovement, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        idempotencyKey: { $in: keys },
      })
    : []
  const seenKeys = new Set(existing.map((row) => row.idempotencyKey ?? ''))

  for (const movement of plan) {
    if (seenKeys.has(movement.idempotencyKey)) {
      report.skipped += 1
      bump(report, 'movementsSkipped')
      continue
    }
    const balance = balanceByVariant.get(movement.catalogVariantId)
    if (!balance) continue
    const outbound = movement.type === 'pick'
    em.persist(
      em.create(InventoryMovement, {
        id: deterministicUuid(`id:${movement.idempotencyKey}`),
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        warehouse,
        // Wydanie ma tylko locationFrom, przyjęcie tylko locationTo. Ruch z obiema stronami to
        // relokacja wewnątrz magazynu i issuedQuantityOf policzyłby go jako zero.
        locationFrom: outbound ? balance.location : null,
        locationTo: outbound ? null : balance.location,
        catalogVariantId: movement.catalogVariantId,
        lot: null,
        serialNumber: null,
        quantity: movement.quantity,
        type: movement.type,
        referenceType: movement.referenceType,
        referenceId: movement.referenceId,
        performedBy,
        performedAt: movement.performedAt,
        receivedAt: movement.receivedAt,
        reason: null,
        reasonCode: null,
        idempotencyKey: movement.idempotencyKey,
      }),
    )
    seenKeys.add(movement.idempotencyKey)
    report.created += 1
    bump(report, outbound ? 'issuesCreated' : 'receiptsCreated')
  }

  await em.flush()
  return report
}
