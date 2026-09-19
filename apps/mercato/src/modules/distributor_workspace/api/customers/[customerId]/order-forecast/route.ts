import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  defaultExportFilename,
  normalizeExportFormat,
  serializeExport,
  type CrudExportColumn,
} from '@open-mercato/shared/lib/crud/exporters'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { PREDICTION_FEEDBACK_KINDS, PREDICTION_REJECTION_REASONS } from '../../../../lib/orderForecast'
import { loadCustomerOrderForecast, summariseRejections } from '../../../../lib/orderForecastLoader'

const logger = createLogger('distributor_workspace').child({ component: 'customer-order-forecast' })

// No `path`: the generator derives it from the folder structure. A hand-written one carrying the
// `/api` prefix is dropped from the module's route shard and the route 404s while still appearing
// in the global manifest.
export const metadata = {
  GET: {
    requireAuth: true,
    requireFeatures: ['customers.companies.view', 'sales.orders.view'],
  },
}

const paramsSchema = z.object({ customerId: z.string().uuid() })

const querySchema = z.object({
  format: z.string().optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  minOccurrences: z.coerce.number().int().min(2).max(50).optional(),
  lookbackDays: z.coerce.number().int().min(30).max(1825).optional(),
})

const cadenceSchema = z.object({
  kind: z.enum(['weekly', 'interval']),
  intervalDays: z.number(),
  dominantWeekday: z.number().int().min(1).max(7).nullable(),
  weekdayShare: z.number(),
  weekdayHits: z.number().int(),
})

const evidenceSchema = z.object({
  occurrences: z.number().int(),
  firstOrderedAt: z.string(),
  lastOrderedAt: z.string(),
  spanDays: z.number(),
  daysSinceLastOrder: z.number(),
  medianIntervalDays: z.number(),
  intervalSpreadDays: z.number(),
  expectedOccurrences: z.number(),
  coverage: z.number(),
  support: z.number(),
  regularity: z.number(),
  recency: z.number(),
  rawConfidence: z.number(),
  calibrationFactor: z.number(),
})

const predictionSchema = z.object({
  productKey: z.string(),
  productId: z.string().nullable(),
  productVariantId: z.string().nullable(),
  productName: z.string(),
  sku: z.string().nullable(),
  predictedQuantity: z.number(),
  quantityMin: z.number(),
  quantityMax: z.number(),
  quantityUnit: z.string().nullable(),
  predictedUnitNetAmount: z.number().nullable(),
  predictedLineNetAmount: z.number().nullable(),
  currencyCode: z.string().nullable(),
  nextExpectedAt: z.string(),
  daysUntilNextExpected: z.number(),
  overdueDays: z.number(),
  cadence: cadenceSchema,
  confidence: z.number(),
  confidenceBand: z.enum(['high', 'medium', 'low']),
  acknowledged: z.boolean(),
  history: z.array(
    z.object({
      orderedAt: z.string(),
      quantity: z.number(),
      orderIds: z.array(z.string()),
    }),
  ),
  evidence: evidenceSchema,
})

const rhythmSchema = z.object({
  orderCount: z.number().int(),
  firstOrderAt: z.string().nullable(),
  lastOrderAt: z.string().nullable(),
  daysSinceLastOrder: z.number().nullable(),
  medianIntervalDays: z.number().nullable(),
  intervalSpreadDays: z.number().nullable(),
  dominantWeekday: z.number().int().min(1).max(7).nullable(),
  weekdayShare: z.number(),
  nextExpectedOrderAt: z.string().nullable(),
  daysUntilNextOrder: z.number().nullable(),
  orderOverdueDays: z.number(),
  typicalOrderNetAmount: z.number().nullable(),
  currencyCode: z.string().nullable(),
  confidence: z.number(),
})

const accuracySchema = z.object({
  cutoffs: z.number().int(),
  trials: z.number().int(),
  hits: z.number().int(),
  misses: z.number().int(),
  missedOpportunities: z.number().int(),
  hitRate: z.number().nullable(),
  recall: z.number().nullable(),
  toleranceDays: z.number(),
  evaluatedFrom: z.string().nullable(),
  evaluatedTo: z.string().nullable(),
})

const noteSchema = z.object({
  productId: z.string().nullable(),
  productVariantId: z.string().nullable(),
  productName: z.string().nullable(),
  kind: z.enum(PREDICTION_FEEDBACK_KINDS),
  validUntil: z.string().nullable(),
})

const basketSchema = z.object({
  expectedAt: z.string(),
  cycleIndex: z.number().int(),
  weekday: z.number().int().min(1).max(7),
  daysUntilExpected: z.number(),
  overdueDays: z.number(),
  lineCount: z.number().int(),
  totalQuantity: z.number(),
  totalNetAmount: z.number().nullable(),
  currencyCode: z.string().nullable(),
  confidence: z.number(),
  confidenceBand: z.enum(['high', 'medium', 'low']),
  acknowledgedLines: z.number().int(),
  onRhythm: z.boolean(),
  lines: z.array(predictionSchema),
})

const forecastResponseSchema = z.object({
  generatedAt: z.string(),
  customerId: z.string(),
  rhythm: rhythmSchema,
  accuracy: accuracySchema,
  predictions: z.array(predictionSchema),
  baskets: z.array(basketSchema),
  notes: z.array(noteSchema),
  rejected: z.array(
    z.object({
      reason: z.enum(PREDICTION_REJECTION_REASONS),
      count: z.number().int(),
      examples: z.array(z.string()),
    }),
  ),
  history: z.object({
    orderCount: z.number().int(),
    lineCount: z.number().int(),
    firstOrderAt: z.string().nullable(),
    lastOrderAt: z.string().nullable(),
  }),
  thresholds: z.object({
    minOccurrences: z.number().int(),
    minSpanDays: z.number(),
    minConfidence: z.number(),
    lookbackDays: z.number(),
    maxOverdueDays: z.number(),
  }),
})

const errorSchema = z.object({ error: z.string() })

const EXPORT_COLUMNS: CrudExportColumn[] = [
  { field: 'productName', header: 'Produkt' },
  { field: 'sku', header: 'SKU' },
  { field: 'predictedQuantity', header: 'Przewidywana ilosc' },
  { field: 'quantityUnit', header: 'Jednostka' },
  { field: 'nextExpectedAt', header: 'Spodziewane' },
  { field: 'cadenceDays', header: 'Rytm (dni)' },
  { field: 'weekday', header: 'Dzien tygodnia' },
  { field: 'confidencePercent', header: 'Pewnosc (%)' },
  { field: 'occurrences', header: 'Liczba zamowien' },
  { field: 'lastOrderedAt', header: 'Ostatnio zamowione' },
  { field: 'predictedLineNetAmount', header: 'Wartosc netto' },
]

const WEEKDAY_LABELS = ['', 'Pn', 'Wt', 'Sr', 'Cz', 'Pt', 'So', 'Nd']

export async function GET(request: Request, context: { params?: { customerId?: string } }) {
  try {
    const { customerId } = paramsSchema.parse({ customerId: context.params?.customerId })
    const url = new URL(request.url)
    const query = querySchema.parse(Object.fromEntries(url.searchParams.entries()))

    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(request)
    if (!auth?.tenantId) {
      throw new CrudHttpError(401, { error: 'Unauthorized' })
    }
    const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request })
    const organizationId = organizationScope?.selectedId ?? auth.orgId ?? null
    if (!organizationId) {
      throw new CrudHttpError(401, { error: 'Unauthorized' })
    }

    const em = (container.resolve('em') as EntityManager).fork()
    const now = new Date()
    const { forecast, baskets, accuracy, history, notes } = await loadCustomerOrderForecast({
      em,
      scope: { organizationId, tenantId: auth.tenantId },
      customerEntityId: customerId,
      now,
      options: {
        ...(query.minConfidence === undefined ? {} : { minConfidence: query.minConfidence }),
        ...(query.minOccurrences === undefined ? {} : { minOccurrences: query.minOccurrences }),
        ...(query.lookbackDays === undefined ? {} : { lookbackDays: query.lookbackDays }),
      },
    })

    const exportFormat = normalizeExportFormat(query.format)
    if (exportFormat) {
      const serialized = serializeExport(
        {
          columns: EXPORT_COLUMNS,
          rows: forecast.predictions.map((prediction) => ({
            productName: prediction.productName,
            sku: prediction.sku ?? '',
            predictedQuantity: prediction.predictedQuantity,
            quantityUnit: prediction.quantityUnit ?? '',
            nextExpectedAt: prediction.nextExpectedAt,
            cadenceDays: prediction.cadence.intervalDays,
            weekday:
              prediction.cadence.dominantWeekday === null
                ? ''
                : WEEKDAY_LABELS[prediction.cadence.dominantWeekday] ?? '',
            confidencePercent: Math.round(prediction.confidence * 100),
            occurrences: prediction.evidence.occurrences,
            lastOrderedAt: prediction.evidence.lastOrderedAt,
            predictedLineNetAmount: prediction.predictedLineNetAmount ?? '',
          })),
        },
        exportFormat,
      )
      return new NextResponse(serialized.body, {
        status: 200,
        headers: {
          'Content-Type': serialized.contentType,
          'Content-Disposition': `attachment; filename="${defaultExportFilename(
            `predykcje-${customerId.slice(0, 8)}`,
            exportFormat,
          )}"`,
        },
      })
    }

    return NextResponse.json(
      forecastResponseSchema.parse({
        generatedAt: now.toISOString(),
        customerId,
        rhythm: forecast.rhythm,
        accuracy,
        predictions: forecast.predictions,
        baskets,
        notes,
        rejected: summariseRejections(forecast),
        history,
        thresholds: {
          minOccurrences: forecast.options.minOccurrences,
          minSpanDays: forecast.options.minSpanDays,
          minConfidence: forecast.options.minConfidence,
          lookbackDays: forecast.options.lookbackDays,
          maxOverdueDays: forecast.options.maxOverdueDays,
        },
      }),
    )
  } catch (error) {
    if (isCrudHttpError(error)) {
      return NextResponse.json(error.body, { status: error.status })
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    logger.error('Failed to build the customer order forecast', { err: error })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Distributor Workspace',
  summary: 'Recurring order forecast for one customer',
  description:
    'Detects which products this customer buys on a repeating rhythm and projects the next delivery for each, with a confidence score and the evidence behind it. Computed live from sales orders — a product bought only once or twice, bought irregularly, or no longer bought at all is deliberately excluded and reported under `rejected` with the reason. `accuracy` replays the customer own history to report how often the same method would have been right.',
  methods: {
    GET: {
      summary: 'Load the order forecast',
      responses: [{ status: 200, description: 'Forecast with evidence and accuracy', schema: forecastResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid customer id or query', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 500, description: 'Forecast failed to build', schema: errorSchema },
      ],
    },
  },
}
