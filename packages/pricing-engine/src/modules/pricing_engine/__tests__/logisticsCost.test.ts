import {
  DEFAULT_TRIPS_PER_DAY,
  DEFAULT_WORKING_DAYS_PER_MONTH,
  LOGISTICS_COST_CODE,
  logisticsCostComponent,
} from '../lib/components/logisticsCost'
import { toDecimal, ZERO } from '../lib/decimal'
import { buildContext, buildDeps, DEMO_ZONES } from './fixtures'

const CITY_ZONE = 'warszawa_poludnie'
const FAR_ZONE = 'mazowieckie_daleko'

function args(
  overrides: Parameters<typeof buildDeps>[0] = {},
  extra: Record<string, unknown> = {},
) {
  const context = buildContext({ deliveryZoneCode: CITY_ZONE })
  return {
    context,
    lineIndex: 0,
    line: context.lines[0],
    quantity: toDecimal('24'),
    runningUnitValue: ZERO,
    unitCostNet: ZERO,
    // Required by `ComponentComputeArgs`: the values of components that already ran in this
    // pipeline pass. Empty here because these cases exercise one component in isolation — but the
    // field has to be PRESENT, or the fixture stops matching the contract it claims to test.
    componentValues: {},
    deps: buildDeps(overrides),
    ...extra,
  }
}

describe('logistics_cost', () => {
  // Zone warszawa_poludnie: 34 km and 55 min one way, 3 stops on the run, van_35t on diesel.
  // Fuel   68 km / 100 x 11.5 l x 6.49 PLN = 50.7518
  // Driver 110 min / 60 x 55 PLN x 1.22 overhead = 123.0167
  // Van    4200 PLN / 21 working days / 1 trip  = 200.0000
  // Run 373.7685 PLN, shared across 3 drops = 124.5895 on this delivery, over 24 units.
  it('prices a round trip from the zone, the vehicle, the fuel price and the driver rate', async () => {
    const result = await logisticsCostComponent.compute(args())

    expect(result.explainValues.fuelCost).toBe('50.7518')
    expect(result.explainValues.driverCost).toBe('123.0167')
    expect(result.explainValues.vehicleCost).toBe('200.0000')
    expect(result.explainValues.runCost).toBe('373.7685')
    expect(Number(result.value)).toBeCloseTo(124.5895 / 24, 4)
    expect(result.effect).toBe('add')
  })

  it('divides the run across the typical number of drops in the zone', async () => {
    const dense = await logisticsCostComponent.compute(args())
    const sparse = await logisticsCostComponent.compute({
      ...args(),
      context: buildContext({ deliveryZoneCode: FAR_ZONE }),
    })
    const denseZone = DEMO_ZONES.find((zone) => zone.code === CITY_ZONE)!
    const sparseZone = DEMO_ZONES.find((zone) => zone.code === FAR_ZONE)!

    expect(denseZone.typicalStops).toBe(3)
    expect(sparseZone.typicalStops).toBe(1)
    // The far zone is both longer and undivided, so it must cost strictly more per unit.
    expect(Number(sparse.value)).toBeGreaterThan(Number(dense.value))
    // Tolerance is 2dp: the reported per-unit amount is snapped to the money scale, so
    // multiplying it back by 24 units cannot recover the full-precision run cost.
    expect(Number(dense.explainValues.runCost as string) / 3).toBeCloseTo(
      Number(dense.value) * 24,
      2,
    )
  })

  it('attributes the run to this line by its share of basket net value', async () => {
    const whole = await logisticsCostComponent.compute(args({ allocation: ['1.0000'] }))
    const quarter = await logisticsCostComponent.compute(
      args({ allocation: ['0.2500', '0.7500'] }),
    )
    expect(Number(quarter.value)).toBeCloseTo(Number(whole.value) / 4, 4)
  })

  it('reports a per-unit amount', async () => {
    const one = await logisticsCostComponent.compute({ ...args(), quantity: toDecimal('1') })
    const ten = await logisticsCostComponent.compute({ ...args(), quantity: toDecimal('10') })
    expect(Number(ten.value)).toBeCloseTo(Number(one.value) / 10, 3)
  })

  it('returns zero rather than dividing by an empty basket line', async () => {
    const result = await logisticsCostComponent.compute({ ...args(), quantity: ZERO })
    expect(result.value).toBe('0.0000')
  })

  it('flags the assumed delivery schedule when no component parameter configures it', async () => {
    const result = await logisticsCostComponent.compute(args())
    expect(result.params.workingDaysPerMonth).toBe('21.0000')
    expect(result.params.tripsPerDay).toBe('1.0000')
    expect(result.params.scheduleSource).toBe('assumed_default')
    expect(result.warnings).toContain('pricing_engine.warnings.logisticsScheduleAssumed')
    expect(result.explainKey).toBe(
      'pricing_engine.components.logisticsCost.explain.assumedSchedule',
    )
    expect(result.confidence).toBe('default')
    expect(DEFAULT_WORKING_DAYS_PER_MONTH).toBe('21')
    expect(DEFAULT_TRIPS_PER_DAY).toBe('1')
  })

  it('prefers a configured schedule and stops calling the result an assumption', async () => {
    const result = await logisticsCostComponent.compute(
      args({
        lookup: {
          componentPayloads: {
            logistics_cost: { workingDaysPerMonth: '21', tripsPerDay: '2' },
          },
        },
      }),
    )
    // Two runs a day halve the fixed-cost share: 4200 / 21 / 2 = 100.
    expect(result.explainValues.vehicleCost).toBe('100.0000')
    expect(result.params.scheduleSource).toBe('component_param')
    expect(result.params.paramRef).toBe('param-logistics_cost')
    expect(result.warnings).not.toContain('pricing_engine.warnings.logisticsScheduleAssumed')
    expect(result.explainKey).toBe('pricing_engine.components.logisticsCost.explain.configured')
    // Zone distances are averages over past runs, so this is never `measured`.
    expect(result.confidence).toBe('estimated')
  })

  it('refuses to invent a distance when the quote carries no delivery zone', async () => {
    const result = await logisticsCostComponent.compute({
      ...args(),
      context: buildContext({ deliveryZoneCode: null }),
    })
    expect(result.value).toBe('0.0000')
    expect(result.confidence).toBe('default')
    expect(result.warnings).toContain('pricing_engine.warnings.deliveryZoneMissing')
    expect(result.explainKey).toBe('pricing_engine.components.logisticsCost.explain.missing')
  })

  it('refuses to price a run when the zone names no vehicle', async () => {
    const result = await logisticsCostComponent.compute(
      args({
        lookup: {
          deliveryZones: [
            {
              code: CITY_ZONE,
              avgDistanceKm: '34.0000',
              avgDriveMinutes: '55.0000',
              typicalStops: 3,
              defaultVehicleCode: null,
            },
          ],
        },
      }),
    )
    expect(result.value).toBe('0.0000')
    expect(result.confidence).toBe('default')
    expect(result.warnings).toContain('pricing_engine.warnings.deliveryVehicleMissing')
  })

  it('refuses to invent a fuel price', async () => {
    const result = await logisticsCostComponent.compute(args({ lookup: { fuelPrices: {} } }))
    expect(result.value).toBe('0.0000')
    expect(result.confidence).toBe('default')
    expect(result.warnings).toContain('pricing_engine.warnings.fuelPriceMissing')
    expect(result.inputs.missingInputs).toEqual(['fuel_price'])
  })

  it('refuses to invent a driver rate', async () => {
    const result = await logisticsCostComponent.compute(args({ lookup: { laborRates: [] } }))
    expect(result.value).toBe('0.0000')
    expect(result.confidence).toBe('default')
    expect(result.warnings).toContain('pricing_engine.warnings.driverRateMissing')
  })

  it('warns instead of zeroing the run when a zone records no stops', async () => {
    const result = await logisticsCostComponent.compute(
      args({
        lookup: {
          deliveryZones: [
            {
              code: CITY_ZONE,
              avgDistanceKm: '34.0000',
              avgDriveMinutes: '55.0000',
              typicalStops: 0,
              defaultVehicleCode: 'van_35t',
            },
          ],
        },
      }),
    )
    expect(result.warnings).toContain('pricing_engine.warnings.deliveryStopsInvalid')
    expect(result.confidence).toBe('default')
    // A zero stop count must not silently zero the delivery cost.
    expect(Number(result.value)).toBeGreaterThan(0)
  })

  it('declares itself as the basket-level cost component at position 5', () => {
    expect(logisticsCostComponent.code).toBe(LOGISTICS_COST_CODE)
    expect(logisticsCostComponent.position).toBe(5)
    expect(logisticsCostComponent.level).toBe('basket')
    expect(logisticsCostComponent.contributesToCost).toBe(true)
    expect(logisticsCostComponent.labelKey).toBe('pricing_engine.components.logisticsCost.label')
  })
})
