import { loadSalesRowsFromSql } from '../lib/deadstock/loader'

const SCOPE = {
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}
const TABLES = { orders: 'sales_orders', lines: 'sales_order_lines' }
const SINCE = new Date('2025-07-01T00:00:00.000Z')

function makeEm(rows: unknown[]) {
  const execute = jest.fn(async () => rows)
  return { em: { getConnection: () => ({ execute }) } as never, execute }
}

function sqlRow(overrides: Record<string, unknown> = {}) {
  return {
    product_id: 'p-1',
    order_id: 'o-1',
    customer_entity_id: 'c-1',
    occurred_at: new Date('2026-02-02T10:00:00.000Z'),
    quantity: '4',
    total_net_amount: '120.00',
    ...overrides,
  }
}

describe('deadstock sales rows', () => {
  it('groups rows by product and keeps the six fields the metrics read', async () => {
    const { em } = makeEm([
      sqlRow(),
      sqlRow({ order_id: 'o-2', quantity: '2', total_net_amount: '60.00' }),
      sqlRow({ product_id: 'p-2', order_id: 'o-3' }),
    ])

    const grouped = await loadSalesRowsFromSql(em, SCOPE, ['p-1', 'p-2'], SINCE, TABLES)

    expect(grouped.get('p-1')).toHaveLength(2)
    expect(grouped.get('p-2')).toHaveLength(1)
    expect(grouped.get('p-1')?.[0]).toEqual({
      productId: 'p-1',
      orderId: 'o-1',
      customerId: 'c-1',
      occurredAt: new Date('2026-02-02T10:00:00.000Z'),
      quantity: '4',
      revenueNet: '120.00',
    })
  })

  // Driver-dependent: the same column can arrive as a Date or as a string.
  it('accepts a date that came back as text', async () => {
    const { em } = makeEm([sqlRow({ occurred_at: '2026-02-02T10:00:00.000Z' })])

    const grouped = await loadSalesRowsFromSql(em, SCOPE, ['p-1'], SINCE, TABLES)

    expect(grouped.get('p-1')?.[0].occurredAt).toEqual(new Date('2026-02-02T10:00:00.000Z'))
  })

  it('drops rows with no product, no order or no date rather than dating them to now', async () => {
    const { em } = makeEm([
      sqlRow({ product_id: null }),
      sqlRow({ order_id: null }),
      sqlRow({ occurred_at: null }),
      sqlRow({ occurred_at: 'nonsense' }),
    ])

    const grouped = await loadSalesRowsFromSql(em, SCOPE, ['p-1'], SINCE, TABLES)

    expect(grouped.size).toBe(0)
  })

  it('reads a null amount as zero instead of NaN', async () => {
    const { em } = makeEm([sqlRow({ quantity: null, total_net_amount: null })])

    const grouped = await loadSalesRowsFromSql(em, SCOPE, ['p-1'], SINCE, TABLES)

    expect(grouped.get('p-1')?.[0]).toMatchObject({ quantity: '0', revenueNet: '0' })
  })

  it('excludes the order states that are intentions rather than sales', async () => {
    const { em, execute } = makeEm([])

    await loadSalesRowsFromSql(em, SCOPE, ['p-1'], SINCE, TABLES)

    const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain("lower(coalesce(o.status, '')) not in")
    for (const status of ['canceled', 'cancelled', 'rejected', 'draft']) {
      expect(params).toContain(status)
    }
    expect(params).toContain(SINCE)
  })

  it('narrows by product id while the list is short', async () => {
    const { em, execute } = makeEm([])

    await loadSalesRowsFromSql(em, SCOPE, ['p-1', 'p-2'], SINCE, TABLES)

    const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('l.product_id in (?, ?)')
    expect(params).toContain('p-1')
    expect(params).toContain('p-2')
  })

  /**
   * Asked for the whole catalogue the id list excludes nothing, so thousands of placeholders would
   * be parsed for no narrowing at all. The set filters in the loop instead.
   */
  it('stops sending the id list once the whole catalogue is asked for', async () => {
    const productIds = Array.from({ length: 501 }, (_, index) => `p-${index}`)
    const { em, execute } = makeEm([sqlRow({ product_id: 'p-1' }), sqlRow({ product_id: 'obcy' })])

    const grouped = await loadSalesRowsFromSql(em, SCOPE, productIds, SINCE, TABLES)

    const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).not.toContain('l.product_id in (')
    expect(sql).toContain('l.product_id is not null')
    expect(params).not.toContain('p-1')
    // A row for a product outside the requested set must still not reach the metrics.
    expect(grouped.has('obcy')).toBe(false)
    expect(grouped.get('p-1')).toHaveLength(1)
  })

  it('asks for nothing when no product was requested', async () => {
    const { em, execute } = makeEm([])

    const grouped = await loadSalesRowsFromSql(em, SCOPE, [], SINCE, TABLES)

    expect(execute).not.toHaveBeenCalled()
    expect(grouped.size).toBe(0)
  })
})

import { loadReceiptRangeFromSql } from '../lib/deadstock/loader'

describe('deadstock receipt range', () => {
  it('keeps both ends of the receipt history per variant', async () => {
    const { em } = makeEm([
      {
        catalog_variant_id: 'v-1',
        first_at: new Date('2024-03-01T00:00:00.000Z'),
        last_at: new Date('2026-01-10T00:00:00.000Z'),
      },
    ])

    const range = await loadReceiptRangeFromSql(em, SCOPE, ['v-1'], 'wms_inventory_movements')

    expect(range.get('v-1')).toEqual({
      first: new Date('2024-03-01T00:00:00.000Z'),
      last: new Date('2026-01-10T00:00:00.000Z'),
    })
  })

  it('counts only receipts, scoped to the tenant', async () => {
    const { em, execute } = makeEm([])

    await loadReceiptRangeFromSql(em, SCOPE, ['v-1'], 'wms_inventory_movements')

    const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain("m.type = 'receipt'")
    expect(sql).toContain('group by m.catalog_variant_id')
    expect(params).toContain(SCOPE.tenantId)
    expect(params).toContain(SCOPE.organizationId)
  })

  it('drops a variant whose ends did not come back as dates', async () => {
    const { em } = makeEm([{ catalog_variant_id: 'v-1', first_at: null, last_at: null }])

    const range = await loadReceiptRangeFromSql(em, SCOPE, ['v-1'], 'wms_inventory_movements')

    expect(range.size).toBe(0)
  })

  it('stops sending the id list for a whole-catalogue sweep but still filters the answer', async () => {
    const variantIds = Array.from({ length: 501 }, (_, index) => `v-${index}`)
    const { em, execute } = makeEm([
      { catalog_variant_id: 'v-1', first_at: '2024-03-01T00:00:00.000Z', last_at: '2026-01-10T00:00:00.000Z' },
      { catalog_variant_id: 'obcy', first_at: '2024-03-01T00:00:00.000Z', last_at: '2026-01-10T00:00:00.000Z' },
    ])

    const range = await loadReceiptRangeFromSql(em, SCOPE, variantIds, 'wms_inventory_movements')

    const [sql] = execute.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).not.toContain('m.catalog_variant_id in (')
    expect(range.has('obcy')).toBe(false)
    expect(range.get('v-1')?.first).toEqual(new Date('2024-03-01T00:00:00.000Z'))
  })
})

import { resolveStockedProductIds } from '../lib/deadstock/loader'

function containerWith(classes: Record<string, unknown>) {
  return {
    resolve: (name: string) => {
      const found = classes[name]
      if (!found) throw new Error(`[internal] ${name} not registered`)
      return found
    },
  }
}

function emWithMetadata(rows: unknown[], tables: Record<string, string>) {
  const execute = jest.fn(async () => rows)
  return {
    execute,
    em: {
      getConnection: () => ({ execute }),
      getMetadata: () => ({
        find: (name: string) => (tables[name] ? { tableName: tables[name] } : undefined),
      }),
    } as never,
  }
}

const WMS_CLASSES = {
  InventoryBalance: { name: 'InventoryBalance' },
  CatalogProductVariant: { name: 'CatalogProductVariant' },
}
const WMS_TABLES = {
  InventoryBalance: 'wms_inventory_balances',
  CatalogProductVariant: 'catalog_product_variants',
}

describe('stocked product narrowing', () => {
  it('returns the products whose balance rows do not sum to zero', async () => {
    const { em, execute } = emWithMetadata([{ product_id: 'p-1' }, { product_id: 'p-2' }], WMS_TABLES)

    const ids = await resolveStockedProductIds(em, containerWith(WMS_CLASSES), SCOPE)

    expect(ids).toEqual(new Set(['p-1', 'p-2']))
    const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('having sum(coalesce(b.quantity_on_hand, 0)) <> 0')
    expect(params).toEqual([SCOPE.organizationId, SCOPE.tenantId])
  })

  /**
   * Null means "could not narrow", and the caller then keeps the whole catalogue. Returning an
   * empty set instead would report an empty warehouse to a distributor who has one.
   */
  it('gives up rather than narrowing when the warehouse module is absent', async () => {
    const { em } = emWithMetadata([], WMS_TABLES)

    const ids = await resolveStockedProductIds(em, containerWith({}), SCOPE)

    expect(ids).toBeNull()
  })

  it('gives up when the ORM cannot name the tables', async () => {
    const { em } = emWithMetadata([], {})

    const ids = await resolveStockedProductIds(em, containerWith(WMS_CLASSES), SCOPE)

    expect(ids).toBeNull()
  })

  it('gives up when the query fails rather than emptying the screen', async () => {
    const execute = jest.fn(async () => {
      throw new Error('relation does not exist')
    })
    const em = {
      getConnection: () => ({ execute }),
      getMetadata: () => ({ find: (name: string) => ({ tableName: WMS_TABLES[name as keyof typeof WMS_TABLES] }) }),
    } as never

    const ids = await resolveStockedProductIds(em, containerWith(WMS_CLASSES), SCOPE)

    expect(ids).toBeNull()
  })
})
