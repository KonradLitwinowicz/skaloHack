import {
  allocateFefo,
  computeShelfLifeMarkdown,
  DEFAULT_SHELF_LIFE_CONFIG,
  DEFAULT_SHELF_LIFE_DAYS,
  readShelfLifeConfig,
  resolveShelfLife,
  resolveStage,
  stageFloorPrice,
  type ShelfLifeConfig,
} from '../lib/components/shelfLife'
import { money, toDecimal } from '../lib/decimal'
import type { ProductLotSnapshot } from '../lib/types'
import { buildLot, QUOTE_DATE } from './fixtures'

const MS_PER_DAY = 86_400_000

function daysFromQuote(days: number): Date {
  return new Date(QUOTE_DATE.getTime() + days * MS_PER_DAY)
}

/** A lot whose remaining life is exactly `remaining / total` of its shelf life at the quote date. */
function lotWithFraction(
  remainingDays: number,
  totalDays: number,
  overrides: Partial<ProductLotSnapshot> = {},
): ProductLotSnapshot {
  return buildLot({
    manufacturedAt: daysFromQuote(remainingDays - totalDays),
    expiresAt: daysFromQuote(remainingDays),
    quantityAvailable: '30.0000',
    ...overrides,
  })
}

function configWith(overrides: Partial<ShelfLifeConfig> = {}): ShelfLifeConfig {
  return { ...DEFAULT_SHELF_LIFE_CONFIG, ...overrides }
}

describe('resolveShelfLife', () => {
  it('measures the full life from the manufacturing date when one is recorded', () => {
    const reading = resolveShelfLife(lotWithFraction(100, 400), QUOTE_DATE)
    expect(reading).not.toBeNull()
    expect(reading?.totalDays).toBe(400)
    expect(reading?.remainingDays).toBe(100)
    expect(money(reading?.remainingFraction ?? 0n)).toBe('0.2500')
    expect(reading?.confidence).toBe('measured')
  })

  it('falls back to the configured default shelf life and says the figure is estimated', () => {
    const reading = resolveShelfLife(
      buildLot({ expiresAt: daysFromQuote(73), quantityAvailable: '10.0000' }),
      QUOTE_DATE,
    )
    expect(reading?.totalDays).toBe(DEFAULT_SHELF_LIFE_DAYS)
    expect(money(reading?.remainingFraction ?? 0n)).toBe('0.2000')
    expect(reading?.confidence).toBe('estimated')
  })

  it('reads best_before_at when no hard expiry is recorded', () => {
    const reading = resolveShelfLife(
      buildLot({ bestBeforeAt: daysFromQuote(40), quantityAvailable: '10.0000' }),
      QUOTE_DATE,
    )
    expect(reading?.expiryDate.toISOString()).toBe(daysFromQuote(40).toISOString())
  })

  it('returns null for a lot carrying no date at all, so no ladder can apply to it', () => {
    expect(resolveShelfLife(buildLot({ quantityAvailable: '10.0000' }), QUOTE_DATE)).toBeNull()
  })
})

describe('resolveStage', () => {
  // The bands are lower-inclusive. A lot sitting exactly on a printed threshold must land in one
  // band deterministically, or the same lot prices two different ways on two different days.
  it.each([
    [101, 400, 'none'],
    [100, 400, 'early'],
    [41, 400, 'early'],
    [40, 400, 'early'],
    [39, 400, 'at_cost'],
    [21, 400, 'at_cost'],
    [20, 400, 'at_cost'],
    [19, 400, 'salvage'],
    [1, 400, 'salvage'],
  ])('puts %i of %i remaining days in stage %s', (remaining, total, expected) => {
    const reading = resolveShelfLife(lotWithFraction(remaining, total), QUOTE_DATE)
    expect(resolveStage(reading?.remainingFraction ?? 0n, DEFAULT_SHELF_LIFE_CONFIG)).toBe(expected)
  })
})

describe('stageFloorPrice', () => {
  const cost = toDecimal('20.0000')

  it('leaves the ordinary guardrail in charge at stage none', () => {
    expect(stageFloorPrice('none', cost, toDecimal('5.2'), DEFAULT_SHELF_LIFE_CONFIG)).toBeNull()
  })

  it('drops the margin floor to the early markdown margin', () => {
    // 20 / (1 - 0.05) = 21.0526
    const floor = stageFloorPrice('early', cost, toDecimal('5.2'), DEFAULT_SHELF_LIFE_CONFIG)
    expect(money(floor ?? 0n)).toBe('21.0526')
  })

  it('sells at cost, exactly, at the at_cost stage', () => {
    expect(money(stageFloorPrice('at_cost', cost, toDecimal('5.2'), DEFAULT_SHELF_LIFE_CONFIG) ?? 0n)).toBe(
      '20.0000',
    )
  })

  it('goes genuinely negative when disposal is not free', () => {
    // Destroying 5.2 kg of hazardous goods costs 31.20 PLN, so giving a unit away for 1 PLN is
    // 32.20 PLN better than scrapping it. A floor of zero would forbid the best outcome.
    const floor = stageFloorPrice(
      'salvage',
      cost,
      toDecimal('5.2'),
      configWith({ disposalRatePerKg: toDecimal('6.00') }),
    )
    expect(money(floor ?? 0n)).toBe('-31.2000')
  })

  it('cannot price disposal without a weight, so it stops at zero', () => {
    const floor = stageFloorPrice('salvage', cost, null, configWith({ disposalRatePerKg: toDecimal('6.00') }))
    expect(money(floor ?? 0n)).toBe('0.0000')
  })
})

describe('allocateFefo', () => {
  it('consumes the earliest-expiring lot first and leaves the surplus unmarked', () => {
    const near = lotWithFraction(19, 400, { lotId: 'lot-near', lotNumber: 'L-CHEM-0070' })
    const portions = allocateFefo([near], toDecimal('100'), QUOTE_DATE, DEFAULT_SHELF_LIFE_CONFIG)

    expect(portions).toHaveLength(2)
    expect(portions[0].lot?.lotNumber).toBe('L-CHEM-0070')
    expect(money(portions[0].quantity)).toBe('30.0000')
    expect(portions[0].stage).toBe('salvage')
    // The 70 units that are not on the shelf are not expiring either.
    expect(portions[1].lot).toBeNull()
    expect(money(portions[1].quantity)).toBe('70.0000')
    expect(portions[1].stage).toBe('none')
  })

  it('skips lots that cannot be picked', () => {
    const held = lotWithFraction(19, 400, { lotId: 'held', lotNumber: 'L-A', status: 'hold' })
    const expiredFlag = lotWithFraction(19, 400, { lotId: 'flagged', lotNumber: 'L-B', status: 'expired' })
    const pastDate = lotWithFraction(-3, 400, { lotId: 'past', lotNumber: 'L-C' })
    const empty = lotWithFraction(19, 400, { lotId: 'empty', lotNumber: 'L-D', quantityAvailable: '0.0000' })
    const good = lotWithFraction(19, 400, { lotId: 'good', lotNumber: 'L-E' })

    const portions = allocateFefo(
      [held, expiredFlag, pastDate, empty, good],
      toDecimal('10'),
      QUOTE_DATE,
      DEFAULT_SHELF_LIFE_CONFIG,
    )
    expect(portions).toHaveLength(1)
    expect(portions[0].lot?.lotId).toBe('good')
  })

  it('sorts lots without a date last and breaks ties on lot number', () => {
    const undated = buildLot({ lotId: 'undated', lotNumber: 'L-AAA', quantityAvailable: '5.0000' })
    const later = lotWithFraction(40, 400, {
      lotId: 'later',
      lotNumber: 'L-ZZZ',
      quantityAvailable: '5.0000',
    })
    const tieB = lotWithFraction(19, 400, { lotId: 'tie-b', lotNumber: 'L-B', quantityAvailable: '5.0000' })
    const tieA = lotWithFraction(19, 400, { lotId: 'tie-a', lotNumber: 'L-A', quantityAvailable: '5.0000' })

    const portions = allocateFefo(
      [undated, later, tieB, tieA],
      toDecimal('100'),
      QUOTE_DATE,
      DEFAULT_SHELF_LIFE_CONFIG,
    )
    expect(portions.map((portion) => portion.lot?.lotId ?? null)).toEqual([
      'tie-a',
      'tie-b',
      'later',
      'undated',
      null,
    ])
  })

  it('is deterministic across runs, so two quotes for the same basket consume the same lots', () => {
    const lots = [
      lotWithFraction(19, 400, { lotId: 'tie-b', lotNumber: 'L-B', quantityAvailable: '5.0000' }),
      lotWithFraction(19, 400, { lotId: 'tie-a', lotNumber: 'L-A', quantityAvailable: '5.0000' }),
    ]
    const first = allocateFefo(lots, toDecimal('8'), QUOTE_DATE, DEFAULT_SHELF_LIFE_CONFIG)
    const second = allocateFefo([...lots].reverse(), toDecimal('8'), QUOTE_DATE, DEFAULT_SHELF_LIFE_CONFIG)
    expect(second.map((portion) => [portion.lot?.lotId, money(portion.quantity)])).toEqual(
      first.map((portion) => [portion.lot?.lotId, money(portion.quantity)]),
    )
  })
})

describe('computeShelfLifeMarkdown', () => {
  const baseArgs = {
    orderedQuantity: toDecimal('100'),
    asOf: QUOTE_DATE,
    unitCostNet: toDecimal('20.0000'),
    // Equal to unitCostNet here only so the existing expectations stay readable; the two diverge in
    // the pipeline, and the test below pins which one the write-off uses.
    purchaseUnitCost: toDecimal('20.0000'),
    weightKg: toDecimal('5.2000'),
    normalUnitPrice: toDecimal('45.0000'),
    config: DEFAULT_SHELF_LIFE_CONFIG,
  }

  // Cost to serve accumulates picking, packing, warehousing and delivery by the time the guardrail
  // runs. Stock nobody buys incurs none of them, so the write-off must be priced at purchase cost.
  it('prices the avoided write-off from purchase cost, not from cost to serve', () => {
    const markdown = computeShelfLifeMarkdown({
      ...baseArgs,
      orderedQuantity: toDecimal('30'),
      unitCostNet: toDecimal('20.0000'),
      purchaseUnitCost: toDecimal('14.0000'),
      lots: [lotWithFraction(20, 400, { quantityAvailable: '100.0000' })],
    })

    expect(money(markdown?.writeOffAvoided ?? 0n)).toBe('1400.0000')
  })

  it('returns null when nothing in stock is near its date', () => {
    expect(
      computeShelfLifeMarkdown({ ...baseArgs, lots: [lotWithFraction(300, 400)] }),
    ).toBeNull()
  })

  it('returns null when no lot carries a date at all', () => {
    expect(
      computeShelfLifeMarkdown({ ...baseArgs, lots: [buildLot({ quantityAvailable: '500.0000' })] }),
    ).toBeNull()
  })

  it('blends the marked-down lot with the rest of the line instead of discounting all of it', () => {
    const markdown = computeShelfLifeMarkdown({
      ...baseArgs,
      lots: [lotWithFraction(20, 400, { lotNumber: 'L-CHEM-0070' })],
    })
    // 30 units at cost, 70 at the price they would have fetched anyway: (30 x 20 + 70 x 45) / 100.
    expect(markdown?.stage).toBe('at_cost')
    expect(money(markdown?.weightedFloorUnitPrice ?? 0n)).toBe('37.5000')
    expect(money(markdown?.markdownQuantity ?? 0n)).toBe('30.0000')
    expect(markdown?.leadLot.lotNumber).toBe('L-CHEM-0070')
  })

  it('prices the whole line at cost when one lot covers it', () => {
    const markdown = computeShelfLifeMarkdown({
      ...baseArgs,
      orderedQuantity: toDecimal('30'),
      lots: [lotWithFraction(20, 400)],
    })
    expect(money(markdown?.weightedFloorUnitPrice ?? 0n)).toBe('20.0000')
    expect(markdown?.warnings).not.toContain('pricing_engine.warnings.shelfLifeBelowCost')
  })

  it('reports the write-off the markdown avoids and warns when the price drops below cost', () => {
    const markdown = computeShelfLifeMarkdown({
      ...baseArgs,
      orderedQuantity: toDecimal('30'),
      config: configWith({ disposalRatePerKg: toDecimal('6.00') }),
      lots: [lotWithFraction(10, 400, { quantityAvailable: '65.3500' })],
    })
    expect(markdown?.stage).toBe('salvage')
    expect(money(markdown?.weightedFloorUnitPrice ?? 0n)).toBe('-31.2000')
    // 65.35 units that cost 20 PLN each is what gets destroyed if nobody buys them.
    expect(money(markdown?.writeOffAvoided ?? 0n)).toBe('1307.0000')
    expect(markdown?.warnings).toContain('pricing_engine.warnings.shelfLifeBelowCost')
  })

  it('warns when a salvage floor is asked for on a product with no weight on record', () => {
    const markdown = computeShelfLifeMarkdown({
      ...baseArgs,
      weightKg: null,
      orderedQuantity: toDecimal('30'),
      lots: [lotWithFraction(10, 400)],
    })
    expect(money(markdown?.salvageFloorUnitPrice ?? 0n)).toBe('0.0000')
    expect(markdown?.warnings).toContain('pricing_engine.warnings.shelfLifeWeightMissing')
  })

  it('is only `measured` once both the rates and the lot dates are, not merely present', () => {
    const configured = readShelfLifeConfig({
      earlyThresholdPercent: '25',
      atCostThresholdPercent: '10',
      salvageThresholdPercent: '5',
      earlyMarginPercent: '5',
      disposalRatePerKg: '6.00',
      defaultShelfLifeDays: 365,
    })
    expect(configured.supplied).toBe(true)

    const measured = computeShelfLifeMarkdown({
      ...baseArgs,
      config: configured,
      lots: [lotWithFraction(20, 400)],
    })
    expect(measured?.confidence).toBe('measured')

    const estimated = computeShelfLifeMarkdown({
      ...baseArgs,
      config: configured,
      lots: [buildLot({ expiresAt: daysFromQuote(20), quantityAvailable: '30.0000' })],
    })
    expect(estimated?.confidence).toBe('estimated')
    expect(estimated?.warnings).toContain('pricing_engine.warnings.shelfLifeLengthAssumed')

    const assumed = computeShelfLifeMarkdown({ ...baseArgs, lots: [lotWithFraction(20, 400)] })
    expect(assumed?.confidence).toBe('default')
    expect(assumed?.warnings).toContain('pricing_engine.warnings.shelfLifeRatesAssumed')
  })
})

describe('readShelfLifeConfig', () => {
  it('refuses thresholds that are not strictly descending, rather than salvaging fresh stock', () => {
    const config = readShelfLifeConfig({
      earlyThresholdPercent: '5',
      atCostThresholdPercent: '10',
      salvageThresholdPercent: '25',
    })
    expect(config.thresholdsRejected).toBe(true)
    expect(config.earlyThreshold).toBe(DEFAULT_SHELF_LIFE_CONFIG.earlyThreshold)
    expect(config.supplied).toBe(false)
  })

  it('refuses a disposal rate that is a typo rather than a price', () => {
    const config = readShelfLifeConfig({ disposalRatePerKg: '-4' })
    expect(config.disposalRateRejected).toBe(true)
    expect(config.disposalRatePerKg).toBe(DEFAULT_SHELF_LIFE_CONFIG.disposalRatePerKg)
  })

  it('accepts a complete row and reports it as configured', () => {
    const config = readShelfLifeConfig({
      earlyThresholdPercent: 30,
      atCostThresholdPercent: 12,
      salvageThresholdPercent: 4,
      earlyMarginPercent: '3',
      disposalRatePerKg: '6.00',
      defaultShelfLifeDays: '540',
    })
    expect(money(config.earlyThreshold)).toBe('0.3000')
    expect(config.defaultShelfLifeDays).toBe(540)
    expect(config.earlyMarginPercent).toBe('3')
    expect(config.supplied).toBe(true)
  })
})
