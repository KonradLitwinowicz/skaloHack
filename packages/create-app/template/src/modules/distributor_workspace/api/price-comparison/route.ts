import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { SalesOrder } from '@open-mercato/core/modules/sales/data/entities'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { opsUnitFromQuote, resolveOfferUnitPrice } from '../../lib/offerPrice'

const logger = createLogger('distributor_workspace').child({ component: 'price-comparison' })

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['sales.orders.view', 'pricing.simulate', 'distributor_workspace.pricing.compare'] },
}

const querySchema = z.object({
  orderId: z.string().uuid(),
  // What-if volume: quote the same basket at N times the quantity. Order-level effort is spread
  // across more units, so the unit cost falls — this is the lever behind "order more, pay less
  // each" and the only honest way to offer a lower price without giving up margin.
  multiplier: z.coerce.number().min(0.1).max(50).optional(),
  // 'goods' reproduces the source system's own arithmetic — purchase invoice and nothing else — so
  // the two columns can be reconciled line by line before any cost-to-serve is argued about.
  // 'full' is this system's answer. Both run off the same quote; only what is counted differs.
  mode: z.enum(['full', 'goods']).optional(),
  // Channel to re-quote the same basket under. The order-intake step carries a per-scenario
  // multiplier calibrated from the client's own costing, so this answers "what would this exact
  // invoice have cost had the customer typed it in themselves" without touching a single amount.
  scenario: z.string().min(1).max(64).optional(),
})

// The volume ladder the offer block walks. Kept in step with the page's multiplier buttons so the
// selected step is always one of the quotes already run.
const LADDER_MULTIPLIERS = [1, 2, 3, 5, 10] as const


type LineRow = {
  line_number: number | null
  name: string | null
  quantity: string | number | null
  quantity_unit: string | null
  unit_price_net: string | number | null
  total_net_amount: string | number | null
  product_variant_id: string | null
  sku: string | null
  product_id: string | null
  catalog_snapshot: Record<string, unknown> | string | null
}

type ParamRow = { component_code: string; payload: Record<string, unknown> | string | null }
type FuelRow = { fuel_type: string; price_per_litre: string | number }
type VehicleRow = { code: string; fuel_type: string; consumption_l_per_100km: string | number; fixed_cost_month: string | number; driver_role_code: string | null }
type LaborRow = { role_code: string; hourly_rate: string | number; overhead_rate: string | number }
type ZoneRow = { code: string; avg_distance_km: string | number; avg_drive_minutes: string | number; default_vehicle_code: string | null }
type ProfileRow = { delivery_zone_code: string | null }

type ScenarioRow = {
  code: string
  label: string
  step_multipliers: Record<string, unknown> | string | null
}

type QuotedLine = {
  line?: { productId?: string; quantity?: string }
  unitPriceNet?: string
  unitCostNet?: string
  marginPercent?: string
  breakdown?: Array<{ code: string; effect: string; value: string; confidence: string }>
}

type CostComponent = { code: string; amount: number; share: number; confidence: string }

type BasketCost = { goods: number; ops: number; total: number; components: CostComponent[] }

const toNum = (value: unknown): number => {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === 'number' ? value : Number(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

const asObject = (value: unknown): Record<string, unknown> => {
  if (!value) return {}
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown> } catch { return {} }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

const goodsUnitOf = (quotedLine: QuotedLine | undefined): number | null =>
  quotedLine
    ? toNum((quotedLine.breakdown ?? []).find((component) => component.code === 'product_cost')?.value)
    : null

const percentOf = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0)

// The purchase cost the WZ itself carries (`catalog_snapshot.zrodlo.cenaZakupuNetto`), handed to
// the engine per line so `product_cost` is the very figure the source ERP booked — never a later
// delivery. The same product must show the same goods cost on both sides of the table; anything
// else reports a valuation method as if it were profit. Absent when the import carried no cost,
// and then the engine falls back to its own purchase position and says so.
const documentPurchaseCostOf = (line: LineRow): string | null => {
  const raw = asObject(asObject(line.catalog_snapshot).zrodlo).cenaZakupuNetto
  if (raw === null || raw === undefined || raw === '') return null
  const value = toNum(raw)
  return Number.isFinite(value) && value >= 0 ? value.toFixed(4) : null
}

/**
 * One imported order, priced twice: once as the source ERP booked it, once through this system's
 * pipeline.
 *
 * Both costs are historical. The source cost rides on the line (`catalog_snapshot.zrodlo`) exactly
 * as the ERP recorded it at sale time; ours comes from the pricing engine quoting the WHOLE basket
 * at the order's own date. Quoting a line on its own would be a different number — order-level
 * effort is allocated across the basket — so the comparison only holds per document.
 *
 * The WZ is the fixed point and is never rewritten: its prices are what the customer actually
 * paid. Everything else is derived from it. The offer ladder answers the sales question — how far
 * can this price go down if the customer changes how (channel) or how much (volume) they order —
 * by handing the customer exactly the cost-to-serve that their behaviour saves, and not a grosz
 * more, so the real profit in zloty stays what the WZ already earned. Alongside, the margin the
 * source ERP would display for that lower price (price minus purchase invoice, nothing else) is
 * shown so a salesperson can see that the number their screen will drop is not money lost.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const auth = await getAuthFromRequest(req)
    if (!auth?.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })

    const url = new URL(req.url)
    const parsed = querySchema.safeParse({
      orderId: url.searchParams.get('orderId'),
      multiplier: url.searchParams.get('multiplier') ?? undefined,
      mode: url.searchParams.get('mode') ?? undefined,
      scenario: url.searchParams.get('scenario') ?? undefined,
    })
    if (!parsed.success) throw new CrudHttpError(400, { error: 'orderId must be a uuid' })
    const multiplier = parsed.data.multiplier ?? 1
    const mode = parsed.data.mode ?? 'full'
    const scenario = parsed.data.scenario ?? null

    const container = await createRequestContainer()
    const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = organizationScope?.selectedId ?? auth.orgId ?? null
    if (!organizationId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const tenantId = auth.tenantId
    const scope = { tenantId, organizationId }

    const em = (container.resolve('em') as EntityManager).fork()
    const connection = em.getConnection()

    // Eight reads that do not depend on one another. Issued one `await` at a time this screen paid
    // eight round trips before it could start pricing; the only genuine dependency is the customer
    // pricing profile, which needs the order's customer id and so waits for the order below.
    const [order, lines, scenarioRows, paramRows, fuelRows, vehicleRows, laborRows, zoneRows] = await Promise.all([
      // The header carries encrypted columns (metadata, customer_snapshot); the lines do not.
      findOneWithDecryption(em, SalesOrder, { id: parsed.data.orderId, tenantId, organizationId }, {}, scope),
      connection.execute<LineRow[]>(
        `select l.line_number, l.name, l.quantity, l.quantity_unit, l.unit_price_net, l.total_net_amount,
                l.product_variant_id, v.sku, v.product_id, l.catalog_snapshot
         from sales_order_lines l
         left join catalog_product_variants v on v.id = l.product_variant_id
         where l.order_id = ? and l.tenant_id = ? and l.organization_id = ? and l.deleted_at is null
         order by l.line_number asc`,
        [parsed.data.orderId, tenantId, organizationId],
      ),
      // Every intake channel the engine knows for this tenant, cheapest first, so the page can
      // offer them as levers rather than hard-code one.
      connection.execute<ScenarioRow[]>(
        `select code, label, step_multipliers
         from pricing_order_scenarios
         where tenant_id = ? and organization_id = ? and deleted_at is null
           and valid_from <= now() and (valid_to is null or valid_to > now())
         order by code asc`,
        [tenantId, organizationId],
      ),
      // Every rate below is tenant configuration read at request time — nothing is written into
      // the code — so a change under Wycena → Parametry reprices this screen without a deploy. The
      // document only stores what physically happened (which day, how many stops shared the round,
      // how many kilometres it ran); the money is derived here from today's parameters.
      connection.execute<ParamRow[]>(
        `select component_code, payload from pricing_component_params
         where tenant_id = ? and organization_id = ? and deleted_at is null and scope = 'global'
           and valid_from <= now() and (valid_to is null or valid_to > now())
           and component_code in ('source_costing', 'logistics_cost')
         order by valid_from desc`,
        [tenantId, organizationId],
      ),
      connection.execute<FuelRow[]>(
        `select fuel_type, price_per_litre from pricing_fuel_prices
         where tenant_id = ? and organization_id = ? and deleted_at is null order by observed_on desc`,
        [tenantId, organizationId],
      ),
      connection.execute<VehicleRow[]>(
        `select code, fuel_type, consumption_l_per_100km, fixed_cost_month, driver_role_code from pricing_vehicles
         where tenant_id = ? and organization_id = ? and deleted_at is null and is_active = true`,
        [tenantId, organizationId],
      ),
      connection.execute<LaborRow[]>(
        `select role_code, hourly_rate, overhead_rate from pricing_labor_rates
         where tenant_id = ? and organization_id = ? and deleted_at is null
           and valid_from <= now() and (valid_to is null or valid_to > now())`,
        [tenantId, organizationId],
      ),
      connection.execute<ZoneRow[]>(
        `select code, avg_distance_km, avg_drive_minutes, default_vehicle_code from pricing_delivery_zones
         where tenant_id = ? and organization_id = ? and deleted_at is null`,
        [tenantId, organizationId],
      ),
    ])
    if (!order) throw new CrudHttpError(404, { error: 'Order not found' })

    const channels = scenarioRows
      .map((row) => ({
        code: row.code,
        label: row.label,
        intakeMultiplier: toNum(asObject(row.step_multipliers).order_intake) || 1,
      }))
      .sort((a, b) => a.intakeMultiplier - b.intakeMultiplier)
    const scenarioKnown = scenario === null || channels.some((channel) => channel.code === scenario)
    const scenarioCode = scenarioKnown ? scenario : null

    const orderMeta = asObject(order.metadata)
    const sourceMeta = asObject(orderMeta.zrodlo)
    // Delivery rides on the ROUTE, not the document: the van reaches a zone once and drops several
    // orders, so the run's cost is split across the stops that shared it. It does not grow with
    // the basket either — a bigger order rides the same van — which is precisely why volume is a
    // lever: the trip is paid once however many cartons are on it.
    const deliveryMeta = asObject(orderMeta.dostawa)
    const deliveryLegs = Array.isArray(deliveryMeta.kursy) ? deliveryMeta.kursy.map((leg) => asObject(leg)) : []

    // Every rate below is tenant configuration read at request time — nothing is written into the
    // code — so a change under Wycena → Parametry reprices this screen without a deploy. The
    // document only stores what physically happened (which day, how many stops shared the round,
    // how many kilometres it ran); the money is derived here from today's parameters.
    const warnings: string[] = []
    const payloads = new Map<string, Record<string, unknown>>()
    for (const row of paramRows) if (!payloads.has(row.component_code)) payloads.set(row.component_code, asObject(row.payload))
    const fuelByType = new Map<string, number>()
    for (const row of fuelRows) if (!fuelByType.has(row.fuel_type)) fuelByType.set(row.fuel_type, toNum(row.price_per_litre))
    const vehicles = new Map(vehicleRows.map((row) => [row.code, row]))
    const laborByRole = new Map(laborRows.map((row) => [row.role_code, row]))
    const zones = new Map(zoneRows.map((row) => [row.code, row]))
    const profileRows = order.customerEntityId
      ? await connection.execute<ProfileRow[]>(
          `select delivery_zone_code from pricing_customer_profiles
           where tenant_id = ? and organization_id = ? and customer_id = ? and deleted_at is null limit 1`,
          [tenantId, organizationId, order.customerEntityId],
        )
      : []
    const customerZone = profileRows[0]?.delivery_zone_code ? zones.get(profileRows[0].delivery_zone_code) ?? null : null

    const logisticsPayload = payloads.get('logistics_cost') ?? null
    const workingDaysPerMonth = toNum(logisticsPayload?.workingDaysPerMonth)
    const tripsPerDay = toNum(logisticsPayload?.tripsPerDay)
    const driveMinutesPerKm = toNum(logisticsPayload?.driveMinutesPerKm)
      || (customerZone && toNum(customerZone.avg_distance_km) > 0
        ? toNum(customerZone.avg_drive_minutes) / toNum(customerZone.avg_distance_km)
        : 0)
    const scheduleConfigured = workingDaysPerMonth > 0 && tripsPerDay > 0
    if (!scheduleConfigured) warnings.push('delivery_schedule_missing')
    if (deliveryLegs.length && !customerZone) warnings.push('delivery_zone_missing')

    const loadedHourlyRate = (roleCode: string | null): number => {
      const rate = roleCode ? laborByRole.get(roleCode) : null
      return rate ? toNum(rate.hourly_rate) * (1 + toNum(rate.overhead_rate) / 100) : 0
    }
    // What one round of a given vehicle costs over `km` kilometres, from the same three parts the
    // engine's own logistics component uses: fuel, the driver's time, the vehicle's monthly fee.
    const roundCost = (vehicle: VehicleRow, km: number): { fuel: number; driver: number; fixed: number; total: number } => {
      const fuel = (km / 100) * toNum(vehicle.consumption_l_per_100km) * (fuelByType.get(vehicle.fuel_type) ?? 0)
      const driver = (km * driveMinutesPerKm / 60) * loadedHourlyRate(vehicle.driver_role_code)
      const fixed = scheduleConfigured ? toNum(vehicle.fixed_cost_month) / workingDaysPerMonth / tripsPerDay : 0
      return { fuel, driver, fixed, total: fuel + driver + fixed }
    }
    const vanVehicle = customerZone?.default_vehicle_code ? vehicles.get(customerZone.default_vehicle_code) ?? null : null
    const courierVehicle = typeof logisticsPayload?.courierVehicleCode === 'string'
      ? vehicles.get(logisticsPayload.courierVehicleCode) ?? null
      : null
    if (deliveryLegs.some((leg) => leg.rodzaj === 'kurier') && !courierVehicle) warnings.push('courier_vehicle_missing')

    const pricedLegs = deliveryLegs.map((leg) => {
      const stops = Math.max(1, toNum(leg.przystankow))
      const documentsAtStop = Math.max(1, toNum(leg.dokumentowNaPrzystanku))
      const isCourier = leg.rodzaj === 'kurier'
      const routeKm = isCourier || leg.kmTrasy === null || leg.kmTrasy === undefined ? null : toNum(leg.kmTrasy)
      const vehicle = isCourier ? courierVehicle : vanVehicle
      const cost = vehicle ? roundCost(vehicle, routeKm ?? 0) : { fuel: 0, driver: 0, fixed: 0, total: 0 }
      const perStop = cost.total / stops
      return {
        date: typeof leg.data === 'string' ? leg.data : null,
        kind: typeof leg.rodzaj === 'string' ? leg.rodzaj : null,
        stops,
        documentsAtStop,
        routeKm,
        routeCost: cost.total,
        fuelCost: cost.fuel,
        driverCost: cost.driver,
        vehicleCost: cost.fixed,
        perStop,
        share: perStop / documentsAtStop,
        priced: vehicle != null,
      }
    })
    const deliveryCost = mode === 'goods' ? 0 : pricedLegs.reduce((total, leg) => total + leg.share, 0)
    const vanRates = vanVehicle
      ? {
          vehicleCode: vanVehicle.code,
          fuelType: vanVehicle.fuel_type,
          fuelPricePerLitre: fuelByType.get(vanVehicle.fuel_type) ?? null,
          consumptionLPer100Km: toNum(vanVehicle.consumption_l_per_100km),
          fuelPerKm: (toNum(vanVehicle.consumption_l_per_100km) / 100) * (fuelByType.get(vanVehicle.fuel_type) ?? 0),
          driverPerKm: (driveMinutesPerKm / 60) * loadedHourlyRate(vanVehicle.driver_role_code),
          driveMinutesPerKm,
          fixedPerRound: scheduleConfigured ? toNum(vanVehicle.fixed_cost_month) / workingDaysPerMonth / tripsPerDay : null,
          workingDaysPerMonth: scheduleConfigured ? workingDaysPerMonth : null,
          tripsPerDay: scheduleConfigured ? tripsPerDay : null,
        }
      : null
    const courierFlat = courierVehicle && scheduleConfigured
      ? toNum(courierVehicle.fixed_cost_month) / workingDaysPerMonth / tripsPerDay
      : null

    const sourcePayload = payloads.get('source_costing') ?? null
    const sourceCosting = sourcePayload
      ? {
          perDocument: toNum(sourcePayload.perDocument),
          perLine: toNum(sourcePayload.perLine),
          perStop: toNum(sourcePayload.perStop),
          source: typeof sourcePayload.source === 'string' ? sourcePayload.source : null,
        }
      : null
    if (!sourceCosting) warnings.push('source_costing_missing')

    const pricingService = container.hasRegistration?.('pricingService')
      ? container.resolve<{ quote: (ctx: unknown, opts?: unknown) => Promise<{ lines: QuotedLine[] }> }>('pricingService')
      : null

    const quotable = lines.filter((line) => line.product_id && toNum(line.quantity) > 0)
    const quoteDate = order.placedAt ? new Date(order.placedAt) : new Date()
    // Bound outside the closure: inside it TypeScript loses the narrowing done above.
    const quoteCurrency = order.currencyCode ?? 'PLN'
    const quoteCustomerId = order.customerEntityId ?? null
    const triggeredByUserId = auth.sub ?? null

    // Every (volume, channel) pair is quoted at most once per request; the ladder, the breakdown
    // panels and the line table all read from the same handful of quotes.
    //
    // The PROMISE is what is cached, not the map it resolves to. The quotes below are issued
    // together, so a cache holding a not-yet-filled map would hand the second caller an empty
    // basket rather than make it wait for the first.
    const quoteCache = new Map<string, Promise<Map<string, QuotedLine>>>()
    function quoteAt(volume: number, orderScenarioCode: string | null): Promise<Map<string, QuotedLine>> {
      const key = `${volume}|${orderScenarioCode ?? ''}`
      const cached = quoteCache.get(key)
      if (cached) return cached
      const pending = runQuote(volume, orderScenarioCode)
      quoteCache.set(key, pending)
      return pending
    }

    async function runQuote(volume: number, orderScenarioCode: string | null): Promise<Map<string, QuotedLine>> {
      const out = new Map<string, QuotedLine>()
      if (!pricingService || !quotable.length) return out
      const result = await pricingService.quote(
        {
          tenantId,
          organizationId,
          currencyCode: quoteCurrency,
          customerId: quoteCustomerId,
          orderScenarioCode,
          lines: quotable.map((line) => ({
            productId: line.product_id as string,
            variantId: line.product_variant_id,
            sku: line.sku,
            quantity: String(toNum(line.quantity) * volume),
            purchaseUnitCostNet: documentPurchaseCostOf(line),
          })),
          date: quoteDate,
          mode: 'simulate',
        },
        { persist: false, triggeredBy: 'simulate', triggeredByUserId },
      )
      for (const quotedLine of result.lines) {
        const productId = quotedLine.line?.productId
        if (productId) out.set(String(productId), quotedLine)
      }
      return out
    }

    // What a quoted basket costs, and what that cost is made of. Comes from the pipeline's own
    // breakdown, so it stays correct when a component is added or a rate changes, and each entry
    // keeps its confidence so an assumed rate cannot pass for a measured one.
    function costOf(quotedMap: Map<string, QuotedLine>): BasketCost {
      const totals = new Map<string, { amount: number; confidence: string }>()
      for (const quotedLine of quotedMap.values()) {
        const lineQuantity = toNum(quotedLine.line?.quantity)
        for (const component of quotedLine.breakdown ?? []) {
          if (component.effect !== 'add') continue
          if (mode === 'goods' && component.code !== 'product_cost') continue
          const amount = toNum(component.value) * lineQuantity
          if (Math.abs(amount) < 0.005) continue
          const current = totals.get(component.code)
          if (current) current.amount += amount
          else totals.set(component.code, { amount, confidence: component.confidence })
        }
      }
      // Delivery belongs on the same line as picking, packing and order handling: it is the
      // fourth thing the source performs and does not book. When the document carries its real
      // delivery calendar, that replaces the engine's zone average outright — pricing both would
      // charge the same van twice. A document without a calendar keeps the zone estimate.
      const logistics = totals.get('logistics_cost')
      if (logistics) totals.delete('logistics_cost')
      const deliveryTotal = !quotedMap.size
        ? 0
        : pricedLegs.length
          ? (mode === 'goods' ? 0 : deliveryCost)
          : (logistics?.amount ?? 0)
      if (deliveryTotal > 0) {
        const operations = totals.get('operational_cost_base')
        if (operations) operations.amount += deliveryTotal
        else totals.set('operational_cost_base', { amount: deliveryTotal, confidence: logistics?.confidence ?? 'measured' })
      }
      const total = Array.from(totals.values()).reduce((sum, entry) => sum + entry.amount, 0)
      const goods = totals.get('product_cost')?.amount ?? 0
      const components: CostComponent[] = Array.from(totals.entries())
        .map(([code, entry]) => ({ code, amount: entry.amount, share: percentOf(entry.amount, total), confidence: entry.confidence }))
        .sort((a, b) => b.amount - a.amount)
      return { goods, ops: total - goods, total, components }
    }

    const emptyCost: BasketCost = { goods: 0, ops: 0, total: 0, components: [] }
    let engineError: string | null = null
    // The WZ as it happened: actual quantities, the customer's usual channel. Every "keep the real
    // profit" figure is anchored here, whatever volume or channel the page is currently exploring.
    let baseQuoted = new Map<string, QuotedLine>()
    let selectedQuoted = new Map<string, QuotedLine>()
    let offerQuoted = new Map<string, QuotedLine>()
    const ladderQuoted = new Map<number, Map<string, QuotedLine>>()
    if (pricingService && quotable.length) {
      try {
        // Eight quotes of one basket, issued together. They share the loaded pricing inputs (the
        // engine memoizes them per EntityManager), so what used to be eight prefetch-and-price
        // rounds one after another is now one prefetch and eight prices in parallel.
        const [base, selected, offer, ...ladder] = await Promise.all([
          quoteAt(1, null),
          quoteAt(multiplier, null),
          quoteAt(multiplier, scenarioCode),
          ...LADDER_MULTIPLIERS.map((volume) => quoteAt(volume, scenarioCode)),
        ])
        baseQuoted = base
        selectedQuoted = selected
        offerQuoted = offer
        LADDER_MULTIPLIERS.forEach((volume, index) => {
          ladderQuoted.set(volume, ladder[index] ?? new Map())
        })
      } catch (err) {
        logger.warn('Pricing engine refused the basket', { err: String(err) })
        engineError = 'pricing_failed'
        baseQuoted = new Map()
        selectedQuoted = new Map()
        offerQuoted = new Map()
        ladderQuoted.clear()
      }
    } else if (!pricingService) {
      engineError = 'pricing_unavailable'
    }

    const baseCost = baseQuoted.size ? costOf(baseQuoted) : emptyCost
    const selectedCost = selectedQuoted.size ? costOf(selectedQuoted) : emptyCost
    const offerCost = offerQuoted.size ? costOf(offerQuoted) : emptyCost

    const revenue = lines.reduce((total, line) => total + toNum(line.total_net_amount), 0)
    const theirCost = lines.reduce(
      (total, line) => total + toNum(asObject(asObject(line.catalog_snapshot).zrodlo).cenaZakupuNetto) * toNum(line.quantity),
      0,
    )
    const baseRealProfit = baseQuoted.size ? revenue - baseCost.total : null

    // Both sides must carry the same kind of cost or the table lies. The source books the purchase
    // invoice alone, but it performs — and pays for — the same picking, packing and delivery, so its
    // line cost gets the identical operational share ours does. Only then is "their margin" against
    // "our price" a comparison rather than a mismatch. The SELLING price is never touched: it is
    // what the customer actually paid on the WZ.
    const rows = lines.map((line) => {
      const source = asObject(asObject(line.catalog_snapshot).zrodlo)
      const quantity = toNum(line.quantity)
      const simulatedQuantity = quantity * multiplier
      const theirUnitPrice = toNum(line.unit_price_net)
      const theirUnitCost = toNum(source.cenaZakupuNetto)
      // Their margin comes from the source document's own `marzaNetto`, not from anything computed
      // here — it is what their system booked and what the salesperson saw. The field holds the
      // LINE total, so it has to come back to a unit before it meets unit prices.
      const theirUnitProfit = quantity > 0 ? toNum(source.marzaNetto) / quantity : 0
      const theirMargin = theirUnitPrice > 0 ? theirUnitProfit / theirUnitPrice : 0
      const baseLine = line.product_id ? baseQuoted.get(line.product_id) : undefined
      const quotedLine = line.product_id ? selectedQuoted.get(line.product_id) : undefined
      const offerLine = line.product_id ? offerQuoted.get(line.product_id) : undefined
      const goodsUnitBase = goodsUnitOf(baseLine)
      const ourGoodsUnit = goodsUnitOf(quotedLine)

      // Operational effort per unit comes from the ENGINE's own costing of this line — its unit
      // cost minus the goods — not from a second allocation invented here.
      //
      // It used to be `documentOps × (line value / document value)`, which made every line's ops
      // cost strictly proportional to its price. Run that through "keep the same zloty of profit"
      // and the goods cancel, leaving `newPrice = oldPrice × (1 + delta)` with the SAME delta on
      // every row — which is why this table showed an identical -3.8% against a serviette and
      // against a paper-towel pack. Nothing in `source_costing` behaves that way: `perDocument`,
      // `perStop` and `perLine` are all flat. The engine already splits basket-level components
      // from line-level ones (`level: 'basket'` vs `'line'`) and allocates by cost share, so the
      // honest move is to use its answer rather than overwrite it with a worse rule.
      const opsUnitOf = (quoted: QuotedLine | undefined): number =>
        opsUnitFromQuote(quoted ? toNum(quoted.unitCostNet) : null, goodsUnitOf(quoted))
      const opsPerUnitBase = opsUnitOf(baseLine)
      const opsPerUnit = opsUnitOf(quotedLine)
      const opsPerUnitOffer = opsUnitOf(offerLine ?? quotedLine)
      const ourUnitCost = quotedLine ? (mode === 'goods' ? ourGoodsUnit : toNum(quotedLine.unitCostNet)) : null
      const scenarioUnitCost = offerLine && scenarioCode
        ? (mode === 'goods' ? goodsUnitOf(offerLine) : toNum(offerLine.unitCostNet))
        : null

      // The document's price is the fixed point: the customer paid it. What differs is the cost
      // behind it, so the useful figures are the profit each side makes AT THAT PRICE, and — for
      // the offer — the price at which the real profit per unit the WZ earned is kept exactly,
      // once the customer's channel and volume have lowered what serving them costs.
      const ourProfitAtTheirPrice = ourGoodsUnit === null ? null : theirUnitPrice - ourGoodsUnit - opsPerUnit
      const profitDelta = ourProfitAtTheirPrice === null ? null : ourProfitAtTheirPrice - theirUnitProfit
      const realProfitUnitBase = goodsUnitBase === null ? null : theirUnitPrice - goodsUnitBase - opsPerUnitBase
      // The engine's own price for this line already carries the target margin, so it is the line
      // that says whether there is anything to give away: a WZ price above it has headroom, a WZ
      // price at or below it is already at or under target and must not be discounted at all.
      // This is the "only where the margin is above target" rule — the discount stops being a flat
      // percentage sprayed across the document and lands only where a margin actually exists.
      const engineOfferUnitPrice = offerLine ? toNum(offerLine.unitPriceNet) : null
      const profitNeutralUnitPrice = ourGoodsUnit === null || realProfitUnitBase === null
        ? null
        : ourGoodsUnit + opsPerUnitOffer + realProfitUnitBase
      // Never below the engine's target price: keeping yesterday's zloty of profit must not be an
      // argument for selling under the margin the tenant configured.
      const offerUnitPrice = resolveOfferUnitPrice({
        theirUnitPrice,
        engineOfferUnitPrice,
        profitNeutralUnitPrice,
      })
      const floorUnitPrice = ourGoodsUnit === null ? null : ourGoodsUnit + opsPerUnitOffer
      const headroomPerUnit = offerUnitPrice === null ? null : theirUnitPrice - offerUnitPrice
      const marginAtTheirPrice = ourUnitCost === null || theirUnitPrice <= 0
        ? null
        : ((theirUnitPrice - ourUnitCost) / theirUnitPrice) * 100

      return {
        simulatedQuantity,
        lineNumber: line.line_number,
        productId: line.product_id ?? null,
        sku: line.sku,
        name: line.name,
        group: (source.grupa as string) ?? null,
        quantity,
        quantityUnit: line.quantity_unit,
        theirUnitPrice,
        theirUnitCost,
        theirUnitCostFull: theirUnitCost + opsPerUnit,
        theirOpsPerUnit: opsPerUnit,
        theirMarginPercent: theirMargin * 100,
        theirLineProfit: theirUnitProfit * quantity,
        ourUnitCost,
        ourGoodsUnit,
        ourProfitAtTheirPrice,
        profitDelta,
        scenarioUnitCost,
        marginAtTheirPrice,
        realProfitUnitBase,
        offerUnitPrice,
        offerDiscountPercent: headroomPerUnit === null ? null : percentOf(headroomPerUnit, theirUnitPrice),
        // What the source ERP would print for the offered price: price minus purchase invoice.
        addAllMarginAtOfferPercent: offerUnitPrice === null || offerUnitPrice <= 0
          ? null
          : ((offerUnitPrice - theirUnitCost) / offerUnitPrice) * 100,
        floorUnitPrice,
        headroomPerUnit,
        priced: quotedLine != null,
      }
    })

    const priced = rows.filter((row) => row.priced)

    // The offer ladder: the same WZ, re-quoted at the chosen channel and at growing volume. Each
    // step hands the customer exactly the cost-to-serve their behaviour removes, so the real profit
    // in zloty is the WZ's own, scaled to the volume. Prices on the WZ are never rewritten.
    const ladder = baseRealProfit === null
      ? []
      : [
          { multiplier: 1, scenario: null as string | null, cost: baseCost },
          ...(scenarioCode
            ? LADDER_MULTIPLIERS.map((volume) => ({
                multiplier: volume,
                scenario: scenarioCode,
                cost: ladderQuoted.has(volume) ? costOf(ladderQuoted.get(volume) as Map<string, QuotedLine>) : emptyCost,
              }))
            : LADDER_MULTIPLIERS.filter((volume) => volume !== 1).map((volume) => ({
                multiplier: volume,
                scenario: null as string | null,
                cost: ladderQuoted.has(volume) ? costOf(ladderQuoted.get(volume) as Map<string, QuotedLine>) : emptyCost,
              }))),
        ].map((step) => {
          const wzRevenue = revenue * step.multiplier
          const purchaseCost = theirCost * step.multiplier
          const realProfitKept = baseRealProfit * step.multiplier
          const offerRevenue = step.cost.goods + step.cost.ops + realProfitKept
          const discount = wzRevenue - offerRevenue
          return {
            multiplier: step.multiplier,
            scenario: step.scenario,
            wzRevenue,
            goods: step.cost.goods,
            ops: step.cost.ops,
            realProfitAtWz: wzRevenue - step.cost.total,
            realProfitKept,
            offerRevenue,
            breakEvenRevenue: step.cost.total,
            discount,
            discountPercent: percentOf(discount, wzRevenue),
            addAllMarginAtWzPercent: percentOf(wzRevenue - purchaseCost, wzRevenue),
            addAllMarginAtOfferPercent: percentOf(offerRevenue - purchaseCost, offerRevenue),
            realMarginAtOfferPercent: percentOf(realProfitKept, offerRevenue),
          }
        })

    // Their own operating cost, allocated exactly as ours is — because our step rates were
    // calibrated FROM their process costing (91 422 zl/month across nine processes). They incur
    // this money too; their ERP simply books it to company overhead instead of to the document
    // that caused it. Showing their column as goods-only made this system look more expensive
    // when it charges the identical amount.
    // Their operating cost is per document, per line and per stop — none of it moves with the
    // quantity on the line, so it stays put under the volume multiplier while ours is re-quoted.
    const sourceDeliveries = Array.isArray(sourceMeta.dostawy) ? sourceMeta.dostawy.length : 0
    const theirOperations = mode === 'goods' || !sourceCosting
      ? 0
      : sourceCosting.perDocument + sourceCosting.perLine * lines.length + sourceCosting.perStop * Math.max(1, sourceDeliveries)
    const theirGoodsAtVolume = theirCost * multiplier
    const theirTotalCost = theirGoodsAtVolume + theirOperations
    const theirComponents: CostComponent[] = [
      { code: 'goods', amount: theirGoodsAtVolume, share: percentOf(theirGoodsAtVolume, theirTotalCost) || 100, confidence: 'measured' },
      ...(theirOperations > 0
        ? [{ code: 'their_operations', amount: theirOperations, share: percentOf(theirOperations, theirTotalCost), confidence: 'unbooked' }]
        : []),
    ]

    return NextResponse.json({
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        customerEntityId: order.customerEntityId ?? null,
        placedAt: order.placedAt,
        currencyCode: order.currencyCode ?? 'PLN',
        customerReference: order.customerReference ?? null,
        sourceFirm: (sourceMeta.firma as string) ?? null,
        salespeople: Array.isArray(sourceMeta.handlowcy) ? sourceMeta.handlowcy : [],
        deliveries: Array.isArray(sourceMeta.dostawy) ? sourceMeta.dostawy : [],
        dataComplete: orderMeta.daneKompletne !== false,
      },
      // The WZ itself, at its own volume and channel — the only numbers that never move.
      baseline: {
        revenue,
        theirCost,
        theirProfit: revenue - theirCost,
        theirMarginPercent: percentOf(revenue - theirCost, revenue),
        ourCost: baseCost.total,
        ops: baseCost.ops,
        realProfit: baseRealProfit,
        realMarginPercent: baseRealProfit === null ? null : percentOf(baseRealProfit, revenue),
      },
      totals: {
        mode,
        multiplier,
        lineCount: rows.length,
        pricedLineCount: priced.length,
        revenue,
        simulatedRevenue: revenue * multiplier,
        theirCost: theirGoodsAtVolume,
        theirTotalCost,
        theirProfit: revenue * multiplier - theirGoodsAtVolume,
        theirMarginPercent: percentOf(revenue - theirCost, revenue),
        ourCost: selectedCost.total,
        scenarioCost: scenarioCode ? offerCost.total : 0,
        linesCheaper: priced.filter((row) => (row.headroomPerUnit ?? 0) > 0.005).length,
        linesBelowOurCost: priced.filter((row) => (row.ourUnitCost ?? 0) > row.theirUnitPrice).length,
      },
      components: {
        theirs: theirComponents,
        ours: selectedCost.components,
        scenario: scenarioCode ? offerCost.components : [],
      },
      scenario: scenarioCode,
      channels,
      ladder,
      // The delivery calendar behind this document: each drop, the round it rode on and how many
      // other stops shared that round's kilometres. This is where "how many orders go out at once"
      // is answered, and why the same customer costs less to reach on a busy day.
      delivery: {
        model: typeof deliveryMeta.model === 'string' ? deliveryMeta.model : null,
        distanceKm: toNum(deliveryMeta.kmDoKlienta) || null,
        zoneCode: customerZone?.code ?? null,
        total: deliveryCost,
        rates: vanRates,
        courierFlat,
        legs: pricedLegs,
      },
      sourceCosting,
      warnings,
      lines: rows,
      engineError,
    })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    logger.error('Price comparison failed', { err: String(err) })
    return NextResponse.json({ error: '[internal] price comparison failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Distributor Workspace',
  summary: 'Compare source ERP pricing with this system’s cost-to-serve pipeline',
  methods: {
    GET: {
      summary: 'Per-line offer price at kept real profit, cost breakdowns and a channel/volume ladder for one imported order',
      responses: [{ status: 200, description: 'Comparison rows, ladder and totals' }],
    },
  },
}
