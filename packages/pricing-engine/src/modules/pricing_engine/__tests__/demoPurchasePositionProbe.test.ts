import { PricingSupplierProfile } from '../data/entities'
import setup from '../setup'

const SCOPE = {
  tenantId: '04b4e92a-94a3-4b7d-8a7e-2450fc538b23',
  organizationId: 'ca70e868-f639-41ce-b509-9681c802abce',
}

class CatalogProductStub {
  id!: string
  sku!: string | null
}

type ProductRow = { id: string; sku: string | null }
type PositionRow = { catalogProductId: string; deletedAt: Date | null }

function createRecordingEm(products: ProductRow[], positions: PositionRow[]) {
  const probes: Array<Record<string, unknown>> = []
  const persisted: Array<Record<string, unknown>> = []
  const em = {
    async findOne(entity: unknown, where: Record<string, unknown>) {
      if (entity === PricingSupplierProfile) return { id: 'supplier-profile' }
      probes.push(where)
      const productId = where.catalogProductId as string
      const livesOnly = where.deletedAt === null
      return (
        positions.find(
          (row) => row.catalogProductId === productId && (!livesOnly || row.deletedAt === null),
        ) ?? null
      )
    },
    async find(entity: unknown) {
      return entity === CatalogProductStub ? products : []
    },
    create(_entity: unknown, data: Record<string, unknown>) {
      return { ...data }
    },
    persist(row: Record<string, unknown>) {
      persisted.push(row)
    },
    async flush() {},
  }
  return { em, probes, persisted }
}

const container = {
  resolve(name: string) {
    if (name === 'CatalogProduct') return CatalogProductStub
    throw new Error('[internal] unregistered service')
  },
}

async function runSeedExamples(products: ProductRow[], positions: PositionRow[]) {
  const recorder = createRecordingEm(products, positions)
  await setup.seedExamples?.({ em: recorder.em, container, ...SCOPE } as never)
  return recorder
}

describe('demo purchase position probe', () => {
  it('does not recreate a position that was soft-retired', async () => {
    const { persisted } = await runSeedExamples(
      [{ id: 'sneaker', sku: 'SNK-1' }],
      [{ catalogProductId: 'sneaker', deletedAt: new Date('2026-01-01') }],
    )

    expect(persisted).toHaveLength(0)
  })

  it('creates a position for a product that was never considered', async () => {
    const { persisted } = await runSeedExamples([{ id: 'horeca-1', sku: 'HOR-1' }], [])

    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      catalogProductId: 'horeca-1',
      sku: 'HOR-1',
      isDemo: true,
      ...SCOPE,
    })
  })

  it('does not duplicate a live position', async () => {
    const { persisted } = await runSeedExamples(
      [{ id: 'horeca-1', sku: 'HOR-1' }],
      [{ catalogProductId: 'horeca-1', deletedAt: null }],
    )

    expect(persisted).toHaveLength(0)
  })

  it('probes by product alone so a retired row stays visible to it', async () => {
    const { probes } = await runSeedExamples([{ id: 'sneaker', sku: null }], [])

    expect(probes).toHaveLength(1)
    expect(probes[0]).toEqual({ ...SCOPE, catalogProductId: 'sneaker' })
    expect(probes[0]).not.toHaveProperty('deletedAt')
  })

  it('seeds the products it has never seen while leaving retired ones retired', async () => {
    const { persisted } = await runSeedExamples(
      [
        { id: 'sneaker', sku: 'SNK-1' },
        { id: 'horeca-1', sku: 'HOR-1' },
        { id: 'wrap-dress', sku: 'DRS-1' },
      ],
      [
        { catalogProductId: 'sneaker', deletedAt: new Date('2026-01-01') },
        { catalogProductId: 'wrap-dress', deletedAt: new Date('2026-01-01') },
      ],
    )

    expect(persisted.map((row) => row.catalogProductId)).toEqual(['horeca-1'])
  })
})
