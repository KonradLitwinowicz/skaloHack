import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { PricingDeliveryZone } from '@open-mercato/pricing-engine/modules/pricing_engine/data/entities'
import { HORECA_CUSTOMERS, HORECA_DEPOT } from './horecaCustomerData'
import { bump, emptyReport, type DistributorSeedScope, type SeedReport, type SeedRunOptions } from './types'

/**
 * Delivery zones are DERIVED from the seeded customer coordinates, not invented.
 *
 * The engine's `logistics_cost` reads `avg_distance_km` and `avg_drive_minutes` per zone. Hand-typing
 * those alongside a customer list whose coordinates say something else is how a zone average quietly
 * stops describing its own customers. So the averages here are computed from the great-circle distance
 * between the depot and each customer's default address, multiplied by a road-winding factor — the same
 * arithmetic the coordinate branch of the distance seam will use, which keeps the zone fallback and the
 * precise branch telling the same story.
 */

/** A straight line is not a road. Polish road networks run roughly 25-40% longer than the crow flies. */
export const ROAD_WINDING_FACTOR = 1.35

/** Average door-to-door speed including urban stops, km/h. Drive minutes derive from it. */
export const AVERAGE_SPEED_KMH = 38

const ZONE_LABELS: Record<string, string> = {
  'warszawa-centrum': 'Warszawa — centrum',
  'warszawa-obrzeza': 'Warszawa — obrzeża',
  'mazowieckie-blisko': 'Mazowieckie — blisko',
  'mazowieckie-daleko': 'Mazowieckie — daleko',
}

const DEFAULT_VEHICLE_CODE = 'van_35t'

export function greatCircleKm(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const earthRadiusKm = 6371
  const toRadians = (value: number) => (value * Math.PI) / 180
  const deltaLat = toRadians(toLat - fromLat)
  const deltaLon = toRadians(toLon - fromLon)
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(deltaLon / 2) ** 2
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}

export type DerivedZone = {
  code: string
  label: string
  avgDistanceKm: string
  avgDriveMinutes: string
  typicalStops: number
  customerCount: number
}

export function deriveZonesFromCustomers(): DerivedZone[] {
  const depotLat = Number(HORECA_DEPOT.latitude)
  const depotLon = Number(HORECA_DEPOT.longitude)
  const buckets = new Map<string, number[]>()

  for (const customer of HORECA_CUSTOMERS) {
    const address = customer.addresses.find((candidate) => candidate.isDefault) ?? customer.addresses[0]
    if (!address) continue
    const straight = greatCircleKm(depotLat, depotLon, Number(address.latitude), Number(address.longitude))
    const bucket = buckets.get(customer.deliveryZoneCode) ?? []
    bucket.push(straight * ROAD_WINDING_FACTOR)
    buckets.set(customer.deliveryZoneCode, bucket)
  }

  return [...buckets.entries()]
    .map(([code, distances]) => {
      const average = distances.reduce((sum, value) => sum + value, 0) / distances.length
      // A dense urban round drops more stops per trip than a long provincial one.
      const typicalStops = average < 12 ? 6 : average < 25 ? 4 : average < 60 ? 2 : 1
      return {
        code,
        label: ZONE_LABELS[code] ?? code,
        avgDistanceKm: average.toFixed(4),
        avgDriveMinutes: ((average / AVERAGE_SPEED_KMH) * 60).toFixed(4),
        typicalStops,
        customerCount: distances.length,
      }
    })
    .sort((left, right) => Number(left.avgDistanceKm) - Number(right.avgDistanceKm))
}

export async function seedHorecaDeliveryZones(
  em: EntityManager,
  scope: DistributorSeedScope,
  options: SeedRunOptions = {},
): Promise<SeedReport> {
  const report = emptyReport()
  const zones = deriveZonesFromCustomers()

  if (options.dryRun) {
    report.created = zones.length
    for (const zone of zones) bump(report, `${zone.code}=${zone.avgDistanceKm}km/${zone.customerCount}kl`)
    report.warnings.push('[internal] dry run: nothing was written')
    return report
  }

  for (const zone of zones) {
    const existing = await em.findOne(PricingDeliveryZone, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      code: zone.code,
    })
    if (existing) {
      existing.label = zone.label
      existing.avgDistanceKm = zone.avgDistanceKm
      existing.avgDriveMinutes = zone.avgDriveMinutes
      existing.typicalStops = zone.typicalStops
      existing.defaultVehicleCode = DEFAULT_VEHICLE_CODE
      existing.deletedAt = null
      report.skipped += 1
      bump(report, 'zonesUpdated')
      continue
    }
    em.persist(
      em.create(PricingDeliveryZone, {
        id: randomUUID(),
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        isDemo: true,
        code: zone.code,
        label: zone.label,
        avgDistanceKm: zone.avgDistanceKm,
        avgDriveMinutes: zone.avgDriveMinutes,
        typicalStops: zone.typicalStops,
        defaultVehicleCode: DEFAULT_VEHICLE_CODE,
      }),
    )
    report.created += 1
    bump(report, 'zonesCreated')
  }

  await em.flush()
  return report
}
