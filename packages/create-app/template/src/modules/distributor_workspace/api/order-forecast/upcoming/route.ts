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
import { loadUpcomingOrderForecasts } from '../../../lib/orderForecastLoader'

const logger = createLogger('distributor_workspace').child({ component: 'upcoming-order-forecast' })

export const metadata = {
  GET: {
    requireAuth: true,
    requireFeatures: ['customers.companies.view', 'sales.orders.view'],
  },
}

/**
 * `horizonDays` counts forward only; rows already past due are always included.
 *
 * An operator asking "what is coming this week" also needs last week's missed delivery in the same
 * list — it is the more urgent of the two, and a horizon that filtered it out would quietly hide
 * the customers most worth a phone call.
 */
const querySchema = z.object({
  format: z.string().optional(),
  horizonDays: z.coerce.number().int().min(1).max(120).optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

const DEFAULT_HORIZON_DAYS = 14
const DEFAULT_LIMIT = 200

const basketLineSchema = z.object({
  productKey: z.string(),
  productId: z.string().nullable(),
  productVariantId: z.string().nullable(),
  productName: z.string(),
  sku: z.string().nullable(),
  predictedQuantity: z.number(),
  quantityUnit: z.string().nullable(),
  predictedUnitNetAmount: z.number().nullable(),
  predictedLineNetAmount: z.number().nullable(),
  confidence: z.number(),
  confidenceBand: z.enum(['high', 'medium', 'low']),
  acknowledged: z.boolean(),
  cadenceDays: z.number(),
  occurrences: z.number().int(),
  lastOrderedAt: z.string(),
  history: z.array(
    z.object({
      orderedAt: z.string(),
      quantity: z.number(),
      orderIds: z.array(z.string()),
    }),
  ),
})

const rowSchema = z.object({
  customerEntityId: z.string(),
  customerName: z.string().nullable(),
  expectedAt: z.string(),
  cycleIndex: z.number().int(),
  weekday: z.number().int().min(1).max(7),
  daysUntilExpected: z.number(),
  overdueDays: z.number(),
  lineCount: z.number().int(),
  totalNetAmount: z.number().nullable(),
  currencyCode: z.string().nullable(),
  confidence: z.number(),
  confidenceBand: z.enum(['high', 'medium', 'low']),
  acknowledgedLines: z.number().int(),
  onRhythm: z.boolean(),
  lines: z.array(basketLineSchema),
})

const responseSchema = z.object({
  generatedAt: z.string(),
  horizonDays: z.number().int(),
  customersAnalysed: z.number().int(),
  customersWithPredictions: z.number().int(),
  totalValueNet: z.number().nullable(),
  currencyCode: z.string().nullable(),
  rows: z.array(rowSchema),
})

const errorSchema = z.object({ error: z.string() })

/** The export is flattened to one row per BASKET LINE: a picking list, not a summary. */
const EXPORT_COLUMNS: CrudExportColumn[] = [
  { field: 'customerName', header: 'Klient' },
  { field: 'expectedAt', header: 'Dostawa' },
  { field: 'productName', header: 'Produkt' },
  { field: 'sku', header: 'SKU' },
  { field: 'predictedQuantity', header: 'Przewidywana ilosc' },
  { field: 'quantityUnit', header: 'Jednostka' },
  { field: 'overdueDays', header: 'Zalegle dni' },
  { field: 'confidencePercent', header: 'Pewnosc (%)' },
  { field: 'predictedLineNetAmount', header: 'Wartosc netto' },
]

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const query = querySchema.parse(Object.fromEntries(url.searchParams.entries()))
    const horizonDays = query.horizonDays ?? DEFAULT_HORIZON_DAYS
    const limit = query.limit ?? DEFAULT_LIMIT

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
    const result = await loadUpcomingOrderForecasts({
      em,
      scope: { organizationId, tenantId: auth.tenantId },
      now,
      horizonDays,
      options: query.minConfidence === undefined ? undefined : { minConfidence: query.minConfidence },
    })

    const rows = result.rows.slice(0, limit).map((row) => ({
      customerEntityId: row.customerEntityId,
      customerName: row.customerName,
      expectedAt: row.basket.expectedAt,
      cycleIndex: row.basket.cycleIndex,
      weekday: row.basket.weekday,
      daysUntilExpected: row.basket.daysUntilExpected,
      overdueDays: row.basket.overdueDays,
      lineCount: row.basket.lineCount,
      totalNetAmount: row.basket.totalNetAmount,
      currencyCode: row.basket.currencyCode,
      confidence: row.basket.confidence,
      confidenceBand: row.basket.confidenceBand,
      acknowledgedLines: row.basket.acknowledgedLines,
      onRhythm: row.basket.onRhythm,
      lines: row.basket.lines.map((line) => ({
        productKey: line.productKey,
        productId: line.productId,
        productVariantId: line.productVariantId,
        productName: line.productName,
        sku: line.sku,
        predictedQuantity: line.predictedQuantity,
        quantityUnit: line.quantityUnit,
        predictedUnitNetAmount: line.predictedUnitNetAmount,
        predictedLineNetAmount: line.predictedLineNetAmount,
        confidence: line.confidence,
        confidenceBand: line.confidenceBand,
        acknowledged: line.acknowledged,
        cadenceDays: line.cadence.intervalDays,
        occurrences: line.evidence.occurrences,
        lastOrderedAt: line.evidence.lastOrderedAt,
        history: line.history,
      })),
    }))

    // A total only means anything when every row behind it is in one currency; two currencies in
    // one sum are not money in either of them.
    const currencies = new Set(rows.map((row) => row.currencyCode ?? ''))
    const singleCurrency = currencies.size === 1 ? (rows[0]?.currencyCode ?? null) : null
    const totalValueNet =
      singleCurrency === null
        ? null
        : rows.reduce((total, row) => total + (row.totalNetAmount ?? 0), 0)

    const exportFormat = normalizeExportFormat(query.format)
    if (exportFormat) {
      const serialized = serializeExport(
        {
          columns: EXPORT_COLUMNS,
          rows: rows.flatMap((row) =>
            row.lines.map((line) => ({
              customerName: row.customerName ?? '',
              expectedAt: row.expectedAt,
              productName: line.productName,
              sku: line.sku ?? '',
              predictedQuantity: line.predictedQuantity,
              quantityUnit: line.quantityUnit ?? '',
              overdueDays: row.overdueDays,
              confidencePercent: Math.round(line.confidence * 100),
              predictedLineNetAmount: line.predictedLineNetAmount ?? '',
            })),
          ),
        },
        exportFormat,
      )
      return new NextResponse(serialized.body, {
        status: 200,
        headers: {
          'Content-Type': serialized.contentType,
          'Content-Disposition': `attachment; filename="${defaultExportFilename(
            'przewidywane-zamowienia',
            exportFormat,
          )}"`,
        },
      })
    }

    return NextResponse.json(
      responseSchema.parse({
        generatedAt: now.toISOString(),
        horizonDays: result.horizonDays,
        customersAnalysed: result.customersAnalysed,
        customersWithPredictions: result.customersWithPredictions,
        totalValueNet,
        currencyCode: singleCurrency,
        rows,
      }),
    )
  } catch (error) {
    if (isCrudHttpError(error)) {
      return NextResponse.json(error.body, { status: error.status })
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    logger.error('Failed to build the upcoming order forecast', { err: error })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Distributor Workspace',
  summary: 'Predicted orders across the whole customer base',
  description:
    'Every recurring order the distributor is expecting within the horizon, across all customers, most overdue first. Rows already past due are always included regardless of the horizon, because a missed delivery is the more urgent half of the question. Computed live from sales orders with the same engine and the same calibration the customer card uses.',
  methods: {
    GET: {
      summary: 'Load the upcoming predicted orders',
      responses: [{ status: 200, description: 'Predicted orders due within the horizon', schema: responseSchema }],
      errors: [
        { status: 400, description: 'Invalid query', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 500, description: 'Forecast failed to build', schema: errorSchema },
      ],
    },
  },
}
