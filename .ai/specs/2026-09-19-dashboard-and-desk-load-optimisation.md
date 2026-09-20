# Load optimisation: main dashboard, predicted orders, price comparison, pricing desk ladder

- **Status:** Implemented (first pass)
- **Date:** 2026-09-19
- **Scope:** OSS
- **Owning packages:** `@open-mercato/ui`, `@open-mercato/core` (`wms`), `@open-mercato/pricing-engine`, `apps/mercato` (`distributor_workspace`)

## 1. Motivation

The operator's screens were slow for reasons that were all measurable rather than mysterious: the
same endpoint fetched twice, whole tables hydrated to produce two integers, a 107k-row forecast
recomputed on every page open, and nine independent reads issued one `await` at a time.

Measured on the reference dataset (Skalo Hurt, mercato-postgres): 1527 inventory balances, 4073
inventory profiles, 188 637 movements, 107 148 order lines in the forecast window.

## 2. What changed

### `/backend` dashboard

| Before | After |
|---|---|
| `stock-gaps` and `expiring-stock` each GET `/api/wms/dashboard/operational` | One request serves both (`sharedApiGet`, `packages/ui/src/backend/utils/sharedApiGet.ts`); a refresh on either card forces a fresh read |
| `loadOperationalDashboard` hydrated 4073 profiles + 1527 balances (with three relation populates) to count `lowStock` / `reorderCritical` | One SQL aggregate (`loadLowStockCounts`, 6 ms on the reference data) |
| Every active aging reservation hydrated to read `.length` | `count(*)` (`loadAgingReservationsCount`) |
| Balances loaded for the whole org | Only rows attached to a lot — the only ones the expiry cards read (92 rows instead of 1527) — and without populates |

`computeLowStockCounts` stays exported as the readable statement of the counting rule and is what
the unit tests pin; the SQL twin carries a pointer to it in both directions.

### Predicted orders (`/backend/predicted-orders`)

- The upcoming forecast is cached per (tenant, organization, horizon, confidence floor, UTC day),
  TTL 5 min, tagged `distributor-order-forecast:<tenantId>`. The UTC day is in the key because the
  rows carry day-relative fields.
- Invalidated by `sales.order.*` and `sales.line.*` subscribers, and directly by the
  prediction-feedback route, whose writes do not travel as sales events.
- The page rendered up to 500 expandable basket cards on mount; it now mounts 25 per section and
  reveals the rest on request. The counts in the headings stay counted over everything.

### Price comparison (`/api/distributor_workspace/price-comparison`)

- Nine sequential reads became one `Promise.all` plus the one genuinely dependent read (the
  customer pricing profile needs the order's customer id).
- The eight quotes of the same basket (WZ, selected volume, offer channel, five-rung ladder) are
  issued together. The per-(volume, channel) cache now holds the PROMISE — holding the map it
  resolves to would have handed a concurrent caller an empty basket.

### Pricing engine

- `loadPricingInputs` is memoised per `EntityManager` (forked per request), capped at 32 entries.
  The comparison screen loaded the identical snapshot eight times per request; the desk reloads it
  on every re-quote.

## 3. Volume ladder: a separate correctness fix

`computeVolumeSensitivity` priced each rung as its own single-line basket. Per-order cost is charged
per DOCUMENT (`source_costing.perDocument` + `perStop`), so a lone unit on its own document carried
all of it: a desk line priced at 7.62 PLN inside a two-line basket showed a `×1` rung reading
93.58 PLN — for the quantity the line already had — and clicking that rung set the quantity to 1 and
displayed 7.62 again.

The rung is a button that changes THIS basket, so it now quotes this basket: the document is
re-priced with that line's quantity swapped, and the rung reports that line. A product not in the
basket (an equivalent being explored) is still priced as the single-line basket it would be.

## 4. Known-open: lines with no purchase cost

`product_cost` returns `0.0000` with `pricing_engine.warnings.purchaseCostMissing` when a product
has no purchase position. On the reference tenant that is **1308 of 4051 products**. The desk still
presents such a line with a margin badge, a price floor and a full ladder, so it will happily quote
below the real purchase cost. The warning reaches only the basket-level warning list.

Not addressed here — it is a display and policy decision, not a performance one.

## 5. Tests

- `packages/ui/src/backend/utils/__tests__/sharedApiGet.test.ts` — dedupe, freshness, force, failure is not remembered, clear-during-flight.
- `packages/core/src/modules/wms/lib/__tests__/loadOperationalDashboard.test.ts` — counts come from SQL, profiles and reservations are no longer hydrated, balances are narrowed to lot rows, warehouse scoping.
- `apps/mercato/src/modules/distributor_workspace/__tests__/orderForecastCache.test.ts` — key separation, midnight retirement, tags, backend failure tolerance.
- `apps/mercato/src/modules/distributor_workspace/__tests__/predictedOrdersPage.test.tsx` — the reveal cap and its reset.
- `packages/pricing-engine/src/modules/pricing_engine/__tests__/advisorSuggestions.test.ts` — the rung at the current quantity equals the basket price, and the two framings really differ.
- `packages/pricing-engine/src/modules/pricing_engine/__tests__/advisorQueryBudget.test.ts` — re-quoting one basket loads its inputs once; another basket or another EntityManager reloads.
