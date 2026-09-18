import {
  guardrailCreateSchema,
  marginRuleCreateSchema,
  marginRuleUpdateSchema,
  vehicleCreateSchema,
  warehouseCostCreateSchema,
  TARGET_MARGIN_COMPONENT_CODE,
} from '../data/validators'

const VALID_FROM = '2026-01-01T00:00:00.000Z'
const UUID = '11111111-1111-4111-8111-111111111111'

describe('margin rule schema', () => {
  it('defaults the component code so the screen never has to send it', () => {
    const parsed = marginRuleCreateSchema.parse({
      scope: 'global',
      targetMarkupPercent: '66.0000',
      changeNote: 'Baseline markup for the whole book',
      validFrom: VALID_FROM,
    })
    expect(parsed.componentCode).toBe(TARGET_MARGIN_COMPONENT_CODE)
  })

  it('forces scopeRefId to null for a global rule even when one is sent', () => {
    const parsed = marginRuleCreateSchema.parse({
      scope: 'global',
      scopeRefId: 'leftover-from-a-previous-scope',
      targetMarkupPercent: '66',
      changeNote: 'House default',
      validFrom: VALID_FROM,
    })
    expect(parsed.scopeRefId).toBeNull()
  })

  it('requires a reference for every scope that is not global', () => {
    for (const scope of ['product_group', 'product', 'customer_group', 'customer']) {
      expect(() =>
        marginRuleCreateSchema.parse({
          scope,
          targetMarkupPercent: '66',
          changeNote: 'note',
          validFrom: VALID_FROM,
        }),
      ).toThrow()
    }
  })

  it('accepts a whole-number percent as a string or a number', () => {
    expect(
      marginRuleCreateSchema.parse({
        scope: 'product_group',
        scopeRefId: 'disinfectants',
        targetMarkupPercent: 84,
        changeNote: 'Sanitary requirements',
        validFrom: VALID_FROM,
      }).targetMarkupPercent,
    ).toBe('84')
  })

  it('rejects a percent the numeric column cannot hold', () => {
    expect(() =>
      marginRuleCreateSchema.parse({
        scope: 'global',
        targetMarkupPercent: 'sixty six',
        changeNote: 'note',
        validFrom: VALID_FROM,
      }),
    ).toThrow()
  })

  it('demands a change note, because nothing else records why a rule exists', () => {
    expect(() =>
      marginRuleCreateSchema.parse({
        scope: 'global',
        targetMarkupPercent: '66',
        changeNote: '',
        validFrom: VALID_FROM,
      }),
    ).toThrow()
  })

  it('refuses a validity window that closes before it opens', () => {
    expect(() =>
      marginRuleCreateSchema.parse({
        scope: 'global',
        targetMarkupPercent: '66',
        changeNote: 'note',
        validFrom: '2026-06-01T00:00:00.000Z',
        validTo: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow()
  })

  it('requires an id on update so a correction cannot create a second row by accident', () => {
    expect(() =>
      marginRuleUpdateSchema.parse({
        scope: 'global',
        targetMarkupPercent: '66',
        changeNote: 'note',
        validFrom: VALID_FROM,
      }),
    ).toThrow()
    expect(
      marginRuleUpdateSchema.parse({
        id: UUID,
        scope: 'global',
        targetMarkupPercent: '66',
        changeNote: 'note',
        validFrom: VALID_FROM,
      }).id,
    ).toBe(UUID)
  })
})

describe('guardrail schema', () => {
  const base = { code: 'floor-hospital', scope: 'customer_group' as const, scopeRefId: 'hospital', validFrom: VALID_FROM }

  it('never leaves negotiatedPricePrecedence null, which the NOT NULL column would reject', () => {
    expect(guardrailCreateSchema.parse(base).negotiatedPricePrecedence).toBe('negotiated_wins')
    expect(() =>
      guardrailCreateSchema.parse({ ...base, negotiatedPricePrecedence: null }),
    ).toThrow()
  })

  it('only accepts the two precedence values the engine understands', () => {
    expect(
      guardrailCreateSchema.parse({ ...base, negotiatedPricePrecedence: 'rules_win' })
        .negotiatedPricePrecedence,
    ).toBe('rules_win')
    expect(() =>
      guardrailCreateSchema.parse({ ...base, negotiatedPricePrecedence: 'whatever' }),
    ).toThrow()
  })

  it('rejects a minimum margin of 100 percent or more, where the floor price is infinite', () => {
    expect(guardrailCreateSchema.parse({ ...base, minMarginPercent: '8' }).minMarginPercent).toBe('8')
    expect(() => guardrailCreateSchema.parse({ ...base, minMarginPercent: '100' })).toThrow()
    expect(() => guardrailCreateSchema.parse({ ...base, minMarginPercent: '150' })).toThrow()
    expect(() => guardrailCreateSchema.parse({ ...base, minMarginPercent: '-5' })).toThrow()
  })

  it('leaves the floors optional so a guardrail can set only one of them', () => {
    const parsed = guardrailCreateSchema.parse({ ...base, floorPrice: '12.5000' })
    expect(parsed.floorPrice).toBe('12.5000')
    expect(parsed.minMarginPercent).toBeUndefined()
  })

  it('requires a reference for a scoped guardrail', () => {
    expect(() =>
      guardrailCreateSchema.parse({ code: 'floor', scope: 'customer', validFrom: VALID_FROM }),
    ).toThrow()
  })
})

describe('other parameter schemas', () => {
  it('refuses a vehicle with no capacity at all, which would contribute nothing to a delivery cost', () => {
    const base = {
      code: 'van',
      label: 'Van',
      fuelType: 'diesel',
      consumptionLPer100Km: '9',
      driverRoleCode: 'driver',
    }
    expect(() => vehicleCreateSchema.parse(base)).toThrow()
    expect(vehicleCreateSchema.parse({ ...base, capacityKg: '1200' }).capacityKg).toBe('1200')
    expect(vehicleCreateSchema.parse({ ...base, capacityPallets: 8 }).capacityPallets).toBe(8)
  })

  it('constrains the warehouse basis to the two values the engine models', () => {
    const base = { costPerMonth: '1000', validFrom: VALID_FROM }
    expect(warehouseCostCreateSchema.parse({ ...base, basis: 'm2' }).defaultTurnoverDays).toBe(30)
    expect(warehouseCostCreateSchema.parse({ ...base, basis: 'pallet_slot' }).basis).toBe('pallet_slot')
    expect(() => warehouseCostCreateSchema.parse({ ...base, basis: 'shelf_metre' })).toThrow()
  })
})
