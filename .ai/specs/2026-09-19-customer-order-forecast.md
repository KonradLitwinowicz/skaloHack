# SPEC — Recurring-order forecast: predicted deliveries and their baskets

**Status:** Implemented. Migration applied on the development database with the owner's approval.
**Date:** 2026-09-19
**Owner module:** `apps/mercato/src/modules/distributor_workspace/`
**Companion specs:** `.ai/specs/2026-09-18-distributor-margin-workspace.md` (the seeded HoReCa
catalog, customers and the `repeat_order` scenario this feature reads), `.ai/specs/2026-09-18-pricing-engine-module.md`.

---

## TLDR

A wholesale distributor's customers buy on a rhythm — towels every Monday, dishwasher chemicals
every second week, gloves once a month. Nothing in the product saw that. An operator opening a
customer card could read the company's address and its open deals, but not the one thing that
decides their week: what this customer is about to order, and when.

This predicts **deliveries**, not products. A row is a basket with a date, a line count and a
value — the unit a distributor actually handles — and it opens to show the products inside, each
with its own rhythm, confidence and the past orders it was read from.

Two surfaces, from one engine and one calibration:
- **`/backend/predicted-orders`**, in the Daily work menu: every delivery expected across the whole
  customer base, grouped by company, what is coming first and what was missed second.
- **Predicted orders** tab on the customer card: that customer's next eight deliveries, each with
  a basket, a price comparison and a one-click draft order.

---

## Problem statement — the state on 2026-09-19 that justified this spec

1. **No forecast anywhere.** `grep` over the tree found no recurrence, cadence or reorder-prediction
   code outside WMS reorder points, which are about stock levels, not about a customer's habits.
2. **Nothing to learn from.** 5 orders and 8 order lines existed in the whole database. No
   recurrence detector can say anything honest on that, and no threshold can be tuned against it.
3. **The negative case is the hard one.** The owner's requirement was explicit: a product bought
   twice is not a pattern. A naive "group by product, count > 1" would have produced a confident,
   useless list — which is worse than no list, because an operator would act on it once and then
   stop trusting the tab.

---

## Owner decisions

| # | Decision | Consequence |
|---|---|---|
| **D1** | **Computed live, never stored.** The forecast is a pure function of the order history, evaluated per request. | Every new order changes the prediction in the same second. No worker, no batch, no cache to go stale, no migration for the forecast itself. |
| **D2** | **"Did it come true?" is answered by replay, not by a ledger.** The engine is deterministic in `(observations, now)`, so "what would we have predicted on 12 May?" is recoverable from the orders themselves. | Accuracy is available from the first day after a real data import, is never biased toward customers somebody happened to open, and rescores itself when an order is corrected. A prediction-ledger table was considered and rejected for failing all three. |
| **D3** | **One small table, for what the data cannot know.** `distributor_order_prediction_feedback` stores only human statements: this product left the customer's list, the next delivery was confirmed by phone, hold this back for now. | Deleting every row would cost the operator their notes and change no prediction's arithmetic. |
| **D4** | **Confidence is calibrated by the customer's own track record.** The replayed hit rate, Laplace-smoothed, becomes a multiplier centred on the prior. | This is the part that sharpens as orders accumulate. A customer with three scored cycles cannot swing it the way one with fifty can. |
| **D5** | **No new write path for orders.** "Create draft order" POSTs to the existing `/api/sales/orders`. | Honours the companion spec's governing principle — extend, never duplicate. `sales.orders.manage` is already in `DISTRIBUTOR_FEATURES`. |
| **D6** | **No new ACL feature.** The tab and both routes gate on `customers.companies.view` + `sales.orders.view` (writes add `customers.companies.manage`, the price comparison adds `pricing.simulate`), all already granted. | No `sync-role-acls` pass needed on existing tenants. |
| **D7** | **The delivery is the unit, the product is the evidence.** Per-product predictions are grouped into baskets anchored on the customer's own delivery rhythm, and projected across the next eight cycles. | Answers "what is going out on Monday, and what the week after" — which a list of loose products cannot. The product layer is kept intact underneath, so nothing is lost. |
| **D8** | **Lateness is bounded twice.** `overdueToleranceFactor: 1` (a missed full cycle means the rhythm broke) and `maxOverdueDays: 21` (absolute ceiling), tighter wins. | Replaces `staleIntervalFactor: 2.5`, which allowed a 40-day rhythm 100 days of silence and still called it forthcoming. Proposing an order to somebody silent for two months is not a prediction. |
| **D9** | **Consolidation is priced, not assumed.** Each basket can be priced through the engine twice — as one delivery and as one delivery per line — and the difference shown. | Several engine costs are per-delivery, so the two are genuinely different prices. This is the argument an operator can make on the phone. Run with `persist: false`; a what-if has no business in the pricing audit ledger. |

---

## The engine — `lib/orderForecast.ts`

Pure, dependency-free, no database. Input: `OrderObservation[]` plus `now`, options, operator
feedback and a calibration record.

**Rejection gates, in order.** These do more work than the prediction itself:

| Gate | Default | What it stops |
|---|---|---|
| `minOccurrences` | 3 | Two purchases becoming a "pattern" |
| `minSpanDays` | 21 | Three deliveries inside one week becoming a "weekly rhythm" — one restock split across invoices |
| `coverage` | — | Eight weekly orders then a three-month gap; the median interval and its spread both still look perfect, only coverage notices the missing cycles |
| `staleIntervalFactor` | 2.5 | A textbook rhythm the customer has since abandoned |
| `minConfidence` | 0.35 | Everything that survives the above but still is not worth an operator's attention |

Every rejection is returned with its reason, so the UI can say why a product is missing instead of
silently dropping it.

**Scoring.** Four factors — `support` (how much evidence), `regularity` (1 − MAD/median interval),
`coverage` (cycles used / cycles available), `recency` (decay from "slightly late" to "gone") —
combined as a **weighted geometric mean**. Geometric because each answers a different question and a
near-zero answer to any one invalidates the prediction; an arithmetic mean would let three strong
factors carry a fatal one. Capped at `maxConfidence: 0.97`: a forecast about a person's next
purchase is never certain, and a row reading 100% invites the operator to stop checking it.

**Robust statistics throughout.** Median and median-absolute-deviation, never mean and standard
deviation — a single holiday-week double order must not hide an otherwise perfect rhythm. The
predicted quantity is the median of past quantities, rounded to a whole unit when every past
purchase was a whole unit (nobody can pick "21.5 packs").

**Dates.** `nextExpectedAt` is one step from the last purchase, weekday-snapped when a weekday
pattern holds — deliberately NOT rolled forward onto the next future slot. Rolling forward reads
well until the customer is late and then lies in the most damaging direction available: a customer
41 days past due on a monthly product would be shown a date a fortnight in the future, telling the
operator to relax about exactly the account they should be phoning. Sorting by that date therefore
puts the most overdue rows at the top, where the calls to make are.

**Backtest — `lib/orderForecastBacktest.ts`.** Sliding cutoffs over the history; at each one the
forecast is rebuilt from the orders that existed then and scored against what actually arrived
within `toleranceDays` (3 — a Monday delivery landing on Thursday is the same standing order).
Runs with no calibration of its own; scoring a calibrated forecast with the score it produced would
be circular.

---

## Data — `seed/orderHistoryData.ts`, `seed/orderHistorySeeder.ts`

Synthetic, and structurally disposable: the engine imports nothing from the seed. It reads
`sales_orders`, so an ERP import into the same tables is indistinguishable downstream.

One delivery rhythm per customer, with products riding on it at multiples of that rhythm — which is
how standing orders actually behave. Per-customer weekday, interval, product choice and basket size
derive from a PRNG seeded with the customer handle, so a rerun reproduces the history exactly while
forty customers do not come out as forty copies of a segment. Deliveries slip a day, cycles get
skipped, quantities move with the season.

Four product lifecycles are planted deliberately, three of them as negative controls:

| Class | Count (14-month run) | Must not be predicted because |
|---|---|---|
| Standing lines | ~7,500 lines | — (these are the positives) |
| One-off noise | 518 lines | bought once or twice |
| Discontinued | 478 lines, 12 SKUs | sold steadily, then stopped at 55% of the window — reserved globally, because a product one customer dropped is not discontinued |
| Seasonal | 306 lines, 9 SKUs | absent outside their months; must not be projected into the off-season |

Idempotent by `external_reference = horeca-history:<handle>:<date>`; a rerun skips days it already
wrote. Fully reversible by that prefix.

    yarn mercato distributor_workspace seed-horeca-order-history --tenant <t> --org <o> --months 14 [--dry-run]

---

## Surfaces

| Path | Method | Gate |
|---|---|---|
| `/api/distributor_workspace/customers/{customerId}/order-forecast` | GET (`?format=csv\|json\|xml\|markdown`) | `customers.companies.view`, `sales.orders.view` |
| `/api/distributor_workspace/customers/{customerId}/prediction-feedback` | POST, DELETE | `customers.companies.manage`, `sales.orders.view` |
| `/api/distributor_workspace/customers/{customerId}/basket-pricing` | POST | + `pricing.simulate` |
| `/api/distributor_workspace/order-forecast/upcoming` | GET (`?horizonDays`, `?format=csv`) | `customers.companies.view`, `sales.orders.view` |

Neither route declares `path` in `metadata`; the generator derives it from the folder structure. A
hand-written one carrying the `/api` prefix is dropped from the module's route shard and 404s while
still appearing in the global manifest.

**UI.** `widgets/injection/customer-order-forecast/` injected at `detail:customers.company:tabs`
through a new `widgets/injection-table.ts`. The spot is shared — `warranty_claims` and
`pricing_engine` also place tabs there — so the widget carries its own id and its own table entry
and never assumes it is alone. `backend/predicted-orders/` adds the cross-customer page, registered
in the Daily work group directly under Orders (`apps/mercato/src/modules.ts`).

**Language.** Counted nouns go through `lib/pluralize.ts` and `Intl.PluralRules`: Polish needs
three forms and a naive template produced "za 1 dni" and "2 pozycji" on a screen read all morning.
Weekday names exist twice — `weekday.*` nominative for a date label, `weekdayIn.*` accusative after
"usually on" — because "sobota 19.09" and "zwykle w sobotę" are different cases of the same word.

**Entity.** `distributor_order_prediction_feedback`, migration
`Migration20260919083820_distributor_workspace.ts`. `product_key` (`variant:<id>` / `product:<id>`)
mirrors `productKeyOf` and exists because Postgres treats NULLs as distinct in a unique index, so a
constraint over the two nullable id columns would admit duplicates for a product with no variant.

---

## Defect found and fixed in passing

`catalog_products.default_unit` was `pack` for 90 of 204 HoReCa products, while the tenant unit
dictionary ships `pkg`. `assertUnitExists` (`sales/commands/documents.ts`) resolves the unit when an
ORDER LINE is written, so those 90 products were **unorderable through `/api/sales/orders`**,
failing with `uom.unit_not_found` — a 400 at checkout for a product that looked healthy on every
screen. Measured: the same flow returned 201 for a `pc` product and 400 for a `pack` one.

Fixed in `seed/catalogSeeder.ts` by `ensureCatalogUnits`, which registers every unit code the seed
data uses, deriving the list from the data rather than from a list in code, so a product added in a
new unit cannot reintroduce the gap. Two entries were created on the development database
(`pack`, `pallet`).

---

## Integration coverage

`__integration__/TC-DIST-ORDER-FORECAST-001.spec.ts` builds its own customer, products and history —
the only way to assert what the forecast must refuse to say.

| Path | Covered |
|---|---|
| `GET .../order-forecast` | 401 unauthenticated; weekly pattern detected with cadence, weekday, quantity and occurrence count; customer rhythm summary |
| `GET .../order-forecast?format=csv` | `text/csv`, attachment disposition, staple present and the twice-bought product absent |
| `POST .../prediction-feedback` | dismissal hides the prediction and appears under `rejected`; a note naming no product is rejected with 400 |
| `DELETE .../prediction-feedback` | clearing the note restores the prediction |
| Rejection path | a product bought twice is absent from `predictions` and reported under `rejected.tooFewOrders` with its name |

Unit coverage: `lib/__tests__/orderForecast.test.ts`, `orderForecastBacktest.test.ts` and
`predictedBaskets.test.ts` — 50 cases across every rejection gate, both overdue bounds, the
confidence shape and its decay across projected cycles, quantity robustness, date projection,
basket grouping, mixed-currency totals, feedback handling and calibration. The module's whole
suite is 263 tests across 18 files.

---

## Verified

- `yarn typecheck` exit 0 across all packages; `yarn lint` 0 errors; `yarn generate` clean;
  `yarn i18n:check-sync` in sync across five locales; `yarn template:sync` exit 0.
- Seeded 1,862 orders / 8,839 lines for 40 customers over 14 months.
- On a hospital customer with 60 orders: seven predictions matching the seeded profile exactly
  (four weekly, two fortnightly, one monthly), 90% replayed accuracy, and the noise and discontinued
  products rejected — the negative control passing on live data.
- On a catering customer with 25 orders: confidence spread 48–94%, most overdue row first.
- Draft order created from two selected predictions through `/api/sales/orders`, landing on the
  document with the predicted quantities and prices.

## Not built — the obvious next step

**Sending a predicted basket to the customer for acceptance.** The operator can create the draft
order themselves, but cannot yet put the basket in front of the customer and ask them to confirm
or adjust it. That needs a proposal record (customer, delivery date, lines, status), a screen in
the existing customer portal (`frontend/[orgSlug]/portal/ordering` already renders a basket and
`api/portal/requests` already accepts a submission), a notification to tell the customer it is
waiting, and acceptance turning the proposal into an order. Deliberately left out rather than
half-built: the acceptance state is a contract between two parties and deserves its own data model
rather than a flag bolted onto the feedback table.

Two things whoever picks this up should not have to rediscover. `api/portal/requests` already
creates the sales document through the command bus and assigns its opening status, so the
conversion half is a pattern to follow rather than one to invent. And it recomputes every price on
the server, ignoring anything the browser said about money — which is not incidental here: a
proposal carrying a price the customer's browser calculated would be an invitation to edit it.

## Open

- Operator feedback writes need the dev server restarted after the migration: MikroORM builds entity
  metadata once per process, so a long-running server started before the entity existed answers
  `MetadataError`. Not a code defect; the route and table are correct.
- The customer card's tab strip scrolls once three injected tabs are present and the last falls out
  of view at ~800px panel width. Host behaviour, not this widget's; worth addressing before a fourth
  tab lands.
- The price comparison is n+1 engine runs per basket, which is why it is an explicit action rather
  than part of the page load. If it becomes a default, the engine needs a batch entry point.
- The seeded history holds no rhythm longer than ~28 days, so nothing exercises a quarterly cadence.
  A fourth reserved pool (`slowMover`: every ~75 days, 2-5 units, no trend, reserved globally) would
  give both this engine a long-interval case and a dead-stock classifier the "slow-moving, not dead"
  negative control it currently lacks. Deferred rather than added, because reseeding would
  invalidate calibration already done against the current dataset.

## Changelog

- 2026-09-19 — Initial implementation: engine, backtest, history seeder, both routes, the customer
  card tab, the feedback entity and migration, unit-dictionary fix, unit and integration coverage.
- 2026-09-19 — Reframed on deliveries: `lib/predictedBaskets.ts`, baskets projected across eight
  cycles with confidence decay, the cross-customer page and its API, the together-vs-separate price
  comparison, source orders shown under every predicted line, grouping by company, undo for every
  operator note, Polish pluralisation and weekday cases, and the bounded overdue rule replacing
  `staleIntervalFactor`.
