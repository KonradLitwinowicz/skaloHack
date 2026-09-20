'use client'

import * as React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { ErrorMessage, LoadingMessage, TabEmptyState } from '@open-mercato/ui/backend/detail'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { buildDeskHref } from '@open-mercato/pricing-engine/modules/pricing_engine/lib/frontend/basketDesk'

/**
 * Their arithmetic against ours, on one order the source system already priced and shipped.
 *
 * The source books the purchase invoice and stops there; this system adds what it costs to pick,
 * pack, store and deliver. So a margin-vs-margin readout would compare two different questions.
 * The WZ is the fixed point — its prices are what the customer paid and are never rewritten. What
 * the screen answers on top of it is the sales question: if this customer ordered through a cheaper
 * channel, or ordered more, how far could the price go down while the real profit in zloty stays
 * exactly what the WZ already earned — and what would the source ERP's own margin column show for
 * that lower price, so nobody mistakes a smaller number there for money given away.
 */

type ComparisonLine = {
  lineNumber: number | null
  productId?: string | null
  sku: string | null
  name: string | null
  group: string | null
  quantity: number
  simulatedQuantity: number
  theirUnitPrice: number
  theirUnitCost: number
  theirUnitCostFull: number
  theirOpsPerUnit: number
  theirMarginPercent: number
  ourUnitCost: number | null
  ourGoodsUnit: number | null
  ourProfitAtTheirPrice: number | null
  profitDelta: number | null
  scenarioUnitCost: number | null
  marginAtTheirPrice: number | null
  realProfitUnitBase: number | null
  offerUnitPrice: number | null
  offerDiscountPercent: number | null
  addAllMarginAtOfferPercent: number | null
  floorUnitPrice: number | null
  headroomPerUnit: number | null
  priced: boolean
}

type LadderStep = {
  multiplier: number
  scenario: string | null
  wzRevenue: number
  goods: number
  ops: number
  realProfitAtWz: number
  realProfitKept: number
  offerRevenue: number
  breakEvenRevenue: number
  discount: number
  discountPercent: number
  addAllMarginAtWzPercent: number
  addAllMarginAtOfferPercent: number
  realMarginAtOfferPercent: number
}

type Channel = { code: string; label: string; intakeMultiplier: number }

type DeliveryLeg = {
  date: string | null
  kind: string | null
  stops: number
  documentsAtStop: number
  routeKm: number | null
  routeCost: number
  fuelCost: number
  driverCost: number
  vehicleCost: number
  perStop: number
  share: number
  priced: boolean
}

type DeliveryRates = {
  vehicleCode: string
  fuelType: string
  fuelPricePerLitre: number | null
  consumptionLPer100Km: number
  fuelPerKm: number
  driverPerKm: number
  driveMinutesPerKm: number
  fixedPerRound: number | null
  workingDaysPerMonth: number | null
  tripsPerDay: number | null
}

type SourceCosting = { perDocument: number; perLine: number; perStop: number; source: string | null }

type ComparisonResponse = {
  order: {
    orderNumber: string
    customerEntityId?: string | null
    placedAt: string | null
    currencyCode: string
    customerReference: string | null
    sourceFirm: string | null
    salespeople: string[]
    deliveries: string[]
    dataComplete: boolean
  }
  baseline: {
    revenue: number
    theirCost: number
    theirProfit: number
    theirMarginPercent: number
    ourCost: number
    ops: number
    realProfit: number | null
    realMarginPercent: number | null
  }
  totals: {
    mode: 'full' | 'goods'
    multiplier: number
    lineCount: number
    pricedLineCount: number
    revenue: number
    simulatedRevenue: number
    theirCost: number
    theirTotalCost: number
    theirProfit: number
    theirMarginPercent: number
    ourCost: number
    scenarioCost: number
    linesCheaper: number
    linesBelowOurCost: number
  }
  components: {
    theirs: CostComponent[]
    ours: CostComponent[]
    scenario: CostComponent[]
  }
  scenario: string | null
  channels: Channel[]
  ladder: LadderStep[]
  delivery: {
    model: string | null
    distanceKm: number | null
    zoneCode: string | null
    total: number
    rates: DeliveryRates | null
    courierFlat: number | null
    legs: DeliveryLeg[]
  }
  sourceCosting: SourceCosting | null
  warnings: string[]
  lines: ComparisonLine[]
  engineError: string | null
}

type CostComponent = {
  code: string
  amount: number
  share: number
  confidence: string
}

type OrderOption = { id: string; orderNumber: string; customer: string | null; placedAt: string | null }

type OrderListItem = {
  id?: unknown
  orderNumber?: unknown
  order_number?: unknown
  customerName?: unknown
  customerReference?: unknown
  placedAt?: unknown
}

async function loadJson<TReturn>(url: string, what: string): Promise<TReturn> {
  const call = await apiCall<TReturn>(url)
  if (!call.ok || !call.result) {
    throw new Error(`[internal] ${what} request failed with status ${call.status}`)
  }
  return call.result
}

const MULTIPLIERS = [1, 2, 3, 5, 10] as const

const money = (value: number | null | undefined, currency = 'PLN') =>
  value === null || value === undefined
    ? '—'
    : new Intl.NumberFormat('pl-PL', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value)

const formatDocumentDate = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('pl-PL')
}

const percent = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `${value.toFixed(1)}%`

const signedPercent = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `${value > 0 ? '−' : value < 0 ? '+' : ''}${Math.abs(value).toFixed(1)}%`

const COMPONENT_LABELS: Record<string, string> = {
  goods: 'Towar (faktura zakupu)',
  their_operations: 'Kompletacja, pakowanie, obsługa, dostawa — ponoszą, ale nie księgują na fakturze',
  product_cost: 'Towar (faktura zakupu, ta sama co u nich)',
  operational_cost_base: 'Kompletacja, pakowanie, obsługa zlecenia, dostawa',
  packaging_cost: 'Materiały pakowe',
  warehouse_cost: 'Magazyn i zamrożony kapitał',
  product_aspects: 'Cechy produktu',
  rounding: 'Zaokrąglenie',
}

const selectableClass = (active: boolean) =>
  `rounded-md border px-3 py-1.5 text-sm transition-colors ${
    active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-accent'
  }`

/**
 * Side-by-side cost composition.
 *
 * The source's column is one bar by construction — it books the purchase invoice and nothing else —
 * and showing it as a single entry is the point, not a gap in the data. Confidence rides on every
 * row of ours because a seeded rate and a measured purchase price must not read the same.
 */
function CostBreakdown({ title, components, total, currency, muted, note }: {
  title: string
  components: CostComponent[]
  total: number
  currency: string
  muted?: boolean
  note?: string
}) {
  const t = useT()
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-lg font-semibold tabular-nums">{money(total, currency)}</span>
      </div>
      {note ? <p className="mb-3 text-xs text-muted-foreground">{note}</p> : null}
      <div className="space-y-2">
        {components.map((component) => (
          <div key={component.code}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className={muted ? 'text-muted-foreground' : undefined}>
                {COMPONENT_LABELS[component.code] ?? component.code}
              </span>
              <span className="shrink-0 tabular-nums">
                {money(component.amount, currency)}
                <span className="ml-2 text-xs text-muted-foreground">{component.share.toFixed(1)}%</span>
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={
                  component.confidence === 'measured'
                    ? 'h-full bg-primary'
                    : component.confidence === 'unbooked'
                      ? 'h-full bg-status-info-fg'
                      : 'h-full bg-status-warning-fg'
                }
                  style={{ width: `${Math.min(100, Math.max(0, component.share))}%` }}
                />
              </div>
              <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                {component.confidence === 'measured'
                  ? t('distributor_workspace.priceComparison.confidence.measured', 'zmierzone')
                  : component.confidence === 'unbooked'
                    ? t('distributor_workspace.priceComparison.confidence.unbooked', 'nieksięgowane')
                    : t('distributor_workspace.priceComparison.confidence.assumed', 'założenie')}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * One ladder step as a bar the length of the WZ price: goods, then cost-to-serve, then the real
 * profit the WZ earned, and whatever is left is the part the customer no longer has to pay. The
 * bar never grows past the WZ price because that price is the reference, not a proposal.
 */
function OfferBar({ step }: { step: LadderStep }) {
  const base = step.wzRevenue > 0 ? step.wzRevenue : 1
  const width = (value: number) => `${Math.max(0, Math.min(100, (value / base) * 100))}%`
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <div className="h-full bg-primary/40" style={{ width: width(step.goods) }} />
      <div className="h-full bg-status-warning-fg" style={{ width: width(step.ops) }} />
      <div className="h-full bg-status-success-fg" style={{ width: width(Math.max(0, step.realProfitKept)) }} />
      <div className="h-full bg-status-info-fg" style={{ width: width(Math.max(0, step.discount)) }} />
    </div>
  )
}

function OfferTile({ label, value, hint, tone }: {
  label: string
  value: string
  hint: string
  tone: 'positive' | 'negative' | 'neutral'
}) {
  const toneClass = tone === 'positive'
    ? 'text-status-success-fg'
    : tone === 'negative'
      ? 'text-status-danger-fg'
      : 'text-foreground'
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  )
}

export default function PriceComparisonPage() {
  const t = useT()
  const [search, setSearch] = React.useState('')
  const [orderId, setOrderId] = React.useState<string | null>(null)
  const [multiplier, setMultiplier] = React.useState(1)
  const [mode, setMode] = React.useState<'full' | 'goods'>('full')
  const [scenario, setScenario] = React.useState<string>('ideal_file')
  // The operator's real question is "which of these can I quote lower", so the table folds away
  // every line that cannot — the ones that need a rise are already summarised above.
  const [onlyCheaper, setOnlyCheaper] = React.useState(false)

  const ordersQuery = useQuery({
    queryKey: ['price-comparison', 'orders', search],
    queryFn: async () => {
      const params = new URLSearchParams({ pageSize: '20', sortField: 'placedAt', sortDir: 'desc' })
      if (search.trim()) params.set('search', search.trim())
      const res = await loadJson<{ items?: OrderListItem[] }>(
        `/api/sales/orders?${params.toString()}`,
        'Order list',
      )
      return (res.items ?? []).map((item): OrderOption => ({
        id: String(item.id ?? ''),
        orderNumber: String(item.orderNumber ?? item.order_number ?? ''),
        customer:
          typeof item.customerName === 'string'
            ? item.customerName
            : typeof item.customerReference === 'string'
              ? item.customerReference
              : null,
        placedAt: typeof item.placedAt === 'string' ? item.placedAt : null,
      }))
    },
  })

  /**
   * Opens on the newest document rather than on an empty screen.
   *
   * The list is already newest-first, and the document an operator wants to look at is almost
   * always the one that just came in — making them click it first is a step that answers nothing.
   * A selection the current list still contains is left alone, so refining the search does not
   * yank the screen away from the order being read; a selection the list no longer holds is
   * replaced by its newest row, because the operator moved on.
   */
  const orderOptions = ordersQuery.data
  React.useEffect(() => {
    if (!orderOptions?.length) return
    const newest = orderOptions[0] as OrderOption
    setOrderId((current) =>
      current && orderOptions.some((option) => option.id === current) ? current : newest.id,
    )
  }, [orderOptions])

  const comparisonQuery = useQuery({
    queryKey: ['price-comparison', orderId, multiplier, mode, scenario],
    enabled: Boolean(orderId),
    queryFn: async () =>
      loadJson<ComparisonResponse>(
        `/api/distributor_workspace/price-comparison?orderId=${orderId}&multiplier=${multiplier}&mode=${mode}&scenario=${scenario}`,
        'Price comparison',
      ),
  })

  const data = comparisonQuery.data
  const currency = data?.order.currencyCode ?? 'PLN'
  const baseline = data?.baseline
  const channelLabel = (code: string | null) => {
    const channel = data?.channels.find((entry) => entry.code === code)
    return channel ? t(channel.label, channel.label) : code ?? ''
  }
  const selectedStep = data?.ladder.find((step) => step.multiplier === multiplier && step.scenario === data.scenario)
    ?? data?.ladder.find((step) => step.multiplier === multiplier)
  const baselineIsLoss = (baseline?.realProfit ?? 0) < 0
  // The WZ lines at the multiplier and channel being looked at, handed to the desk as a what-if
  // basket. The WZ itself is never rewritten; the desk starts a new document if one is wanted.
  const deskHref = data
    ? buildDeskHref({
        customerId: data.order.customerEntityId ?? null,
        orderScenarioCode: data.scenario,
        lines: data.lines.flatMap((line) =>
          line.productId ? [{ productId: line.productId, quantity: String(line.simulatedQuantity) }] : [],
        ),
      })
    : null
  const stepLabel = (step: LadderStep) =>
    step.scenario === null && step.multiplier === 1
      ? t('distributor_workspace.priceComparison.offer.asIs', 'Jak było na WZ')
      : `${step.scenario ? channelLabel(step.scenario) : t('distributor_workspace.priceComparison.offer.sameChannel', 'Ten sam kanał')}${step.multiplier !== 1 ? ` ×${step.multiplier}` : ''}`

  return (
    <Page>
      <PageHeader
        title={t('distributor_workspace.priceComparison.page.title', 'Porównanie wycen')}
        description={t(
          'distributor_workspace.priceComparison.page.description',
          'Zamówienie wycenione dwa razy: tak jak policzył je system źródłowy i tak jak liczy nasz silnik kosztu obsługi.',
        )}
      />
      <PageBody>
        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end">
          <div className="md:w-96">
            <label className="mb-1 block text-sm font-medium" htmlFor="order-search">
              {t('distributor_workspace.priceComparison.search.label', 'Znajdź zamówienie')}
            </label>
            <Input
              id="order-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('distributor_workspace.priceComparison.search.placeholder', 'Numer dokumentu lub klient')}
            />
          </div>
        </div>

        {ordersQuery.isLoading ? (
          <LoadingMessage label={t('distributor_workspace.priceComparison.loadingOrders', 'Wczytuję zamówienia…')} />
        ) : null}
        {ordersQuery.isError ? (
          <ErrorMessage label={t('distributor_workspace.priceComparison.errors.orders', 'Nie udało się wczytać listy zamówień.')} />
        ) : null}
        {ordersQuery.data?.length ? (
          <div className="mb-6 flex flex-wrap gap-2">
            {ordersQuery.data.map((order) => (
              <button
                key={order.id}
                type="button"
                onClick={() => setOrderId(order.id)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  orderId === order.id
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card hover:bg-accent'
                }`}
              >
                <span className="font-medium">{order.orderNumber}</span>
                {order.customer ? <span className="ml-2 opacity-70">{order.customer}</span> : null}
                {order.placedAt ? (
                  <span className="ml-2 text-xs opacity-60">{formatDocumentDate(order.placedAt)}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}

        {!orderId && !ordersQuery.isLoading ? (
          <TabEmptyState
            title={t('distributor_workspace.priceComparison.empty.title', 'Wybierz zamówienie')}
            description={t(
              'distributor_workspace.priceComparison.empty.description',
              'Wskaż dokument powyżej, żeby zobaczyć porównanie pozycja po pozycji.',
            )}
          />
        ) : null}

        {comparisonQuery.isLoading ? (
          <LoadingMessage label={t('distributor_workspace.priceComparison.loadingComparison', 'Wyceniam zamówienie naszym silnikiem…')} />
        ) : null}
        {comparisonQuery.isError ? (
          <ErrorMessage label={t('distributor_workspace.priceComparison.errors.comparison', 'Nie udało się policzyć porównania.')} />
        ) : null}

        {data && baseline ? (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold">{data.order.orderNumber}</h2>
              {data.order.customerReference ? (
                <span className="text-muted-foreground">{data.order.customerReference}</span>
              ) : null}
              {data.order.sourceFirm ? <StatusBadge variant="neutral">{data.order.sourceFirm}</StatusBadge> : null}
              {!data.order.dataComplete ? (
                <StatusBadge variant="warning">
                  {t('distributor_workspace.priceComparison.badge.incomplete', 'Eksport źródłowy niepełny')}
                </StatusBadge>
              ) : null}
              {data.engineError ? (
                <StatusBadge variant="error">
                  {t('distributor_workspace.priceComparison.badge.engineError', 'Silnik wyceny niedostępny')}
                </StatusBadge>
              ) : null}
              {deskHref ? (
                <Button asChild size="sm" variant="outline" className="ml-auto">
                  <Link href={deskHref}>
                    {t('distributor_workspace.priceComparison.action.openDesk', 'Otwórz ten koszyk w kalkulatorze')}
                  </Link>
                </Button>
              ) : null}
            </div>

            <div className="rounded-lg border-2 border-primary/30 bg-card p-5">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('distributor_workspace.priceComparison.answer.label', 'Zysk pozorny — pokazany przez ich system, a nieosiągnięty')}
              </div>
              <div className="mt-2 flex flex-wrap items-baseline gap-4">
                <span className="text-3xl font-semibold tabular-nums text-status-danger-fg">
                  {money(baseline.realProfit === null ? null : baseline.theirProfit - baseline.realProfit, currency)}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t('distributor_workspace.priceComparison.answer.onInvoice', 'na fakturze za')} {money(baseline.revenue, currency)}
                </span>
              </div>
              <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                <div>
                  <span className="text-muted-foreground">{t('distributor_workspace.priceComparison.answer.reported', 'Marża wg Add All (przed kosztami)')}: </span>
                  <span className="font-medium tabular-nums">{money(baseline.theirProfit, currency)} ({percent(baseline.theirMarginPercent)})</span>
                </div>
                <div>
                  <span className="text-muted-foreground">{t('distributor_workspace.priceComparison.answer.real', 'Zysk realny')}: </span>
                  <span className={`font-medium tabular-nums ${baselineIsLoss ? 'text-status-danger-fg' : ''}`}>
                    {money(baseline.realProfit, currency)} ({percent(baseline.realMarginPercent)})
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">{t('distributor_workspace.priceComparison.answer.cheaper', 'Pozycje, na których możemy zejść z ceny')}: </span>
                  <span className={`font-medium tabular-nums ${data.totals.linesCheaper ? 'text-status-success-fg' : ''}`}>
                    {data.totals.linesCheaper} / {data.totals.pricedLineCount}
                  </span>
                  {data.totals.linesCheaper > 0 ? (
                    <button
                      type="button"
                      onClick={() => setOnlyCheaper((value) => !value)}
                      className="ml-2 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent"
                    >
                      {onlyCheaper
                        ? t('distributor_workspace.priceComparison.answer.showAll', 'pokaż wszystkie')
                        : t('distributor_workspace.priceComparison.answer.showCheaper', 'pokaż tylko te')}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>

            {data.ladder.length ? (
              <div className="rounded-lg border-2 border-status-success-fg/30 bg-card p-5">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t('distributor_workspace.priceComparison.offer.title', 'Czemu opłaca się brać od nas — ile możemy zejść z ceny, nie tracąc ani złotówki realnego zysku')}
                </div>
                {selectedStep ? (
                  <div className="mt-2 flex flex-wrap items-baseline gap-4">
                    <span className={`text-3xl font-semibold tabular-nums ${selectedStep.discount > 0.005 ? 'text-status-success-fg' : selectedStep.discount < -0.005 ? 'text-status-danger-fg' : ''}`}>
                      {money(Math.abs(selectedStep.discount), currency)}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {selectedStep.discount < -0.005
                        ? t('distributor_workspace.priceComparison.offer.needRise', 'drożej musiałoby być, żeby zysk realny został ten sam')
                        : t('distributor_workspace.priceComparison.offer.lead', 'taniej dla klienta przy tym samym realnym zysku')}
                      {' · '}
                      {stepLabel(selectedStep)}
                      {' · '}
                      {signedPercent(selectedStep.discountPercent)}
                    </span>
                  </div>
                ) : null}
                <p className="mt-2 text-xs text-muted-foreground">
                  {t(
                    'distributor_workspace.priceComparison.offer.wzNote',
                    'Ceny z WZ nie są zmieniane — WZ to źródło prawdy o tym, ile klient realnie zapłacił. „Cena możliwa" to symulacja: oddajemy klientowi dokładnie tyle, ile jego sposób zamawiania oszczędza nam w obsłudze, a zysk realny w złotych zostaje taki, jaki dała ta faktura.',
                  )}
                </p>
                {baselineIsLoss ? (
                  <p className="mt-2 text-xs text-status-danger-fg">
                    {t(
                      'distributor_workspace.priceComparison.offer.lossNote',
                      'Ta faktura już przy cenach z WZ nie pokrywa pełnego kosztu obsługi. „Ten sam zysk realny" oznacza tu tę samą stratę — kolumna „dno" pokazuje cenę, przy której koszt jest dopiero pokryty.',
                    )}
                  </p>
                ) : null}

                <div className="mt-4">
                  <div className="mb-2 text-sm font-medium">
                    {t('distributor_workspace.priceComparison.channel.title', 'Kanał zamówienia')}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {data.channels.map((channel) => (
                      <button
                        key={channel.code}
                        type="button"
                        onClick={() => setScenario(channel.code)}
                        className={selectableClass(data.scenario === channel.code)}
                      >
                        {t(channel.label, channel.label)}
                        <span className="ml-2 text-xs opacity-70">{`×${channel.intakeMultiplier.toFixed(2)}`}</span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t(
                      'distributor_workspace.priceComparison.channel.note',
                      'Ta sama faktura, te same ceny i ilości — zmienia się tylko to, kto wpisuje zamówienie. Mnożnik przy kanale to koszt przyjęcia zamówienia względem telefonu, z parametrów scenariuszy w Wycena → Parametry.',
                    )}
                  </p>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  {data.ladder
                    .filter((step) => step.scenario !== null || step.multiplier !== 1)
                    .filter((step) => [1, 2, 5].includes(step.multiplier))
                    .map((step) => (
                      <OfferTile
                        key={`${step.scenario ?? 'same'}-${step.multiplier}`}
                        label={stepLabel(step)}
                        value={signedPercent(step.discountPercent)}
                        hint={`${money(step.offerRevenue, currency)} ${t('distributor_workspace.priceComparison.offer.insteadOf', 'zamiast')} ${money(step.wzRevenue, currency)}`}
                        tone={step.discount > 0.005 ? 'positive' : step.discount < -0.005 ? 'negative' : 'neutral'}
                      />
                    ))}
                </div>

                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[56rem] text-sm">
                    <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-2 py-2 text-left">{t('distributor_workspace.priceComparison.offer.col.step', 'Scenariusz')}</th>
                        <th className="px-2 py-2 text-right">{t('distributor_workspace.priceComparison.offer.col.wzPrice', 'Cena z WZ')}</th>
                        <th className="px-2 py-2 text-right">{t('distributor_workspace.priceComparison.offer.col.ops', 'Koszt obsługi')}</th>
                        <th className="px-2 py-2 text-right">{t('distributor_workspace.priceComparison.offer.col.offerPrice', 'Cena możliwa')}</th>
                        <th className="px-2 py-2 text-right">{t('distributor_workspace.priceComparison.offer.col.discount', 'Taniej')}</th>
                        <th className="px-2 py-2 text-right">{t('distributor_workspace.priceComparison.offer.col.addAll', 'Marża wg Add All')}</th>
                        <th className="px-2 py-2 text-right">{t('distributor_workspace.priceComparison.offer.col.real', 'Zysk realny')}</th>
                        <th className="px-2 py-2 text-right">{t('distributor_workspace.priceComparison.offer.col.floor', 'Dno')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.ladder.map((step) => {
                        const isSelected = selectedStep === step
                        return (
                          <React.Fragment key={`${step.scenario ?? 'same'}-${step.multiplier}`}>
                            <tr className={`border-t border-border ${isSelected ? 'bg-accent/40' : ''}`}>
                              <td className="px-2 pt-2 font-medium">{stepLabel(step)}</td>
                              <td className="px-2 pt-2 text-right tabular-nums">{money(step.wzRevenue, currency)}</td>
                              <td className="px-2 pt-2 text-right tabular-nums">{money(step.ops, currency)}</td>
                              <td className="px-2 pt-2 text-right tabular-nums font-medium">{money(step.offerRevenue, currency)}</td>
                              <td className={`px-2 pt-2 text-right tabular-nums font-medium ${step.discount > 0.005 ? 'text-status-success-fg' : step.discount < -0.005 ? 'text-status-danger-fg' : 'text-muted-foreground'}`}>
                                {step.discount > 0.005 || step.discount < -0.005
                                  ? `${money(Math.abs(step.discount), currency)} (${signedPercent(step.discountPercent)})`
                                  : '—'}
                              </td>
                              <td className="px-2 pt-2 text-right tabular-nums">
                                <span className="text-muted-foreground">{percent(step.addAllMarginAtWzPercent)}</span>
                                {' → '}
                                <span className="font-medium">{percent(step.addAllMarginAtOfferPercent)}</span>
                              </td>
                              <td className={`px-2 pt-2 text-right tabular-nums ${step.realProfitKept < 0 ? 'text-status-danger-fg' : ''}`}>
                                {money(step.realProfitKept, currency)}
                                <span className="ml-1 text-xs text-muted-foreground">{percent(step.realMarginAtOfferPercent)}</span>
                              </td>
                              <td className="px-2 pt-2 text-right tabular-nums text-muted-foreground">{money(step.breakEvenRevenue, currency)}</td>
                            </tr>
                            <tr className={isSelected ? 'bg-accent/40' : ''}>
                              <td colSpan={8} className="px-2 pb-2 pt-1">
                                <OfferBar step={step} />
                              </td>
                            </tr>
                          </React.Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-primary/40" />{t('distributor_workspace.priceComparison.offer.legend.goods', 'towar')}</span>
                  <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-status-warning-fg" />{t('distributor_workspace.priceComparison.offer.legend.ops', 'koszt obsługi')}</span>
                  <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-status-success-fg" />{t('distributor_workspace.priceComparison.offer.legend.profit', 'zysk realny — zachowany')}</span>
                  <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-status-info-fg" />{t('distributor_workspace.priceComparison.offer.legend.discount', 'oddane klientowi')}</span>
                  <span>{t('distributor_workspace.priceComparison.offer.addAllHint', 'Marża wg Add All = cena minus faktura zakupu, przed kosztami obsługi — tyle pokaże ich system dla ceny możliwej.')}</span>
                </div>
              </div>
            ) : null}

            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 text-sm font-medium">
                {t('distributor_workspace.priceComparison.mode.title', 'Co liczymy po naszej stronie')}
              </div>
              <div className="flex flex-wrap gap-2">
                {(['goods', 'full'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setMode(value)}
                    className={selectableClass(mode === value)}
                  >
                    {value === 'goods'
                      ? t('distributor_workspace.priceComparison.mode.goods', 'Tylko towar — jak oni')
                      : t('distributor_workspace.priceComparison.mode.full', 'Pełny koszt obsługi')}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {mode === 'goods'
                  ? t(
                      'distributor_workspace.priceComparison.mode.goodsNote',
                      'Liczymy dokładnie to co ich system: cenę z faktury zakupu i nic poza nią. Różnica, która zostaje, to wyłącznie metoda wyceny zapasu.',
                    )
                  : t(
                      'distributor_workspace.priceComparison.mode.fullNote',
                      'Do kosztu towaru dochodzi kompletacja, pakowanie, obsługa zlecenia, magazyn i dowóz. Dowóz liczony z realnej trasy w dniu dostawy: paliwo, czas kierowcy i koszt stały auta z parametrów systemu, dzielone na przystanki na trasie; poza zasięgiem auta kurier.',
                    )}
              </p>
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              <CostBreakdown
                title={t('distributor_workspace.priceComparison.breakdown.theirs', 'Z czego składa się ICH koszt')}
                components={data.components.theirs}
                total={data.totals.theirTotalCost}
                currency={currency}
                muted
                note={data.sourceCosting
                  ? t('distributor_workspace.priceComparison.breakdown.theirsNote', 'Stawki z ich własnej prezentacji: {perDocument} na dokument, {perLine} na pozycję, {perStop} na przystanek. Nie zależą od ilości na pozycji. Parametr „source_costing" w Wycena → Parametry.', {
                      perDocument: money(data.sourceCosting.perDocument, currency),
                      perLine: money(data.sourceCosting.perLine, currency),
                      perStop: money(data.sourceCosting.perStop, currency),
                    })
                  : t('distributor_workspace.priceComparison.breakdown.theirsMissing', 'Brak parametru „source_costing" — ich koszt obsługi nie jest policzony. Dodaj go w Wycena → Parametry.')}
              />
              <CostBreakdown
                title={t('distributor_workspace.priceComparison.breakdown.ours', 'Z czego składa się NASZ koszt')}
                components={data.components.ours}
                total={data.totals.ourCost}
                currency={currency}
              />
              {data.components.scenario.length ? (
                <CostBreakdown
                  title={`${t('distributor_workspace.priceComparison.breakdown.scenarioFor', 'Gdyby klient zamówił przez')}: ${channelLabel(data.scenario)}`}
                  components={data.components.scenario}
                  total={data.totals.scenarioCost}
                  currency={currency}
                />
              ) : null}
            </div>

            {data.delivery?.legs?.length ? (
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">
                    {t('distributor_workspace.priceComparison.delivery.title', 'Ile zamówień leci na raz — dostawy tego dokumentu')}
                  </span>
                  <span className="text-lg font-semibold tabular-nums">{money(data.delivery.total, currency)}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(
                    'distributor_workspace.priceComparison.delivery.note',
                    'Auto jedzie raz i obsługuje wszystkie przystanki dnia; koszt trasy dzieli się po równo na przystanki. Im więcej zamówień tego dnia, tym taniej wychodzi każde.',
                  )}
                  {data.delivery.distanceKm ? ` ${t('distributor_workspace.priceComparison.delivery.distance', 'Odległość od magazynu')}: ${data.delivery.distanceKm.toFixed(1)} km.` : ''}
                </p>
                {data.delivery.rates ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('distributor_workspace.priceComparison.delivery.rates', 'Stawki z parametrów: paliwo {fuelPrice}/l × {consumption} l/100 km = {fuelPerKm}/km, kierowca {driverPerKm}/km ({minutes} min/km), koszt stały auta {fixedPerRound} na kurs ({vehicle}), kurier {courier} za dostawę.', {
                      fuelPrice: money(data.delivery.rates.fuelPricePerLitre, currency),
                      consumption: data.delivery.rates.consumptionLPer100Km.toFixed(1),
                      fuelPerKm: money(data.delivery.rates.fuelPerKm, currency),
                      driverPerKm: money(data.delivery.rates.driverPerKm, currency),
                      minutes: data.delivery.rates.driveMinutesPerKm.toFixed(1),
                      fixedPerRound: money(data.delivery.rates.fixedPerRound, currency),
                      vehicle: data.delivery.rates.vehicleCode,
                      courier: money(data.delivery.courierFlat, currency),
                    })}
                  </p>
                ) : null}
                {data.warnings?.length ? (
                  <p className="mt-1 text-xs text-status-warning-fg">
                    {data.warnings.map((code) => t(`distributor_workspace.priceComparison.warnings.${code}`, code)).join(' · ')}
                  </p>
                ) : null}
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-sm">
                    <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1 text-left">{t('distributor_workspace.priceComparison.delivery.col.date', 'Dzień dostawy')}</th>
                        <th className="px-2 py-1 text-left">{t('distributor_workspace.priceComparison.delivery.col.kind', 'Jak')}</th>
                        <th className="px-2 py-1 text-right">{t('distributor_workspace.priceComparison.delivery.col.stops', 'Zamówień na trasie')}</th>
                        <th className="px-2 py-1 text-right">{t('distributor_workspace.priceComparison.delivery.col.km', 'Km trasy')}</th>
                        <th className="px-2 py-1 text-right">{t('distributor_workspace.priceComparison.delivery.col.routeCost', 'Koszt trasy')}</th>
                        <th className="px-2 py-1 text-right">{t('distributor_workspace.priceComparison.delivery.col.share', 'Na tę fakturę')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.delivery.legs.map((leg, index) => (
                        <tr key={`${leg.date}-${index}`} className="border-t border-border">
                          <td className="px-2 py-1">{leg.date ? formatDocumentDate(leg.date) : '—'}</td>
                          <td className="px-2 py-1">
                            {leg.kind === 'kurier'
                              ? t('distributor_workspace.priceComparison.delivery.kind.courier', 'kurier')
                              : t('distributor_workspace.priceComparison.delivery.kind.van', 'nasze auto')}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums">{leg.stops}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{leg.routeKm === null ? '—' : leg.routeKm.toFixed(1)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{money(leg.routeCost, currency)}</td>
                          <td className="px-2 py-1 text-right tabular-nums font-medium">{money(leg.share, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 text-sm font-medium">
                {t('distributor_workspace.priceComparison.whatIf.title', 'A gdyby zamówili więcej?')}
              </div>
              <p className="mb-3 text-xs text-muted-foreground">
                {t(
                  'distributor_workspace.priceComparison.whatIf.description',
                  'Koszty obsługi zlecenia rozkładają się na całe zamówienie, więc przy większej ilości koszt jednostkowy spada i cena może być niższa przy tej samej marży.',
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                {MULTIPLIERS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setMultiplier(value)}
                    className={selectableClass(multiplier === value)}
                  >
                    {value === 1
                      ? t('distributor_workspace.priceComparison.whatIf.actual', 'Jak było')
                      : `×${value}`}
                  </button>
                ))}
              </div>
              {multiplier !== 1 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  {t(
                    'distributor_workspace.priceComparison.whatIf.note',
                    'Kolumna „ich cena" i „ich koszt" zostają z faktycznego dokumentu — zmienia się tylko nasza strona, wyceniona na większym wolumenie.',
                  )}
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span>
                {t('distributor_workspace.priceComparison.summary.cheaper', 'Pozycje, na których możemy zejść z ceny')}:{' '}
                <strong className="text-status-success-fg">{data.totals.linesCheaper}</strong> / {data.totals.pricedLineCount}
              </span>
              <span>
                {t('distributor_workspace.priceComparison.summary.belowCost', 'Pozycje poniżej naszego pełnego kosztu')}:{' '}
                <strong className="text-status-danger-fg">{data.totals.linesBelowOurCost}</strong>
              </span>
              {selectedStep ? (
                <span>
                  {t('distributor_workspace.priceComparison.summary.offerFor', 'Cena możliwa liczona dla')}: <strong>{stepLabel(selectedStep)}</strong>
                </span>
              ) : null}
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[72rem] text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">{t('distributor_workspace.priceComparison.col.product', 'Produkt')}</th>
                    <th className="px-3 py-2 text-right">{t('distributor_workspace.priceComparison.col.qty', 'Ilość')}</th>
                    <th className="px-3 py-2 text-right">{t('distributor_workspace.priceComparison.col.theirPrice', 'Cena z WZ')}</th>
                    <th className="px-3 py-2 text-right">{t('distributor_workspace.priceComparison.col.theirGoods', 'Ich koszt towaru')}</th>
                    <th className="px-3 py-2 text-right">{t('distributor_workspace.priceComparison.col.theirMargin', 'Marża wg Add All')}</th>
                    <th className="px-3 py-2 text-right">{t('distributor_workspace.priceComparison.col.ops', 'Koszt obsługi')}</th>
                    <th className="px-3 py-2 text-right">{t('distributor_workspace.priceComparison.col.reportedProfit', 'Zysk wg ich systemu')}</th>
                    <th className="px-3 py-2 text-right">{t('distributor_workspace.priceComparison.col.realProfit', 'Zysk realny')}</th>
                    <th className="px-3 py-2 text-right">{t('distributor_workspace.priceComparison.col.apparent', 'Zysk pozorny')}</th>
                    <th className="px-3 py-2 text-right">{t('distributor_workspace.priceComparison.col.offerPrice', 'Cena możliwa')}</th>
                    <th className="px-3 py-2 text-right">{t('distributor_workspace.priceComparison.col.addAllAtOffer', 'Marża Add All po obniżce')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(onlyCheaper ? data.lines.filter((line) => (line.headroomPerUnit ?? 0) > 0.005) : data.lines).map((line, index) => {
                    const canGoLower = (line.headroomPerUnit ?? 0) > 0.005
                    const belowCost = (line.marginAtTheirPrice ?? 0) < 0
                    const apparentTone = (line.profitDelta ?? 0) >= 0
                      ? 'text-status-success-fg'
                      : belowCost
                        ? 'text-status-danger-fg'
                        : 'text-muted-foreground'
                    return (
                      <tr key={`${line.sku}-${index}`} className="border-t border-border">
                        <td className="px-3 py-2">
                          <div className="font-medium">{line.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {line.sku}
                            {line.group ? ` · ${line.group}` : ''}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {line.simulatedQuantity !== line.quantity ? (
                            <span>
                              <span className="text-muted-foreground line-through">{line.quantity}</span>{' '}
                              <span className="font-medium">{line.simulatedQuantity}</span>
                            </span>
                          ) : (
                            line.quantity
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(line.theirUnitPrice, currency)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {money(line.theirUnitCost, currency)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{percent(line.theirMarginPercent)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(line.theirOpsPerUnit, currency)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {money(line.theirUnitPrice - line.theirUnitCost, currency)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {money(line.ourProfitAtTheirPrice, currency)}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums font-medium ${apparentTone}`}>
                          {line.profitDelta === null ? '—' : money(Math.abs(line.profitDelta), currency)}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums font-medium ${canGoLower ? 'text-status-success-fg' : ''}`}>
                          {money(line.offerUnitPrice, currency)}
                          {line.offerDiscountPercent !== null && Math.abs(line.offerDiscountPercent) >= 0.05 ? (
                            <div className="text-xs font-normal text-muted-foreground">{signedPercent(line.offerDiscountPercent)}</div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {percent(line.addAllMarginAtOfferPercent)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </PageBody>
    </Page>
  )
}
