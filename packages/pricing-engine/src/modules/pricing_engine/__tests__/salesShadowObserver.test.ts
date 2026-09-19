import type { SalesCalculationService } from '@open-mercato/core/modules/sales/services/salesCalculationService'
import { createShadowObservingCalculationService } from '../services/salesShadowObserver'
import { SHADOW_OBSERVE_ENV } from '../lib/shadow/gate'
import {
  DEMO_LABOR_RATES,
  DEMO_ORDER_SCENARIOS,
  DEMO_OVERHEAD_RATE,
  DEMO_PROCESS_STEPS,
} from '../lib/seedDefaults'
import { PRODUCT_ID } from './fixtures'

const TENANT_ID = '33333333-3333-4333-8333-333333333333'
const ORGANIZATION_ID = '44444444-4444-4444-8444-444444444444'
const SALES_LINE_ID = '55555555-5555-4555-8555-555555555555'
const SALES_DOCUMENT_ID = '66666666-6666-4666-8666-666666666666'
const CUSTOMER_ID = '77777777-7777-4777-8777-777777777777'
const EPOCH = new Date('2000-01-01T00:00:00.000Z')

type Created = { entity: string; data: Record<string, unknown> }

function seedRows(supplierCurrency = 'PLN'): Record<string, unknown[]> {
  return {
    PricingSupplierProfile: [
      {
        id: 'supplier-1',
        slug: 'demo-horeca',
        currencyCode: supplierCurrency,
        defaultTargetMarkup: '66.0000',
        mode: 'shadow',
        roundingPolicy: { step: '0.01' },
        parameterSetVersion: 7,
      },
    ],
    PricingLaborRate: DEMO_LABOR_RATES.map((rate) => ({
      ...rate,
      overheadRate: DEMO_OVERHEAD_RATE,
      validFrom: EPOCH,
      validTo: null,
    })),
    PricingProcessStep: DEMO_PROCESS_STEPS.map((step) => ({ ...step, validFrom: EPOCH, validTo: null })),
    PricingOrderScenario: DEMO_ORDER_SCENARIOS.map((scenario) => ({
      ...scenario,
      stepMultipliers: { ...scenario.stepMultipliers },
      extraStepCodes: [...scenario.extraStepCodes],
      validFrom: EPOCH,
      validTo: null,
    })),
    PricingComponentParam: [],
    PricingGuardrail: [],
    PricingPackagingCost: [],
    PricingWarehouseCost: [],
    PricingVehicle: [],
    PricingDeliveryZone: [],
    PricingFuelPrice: [],
    PricingPurchasePosition: [],
    PricingCustomerIndicator: [],
  }
}

/**
 * A request EntityManager that refuses every write. The observer is only allowed to touch a fork,
 * so any persist or flush reaching this object is the defect the harness exists to catch.
 */
function createForkingEm(rows: Record<string, unknown[]>) {
  const created: Created[] = []
  const forkOptions: unknown[] = []
  const finds: Array<{ entity: string; where: unknown }> = []
  let forkFlushes = 0
  const nameOf = (entity: unknown): string =>
    typeof entity === 'function' ? (entity as { name: string }).name : String(entity)

  const fork = {
    async findOne(entity: unknown) {
      return (rows[nameOf(entity)] ?? [])[0] ?? null
    },
    async find(entity: unknown, where?: unknown) {
      finds.push({ entity: nameOf(entity), where })
      return rows[nameOf(entity)] ?? []
    },
    create(entity: unknown, data: Record<string, unknown>) {
      const record = { ...data }
      created.push({ entity: nameOf(entity), data: record })
      return record
    },
    persist() {},
    async flush() {
      forkFlushes += 1
    },
  }

  const requestEm = {
    fork(options: unknown) {
      forkOptions.push(options)
      return fork
    },
    async findOne() {
      throw new Error('[internal] the observer must read through a fork')
    },
    async find() {
      throw new Error('[internal] the observer must read through a fork')
    },
    create() {
      throw new Error('[internal] the observer must not create on the request EntityManager')
    },
    persist() {
      throw new Error('[internal] the observer must not persist on the request EntityManager')
    },
    async flush() {
      throw new Error('[internal] the observer must not flush the request EntityManager')
    },
  }

  return {
    requestEm,
    created,
    forkOptions,
    finds,
    // Exposed so a test can replay what an earlier pass wrote, which is how the deduplication
    // guard is exercised without a database.
    rows,
    forkFlushCount: () => forkFlushes,
    container: {
      resolve(name: string) {
        if (name === 'em') return requestEm
        throw new Error('[internal] catalog and inventory peers are absent in this test')
      },
    },
  }
}

function buildDocumentResult(overrides: { currencyCode?: string; quantity?: number; netAmount?: number } = {}) {
  const quantity = overrides.quantity ?? 24
  const netAmount = overrides.netAmount ?? 1200
  return {
    kind: 'order' as const,
    currencyCode: overrides.currencyCode ?? 'PLN',
    lines: [
      {
        line: {
          id: SALES_LINE_ID,
          kind: 'product' as const,
          productId: PRODUCT_ID,
          productVariantId: null,
          quantity,
          currencyCode: overrides.currencyCode ?? 'PLN',
          unitPriceNet: netAmount / quantity,
        },
        netAmount,
        grossAmount: netAmount * 1.23,
        taxAmount: netAmount * 0.23,
        discountAmount: 0,
        adjustments: [],
      },
    ],
    adjustments: [],
    totals: {
      subtotalNetAmount: netAmount,
      subtotalGrossAmount: netAmount * 1.23,
      discountTotalAmount: 0,
      taxTotalAmount: netAmount * 0.23,
      grandTotalNetAmount: netAmount,
      grandTotalGrossAmount: netAmount * 1.23,
    },
    metadata: {},
  }
}

function buildDocumentInput(
  currencyCode = 'PLN',
  identity: { documentId?: string | null; customerId?: string | null } = {},
) {
  return {
    documentKind: 'order' as const,
    lines: [],
    context: { tenantId: TENANT_ID, organizationId: ORGANIZATION_ID, currencyCode, ...identity },
  } as unknown as Parameters<SalesCalculationService['calculateDocumentTotals']>[0]
}

function buildBaseService(result: unknown, lineResult: unknown = { line: {}, netAmount: 0, grossAmount: 0, taxAmount: 0, discountAmount: 0, adjustments: [] }) {
  const calls = { document: 0, line: 0 }
  const service = {
    async calculateDocumentTotals() {
      calls.document += 1
      return result
    },
    async calculateLine() {
      calls.line += 1
      return lineResult
    },
  } as unknown as SalesCalculationService
  return { service, calls }
}

describe('shadow-observing sales calculation service', () => {
  const originalFlag = process.env[SHADOW_OBSERVE_ENV]

  afterEach(() => {
    if (originalFlag === undefined) delete process.env[SHADOW_OBSERVE_ENV]
    else process.env[SHADOW_OBSERVE_ENV] = originalFlag
  })

  it('returns the base result unchanged, by value and by reference', async () => {
    process.env[SHADOW_OBSERVE_ENV] = '1'
    const harness = createForkingEm(seedRows())
    const baseResult = buildDocumentResult()
    const expected = structuredClone(baseResult)
    const { service } = buildBaseService(baseResult)

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })
    const result = await decorated.calculateDocumentTotals(buildDocumentInput())

    expect(result).toEqual(expected)
    expect(result).toBe(baseResult)
    expect(harness.created.length).toBeGreaterThan(0)
  })

  it('records the delta between the invoiced unit price and the engine unit price', async () => {
    process.env[SHADOW_OBSERVE_ENV] = '1'
    const harness = createForkingEm(seedRows())
    const { service } = buildBaseService(buildDocumentResult({ quantity: 24, netAmount: 1200 }))

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })
    await decorated.calculateDocumentTotals(buildDocumentInput())

    const observations = harness.created.filter((row) => row.entity === 'PricingShadowObservation')
    expect(observations).toHaveLength(1)
    const row = observations[0].data

    expect(row.tenantId).toBe(TENANT_ID)
    expect(row.organizationId).toBe(ORGANIZATION_ID)
    expect(row.salesDocumentKind).toBe('order')
    expect(row.salesLineId).toBe(SALES_LINE_ID)
    expect(row.calculationId).toBeNull()
    expect(row.invoicedUnitPriceNet).toBe('50.0000')
    expect(Number(row.engineUnitPriceNet)).toBeGreaterThan(0)
    expect(Number(row.deltaAbsolute)).toBeCloseTo(
      Number(row.engineUnitPriceNet) - Number(row.invoicedUnitPriceNet),
      4,
    )
  })

  // `calculateDocumentTotals` runs on nearly every mutation of a draft — sixty call sites across
  // the sales module — so an unconditional insert would bury the handful of rows that mean
  // something under hundreds that repeat them.
  // Without these the row could not be joined back to the document or the customer it came from,
  // which is what made customer- and group-scoped parameters unreachable from this seam.
  it('attributes the observation to the document and the customer the context names', async () => {
    process.env[SHADOW_OBSERVE_ENV] = '1'
    const harness = createForkingEm(seedRows())
    const { service } = buildBaseService(buildDocumentResult({ quantity: 24, netAmount: 1200 }))

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })
    await decorated.calculateDocumentTotals(
      buildDocumentInput('PLN', { documentId: SALES_DOCUMENT_ID, customerId: CUSTOMER_ID }),
    )

    const observations = harness.created.filter((row) => row.entity === 'PricingShadowObservation')
    expect(observations).toHaveLength(1)
    expect(observations[0].data.salesDocumentId).toBe(SALES_DOCUMENT_ID)
    expect(observations[0].data.customerId).toBe(CUSTOMER_ID)

    // The point of carrying the customer is not the column: it is that customer-scoped inputs are
    // now reachable, so the engine price being compared is the one this customer would be quoted.
    expect(harness.finds).toContainEqual({
      entity: 'PricingCustomerIndicator',
      where: expect.objectContaining({ customerId: CUSTOMER_ID }),
    })
  })

  // Both fields are optional on the sales contract, so a caller written before they existed keeps
  // producing observations; they are simply unattributed rather than absent.
  it('records null attribution for a caller whose context carries neither field', async () => {
    process.env[SHADOW_OBSERVE_ENV] = '1'
    const harness = createForkingEm(seedRows())
    const { service } = buildBaseService(buildDocumentResult({ quantity: 24, netAmount: 1200 }))

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })
    await decorated.calculateDocumentTotals(buildDocumentInput())

    const observations = harness.created.filter((row) => row.entity === 'PricingShadowObservation')
    expect(observations).toHaveLength(1)
    expect(observations[0].data.salesDocumentId).toBeNull()
    expect(observations[0].data.customerId).toBeNull()
  })

  it('records an unchanged comparison once, however many times the document is recalculated', async () => {
    process.env[SHADOW_OBSERVE_ENV] = '1'
    const harness = createForkingEm(seedRows())
    const { service } = buildBaseService(buildDocumentResult({ quantity: 24, netAmount: 1200 }))

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })
    await decorated.calculateDocumentTotals(buildDocumentInput())

    const first = harness.created.filter((row) => row.entity === 'PricingShadowObservation')
    expect(first).toHaveLength(1)

    // Replay the row the first pass wrote, exactly as the database would hand it back.
    const stored = first[0].data
    harness.rows.PricingShadowObservation = [
      {
        salesLineId: stored.salesLineId,
        invoicedUnitPriceNet: stored.invoicedUnitPriceNet,
        engineUnitPriceNet: stored.engineUnitPriceNet,
      },
    ]
    await decorated.calculateDocumentTotals(buildDocumentInput())

    expect(harness.created.filter((row) => row.entity === 'PricingShadowObservation')).toHaveLength(1)
  })

  it('records a second row once the comparison itself changes', async () => {
    process.env[SHADOW_OBSERVE_ENV] = '1'
    const harness = createForkingEm(seedRows())
    harness.rows.PricingShadowObservation = [
      {
        salesLineId: SALES_LINE_ID,
        invoicedUnitPriceNet: '999.0000',
        engineUnitPriceNet: '111.0000',
      },
    ]
    const { service } = buildBaseService(buildDocumentResult({ quantity: 24, netAmount: 1200 }))

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })
    await decorated.calculateDocumentTotals(buildDocumentInput())

    expect(harness.created.filter((row) => row.entity === 'PricingShadowObservation')).toHaveLength(1)
  })

  // A line sales has not persisted yet has no id: its observation could be neither attributed nor
  // recognised on the next pass, so it would add one unattributable row per redraw.
  it('observes nothing for a line that has no id yet', async () => {
    process.env[SHADOW_OBSERVE_ENV] = '1'
    const harness = createForkingEm(seedRows())
    const result = buildDocumentResult({ quantity: 24, netAmount: 1200 })
    const lines = (result as { lines: Array<{ line: Record<string, unknown> }> }).lines
    for (const entry of lines) entry.line.id = null
    const { service } = buildBaseService(result)

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })
    await decorated.calculateDocumentTotals(buildDocumentInput())

    expect(harness.created.filter((row) => row.entity === 'PricingShadowObservation')).toHaveLength(0)
  })

  it('persists through a fork and never through the request EntityManager', async () => {
    process.env[SHADOW_OBSERVE_ENV] = '1'
    const harness = createForkingEm(seedRows())
    const { service } = buildBaseService(buildDocumentResult())

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })
    await decorated.calculateDocumentTotals(buildDocumentInput())

    expect(harness.forkOptions).toEqual([{ clear: true }])
    expect(harness.forkFlushCount()).toBe(1)
  })

  it('writes nothing when the switch is off', async () => {
    process.env[SHADOW_OBSERVE_ENV] = 'off'
    const harness = createForkingEm(seedRows())
    const { service } = buildBaseService(buildDocumentResult())

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })
    const result = await decorated.calculateDocumentTotals(buildDocumentInput())

    expect(result).toBeDefined()
    expect(harness.created).toHaveLength(0)
    expect(harness.forkOptions).toHaveLength(0)
  })

  it('is off unless the switch is explicitly turned on', async () => {
    delete process.env[SHADOW_OBSERVE_ENV]
    const harness = createForkingEm(seedRows())
    const { service } = buildBaseService(buildDocumentResult())

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })
    await decorated.calculateDocumentTotals(buildDocumentInput())

    expect(harness.created).toHaveLength(0)
  })

  it('skips the document rather than comparing two currencies', async () => {
    process.env[SHADOW_OBSERVE_ENV] = '1'
    const harness = createForkingEm(seedRows('PLN'))
    const { service } = buildBaseService(buildDocumentResult({ currencyCode: 'USD' }))

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })
    const result = await decorated.calculateDocumentTotals(buildDocumentInput('USD'))

    expect(result).toBeDefined()
    expect(harness.created).toHaveLength(0)
    expect(harness.forkFlushCount()).toBe(0)
  })

  it('swallows an observer failure instead of breaking the calculation', async () => {
    process.env[SHADOW_OBSERVE_ENV] = '1'
    const baseResult = buildDocumentResult()
    const { service } = buildBaseService(baseResult)
    const brokenContainer = {
      resolve() {
        throw new Error('[internal] no EntityManager in this container')
      },
    }

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: brokenContainer,
    })

    await expect(decorated.calculateDocumentTotals(buildDocumentInput())).resolves.toBe(baseResult)
  })

  it('survives a supplier profile that does not exist', async () => {
    process.env[SHADOW_OBSERVE_ENV] = '1'
    const rows = seedRows()
    rows.PricingSupplierProfile = []
    const harness = createForkingEm(rows)
    const baseResult = buildDocumentResult()
    const { service } = buildBaseService(baseResult)

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })

    await expect(decorated.calculateDocumentTotals(buildDocumentInput())).resolves.toBe(baseResult)
    expect(harness.created).toHaveLength(0)
  })

  it('observes nothing for a document whose lines carry no product', async () => {
    process.env[SHADOW_OBSERVE_ENV] = '1'
    const harness = createForkingEm(seedRows())
    const result = buildDocumentResult()
    result.lines[0].line.productId = null as unknown as string
    const { service } = buildBaseService(result)

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })
    await decorated.calculateDocumentTotals(buildDocumentInput())

    expect(harness.created).toHaveLength(0)
    expect(harness.forkOptions).toHaveLength(0)
  })

  it('observes nothing for a zero-quantity line, which has no unit price to compare', async () => {
    process.env[SHADOW_OBSERVE_ENV] = '1'
    const harness = createForkingEm(seedRows())
    const { service } = buildBaseService(buildDocumentResult({ quantity: 0, netAmount: 0 }))

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })
    await decorated.calculateDocumentTotals(buildDocumentInput())

    expect(harness.created).toHaveLength(0)
  })

  it('delegates calculateLine untouched and observes nothing for it', async () => {
    process.env[SHADOW_OBSERVE_ENV] = '1'
    const harness = createForkingEm(seedRows())
    const lineResult = {
      line: { kind: 'product', productId: PRODUCT_ID, quantity: 24, currencyCode: 'PLN' },
      netAmount: 1200,
      grossAmount: 1476,
      taxAmount: 276,
      discountAmount: 0,
      adjustments: [],
    }
    const { service, calls } = buildBaseService(buildDocumentResult(), lineResult)

    const decorated = createShadowObservingCalculationService({
      base: service,
      container: harness.container,
    })
    const result = await decorated.calculateLine({
      documentKind: 'order',
      line: lineResult.line,
      context: { tenantId: TENANT_ID, organizationId: ORGANIZATION_ID, currencyCode: 'PLN' },
    } as unknown as Parameters<SalesCalculationService['calculateLine']>[0])

    expect(result).toBe(lineResult)
    expect(calls.line).toBe(1)
    expect(harness.created).toHaveLength(0)
    expect(harness.forkOptions).toHaveLength(0)
  })
})
