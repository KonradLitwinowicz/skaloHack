# SPEC — Deadstock detection, carrying cost and liquidation floor

Status: implemented, pending migration apply and i18n keys (2026-09-19)
Module: `packages/pricing-engine` (`pricing_engine`)
Related: `.ai/specs/2026-09-18-pricing-engine-module.md`, `.ai/specs/2026-09-18-distributor-margin-workspace.md` (Deliverable G — shelf-life markdown)

## TLDR

Stock that nobody buys is not free to keep. This spec adds, inside `pricing_engine`:

1. **Measured rotation per product** — units, revenue, order count and distinct customers over 7 / 30 / 90 / 365 day windows, plus days since last sale, sortable in a list and reusable by any caller.
2. **A classification** — `healthy` / `slow` / `dying` / `dead` / `never_sold`, with explicit suppressors for products that are merely *new* or *seasonal*.
3. **Carrying cost per position** — what this pile costs per month and what it has already eaten, computed from `PricingWarehouseCost` with the same formula the `warehouse_cost` component already uses.
4. **A liquidation floor** — the lowest unit price at which selling today still beats holding the goods, expressed as a floor modifier, never as a price.
5. **A decision record** — the one thing the data model does not have: an operator saying "yes, this is deadstock, act on it" or "no, leave it", with an expiry on that judgement.
6. **Two surfaces** — a `Deadstock` backend screen and a dashboard widget, so the number is seen without being looked for.

## Problem Statement

The engine can already price a line, and Deliverable G can already discount a lot that is about to expire. Neither answers the distributor's other question: *what is sitting in my warehouse doing nothing, what is it costing me, and what do I have to charge to get rid of it without booking a loss?*

Three facts make this a separate problem, not an extension of shelf life:

- **Expiry has a deadline; deadstock does not.** A lot with `best_before_at` forces a decision on a date. A pallet of something nobody orders has no date, which is exactly why it stays for years.
- **The cost is invisible.** `PricingWarehouseCost` already prices a pallet slot at a monthly rate and frozen capital at an annual rate, but that cost is only ever charged into a *quote*. Nobody is charged for the stock that never gets quoted, so nothing surfaces it.
- **The decision is economic, not moral.** Purchase cost is sunk. The real comparison is *hold* (monthly carrying cost plus rising write-off risk) against *sell cheaper now*. Framed as "would I sell below cost", the answer is always no; framed as "would I rather have 60% of the cost today or 100% of a write-off in two years", the answer changes.

## Governing principle — extend, never duplicate

Everything this feature needs except the decision record already exists. It is reused, not re-implemented:

| Need | Existing owner | Reuse |
|---|---|---|
| Rotation from stock movements | `lib/inventory.ts` (`computeRotation`, `issuedQuantityOf`, `loadInventorySnapshot`) | called, not forked |
| Purchase cost | `PricingPurchasePosition.lastDeliveryUnitCost` | read |
| Carrying cost rates | `PricingWarehouseCost` (`costPerMonth`, `capitalCostAnnualRate`, `defaultTurnoverDays`) | read; **no new cost entity** |
| Occupancy share of a pallet slot | `lib/components/warehouseCost.ts` | shared helper extracted, formula unchanged |
| Markdown ladder semantics | `lib/components/shelfLife.ts` + `lib/components/guardrails.ts` | same shape, second floor source |
| Money arithmetic | `lib/decimal.ts` | mandatory, no `number` math |
| Expiry window constant | `@open-mercato/core` `wms/lib/expiry.ts` (`EXPIRING_SOON_DAYS`) | imported, never restated |
| Thresholds as versioned params | `PricingComponentParam` under a synthetic component code | same trick as `objective_weights` — **no migration for configuration** |

## Owner Decisions

- **D1 — Rotation is measured from SALES, not from stock movements.** No WMS route writes `pick` / `ship` / `pack`; `computeRotation` therefore returns `source: 'no_issues'` in production, and in the seeded demo database every one of the 184 stocked variants has its last pick exactly 7 days ago and its last receipt exactly 28 days ago — a generated cadence, not a history. Sales lines are the only signal with real spread. WMS rotation is still read where present and reported as a second opinion, never as the primary number.
- **D2 — The floor moves; the price does not.** Identical to Deliverable G, and for the same reason: setting a price would hand cost-price to every customer who asks about a product that happens to have one stale pallet, including the customer who would have paid full rate. Deadstock grants *permission* to go low. A human still decides.
- **D2a — The floor is AUTHORISED, not inferred.** The pipeline never derives a deadstock floor at quote time. It reads back a floor a person confirmed on the screen, stored as a snapshot on the decision. The reason is not performance, though fourteen months of sales history inside a fifty-line basket would also be unaffordable: an automatic below-cost floor appearing in a quote because a heuristic decided a product looked quiet is precisely the behaviour this feature exists to prevent.
- **D2c — A missing decisions table is read as "no authorisations", never as a failure.** `loadPricingInputs` queries this table on every quote, and `AGENTS.md` is explicit that a pull request ships migration FILES while applying them is the owner's decision — so "code deployed, migration not applied" is a normal state of this repo, and a fresh install is in it by definition. Detection is by SQLSTATE `42P01` walked through the ORM's wrapper chain, never by message text, which is localised by the server's `lc_messages`. Every other database error still propagates: pricing on silence would be worse than failing.
- **D2b — The deadstock floor BYPASSES the ordinary floors, exactly as the shelf-life ladder does.** Without this, `applyNormalFloors` raises the price straight back to the minimum margin and the markdown looks like it works while nothing is discounted. Being allowed below the ordinary minimum margin is the whole content of the permission.
- **D3 — Below purchase cost is allowed, and it is bounded by FORWARD carrying cost, not by sunk cost.** Selling at `cost − (monthly carrying × expected months to clear)` is exactly as good as holding and selling at cost later. Anything the sunk purchase price says about this is irrelevant. The floor is bounded below by zero, and by the salvage floor when the shelf-life ladder is also open on the same product.
- **D4a — A suppressor fires on positive evidence, never on missing data.** Three defects, all found by opening the screen rather than by any of the 513 unit tests, all in the suppressors — which is where a bug hides a list instead of breaking it. (1) The availability clock read the LATEST receipt, so a product restocked every four weeks was permanently "28 days old" and the newness suppressor hid everything: 0 accused, 85 suppressed. It now starts at the FIRST receipt, and a sale older than that overrides it. (2) With no receipt history the clock fell back to `lastDeliveryAt` — the LAST delivery by definition, the same bug again — hiding all fifteen never-sold positions, the plainest deadstock there is. Absence of a date now yields a verdict plus a named gap, not silence. (3) Seasonality fired on the one-off tail: a product bought twice has two peak months by construction and ten months "out of season", which suppressed 26 positions against the 9 genuinely seasonal SKUs in the dataset. A season must now be concentrated (≤5 peak months) and must recur (≥8 lifetime orders).
- **D4 — Seasonality and newness suppress the classification, never the measurement.** The metrics are always computed and always shown. A product whose sales are concentrated in a few months of the year, or which has not been sellable long enough to judge, is reported with its suppression reason instead of a deadstock verdict. A detector that proposes clearing patio heaters every January is a detector nobody opens twice.
- **D5 — Uncertainty is inherited and shown.** `PricingWarehouseCost` rates are assumptions, `warehouseCost` geometry is a documented `TODO(data-source)`, and any `lastDeliveryUnitCost` older than `STALE_PURCHASE_COST_DAYS = 60` is already flagged `estimated` — which for deadstock is *always*, since deadstock is by definition older than that. Every derived figure carries `confidence` and every screen renders `default` / `estimated` differently from `measured`.
- **D6 — Configuration lives in `PricingComponentParam`, the decision in a new entity.** Thresholds, window lengths and stage margins are versioned parameters under component code `deadstock_policy`; only the operator's judgement — which has an author, a timestamp and a review date — earns a table.

## Deliverable A — Rotation metrics

`lib/deadstock/metrics.ts`, loader in `lib/deadstock/salesLoader.ts`.

One scoped query over `sales_order_lines ⋈ sales_orders`, modelled on `distributor_workspace/lib/orderForecastLoader.ts`: `kind = 'product'`, `deleted_at is null` on both sides, date from `coalesce(placed_at, created_at)`, non-purchase statuses excluded, grouped by `product_id`.

Per product, for each window in `{7, 30, 90, 365}` days:

```
unitsSold, revenueNet, orderCount, distinctCustomers
```

plus window-independent: `firstSaleAt`, `lastSaleAt`, `daysSinceLastSale`, `lifetimeUnits`, `lifetimeRevenueNet`.

Every one of these is a sortable column. "Sort by units sold in the last year, ascending" is the feature, not a by-product of it.

## Deliverable B — Classification

`lib/deadstock/classify.ts`. Pure function over metrics + stock + policy; no I/O, fully unit-testable.

| Class | Rule |
|---|---|
| `never_sold` | stock on hand > 0 and `lifetimeUnits = 0` |
| `dead` | stock > 0 and no sale within `deadAfterDays` (default 180) |
| `dying` | stock > 0, sold within `deadAfterDays` but not within `dyingAfterDays` (default 90), and trailing-90 units below `dyingRatio` (default 0.25) of the previous 90 |
| `slow` | stock cover above `slowCoverDays` (default 120) computed as `onHand ÷ daily sales rate` |
| `healthy` | everything else |

Suppressors, applied after classification and reported with the row:

- `new_product` — first stock receipt or `launchAt` newer than `minObservationDays` (default 90). Nothing to judge yet.
- `seasonal` — sales in the same calendar window a year earlier exceed `seasonalRatio` (default 0.5) of that product's best window. Demand is absent, not gone.
- `decision_suppressed` — an operator dismissal from Deliverable E is still in force.

## Deliverable C — Carrying cost

`lib/deadstock/carryingCost.ts`, reusing the occupancy helper extracted from `lib/components/warehouseCost.ts` without changing its arithmetic.

```
spaceCostPerUnitPerMonth   = occupancyShare × costPerMonth
capitalCostPerUnitPerMonth = unitCost × capitalCostAnnualRate ÷ 12
carryPerUnitPerMonth       = spaceCostPerUnitPerMonth + capitalCostPerUnitPerMonth
positionCarryPerMonth      = carryPerUnitPerMonth × onHandQuantity
carriedToDate              = positionCarryPerMonth × monthsSinceReceipt
```

`monthsSinceReceipt` prefers `max(received_at)` of `receipt` movements, falls back to `PricingPurchasePosition.lastDeliveryAt`, and stamps which source it used. In the seeded database every variant returns 28 days from the first source, which is a property of the seeder rather than of the warehouse; the fallback exists so production data is not the first time the second path runs.

`tiedCapital = onHandQuantity × unitCost` — the headline number for the dashboard, because "487 000 zł is asleep in the warehouse" is a sentence an owner acts on.

## Deliverable D — Liquidation floor

`lib/deadstock/markdown.ts`. Ladder shaped exactly like `shelfLife.ts`, staged on class instead of remaining shelf life:

| Class | Floor |
|---|---|
| `slow` | ordinary guardrail, unchanged |
| `dying` | `unitCost × (1 + dyingMarginPercent)`, default 5% |
| `dead` | `unitCost − forwardCarry` |
| `never_sold` | `unitCost − forwardCarry`, with `forwardCarry` taken over the longer `neverSoldHorizonMonths` (default 12) |

where `forwardCarry = carryPerUnitPerMonth × expectedMonthsToClear`, `expectedMonthsToClear` defaulting to `clearHorizonMonths` (6) and clamped so the floor never goes below zero.

Reported alongside, mirroring Deliverable G's three numbers so the two ladders read the same:

- `deadstockFloorUnitPrice` — how low this may go
- `floorHeadroomPerUnit` — how much room is left below the current target
- `carryingCostAvoided` — `positionCarryPerMonth × expectedMonthsToClear`, the money the sale stops burning

Integration point is a single additional clamp in `lib/components/guardrails.ts`, inside the branch that already bypasses `applyNormalFloors`. `resolveEffectiveFloor` picks the LOWER of the two floors and names which one it was; the two never stack, because both are computed from the same purchase cost and the shelf-life ladder already weights its write-off by the share of stock near its date — subtracting a full deadstock carry from that result would count the same goods twice. A product that is both dormant and expiring has two independent reasons to be cleared, and the stronger one sets the limit. No twelfth pipeline component.

**`effectiveFloorSource` reports all four floors**, not only the two moving ones: `'shelf_life' | 'deadstock' | 'min_margin' | 'floor_price'`, emitted with `effectiveFloorUnitPrice` and `floorHeadroomPerUnit` whenever any floor binds the price, and absent only when none did. The commonest case on the customer-pricing panel is an ordinary floor raising a negotiated price with no ladder open at all, and a consumer forced to infer the source from `applied` or from the presence of a warning would be reading side effects instead of a contract.

## Deliverable E — Decision record

The only new entity. `PricingDeadstockDecision` extends `PricingScopedEntity`, table `pricing_deadstock_decisions`:

`catalogProductId`, `catalogVariantId` (nullable), `verdict` (`confirmed` | `dismissed` | `actioned`), `reasonCode`, `note`, `decidedBy` (uuid), `decidedAt`, `reviewAt`, `snapshot` (jsonb — the metrics the human actually saw), `isDemo`.

`reviewAt` is what keeps the list honest: a dismissal is a judgement with a shelf life of its own, and when it lapses the product returns to the list rather than disappearing because somebody once clicked it away. `snapshot` exists so a decision can be audited against what was on screen, not against what the numbers say today.

ACL: reuses `pricing.view` for reading; writing a decision requires a new feature `pricing.deadstock.decide` added to `acl.ts` and to `setup.ts` `defaultRoleFeatures`.

## Deliverable F — Surfaces

**API** — `GET /api/pricing/deadstock`, `metadata.path` as an object literal (the generator reads it statically), `requireFeatures: ['pricing.view']`. Query: `productClass`, `atRiskOnly`, `includeSuppressed`, `search`, `sort`, `dir`, `page`, `pageSize` (≤ 100). Returns rows carrying metrics, class, suppression, stock, carrying cost, floor and any live decision, plus a `totals` block computed over the whole catalogue rather than the page.

`POST /api/pricing/deadstock/decisions` behind `pricing.deadstock.decide`. **Decisions are append-only — no PUT, no DELETE, and therefore no version to lock against.** A judgement is a historical fact, the reversal an operator wants is itself a decision worth recording, and the snapshot is the feature's only audit trail. The latest row per product is the one in force; a later dismissal revokes an earlier confirmation. The snapshot is computed server-side and never read from the request body, because `guardrails` reads the floor out of it and a client that could post its own numbers could authorise any price it liked.

**Screen** — `backend/pricing/deadstock/` (`page.tsx` + `page.meta.ts`, `pageGroup: 'Pricing'`), `DataTable` with sortable metric columns, `FilterBar` on class and category, row actions for confirm / dismiss, and a totals strip: tied capital, monthly burn, recoverable at floor.

**Dashboard widget** — `widgets/dashboard/deadstock/` inside `pricing_engine` (module-owned, so it collides with nothing in `distributor_workspace`), `features: ['dashboards.view', 'pricing.view']`, `defaultPriority: 400`. Headline tied capital and monthly burn, top offenders by tied capital, link into the screen. It does **not** read `/api/wms/dashboard/operational`, whose `sparkline` and `deltaSinceYesterday` fields are known to be meaningless for this purpose.

## Boundaries

Owned: `packages/pricing-engine/**` only.

Not touched, by agreement with the sessions holding them: `packages/core/src/modules/wms/**` (read-only via DI `tryResolve` and the `expiry.ts` constants), `apps/mercato/src/modules/distributor_workspace/**` (its order-history seeder is the data source; this spec adds no seeder of its own), `packages/ui/src/backend/dashboard/**`.

## Data reality on 2026-09-19 (measured, not assumed)

- `sales_orders` 5, `sales_order_lines` 8 — no rotation signal yet; the distributor_workspace seeder supplies ~1866 orders / ~8092 lines across 14 months and is the calibration set.
- `catalog_products` 204, `catalog_product_variants` 258, `wms_inventory_balances` 200 rows with real spread (mean ≈ 100 units, max 1462).
- `pricing_purchase_positions` 200 rows, all with `last_delivery_unit_cost` and `last_delivery_at`, keyed by `catalog_product_id` — **not** by variant.
- `pricing_warehouse_costs` 1 row: `pallet_slot`, 95.00 / month, 9% annual capital, 30 turnover days.
- `wms_inventory_movements` 5520 rows, `pick` 4416 and `receipt` 1104, `received_at = performed_at` in every single row, last pick uniformly 7 days ago and last receipt uniformly 28 days ago across all 184 variants. Quantities vary (cover 18–60 days); recency does not. Hence D1.

## Testing

Unit: `classify` truth table including both suppressors; `carryingCost` against hand-computed arithmetic; `markdown` ladder per class plus the zero clamp; the combined-floor rule when both ladders are open; i18n key guard in the style of `i18nKeys.test.ts` for every emitted `explainKey` and warning across `en` and `pl`.

Integration: `TC-PRICING-DEAD-001` — list, sort by each metric, filter by class, ACL read vs decide, decision create / dismiss / expiry-of-dismissal, and a 409 on a stale decision update.

## Risks

- **No sales history until the neighbouring seeder runs.** Thresholds are placeholders until calibrated on seeded data; they are parameters, so calibration is a data change, not a code change.
- **Purchase cost is per product and always stale for deadstock.** Accepted and surfaced as `estimated`; a per-lot cost layer is out of scope and would need a WMS change owned by someone else.
- **Carrying cost inherits assumed rates and assumed pallet geometry.** Never reported better than `estimated`.
- **Seasonality detection needs more than one year of history** to work at all; with less it degrades to "cannot judge", not to a false positive.

## As built (2026-09-19)

| Piece | Files |
|---|---|
| Engine | `lib/deadstock/{policy,metrics,classify,carryingCost,markdown}.ts` — pure, no I/O |
| Loading | `lib/deadstock/{loader,authorisedFloor}.ts` — eight queries flat in catalogue size, peers via DI `tryResolve` |
| Contract | `lib/deadstock/schemas.ts` (NOT `data/validators.ts`, which stays the frozen quote contract) |
| Shaping | `lib/deadstock/view.ts` — sort, filter, paginate, totals |
| API | `api/deadstock/route.ts`, `api/deadstock/decisions/route.ts` |
| Pricing | `lib/components/guardrails.ts` (second floor source), `lib/types.ts` (`ComponentDeps.deadstock`, optional), `services/pricingService.ts` (one prefetch) |
| Occupancy | `lib/components/warehouseCost.ts` — `resolveOccupancy` exported, arithmetic unchanged |
| Entity | `PricingDeadstockDecision` + `Migration20260919084214_pricing_engine.ts` |
| ACL | `pricing.deadstock.decide`; `admin` inherits it through the existing `pricing.*` wildcard in `setup.ts` |
| Screens | `backend/pricing/deadstock/`, `widgets/dashboard/deadstock/` |
| Resilience | `lib/deadstock/missingTable.ts` — SQLSTATE 42P01 tolerance, one warning per process |
| Tests | `__tests__/deadstock{Metrics,Classify,CarryingCost,Markdown,Policy,Guardrails,MissingTable}.test.ts` (67 cases), `__integration__/TC-PRICING-DEAD-001.spec.ts` |

Measured on the screen itself, after the suppressor fixes in D4a: **83 794.76 PLN of capital asleep, 2 702.59 PLN a month burning, 68 476.88 PLN recoverable at the floor, 35 positions carrying a verdict and 13 verdicts withheld** — 15 never sold, 14 dead, 6 dying, 37 slow. The figure converges on the 82 972 PLN estimated independently from raw SQL before any of this code existed, which is the strongest evidence available that the pipeline computes what it claims to.

### Known gaps

- **i18n keys are not yet in `i18n/*.json`.** Every string is called as `t('key', 'Fallback')`, so the screens render correctly, but the five locale files were held by a parallel session and the keys go in as one pass once released.
- **The migration is written and reviewed but not applied.** `yarn db:migrate` is the remaining step. Until it runs the screen shows no Decision column and the response carries `pricing_engine.deadstock.warnings.decisionsUnavailable`; nothing else is affected — see D2c.
- `pricing.deadstock.decide` needs `yarn mercato auth sync-role-acls` to reach existing tenants, and somebody has to decide whether the `distributor` role gets it.

## Changelog

- 2026-09-19 — spec drafted; boundaries agreed with the sessions owning `wms` / dashboard and `distributor_workspace` order forecasting.
- 2026-09-19 — **three suppressor defects found by opening the screen** and fixed; see D4a. Each one made the worklist emptier than the truth, which is the failure mode a detector must never have. Added `RowActions`, `ListEmptyState`, links into the catalogue record and a dashboard footer link during the same UI pass.
- 2026-09-19 — **defect found and fixed after measurement**: the new prefetch in `loadPricingInputs` took down the entire pricing engine whenever the migration had not been applied — `/api/pricing/quote`, `/api/pricing/customer-pricing-impact`, the margin calculator and the advisor all returned 500 with `relation "pricing_deadstock_decisions" does not exist`. A parallel session measured both endpoints on a freshly restarted server. Added D2c and `lib/deadstock/missingTable.ts`.
- 2026-09-19 — implemented. Added D2a (authorised, not inferred) and D2b (bypasses the ordinary floors) after a parallel session pointed out that `applyNormalFloors` would silently undo the markdown. Decisions became append-only. `effectiveFloorSource` widened to all four floor sources at the same session's request.
