import { z } from 'zod'

/**
 * Schemas for the deadstock surface.
 *
 * They live here rather than in `data/validators.ts` for the same reason the advisor's objectives
 * do: that file is the frozen quote/simulate contract, and a screen's query parameters have no
 * business in it.
 */

export const DEADSTOCK_CLASSES = ['healthy', 'slow', 'dying', 'dead', 'never_sold'] as const
export const DEADSTOCK_SUPPRESSIONS = ['new_product', 'seasonal', 'decision_dismissed'] as const
export const DEADSTOCK_VERDICTS = ['confirmed', 'dismissed', 'actioned'] as const

/**
 * Sortable columns.
 *
 * Every measured figure is here on purpose. "What sold most in the last year" and "what has not
 * moved in the longest" are the same list read from opposite ends, and an operator who can only
 * sort by one of them is being told which question to ask.
 */
export const DEADSTOCK_SORT_KEYS = [
  'title',
  'sku',
  'onHandQuantity',
  'tiedCapital',
  'monthlyCarry',
  'carriedToDate',
  'daysSinceLastSale',
  'stockAgeDays',
  'coverDays',
  'units7',
  'units30',
  'units90',
  'units365',
  'revenue365',
  'orders365',
  'customers365',
  'floorUnitPrice',
  'carryingCostAvoided',
] as const

export type DeadstockSortKey = (typeof DEADSTOCK_SORT_KEYS)[number]

export const MAX_PAGE_SIZE = 100

export const deadstockListQuerySchema = z.object({
  productClass: z.enum(DEADSTOCK_CLASSES).optional(),
  /** Everything with a verdict, which is the default view: the list is a worklist, not a report. */
  atRiskOnly: z.coerce.boolean().optional(),
  /** Only positions carrying a liquidation floor — the same basis the totals count on. */
  actionableOnly: z.coerce.boolean().optional(),
  includeSuppressed: z.coerce.boolean().optional(),
  search: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(DEADSTOCK_SORT_KEYS).default('tiedCapital'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
})

export type DeadstockListQuery = z.infer<typeof deadstockListQuerySchema>

const windowSchema = z.object({
  windowDays: z.number().int(),
  unitsSold: z.string(),
  revenueNet: z.string(),
  orderCount: z.number().int(),
  distinctCustomers: z.number().int(),
})

const carryingSchema = z.object({
  perUnitPerMonth: z.string(),
  positionPerWeek: z.string(),
  positionPerMonth: z.string(),
  positionPerYear: z.string(),
  carriedToDate: z.string(),
  tiedCapital: z.string(),
  confidence: z.enum(['measured', 'estimated', 'default']),
})

const markdownSchema = z.object({
  stage: z.enum(['dying', 'dead', 'never_sold']),
  stageLabelKey: z.string(),
  floorUnitPrice: z.string(),
  horizonMonths: z.string(),
  forwardCarryPerUnit: z.string(),
  belowCostPerUnit: z.string(),
  carryingCostAvoided: z.string(),
  recoverableAtFloor: z.string(),
  confidence: z.enum(['measured', 'estimated', 'default']),
})

const decisionSchema = z.object({
  id: z.string().uuid(),
  verdict: z.enum(DEADSTOCK_VERDICTS),
  reasonCode: z.string().nullable(),
  note: z.string().nullable(),
  decidedAt: z.string(),
  reviewAt: z.string().nullable(),
  inForce: z.boolean(),
})

export const deadstockRowSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullable(),
  sku: z.string().nullable(),
  title: z.string().nullable(),
  isActive: z.boolean(),
  productClass: z.enum(DEADSTOCK_CLASSES),
  rawClass: z.enum(DEADSTOCK_CLASSES),
  suppression: z.enum(DEADSTOCK_SUPPRESSIONS).nullable(),
  reasonKey: z.string(),
  onHandQuantity: z.string(),
  unitCost: z.string(),
  hasUnitCost: z.boolean(),
  stockAgeDays: z.number().int().nullable(),
  stockAgeSource: z.enum(['receipt_movement', 'last_delivery', 'unknown']),
  coverDays: z.string().nullable(),
  daysSinceLastSale: z.number().int().nullable(),
  firstSaleAt: z.string().nullable(),
  lastSaleAt: z.string().nullable(),
  lifetimeUnits: z.string(),
  lifetimeRevenueNet: z.string(),
  lifetimeOrderCount: z.number().int(),
  lifetimeCustomerCount: z.number().int(),
  windows: z.array(windowSchema),
  carrying: carryingSchema,
  markdown: markdownSchema.nullable(),
  nearestExpiryAt: z.string().nullable(),
  seasonalityKnown: z.boolean(),
  peakMonths: z.array(z.number().int()),
  nextPeakMonth: z.number().int().nullable(),
  decision: decisionSchema.nullable(),
  warnings: z.array(z.string()),
})

export type DeadstockRow = z.infer<typeof deadstockRowSchema>

export const deadstockTotalsSchema = z.object({
  /** Purchase value of every position carrying a verdict. The headline figure. */
  tiedCapital: z.string(),
  weeklyCarry: z.string(),
  monthlyCarry: z.string(),
  /** The figure that turns an expense into a decision. */
  yearlyCarry: z.string(),
  recoverableAtFloor: z.string(),
  atRiskCount: z.number().int(),
  catalogCount: z.number().int(),
  stockedCount: z.number().int(),
  byClass: z.record(z.enum(DEADSTOCK_CLASSES), z.number().int()),
  suppressedCount: z.number().int(),
})

export const deadstockListResponseSchema = z.object({
  items: z.array(deadstockRowSchema),
  totals: deadstockTotalsSchema,
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
  asOf: z.string(),
  historyStartsAt: z.string(),
  /** Every money figure on this screen is net and in this currency. The engine does not do VAT. */
  currencyCode: z.string(),
  /** Assumed-versus-measured, surfaced so the screen can mark what it inherited. */
  warehouseCostConfigured: z.boolean(),
  truncated: z.boolean(),
  warnings: z.array(z.string()),
})

export const deadstockDecisionCreateSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional(),
  verdict: z.enum(DEADSTOCK_VERDICTS),
  reasonCode: z.string().trim().max(100).optional(),
  note: z.string().trim().max(2000).optional(),
  /** Days until a dismissal lapses. Omitted means it does not. */
  reviewInDays: z.coerce.number().int().min(1).max(3650).optional(),
})

export type DeadstockDecisionCreateInput = z.infer<typeof deadstockDecisionCreateSchema>

export const deadstockDecisionResponseSchema = z.object({
  ok: z.literal(true),
  decision: decisionSchema,
})

/**
 * Totals without rows, for KPI tiles.
 *
 * A separate response rather than a flag on the list, because it is gated on a DIFFERENT feature:
 * `pricing.deadstock.summary` may be granted to a warehouse role on its own, and that role must not
 * reach an endpoint capable of returning unit costs. The shape enforces it — no row can appear here
 * however the query is written.
 */
export const deadstockSummaryResponseSchema = z.object({
  totals: deadstockTotalsSchema,
  asOf: z.string(),
  currencyCode: z.string(),
  warehouseCostConfigured: z.boolean(),
  warnings: z.array(z.string()),
})
