import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api'
import { getTokenScope } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures'
import { withClient } from '@open-mercato/core/modules/core/__integration__/helpers/dbFixtures'

/**
 * TC-PRICING-SHELF-001: the shelf-life markdown ladder on `POST /api/pricing/quote`.
 *
 * The ladder only lowers the guardrail floor for a line FEFO would fill from a lot that is near
 * its date. The decisive assertion here is the negative one: an otherwise identical basket priced
 * on a product that holds the same quantity of stock with NO dated lot must come back with none of
 * the ladder's fields and the plain `explain.none` guardrail. Without that, a ladder that had
 * degenerated into an unconditional discount would still satisfy the positive assertions.
 *
 * The two products are configured identically — same purchase cost, same product-scoped target
 * markup, same product-scoped guardrail — so the only variable between them is the lot.
 */

export const integrationMeta = {
  description: 'Shelf-life markdown ladder on the quote endpoint',
  requiredModules: ['pricing_engine', 'catalog', 'wms'],
}

const QUOTE_API = '/api/pricing/quote'
const GUARDRAILS_CODE = 'guardrails'
const MARKDOWN_STAGES = ['early', 'at_cost', 'salvage']
const UNIT_COST = '20.0000'
const TARGET_MARKUP = '80.0000'
const MIN_MARGIN_PERCENT = '25'
const LINE_QUANTITY = '10'
const RECEIVED_QUANTITY = 100

/** 27 days left out of a 365-day life: ~7.4% remaining, well inside the markdown band. */
const SHELF_LIFE_DAYS = 365
const REMAINING_DAYS = 27

type ComponentResult = {
  code: string
  explainKey: string
  inputs: Record<string, unknown>
  params: Record<string, unknown>
}

type QuoteLine = { unitCostNet: string; breakdown: ComponentResult[] }

type QuoteResponse = { calculationId: string | null; lines: QuoteLine[] }

type Fixture = {
  productId: string
  variantId: string
  profileId: string
  purchasePositionId: string
  guardrailId: string
  marginRuleId: string
  lotId: string | null
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString()
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

function componentOf(line: QuoteLine, code: string): ComponentResult {
  const component = line.breakdown.find((entry) => entry.code === code)
  expect(component, `the breakdown should carry a ${code} component`).toBeTruthy()
  return component as ComponentResult
}

/** price_min = cost / (1 - margin/100) — the same formula `minPriceForMargin` clamps with. */
function minMarginFloor(unitCostNet: string, minMarginPercent: unknown): number {
  const percent = Number(minMarginPercent)
  expect(Number.isFinite(percent), 'guardrail should report its min margin percent').toBe(true)
  return Number(unitCostNet) / (1 - percent / 100)
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

test.describe('TC-PRICING-SHELF-001: shelf-life markdown ladder', () => {
  test('a near-expiry lot lowers the floor while identical stock without a lot does not', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const { organizationId, tenantId, userId } = getTokenScope(token)
    expect(organizationId && tenantId && userId, 'admin token should carry a full scope').toBeTruthy()

    const stamp = Date.now()
    let warehouseId: string | null = null
    let locationId: string | null = null
    const fixtures: Fixture[] = []
    const calculationIds: string[] = []

    const buildProduct = async (slug: string, withLot: boolean): Promise<Fixture> => {
      const productId = await createJson(request, token, '/api/catalog/products', {
        title: `QA Shelf ${slug} ${stamp}`,
        sku: `QA-SHELF-${slug}-${stamp}`,
        description:
          'Long enough description for SEO checks in QA automation flows. This text keeps the create validation satisfied.',
      })
      const variantId = await createJson(request, token, '/api/catalog/variants', {
        productId,
        name: `QA Shelf ${slug} variant`,
        sku: `QA-SHELF-${slug}-V-${stamp}`,
        isDefault: true,
        isActive: true,
      })
      const profileId = await createJson(request, token, '/api/wms/inventory-profiles', {
        catalogProductId: productId,
        catalogVariantId: variantId,
        defaultUom: 'pcs',
        trackLot: withLot,
        trackExpiration: withLot,
        defaultStrategy: withLot ? 'fefo' : 'fifo',
      })
      const lotId = withLot
        ? await createJson(request, token, '/api/wms/lots', {
            catalogVariantId: variantId,
            sku: `QA-SHELF-${slug}-V-${stamp}`,
            lotNumber: `QA-LOT-${slug}-${stamp}`,
            manufacturedAt: isoDaysFromNow(REMAINING_DAYS - SHELF_LIFE_DAYS),
            expiresAt: isoDaysFromNow(REMAINING_DAYS),
            status: 'available',
          })
        : null

      const receiveBody: Record<string, unknown> = {
        organizationId,
        tenantId,
        warehouseId,
        locationId,
        catalogVariantId: variantId,
        quantity: RECEIVED_QUANTITY,
        referenceType: 'po',
        referenceId: crypto.randomUUID(),
        performedBy: userId,
      }
      if (lotId) receiveBody.lotId = lotId
      const receiveResponse = await apiRequest(request, 'POST', '/api/wms/inventory/receive', {
        token,
        data: receiveBody,
      })
      expect(
        receiveResponse.ok(),
        `receive should succeed: ${receiveResponse.status()} ${await receiveResponse.text()}`,
      ).toBe(true)

      const purchasePositionId = await createJson(request, token, '/api/pricing/purchase-positions', {
        catalogProductId: productId,
        catalogVariantId: variantId,
        sku: `QA-SHELF-${slug}-${stamp}`,
        lastDeliveryUnitCost: UNIT_COST,
        annualVolume: '0',
        currentTierDiscount: '0',
      })
      const marginRuleId = await createJson(request, token, '/api/pricing/margin-rules', {
        scope: 'product',
        scopeRefId: productId,
        targetMarkupPercent: TARGET_MARKUP,
        changeNote: `QA TC-PRICING-SHELF-001 ${slug} ${stamp}`,
        validFrom: '2020-01-01T00:00:00.000Z',
      })
      const guardrailId = await createJson(request, token, '/api/pricing/guardrails', {
        code: `qa-shelf-${slug}-${stamp}`,
        scope: 'product',
        scopeRefId: productId,
        minMarginPercent: MIN_MARGIN_PERCENT,
        floorPrice: null,
        validFrom: '2020-01-01T00:00:00.000Z',
      })

      return { productId, variantId, profileId, purchasePositionId, guardrailId, marginRuleId, lotId }
    }

    const quote = async (fixture: Fixture): Promise<QuoteLine> => {
      const response = await apiRequest(request, 'POST', QUOTE_API, {
        token,
        data: {
          lines: [{ productId: fixture.productId, variantId: fixture.variantId, quantity: LINE_QUANTITY }],
        },
      })
      expect(response.ok(), `quote should succeed: ${response.status()} ${await response.text()}`).toBe(true)
      const body = (await response.json()) as QuoteResponse
      if (body.calculationId) calculationIds.push(body.calculationId)
      expect(body.lines.length, 'the quote should price exactly one line').toBe(1)
      return body.lines[0]
    }

    try {
      warehouseId = await createJson(request, token, '/api/wms/warehouses', {
        name: `QA Shelf WH ${stamp}`,
        code: `QA-SHELF-WH-${stamp}`,
        isActive: true,
      })
      locationId = await createJson(request, token, '/api/wms/locations', {
        warehouseId,
        code: `QA-SHELF-LOC-${stamp}`,
        type: 'bin',
        isActive: true,
      })

      const expiring = await buildProduct('exp', true)
      fixtures.push(expiring)
      const plain = await buildProduct('plain', false)
      fixtures.push(plain)

      await skipUnlessEngineInitialised(request, token, expiring.productId)

      const expiringLine = await quote(expiring)
      const expiringGuardrails = componentOf(expiringLine, GUARDRAILS_CODE)

      expect(expiringGuardrails.params.leadLotId, 'the ladder should name the lot it read').toBe(expiring.lotId)
      expect(
        MARKDOWN_STAGES,
        `stage should be a markdown rung, got ${String(expiringGuardrails.params.shelfLifeStage)}`,
      ).toContain(expiringGuardrails.params.shelfLifeStage)
      const shelfLifeFloor = Number(expiringGuardrails.params.shelfLifeFloorUnitPrice)
      expect(
        Number.isFinite(shelfLifeFloor),
        `shelfLifeFloorUnitPrice should be a decimal, got ${String(expiringGuardrails.params.shelfLifeFloorUnitPrice)}`,
      ).toBe(true)
      expect(expiringGuardrails.explainKey).toMatch(
        /^pricing_engine\.components\.guardrails\.explain\.shelfLife/,
      )

      const normalFloor = minMarginFloor(
        String(expiringGuardrails.inputs.unitCostNet),
        expiringGuardrails.params.minMarginPercent,
      )
      expect(
        shelfLifeFloor,
        `the expiry floor (${shelfLifeFloor}) must sit below the ordinary min-margin floor (${normalFloor})`,
      ).toBeLessThan(normalFloor)

      const plainLine = await quote(plain)
      const plainGuardrails = componentOf(plainLine, GUARDRAILS_CODE)

      expect(plainGuardrails.explainKey).toBe('pricing_engine.components.guardrails.explain.none')
      for (const key of ['leadLotId', 'shelfLifeStage', 'shelfLifeFloorUnitPrice']) {
        expect(
          key in plainGuardrails.params,
          `stock without a dated lot must not carry ${key} — the ladder would be a blanket discount`,
        ).toBe(false)
      }
      expect(plainGuardrails.params.minMarginPercent).toBe(expiringGuardrails.params.minMarginPercent)
    } finally {
      for (const fixture of fixtures) {
        await deleteById(request, token, '/api/pricing/guardrails', fixture.guardrailId)
        await deleteById(request, token, '/api/pricing/margin-rules', fixture.marginRuleId)
        await deleteById(request, token, '/api/pricing/purchase-positions', fixture.purchasePositionId)
      }
      // Balances, movements and priced calculations have no delete route; the ledger is
      // append-only by design and the quote endpoint persists every run.
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
        await deleteById(request, token, '/api/wms/lots', fixture.lotId)
        await deleteById(request, token, '/api/wms/inventory-profiles', fixture.profileId)
        await deleteById(request, token, '/api/catalog/variants', fixture.variantId)
        await deleteById(request, token, '/api/catalog/products', fixture.productId)
      }
      await deleteById(request, token, '/api/wms/locations', locationId)
      await deleteById(request, token, '/api/wms/warehouses', warehouseId)
    }
  })
})
