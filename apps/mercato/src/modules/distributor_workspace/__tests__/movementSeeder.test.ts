import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EntityManager } from '@mikro-orm/postgresql'
import { InventoryMovement, Warehouse } from '@open-mercato/core/modules/wms/data/entities'
import {
  planMovements,
  seedHorecaMovements,
  type MovementPlanBalance,
  type PlannedMovement,
} from '../seed/movementSeeder'
import { MOVEMENT_HISTORY_MONTHS, WEEKS_PER_MONTH } from '../seed/movementPlanData'
import type { DistributorSeedScope } from '../seed/types'

const findOneWithDecryptionMock = jest.fn()
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
  findWithDecryption: jest.fn(),
}))

const SCOPE: DistributorSeedScope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}

const NOW = new Date('2026-09-18T09:00:00.000Z')
const NEXT_DAY = new Date('2026-09-19T09:00:00.000Z')

const VARIANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const VARIANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const VARIANT_EMPTY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const BALANCES: MovementPlanBalance[] = [
  { catalogVariantId: VARIANT_B, locationId: 'location-b', quantityOnHand: '240.0000' },
  { catalogVariantId: VARIANT_A, locationId: 'location-a', quantityOnHand: '120.0000' },
  { catalogVariantId: VARIANT_EMPTY, locationId: 'location-c', quantityOnHand: '0.0000' },
]

function keysOf(plan: PlannedMovement[]): string[] {
  return plan.map((row) => row.idempotencyKey)
}

describe('planMovements', () => {
  it('produces the same plan byte for byte on every run', () => {
    const first = planMovements(BALANCES, NOW, MOVEMENT_HISTORY_MONTHS)
    const second = planMovements(BALANCES, NOW, MOVEMENT_HISTORY_MONTHS)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first.length).toBeGreaterThan(0)
  })

  it('does not depend on the order the database returned the balances in', () => {
    const forwards = planMovements(BALANCES, NOW, MOVEMENT_HISTORY_MONTHS)
    const backwards = planMovements([...BALANCES].reverse(), NOW, MOVEMENT_HISTORY_MONTHS)
    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards))
  })

  it('leaves no randomness in the module that could move a price between runs', () => {
    const seedDir = join(__dirname, '..', 'seed')
    for (const file of ['movementSeeder.ts', 'movementPlanData.ts']) {
      // Comments are stripped first: this file explains WHY randomUUID is refused, and a naive
      // substring scan would fail on the explanation instead of on a real call.
      const code = readFileSync(join(seedDir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      expect(code).not.toContain('Math.random')
      expect(code).not.toContain('randomUUID')
      expect(code).not.toContain('Date.now')
    }
  })

  it('carries every field the movement entity requires', () => {
    const plan = planMovements(BALANCES, NOW, MOVEMENT_HISTORY_MONTHS)
    for (const movement of plan) {
      expect(movement.catalogVariantId).toBeTruthy()
      expect(movement.locationId).toBeTruthy()
      expect(['pick', 'receipt']).toContain(movement.type)
      expect(['so', 'po']).toContain(movement.referenceType)
      expect(movement.referenceId).toMatch(UUID_PATTERN)
      expect(Number(movement.quantity)).toBeGreaterThan(0)
      expect(movement.performedAt.getTime()).toBeLessThan(NOW.getTime())
      expect(movement.receivedAt.getTime()).toBe(movement.performedAt.getTime())
      expect(movement.idempotencyKey.startsWith('horeca-seed:')).toBe(true)
    }
  })

  it('writes issues that the rotation reader will count, and receipts it will ignore', () => {
    const plan = planMovements(BALANCES, NOW, MOVEMENT_HISTORY_MONTHS)
    const issues = plan.filter((row) => row.type === 'pick')
    const receipts = plan.filter((row) => row.type === 'receipt')
    expect(issues.length).toBeGreaterThan(0)
    expect(receipts.length).toBeGreaterThan(0)
  })

  it('keeps the whole history inside the rotation window the engine reads', () => {
    const plan = planMovements(BALANCES, NOW, MOVEMENT_HISTORY_MONTHS)
    const oldest = Math.min(...plan.map((row) => row.performedAt.getTime()))
    const spanDays = (NOW.getTime() - oldest) / 86_400_000
    expect(spanDays).toBeLessThanOrEqual(180)
    expect(spanDays).toBe(MOVEMENT_HISTORY_MONTHS * WEEKS_PER_MONTH * 7)
  })

  it('invents no issues for a product with nothing on the shelf', () => {
    const plan = planMovements(BALANCES, NOW, MOVEMENT_HISTORY_MONTHS)
    expect(plan.some((row) => row.catalogVariantId === VARIANT_EMPTY)).toBe(false)
    expect(plan.some((row) => row.catalogVariantId === VARIANT_A && row.type === 'pick')).toBe(true)
  })

  it('shortens the history when fewer months are asked for', () => {
    const short = planMovements(BALANCES, NOW, 2)
    const long = planMovements(BALANCES, NOW, MOVEMENT_HISTORY_MONTHS)
    expect(short.length).toBeLessThan(long.length)
    expect(Math.max(...short.map((row) => row.weeksAgo))).toBe(2 * WEEKS_PER_MONTH)
  })

  it('keys idempotency to a relative week, so a run on another day adds nothing', () => {
    const today = planMovements(BALANCES, NOW, MOVEMENT_HISTORY_MONTHS)
    const tomorrow = planMovements(BALANCES, NEXT_DAY, MOVEMENT_HISTORY_MONTHS)
    expect(keysOf(tomorrow)).toEqual(keysOf(today))
    expect(tomorrow.map((row) => row.referenceId)).toEqual(today.map((row) => row.referenceId))
    for (const key of keysOf(today)) expect(key).not.toContain('2026-09')
  })
})

type Created = { type: unknown; data: Record<string, unknown> }

function recordingEm(existingKeys: string[]): { em: EntityManager; persisted: Created[] } {
  const persisted: Created[] = []
  const warehouse = { id: 'warehouse-1', code: 'horeca-centralny' }
  const balances = BALANCES.map((row) => ({
    catalogVariantId: row.catalogVariantId,
    location: { id: row.locationId },
    warehouse,
    quantityOnHand: row.quantityOnHand,
  }))
  const em = {
    async findOne(type: unknown) {
      return type === Warehouse ? warehouse : null
    },
    async find(type: unknown) {
      if (type === InventoryMovement) return existingKeys.map((idempotencyKey) => ({ idempotencyKey }))
      return balances
    },
    create(type: unknown, data: Record<string, unknown>) {
      return { ...data, __type: type }
    },
    persist(entity: Record<string, unknown>) {
      persisted.push({ type: entity.__type, data: entity })
      return em
    },
    async flush() {
      return undefined
    },
  } as unknown as EntityManager
  return { em, persisted }
}

beforeEach(() => {
  findOneWithDecryptionMock.mockReset()
  findOneWithDecryptionMock.mockResolvedValue({ id: 'user-1' })
})

describe('seedHorecaMovements', () => {
  it('writes the planned history once and skips it entirely on a second run', async () => {
    const first = recordingEm([])
    const firstReport = await seedHorecaMovements(first.em, SCOPE)
    expect(firstReport.created).toBeGreaterThan(0)
    expect(first.persisted.every((row) => row.type === InventoryMovement)).toBe(true)

    const writtenKeys = first.persisted.map((row) => String(row.data.idempotencyKey))
    const second = recordingEm(writtenKeys)
    const secondReport = await seedHorecaMovements(second.em, SCOPE)
    expect(secondReport.created).toBe(0)
    expect(second.persisted).toHaveLength(0)
    expect(secondReport.skipped).toBe(firstReport.created)
  })

  it('sets only the source location on an issue and only the target on a receipt', async () => {
    const { em, persisted } = recordingEm([])
    await seedHorecaMovements(em, SCOPE)
    for (const row of persisted) {
      const isIssue = row.data.type === 'pick'
      expect(Boolean(row.data.locationFrom)).toBe(isIssue)
      expect(Boolean(row.data.locationTo)).toBe(!isIssue)
      expect(row.data.performedBy).toBe('user-1')
      expect(row.data.tenantId).toBe(SCOPE.tenantId)
      expect(row.data.organizationId).toBe(SCOPE.organizationId)
    }
  })

  it('writes nothing on a dry run', async () => {
    const { em, persisted } = recordingEm([])
    const report = await seedHorecaMovements(em, SCOPE, { dryRun: true })
    expect(persisted).toHaveLength(0)
    expect(report.created).toBeGreaterThan(0)
    expect(report.warnings).toContain('[internal] dry run: nothing was written')
  })

  it('refuses to write without the user every movement row must be attributed to', async () => {
    findOneWithDecryptionMock.mockResolvedValue(null)
    const { em, persisted } = recordingEm([])
    const report = await seedHorecaMovements(em, SCOPE)
    expect(persisted).toHaveLength(0)
    expect(report.created).toBe(0)
    expect(report.warnings.join(' ')).toContain('seed-distributor-accounts')
  })
})
