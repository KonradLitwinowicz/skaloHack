import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api'
import { getTokenScope } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures'
import { withClient } from '@open-mercato/core/modules/core/__integration__/helpers/dbFixtures'

/**
 * TC-PRICING-ROT-001: warehouse turnover measured from WMS movements on `POST /api/pricing/quote`.
 *
 * `warehouse_cost` charges space rent and frozen capital for as long as the goods sit on the
 * shelf. That duration is a measurement when stock history exists and a declared assumption when
 * it does not, and the component has to say which. Two products differing only in their movement
 * history pin both halves.
 *
 * The issuing movement is written with SQL: `wms.inventory.receive` / `adjust` / `move` all record
 * an inbound or an intra-warehouse leg, so no WMS route today writes a movement that
 * `issuedQuantityOf` counts as demand (see the TODO in `lib/components/warehouseCost.ts`).
 */

export const integrationMeta = {
  description: 'Warehouse turnover derived from inventory movements',
  requiredModules: ['pricing_engine', 'catalog', 'wms'],
}

const QUOTE_API = '/api/pricing/quote'
const WAREHOUSE_COST_CODE = 'warehouse_cost'
const TURNOVER_ASSUMED_WARNING = 'pricing_engine.warnings.warehouseTurnoverAssumed'
const UNIT_COST = '20.0000'
const RECEIVED_QUANTITY = 100
const ISSUED_QUANTITY = 40
const RECEIPT_DAYS_AGO = 90
const ISSUE_DAYS_AGO = 60
/** Past `ROTATION_WINDOW_DAYS` (180), so the control product has no movement inside the window. */
const STALE_RECEIPT_DAYS_AGO = 260

type ComponentResult = {
  code: string
  explainKey: string
  inputs: Record<string, unknown>
  params: Record<string, unknown>
  warnings?: string[]
}

type QuoteLine = { breakdown: ComponentResult[] }

type QuoteResponse = { calculationId: string | null; lines: QuoteLine[] }

type Fixture = {
  productId: string
  variantId: string
  profileId: string
  purchasePositionId: string
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

async function createJson(
  request: APIRequestContext,
  token: string,
  path: string,
  data: Record<string, unknown>,
): Promise<string> {
  const response = await apiRequest(request, 'POST', path, { token, data })
  expect(response.ok(), `POST ${path} should succeed: ${response.status()} ${await response.text()}`).toBe(true)
  const body = (await response.json()) as { id?: string }
  expect(typeof body.id, `POST ${path} should return an id`).toBe('string')
  return body.id as string
}

async function deleteById(
  request: APIRequestContext,
  token: string,
  path: string,
  id: string | null,
): Promise<void> {
  if (!id) return
  await apiRequest(request, 'DELETE', `${path}?id=${encodeURIComponent(id)}`, { token }).catch(() => undefined)
}

function warehouseComponentOf(line: QuoteLine): ComponentResult {
  const component = line.breakdown.find((entry) => entry.code === WAREHOUSE_COST_CODE)
  expect(component, 'the breakdown should carry a warehouse_cost component').toBeTruthy()
  return component as ComponentResult
}

/**
 * The engine refuses to price without a `pricing_supplier_profile` for the tenant, and that row is
 * created by the module's own tenant setup — not by this test, which has no API to create one.
 * `mercato pricing_engine purge-demo` deletes it (`cli.ts:90`), so a tenant can legitimately be
 * without it. Say so out loud and skip: a suite that fails with "409" on an unprepared tenant
 * teaches the reader nothing, and one that silently depends on seeded rows is worse.
 */
async function skipUnlessEngineInitialised(
  request: APIRequestContext,
  token: string,
  productId: string,
): Promise<void> {
  const response = await apiRequest(request, 'POST', '/api/pricing/quote', {
    token,
    data: { lines: [{ productId, quantity: '1' }] },
  })
  if (response.status() !== 409) return
  test.skip(
    true,
    'pricing_engine is not initialised for this tenant (no supplier profile). Run: yarn mercato pricing_engine seed --tenant <t> --org <o>',
  )
}

test.describe('TC-PRICING-ROT-001: warehouse turnover from inventory movements', () => {
  test('issued stock measures turnover while stock without movements keeps the configured default', async ({
    request,
  }) => {
    const token = await getAuthToken(request, 'admin')
    const { organizationId, tenantId, userId } = getTokenScope(token)
    expect(organizationId && tenantId && userId, 'admin token should carry a full scope').toBeTruthy()

    const stamp = Date.now()
    let warehouseId: string | null = null
    let locationId: string | null = null
    const fixtures: Fixture[] = []
    const calculationIds: string[] = []

    const buildProduct = async (slug: string, receiptDaysAgo: number): Promise<Fixture> => {
      const productId = await createJson(request, token, '/api/catalog/products', {
        title: `QA Rotation ${slug} ${stamp}`,
        sku: `QA-ROT-${slug}-${stamp}`,
        description:
          'Long enough description for SEO checks in QA automation flows. This text keeps the create validation satisfied.',
      })
      const variantId = await createJson(request, token, '/api/catalog/variants', {
        productId,
        name: `QA Rotation ${slug} variant`,
        sku: `QA-ROT-${slug}-V-${stamp}`,
        isDefault: true,
        isActive: true,
      })
      const profileId = await createJson(request, token, '/api/wms/inventory-profiles', {
        catalogProductId: productId,
        catalogVariantId: variantId,
        defaultUom: 'pcs',
        trackLot: false,
        trackExpiration: false,
        defaultStrategy: 'fifo',
      })
      const receiveResponse = await apiRequest(request, 'POST', '/api/wms/inventory/receive', {
        token,
        data: {
          organizationId,
          tenantId,
          warehouseId,
          locationId,
          catalogVariantId: variantId,
          quantity: RECEIVED_QUANTITY,
          referenceType: 'po',
          referenceId: crypto.randomUUID(),
          performedBy: userId,
          performedAt: isoDaysAgo(receiptDaysAgo),
        },
      })
      expect(
        receiveResponse.ok(),
        `receive should succeed: ${receiveResponse.status()} ${await receiveResponse.text()}`,
      ).toBe(true)
      const purchasePositionId = await createJson(request, token, '/api/pricing/purchase-positions', {
        catalogProductId: productId,
        catalogVariantId: variantId,
        sku: `QA-ROT-${slug}-${stamp}`,
        lastDeliveryUnitCost: UNIT_COST,
        annualVolume: '0',
        currentTierDiscount: '0',
      })
      return { productId, variantId, profileId, purchasePositionId }
    }

    const quote = async (fixture: Fixture): Promise<QuoteLine> => {
      const response = await apiRequest(request, 'POST', QUOTE_API, {
        token,
        data: { lines: [{ productId: fixture.productId, variantId: fixture.variantId, quantity: '10' }] },
      })
      expect(response.ok(), `quote should succeed: ${response.status()} ${await response.text()}`).toBe(true)
      const body = (await response.json()) as QuoteResponse
      if (body.calculationId) calculationIds.push(body.calculationId)
      expect(body.lines.length, 'the quote should price exactly one line').toBe(1)
      return body.lines[0]
    }

    try {
      warehouseId = await createJson(request, token, '/api/wms/warehouses', {
        name: `QA Rotation WH ${stamp}`,
        code: `QA-ROT-WH-${stamp}`,
        isActive: true,
      })
      locationId = await createJson(request, token, '/api/wms/locations', {
        warehouseId,
        code: `QA-ROT-LOC-${stamp}`,
        type: 'bin',
        isActive: true,
      })

      const moving = await buildProduct('moving', RECEIPT_DAYS_AGO)
      fixtures.push(moving)
      const idle = await buildProduct('idle', STALE_RECEIPT_DAYS_AGO)
      fixtures.push(idle)

      await withClient(async (client) => {
        await client.query(
          `insert into wms_inventory_movements
             (organization_id, tenant_id, created_at, updated_at, warehouse_id, location_from_id,
              catalog_variant_id, quantity, type, reference_type, reference_id, performed_by,
              performed_at, received_at)
           values ($1, $2, now(), now(), $3, $4, $5, $6, 'pick', 'so', gen_random_uuid(), $7, $8, $8)`,
          [
            organizationId,
            tenantId,
            warehouseId,
            locationId,
            moving.variantId,
            ISSUED_QUANTITY,
            userId,
            isoDaysAgo(ISSUE_DAYS_AGO),
          ],
        )
      })

      await skipUnlessEngineInitialised(request, token, moving.productId)

      const movingWarehouse = warehouseComponentOf(await quote(moving))
      expect(
        movingWarehouse.inputs.turnoverSource,
        'issued stock should make the turnover a measurement',
      ).toBe('movements')
      expect(Number(movingWarehouse.inputs.issuedQuantity)).toBeGreaterThan(0)
      const measuredDays = Number(movingWarehouse.inputs.turnoverDays)
      const configuredDays = Number(movingWarehouse.params.defaultTurnoverDays)
      expect(Number.isFinite(measuredDays) && Number.isFinite(configuredDays)).toBe(true)
      expect(
        measuredDays,
        `a measured turnover must displace the configured default (${configuredDays})`,
      ).not.toBe(configuredDays)
      expect(movingWarehouse.warnings ?? []).not.toContain(TURNOVER_ASSUMED_WARNING)

      const idleWarehouse = warehouseComponentOf(await quote(idle))
      expect(
        idleWarehouse.inputs.turnoverSource,
        'stock with no movement in the window cannot claim a measured turnover',
      ).not.toBe('movements')
      expect(idleWarehouse.warnings ?? []).toContain(TURNOVER_ASSUMED_WARNING)
      expect(Number(idleWarehouse.inputs.turnoverDays)).toBe(
        Number(idleWarehouse.params.defaultTurnoverDays),
      )
    } finally {
      for (const fixture of fixtures) {
        await deleteById(request, token, '/api/pricing/purchase-positions', fixture.purchasePositionId)
      }
      await withClient(async (client) => {
        for (const calculationId of calculationIds) {
          await client.query('delete from pricing_calculation_lines where calculation_id = $1', [calculationId])
          await client.query('delete from pricing_calculations where id = $1', [calculationId])
        }
        for (const fixture of fixtures) {
          await client.query('delete from wms_inventory_movements where catalog_variant_id = $1', [fixture.variantId])
          await client.query('delete from wms_inventory_balances where catalog_variant_id = $1', [fixture.variantId])
        }
      }).catch(() => undefined)
      for (const fixture of fixtures) {
        await deleteById(request, token, '/api/wms/inventory-profiles', fixture.profileId)
        await deleteById(request, token, '/api/catalog/variants', fixture.variantId)
        await deleteById(request, token, '/api/catalog/products', fixture.productId)
      }
      await deleteById(request, token, '/api/wms/locations', locationId)
      await deleteById(request, token, '/api/wms/warehouses', warehouseId)
    }
  })
})
