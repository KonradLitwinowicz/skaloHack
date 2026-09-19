import { retireForeignDemoPositions } from '../seed/catalogSeeder'
import type { DistributorSeedScope } from '../seed/types'

const SCOPE: DistributorSeedScope = {
  tenantId: '04b4e92a-94a3-4b7d-8a7e-2450fc538b23',
  organizationId: 'ca70e868-f639-41ce-b509-9681c802abce',
}

type PositionRow = { catalogProductId: string; deletedAt: Date | null }

function createRecordingEm(rows: PositionRow[]) {
  const wheres: Array<Record<string, unknown>> = []
  const em = {
    async find(_entity: unknown, where: Record<string, unknown>) {
      wheres.push(where)
      const excluded = ((where.catalogProductId as { $nin?: string[] } | undefined)?.$nin ?? []) as string[]
      return rows.filter((row) => row.deletedAt === null && !excluded.includes(row.catalogProductId))
    },
  }
  return { em, wheres }
}

describe('retireForeignDemoPositions', () => {
  it('retires a demo position whose product this seeder does not own', async () => {
    const foreign: PositionRow = { catalogProductId: 'sneaker', deletedAt: null }
    const { em } = createRecordingEm([foreign])

    const retired = await retireForeignDemoPositions(em as never, SCOPE, ['horeca-1', 'horeca-2'])

    expect(retired).toBe(1)
    expect(foreign.deletedAt).toBeInstanceOf(Date)
  })

  it('narrows the query by the owned set rather than filtering in memory', async () => {
    const { em, wheres } = createRecordingEm([{ catalogProductId: 'horeca-1', deletedAt: null }])

    await retireForeignDemoPositions(em as never, SCOPE, ['horeca-1'])

    expect(wheres).toHaveLength(1)
    expect(wheres[0]).toMatchObject({
      tenantId: SCOPE.tenantId,
      organizationId: SCOPE.organizationId,
      isDemo: true,
      deletedAt: null,
      catalogProductId: { $nin: ['horeca-1'] },
    })
  })

  it('leaves an owned position untouched', async () => {
    const owned: PositionRow = { catalogProductId: 'horeca-1', deletedAt: null }
    const { em } = createRecordingEm([owned])

    const retired = await retireForeignDemoPositions(em as never, SCOPE, ['horeca-1'])

    expect(retired).toBe(0)
    expect(owned.deletedAt).toBeNull()
  })

  // An empty owned set means the seed data itself is empty. Retiring every demo position then would
  // wipe the whole portal catalogue, which is far worse than doing nothing.
  it('does nothing at all when the owned set is empty', async () => {
    const survivor: PositionRow = { catalogProductId: 'sneaker', deletedAt: null }
    const { em, wheres } = createRecordingEm([survivor])

    const retired = await retireForeignDemoPositions(em as never, SCOPE, [])

    expect(retired).toBe(0)
    expect(wheres).toHaveLength(0)
    expect(survivor.deletedAt).toBeNull()
  })

  it('is idempotent: an already-retired position is not touched twice', async () => {
    const alreadyRetired: PositionRow = { catalogProductId: 'sneaker', deletedAt: new Date('2026-01-01') }
    const { em } = createRecordingEm([alreadyRetired])

    const retired = await retireForeignDemoPositions(em as never, SCOPE, ['horeca-1'])

    expect(retired).toBe(0)
    expect(alreadyRetired.deletedAt).toEqual(new Date('2026-01-01'))
  })
})
