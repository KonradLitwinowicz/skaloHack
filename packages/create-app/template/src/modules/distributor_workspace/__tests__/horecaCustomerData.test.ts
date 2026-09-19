import {
  HORECA_CUSTOMERS,
  HORECA_DEPOT,
  type HorecaCustomerSeed,
} from '../seed/horecaCustomerData'

/**
 * These assertions guard the seed DATA, not the seeder. The pricing engine divides by these
 * numbers: a wrong coordinate silently changes every delivery cost, a duplicate NIP breaks a
 * uniqueness assumption downstream, and a zone that disagrees with its own distance makes the
 * zone fallback and the coordinate branch produce contradictory answers for the same customer.
 */

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/

function nipChecksum(nip: string): boolean {
  if (!/^\d{10}$/.test(nip)) return false
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7]
  const sum = weights.reduce((acc, weight, index) => acc + weight * Number(nip[index]), 0)
  const remainder = sum % 11
  if (remainder === 10) return false
  return remainder === Number(nip[9])
}

function greatCircleKm(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): number {
  const earthRadiusKm = 6371
  const toRadians = (value: number) => (value * Math.PI) / 180
  const deltaLat = toRadians(toLat - fromLat)
  const deltaLon = toRadians(toLon - fromLon)
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(deltaLon / 2) ** 2
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

const ZONE_BANDS: Record<string, { min: number; max: number }> = {
  'warszawa-centrum': { min: 0, max: 8 },
  'warszawa-obrzeza': { min: 8, max: 20 },
  'mazowieckie-blisko': { min: 20, max: 60 },
  'mazowieckie-daleko': { min: 60, max: 160 },
}

function defaultAddress(customer: HorecaCustomerSeed) {
  return customer.addresses.find((address) => address.isDefault)
}

describe('HoReCa customer seed data', () => {
  it('ships exactly 40 customers', () => {
    expect(HORECA_CUSTOMERS).toHaveLength(40)
  })

  it('has unique handles, tax ids and emails', () => {
    const handles = new Set(HORECA_CUSTOMERS.map((customer) => customer.handle))
    const taxIds = new Set(HORECA_CUSTOMERS.map((customer) => customer.taxId))
    const emails = new Set(HORECA_CUSTOMERS.map((customer) => customer.email.toLowerCase()))
    expect(handles.size).toBe(HORECA_CUSTOMERS.length)
    expect(taxIds.size).toBe(HORECA_CUSTOMERS.length)
    expect(emails.size).toBe(HORECA_CUSTOMERS.length)
  })

  it('prefixes every handle so the seeder probe cannot collide with other data', () => {
    const unprefixed = HORECA_CUSTOMERS.filter((customer) => !customer.handle.startsWith('horeca-'))
    expect(unprefixed.map((customer) => customer.handle)).toEqual([])
  })

  it('carries valid Polish tax ids', () => {
    const invalid = HORECA_CUSTOMERS.filter((customer) => !nipChecksum(customer.taxId))
    expect(invalid.map((customer) => `${customer.handle}:${customer.taxId}`)).toEqual([])
  })

  it('gives every customer exactly one default delivery address', () => {
    const broken = HORECA_CUSTOMERS.filter(
      (customer) => customer.addresses.filter((address) => address.isDefault).length !== 1,
    )
    expect(broken.map((customer) => customer.handle)).toEqual([])
  })

  it('places every address inside Poland', () => {
    const outside = HORECA_CUSTOMERS.flatMap((customer) =>
      customer.addresses
        .filter((address) => {
          const lat = Number(address.latitude)
          const lon = Number(address.longitude)
          return !(lat > 49 && lat < 55 && lon > 14 && lon < 24.2)
        })
        .map((address) => `${customer.handle}:${address.city}`),
    )
    expect(outside).toEqual([])
  })

  it('keeps every declared zone consistent with the distance from the depot', () => {
    const depotLat = Number(HORECA_DEPOT.latitude)
    const depotLon = Number(HORECA_DEPOT.longitude)
    const mismatched = HORECA_CUSTOMERS.flatMap((customer) => {
      const address = defaultAddress(customer)
      if (!address) return [`${customer.handle}:no-default-address`]
      const band = ZONE_BANDS[customer.deliveryZoneCode]
      if (!band) return [`${customer.handle}:unknown-zone-${customer.deliveryZoneCode}`]
      const distance = greatCircleKm(depotLat, depotLon, Number(address.latitude), Number(address.longitude))
      if (distance < band.min || distance > band.max) {
        return [`${customer.handle}:${customer.deliveryZoneCode}:${distance.toFixed(2)}km`]
      }
      return []
    })
    expect(mismatched).toEqual([])
  })

  it('emits every money and coordinate value as a decimal string, never a float', () => {
    const offenders = HORECA_CUSTOMERS.flatMap((customer) => {
      const problems: string[] = []
      if (typeof customer.avgBasketValueNet !== 'string' || !DECIMAL_STRING.test(customer.avgBasketValueNet)) {
        problems.push(`${customer.handle}:avgBasketValueNet`)
      }
      for (const address of customer.addresses) {
        if (typeof address.latitude !== 'string' || !DECIMAL_STRING.test(address.latitude)) {
          problems.push(`${customer.handle}:latitude`)
        }
        if (typeof address.longitude !== 'string' || !DECIMAL_STRING.test(address.longitude)) {
          problems.push(`${customer.handle}:longitude`)
        }
      }
      return problems
    })
    expect(offenders).toEqual([])
  })

  it('covers every segment and every zone so the seeded tenant is not uniform', () => {
    const segments = new Set(HORECA_CUSTOMERS.map((customer) => customer.segment))
    const zones = new Set(HORECA_CUSTOMERS.map((customer) => customer.deliveryZoneCode))
    expect(segments.size).toBeGreaterThanOrEqual(8)
    expect([...zones].sort()).toEqual(Object.keys(ZONE_BANDS).sort())
  })

  it('varies order volume and basket value rather than repeating one figure', () => {
    const baskets = new Set(HORECA_CUSTOMERS.map((customer) => customer.avgBasketValueNet))
    const counts = new Set(HORECA_CUSTOMERS.map((customer) => customer.monthlyOrderCount))
    expect(baskets.size).toBeGreaterThan(20)
    expect(counts.size).toBeGreaterThan(5)
  })
})
