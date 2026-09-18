import { add, div, gt, money, mul, ONE, percentToFactor, toDecimal, ZERO } from '../decimal'
import type { Decimal } from '../decimal'
import type { ComponentComputeArgs, ComponentResult, PriceComponent } from '../types'

export const LOGISTICS_COST_CODE = 'logistics_cost'

// TODO(data-source): neither the fleet nor the delivery-zone tables record how often a vehicle
// actually rolls. Until a route/dispatch source exists, the monthly fixed cost is spread over an
// assumed calendar: a Polish working month (21 days) and one run per vehicle per day. Both are
// overridable through `pricing_component_params` for `logistics_cost`, and any calculation that
// falls back to them is reported as an assumption, never as a measurement.
export const DEFAULT_WORKING_DAYS_PER_MONTH = '21'
export const DEFAULT_TRIPS_PER_DAY = '1'

const MINUTES_PER_HOUR = toDecimal('60')
const KM_PER_CONSUMPTION_REFERENCE = toDecimal('100')
// A delivery run goes out and comes back; the zone stores the one-way figures.
const ROUND_TRIP = toDecimal('2')

type LogisticsPayload = {
  workingDaysPerMonth?: string | number
  tripsPerDay?: string | number
}

function missingResult(
  args: ComponentComputeArgs,
  zoneCode: string | null,
  missingInputs: string[],
  warnings: string[],
): ComponentResult {
  return {
    code: LOGISTICS_COST_CODE,
    labelKey: 'pricing_engine.components.logisticsCost.label',
    effect: 'add',
    value: '0.0000',
    inputs: {
      deliveryZoneCode: zoneCode,
      quantity: money(args.quantity),
      missingInputs,
    },
    params: {},
    explainKey: 'pricing_engine.components.logisticsCost.explain.missing',
    explainValues: {
      zone: zoneCode ?? '',
      missingCount: missingInputs.length,
    },
    confidence: 'default',
    warnings,
  }
}

async function compute(args: ComponentComputeArgs): Promise<ComponentResult> {
  const { context, deps, line, quantity, lineIndex } = args
  const zoneCode = context.deliveryZoneCode ?? null
  const zone = deps.params.deliveryZone(zoneCode)
  const warnings: string[] = []

  if (!zone) {
    // TODO(data-source): no delivery zone on the quote, or no `pricing_delivery_zones` row for it.
    // There is no distance to fall back on, so the line is priced without a delivery cost and says so.
    warnings.push('pricing_engine.warnings.deliveryZoneMissing')
    return missingResult(args, zoneCode, ['delivery_zone'], warnings)
  }

  const vehicle = deps.params.vehicle(zone.defaultVehicleCode)
  const fuelPricePerLitre = vehicle ? deps.params.fuelPrice(vehicle.fuelType) : null
  const driverRate = vehicle ? deps.params.laborRate(vehicle.driverRoleCode) : null

  const missingInputs: string[] = []
  if (!vehicle) {
    // TODO(data-source): the zone names no vehicle, or the referenced `pricing_vehicles` row is gone.
    missingInputs.push('vehicle')
    warnings.push('pricing_engine.warnings.deliveryVehicleMissing')
  }
  if (vehicle && !fuelPricePerLitre) {
    // TODO(data-source): no `pricing_fuel_prices` observation at or before the quote date for this
    // fuel type. A fuel price is never guessed — a stale-by-invention litre price moves every line.
    missingInputs.push('fuel_price')
    warnings.push('pricing_engine.warnings.fuelPriceMissing')
  }
  if (vehicle && !driverRate) {
    // TODO(data-source): the vehicle's driver role has no `pricing_labor_rates` row.
    missingInputs.push('driver_rate')
    warnings.push('pricing_engine.warnings.driverRateMissing')
  }

  if (!vehicle || !fuelPricePerLitre || !driverRate) {
    return missingResult(args, zone.code, missingInputs, warnings)
  }

  const product = deps.catalog.byProductId.get(line.productId) ?? null
  const scopeRefs = {
    productId: line.productId,
    productGroupCode: product?.productGroupCode ?? null,
    customerId: context.customerId ?? null,
    customerGroupCode: context.customerGroupCode ?? null,
  }
  const payload = deps.params.componentPayload(LOGISTICS_COST_CODE, scopeRefs) as LogisticsPayload | null
  const paramRef = deps.params.componentParamRef(LOGISTICS_COST_CODE, scopeRefs)

  // Both figures are divisors. A configured 0, a negative, null or a non-numeric string must fall
  // back to the documented default and be reported as assumed: `div()` returns 0 on a zero
  // divisor, so an unvalidated 0 would make the vehicle's fixed cost silently vanish from the
  // price while the component still claimed the schedule was configured.
  const resolveDivisor = (configured: unknown, fallback: string): { value: Decimal; assumed: boolean } => {
    if (configured === undefined || configured === null) return { value: toDecimal(fallback), assumed: true }
    const parsed = toDecimal(configured as string | number, fallback)
    if (!gt(parsed, ZERO)) return { value: toDecimal(fallback), assumed: true }
    return { value: parsed, assumed: false }
  }

  const workingDays = resolveDivisor(payload?.workingDaysPerMonth, DEFAULT_WORKING_DAYS_PER_MONTH)
  const trips = resolveDivisor(payload?.tripsPerDay, DEFAULT_TRIPS_PER_DAY)
  const scheduleAssumed = workingDays.assumed || trips.assumed
  if (scheduleAssumed) warnings.push('pricing_engine.warnings.logisticsScheduleAssumed')

  const workingDaysPerMonth = workingDays.value
  const tripsPerDay = trips.value

  const roundTripKm = mul(toDecimal(zone.avgDistanceKm), ROUND_TRIP)
  const litres = mul(
    div(roundTripKm, KM_PER_CONSUMPTION_REFERENCE),
    toDecimal(vehicle.consumptionLPer100Km),
  )
  const fuelCost = mul(litres, toDecimal(fuelPricePerLitre))

  const roundTripHours = div(mul(toDecimal(zone.avgDriveMinutes), ROUND_TRIP), MINUTES_PER_HOUR)
  const loadedDriverRate = mul(
    toDecimal(driverRate.hourlyRate),
    add(ONE, percentToFactor(driverRate.overheadRate)),
  )
  const driverCost = mul(roundTripHours, loadedDriverRate)

  // A vehicle earns its monthly fixed cost back over the runs it actually makes; dividing by
  // days x trips turns a monthly figure into the share carried by this one run.
  const vehicleFixedShare = div(div(toDecimal(vehicle.fixedCostMonth), workingDaysPerMonth), tripsPerDay)
  const runCost = add(add(fuelCost, driverCost), vehicleFixedShare)

  // Delivery density: the run is shared across every drop on it, so a dense city zone costs a
  // fraction of what the same kilometres cost when one customer is the only stop.
  // `typical_stops` is a plain integer column, so NaN/Infinity/0/negatives all have to be caught
  // here rather than trusted — an invalid divisor would otherwise either zero the cost or invert it.
  const stopsInvalid = !Number.isInteger(zone.typicalStops) || zone.typicalStops < 1
  if (stopsInvalid) warnings.push('pricing_engine.warnings.deliveryStopsInvalid')
  const typicalStops = stopsInvalid ? ONE : toDecimal(String(zone.typicalStops))
  const costPerStop = div(runCost, typicalStops)

  const lineShare = toDecimal(deps.allocation.shareByLineIndex[lineIndex] ?? '0')
  const lineCost = mul(costPerStop, lineShare)
  const perUnit = quantity > ZERO ? div(lineCost, quantity) : ZERO

  const assumed = scheduleAssumed || stopsInvalid

  return {
    code: LOGISTICS_COST_CODE,
    labelKey: 'pricing_engine.components.logisticsCost.label',
    effect: 'add',
    value: money(perUnit),
    inputs: {
      deliveryZoneCode: zone.code,
      avgDistanceKm: zone.avgDistanceKm,
      avgDriveMinutes: zone.avgDriveMinutes,
      typicalStops: zone.typicalStops,
      vehicleCode: vehicle.code,
      fuelType: vehicle.fuelType,
      fuelPricePerLitre,
      quantity: money(quantity),
      lineShare: money(lineShare),
    },
    params: {
      consumptionLPer100Km: vehicle.consumptionLPer100Km,
      fixedCostMonth: vehicle.fixedCostMonth,
      driverRoleCode: vehicle.driverRoleCode,
      driverHourlyRate: driverRate.hourlyRate,
      overheadRate: driverRate.overheadRate,
      workingDaysPerMonth: money(workingDaysPerMonth),
      tripsPerDay: money(tripsPerDay),
      scheduleSource: scheduleAssumed ? 'assumed_default' : 'component_param',
      paramRef,
    },
    explainKey: scheduleAssumed
      ? 'pricing_engine.components.logisticsCost.explain.assumedSchedule'
      : 'pricing_engine.components.logisticsCost.explain.configured',
    explainValues: {
      zone: zone.code,
      vehicle: vehicle.code,
      distanceKm: money(roundTripKm),
      fuelCost: money(fuelCost),
      driverCost: money(driverCost),
      vehicleCost: money(vehicleFixedShare),
      runCost: money(runCost),
      stops: zone.typicalStops,
      workingDays: money(workingDaysPerMonth),
      tripsPerDay: money(tripsPerDay),
      perUnit: money(perUnit),
      currency: context.currencyCode,
    },
    // Never `measured`: a zone's distance and drive time are averages over past runs, so even a
    // fully configured fleet prices this line off a derived figure rather than a measured one.
    confidence: assumed ? 'default' : 'estimated',
    warnings,
  }
}

export const logisticsCostComponent: PriceComponent = {
  code: LOGISTICS_COST_CODE,
  position: 5,
  level: 'basket',
  effect: 'add',
  labelKey: 'pricing_engine.components.logisticsCost.label',
  contributesToCost: true,
  compute,
}
