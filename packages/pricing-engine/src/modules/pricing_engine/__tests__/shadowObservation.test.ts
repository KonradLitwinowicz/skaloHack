import { buildShadowObservationDraft } from '../lib/shadow/observation'

describe('shadow observation deltas', () => {
  it('reports the signed gap between the engine price and the invoiced price', () => {
    const draft = buildShadowObservationDraft('100.0000', '112.5000')

    expect(draft.invoicedUnitPriceNet).toBe('100.0000')
    expect(draft.engineUnitPriceNet).toBe('112.5000')
    expect(draft.deltaAbsolute).toBe('12.5000')
    expect(draft.deltaPercent).toBe('12.5000')
    expect(draft.hasDeltaPercent).toBe(true)
    expect(draft.deltaPercentClamped).toBe(false)
  })

  it('keeps the sign when the engine would have charged less than the invoice', () => {
    const draft = buildShadowObservationDraft('80.0000', '60.0000')

    expect(draft.deltaAbsolute).toBe('-20.0000')
    expect(draft.deltaPercent).toBe('-25.0000')
  })

  it('reports agreement as a zero delta rather than as an absence', () => {
    const draft = buildShadowObservationDraft('42.7300', '42.7300')

    expect(draft.deltaAbsolute).toBe('0.0000')
    expect(draft.deltaPercent).toBe('0.0000')
    expect(draft.hasDeltaPercent).toBe(true)
  })

  it('flags a zero invoiced amount instead of dividing by it', () => {
    const draft = buildShadowObservationDraft('0', '31.0000')

    expect(draft.deltaAbsolute).toBe('31.0000')
    expect(draft.deltaPercent).toBe('0.0000')
    expect(draft.hasDeltaPercent).toBe(false)
  })

  it('treats a zero-to-zero comparison as agreement with no ratio', () => {
    const draft = buildShadowObservationDraft('0', '0')

    expect(draft.deltaAbsolute).toBe('0.0000')
    expect(draft.deltaPercent).toBe('0.0000')
    expect(draft.hasDeltaPercent).toBe(false)
  })

  it('clamps a percentage that numeric(7,4) could not store, and says so', () => {
    const draft = buildShadowObservationDraft('0.0100', '500.0000')

    expect(draft.deltaAbsolute).toBe('499.9900')
    expect(draft.deltaPercent).toBe('999.9999')
    expect(draft.deltaPercentClamped).toBe(true)
  })

  it('clamps a negative overflow to the same magnitude', () => {
    const draft = buildShadowObservationDraft('-0.0100', '500.0000')

    expect(draft.deltaPercent).toBe('-999.9999')
    expect(draft.deltaPercentClamped).toBe(true)
  })

  it('reads decimal strings and numbers alike, and treats a missing amount as zero', () => {
    expect(buildShadowObservationDraft(10, 15).deltaAbsolute).toBe('5.0000')
    expect(buildShadowObservationDraft(null, undefined).deltaAbsolute).toBe('0.0000')
  })

  it('rounds the percentage to the four decimals the column holds', () => {
    const draft = buildShadowObservationDraft('3.0000', '4.0000')

    expect(draft.deltaPercent).toBe('33.3333')
  })
})
