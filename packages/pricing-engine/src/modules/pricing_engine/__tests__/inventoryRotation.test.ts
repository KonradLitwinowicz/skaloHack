import {
  computeRotation,
  issuedQuantityOf,
  MAX_COVER_DAYS,
  MIN_OBSERVED_DAYS,
  ROTATION_WINDOW_DAYS,
  type MovementRow,
  type RotationArgs,
} from '../lib/inventory'
import { toDecimal, ZERO } from '../lib/decimal'
import { PRODUCT_ID, QUOTE_DATE, VARIANT_ID } from './fixtures'

const MS_PER_DAY = 86_400_000

function daysBefore(days: number): Date {
  return new Date(QUOTE_DATE.getTime() - days * MS_PER_DAY)
}

function movement(overrides: Partial<MovementRow> = {}): MovementRow {
  return {
    catalogVariantId: VARIANT_ID,
    quantity: '10',
    type: 'pick',
    performedAt: daysBefore(10),
    locationFrom: { id: 'location-a' },
    locationTo: null,
    ...overrides,
  }
}

function rotationArgs(rows: MovementRow[], onHand: string): RotationArgs {
  return {
    productId: PRODUCT_ID,
    variantIds: [VARIANT_ID],
    onHand: toDecimal(onHand),
    rows,
    asOf: QUOTE_DATE,
    windowDays: ROTATION_WINDOW_DAYS,
    minObservedDays: MIN_OBSERVED_DAYS,
    maxCoverDays: MAX_COVER_DAYS,
  }
}

describe('issuedQuantityOf', () => {
  it('counts nothing for a relocation, whatever type it carries', () => {
    for (const type of ['pick', 'ship', 'transfer', 'adjust']) {
      const row = movement({ type, locationFrom: { id: 'location-a' }, locationTo: { id: 'location-b' } })
      expect(issuedQuantityOf(row)).toBe(ZERO)
    }
  })

  it('counts a pick and a ship as goods leaving the building', () => {
    expect(issuedQuantityOf(movement({ type: 'pick', quantity: '10' }))).toBe(toDecimal('10'))
    expect(issuedQuantityOf(movement({ type: 'ship', quantity: '7.5000' }))).toBe(toDecimal('7.5'))
  })

  it('reads an adjustment from its sign: negative removes stock, positive does not', () => {
    expect(issuedQuantityOf(movement({ type: 'adjust', quantity: '-4' }))).toBe(toDecimal('4'))
    expect(issuedQuantityOf(movement({ type: 'adjust', quantity: '4' }))).toBe(ZERO)
  })

  it('ignores inbound movements', () => {
    const receipt = movement({ type: 'receipt', locationFrom: null, locationTo: { id: 'location-a' } })
    const putaway = movement({ type: 'putaway', locationFrom: null, locationTo: { id: 'location-a' } })
    expect(issuedQuantityOf(receipt)).toBe(ZERO)
    expect(issuedQuantityOf(putaway)).toBe(ZERO)
  })
})

describe('computeRotation', () => {
  it('derives days of cover from the measured issue rate', () => {
    const rows = [
      movement({ performedAt: daysBefore(90), quantity: '10' }),
      movement({ performedAt: daysBefore(30), quantity: '10' }),
    ]
    const rotation = computeRotation(rotationArgs(rows, '20'))
    expect(rotation.source).toBe('movements')
    expect(rotation.issuedQuantity).toBe('20.0000')
    expect(rotation.observedDays).toBe(90)
    expect(rotation.dailyIssueRate).toBe('0.2222')
    expect(rotation.coverDays).toBe('90.0000')
  })

  it('measures the observed span from the oldest movement in the window, not from the window width', () => {
    const rows = [
      movement({ performedAt: daysBefore(170), quantity: '10' }),
      movement({ performedAt: daysBefore(10), quantity: '10' }),
    ]
    const rotation = computeRotation(rotationArgs(rows, '20'))
    expect(rotation.observedDays).toBe(170)
    expect(rotation.observedDays).not.toBe(ROTATION_WINDOW_DAYS)
  })

  it('drops movements older than the window', () => {
    const rows = [
      movement({ performedAt: daysBefore(200), quantity: '999' }),
      movement({ performedAt: daysBefore(90), quantity: '10' }),
    ]
    const rotation = computeRotation(rotationArgs(rows, '20'))
    expect(rotation.issuedQuantity).toBe('10.0000')
    expect(rotation.observedDays).toBe(90)
  })

  it('refuses to report a rate from a history shorter than the minimum', () => {
    const rotation = computeRotation(rotationArgs([movement({ performedAt: daysBefore(10) })], '20'))
    expect(rotation.source).toBe('short_history')
    expect(rotation.coverDays).toBeNull()
    expect(rotation.observedDays).toBeLessThan(MIN_OBSERVED_DAYS)
  })

  it('reports no issues when every movement in the window was a relocation', () => {
    const rows = [
      movement({ performedAt: daysBefore(90), locationTo: { id: 'location-b' } }),
      movement({ performedAt: daysBefore(30), locationTo: { id: 'location-b' } }),
    ]
    const rotation = computeRotation(rotationArgs(rows, '20'))
    expect(rotation.source).toBe('no_issues')
    expect(rotation.issuedQuantity).toBe('0.0000')
    expect(rotation.coverDays).toBeNull()
  })

  it('reports no stock when nothing is on hand to cover', () => {
    const rows = [
      movement({ performedAt: daysBefore(90), quantity: '10' }),
      movement({ performedAt: daysBefore(30), quantity: '10' }),
    ]
    const rotation = computeRotation(rotationArgs(rows, '0'))
    expect(rotation.source).toBe('no_stock')
    expect(rotation.coverDays).toBeNull()
  })

  it('reports no movements when the window is empty', () => {
    const rotation = computeRotation(rotationArgs([], '20'))
    expect(rotation.source).toBe('no_movements')
    expect(rotation.observedDays).toBe(0)
    expect(rotation.coverDays).toBeNull()
  })

  it('clamps an immovable product to the maximum cover instead of reporting years', () => {
    const rows = [
      movement({ performedAt: daysBefore(90), quantity: '10' }),
      movement({ performedAt: daysBefore(30), quantity: '10' }),
    ]
    const rotation = computeRotation(rotationArgs(rows, '100000'))
    expect(rotation.coverDays).toBe(`${MAX_COVER_DAYS}.0000`)
  })
})
