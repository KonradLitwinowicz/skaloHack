# SPEC — Distributor Margin Workspace (seeding, origin/distance, P&L panel, IA)

**Status:** Draft — owner decisions D1–D8 recorded below, awaiting go-ahead to implement.
**Date:** 2026-09-18
**Owner module:** new app module `apps/mercato/src/modules/distributor_workspace/` + additive work inside `@open-mercato/pricing-engine` and `packages/core/src/modules/directory`.
**Companion spec:** `.ai/specs/2026-09-18-pricing-engine-module.md` (Steps 1–2 implemented; this spec consumes it and does not restate it).
**Related, read before implementing:** `.ai/specs/implemented/SPEC-007-2026-01-26-sidebar-reorganization.md`, `.ai/specs/2026-08-10-address-contact-and-tax-fields.md`, `.ai/specs/SPEC-055-2026-02-23-promotions-module.md` (Approved, unbuilt — owns discount math).

---

## TLDR

`pricing_engine` already prices a basket and persists a fully auditable 9-component breakdown, but nothing
in the product lets an operator (a) get realistic data in, (b) set a single rate from the panel, (c) see
revenue / cost / margin / assumptions for a chosen customer, or (d) find any of it in a 96-entry sidebar.
This spec closes those four gaps in that order.

---

## Problem Statement — verified, not assumed

1. **No data to price.** 4 catalog products, 8 categories, 6 variants; 9 customer entities; **0 delivery
   addresses with a distance**; 0 rows in `pricing_customer_profiles` and `pricing_customer_indicators`.
2. **Delivery cost is silently zero.** `logisticsCost` returns `0.0000` with warning `deliveryZoneMissing`
   when no zone resolves (`lib/components/logisticsCost.ts:58-63`), and the playground never sends
   `deliveryZoneCode` (`backend/pricing/playground/page.tsx:42-46`). Every panel-originated quote today
   prices delivery at zero.
3. **No rate is editable from the panel.** `makeCrudRoute` appears **zero** times in
   `packages/pricing-engine`; `backend/pricing/` holds only `coverage/` and `playground/`, both read-only.
   ACL features `pricing.params.read` / `pricing.params.write` gate nothing (repo-wide grep outside
   `acl.ts` returns no hits). The only way to set an hourly rate is the `seed` CLI, which refuses to touch
   an existing row (`setup.ts:65-66`).
4. **No profit figure and no per-line replay.** The package contains no `profit` / `revenue` /
   `marginAmount` field; `PricingCalculation.finalUnitPriceNet` stores **only the first basket line's**
   unit price (`services/pricingService.ts:183`), so a multi-line calculation cannot be replayed per line.
5. **Currency collision, live-verified.** Supplier profile is PLN; `catalog_price_kinds`,
   `catalog_product_variant_prices` and every `sales_orders` row are USD. `pricingService` takes
   `context.currencyCode || supplier.currencyCode` and never converts or validates.
6. **No origin.** No table in the repo represents "our company" as a dispatch point.
   `customer_addresses` **does** carry `latitude`/`longitude`, unencrypted — the destination half is solved.
7. **149 navigation entries** (24 groups / 96 main + 53 settings), most irrelevant to a distributor.

---

## Governing principle — extend, never duplicate

Owner instruction, 2026-09-18: *"jeżeli mamy te produkty już, to dołączymy do nich; jeżeli mamy jakieś dane,
to połączmy do nich. Nie róbmy tych samych rzeczy jeszcze raz. Jak coś mamy od Open Mercato, to rozwińmy
to, nie zastępujmy. Wszystko to jest w systemie, jest połączone i nie powinno być robione obok."*

This outranks every convenience below. Concretely, it forbids:

- a parallel product model — purchase cost attaches to existing `catalog_products` by
  `pricing_purchase_positions.catalog_product_id`, and the seeder creates catalog rows through the catalog
  module's own entities, never its own tables;
- a parallel customer model — delivery data attaches to existing `customers.CustomerEntity` and
  `CustomerAddress`;
- a parallel company record — the origin goes on the existing `directory.Organization` (D6), not into a
  new `CompanyProfile` entity;
- a parallel distance store where the coordinates already exist (see D7, revised);
- a parallel portal role — the existing default `buyer` role is relabelled, not duplicated (D8);
- a parallel navigation shell — the IA is expressed as overrides over the existing nav, not a second menu;
- a margin screen that lives *next to* sales rather than *on* a sales document — see Deliverable C.

Where an extension genuinely does not exist, the additive path is: an extension entity plus a declared
link in `data/extensions.ts`, an FK id with no ORM relation, or a widget injected into the owning module's
extension point. Never a fork of the owning module's concept.

---

## Owner Decisions

| # | Decision | Consequence |
|---|---|---|
| **D1** | **Everything in PLN.** The catalog seed writes PLN prices and a PLN price kind; existing USD demo rows are left untouched. | No FX in the engine. The panel never labels a mixed-currency aggregate. A later multi-currency catalog goes through `baseCurrencyService`, not through this spec. |
| **D2** | **Warehouse labour stays per-line**, divided by quantity — a 1-unit line absorbs the full pick/pack step, a 40-unit line absorbs 1/40 of it. | Models "one trip to the shelf per position"; rewards larger lines, matching wholesale logic. No schema change. The panel MUST state this as an assumption, because it is invisible in the numbers. |
| **D3** | **Catalog seed is a HoReCa assortment** — cleaning chemicals, disinfectants, paper, disposable packaging, cutlery, films, sacks, dishwasher agents. Realistic weights and dimensions, because `product_aspects` reads them. | ~200 products across 12+ categories, a subset with variants. |
| **D4** | **Full parameter screens ship now** — CRUD for labour rates, process steps, order scenarios, packaging, warehouse, delivery zones, vehicles, fuel prices, guardrails and component params. | Largest single piece of work; it is also what unblocks the "Dostawy" nav group and turns the panel into a tool rather than a viewer. |
| **D5** | **Target is configured as MARGIN, not markup.** `targetMarginPercent` in the component payload wins over `targetMarkupPercent`; conversion `multiplier = 1 / (1 − margin)`. | Additive — `target_markup_percent` stays a frozen contract surface per `BACKWARD_COMPATIBILITY.md`. Needs a hard guardrail at `margin >= 100%`, which the markup form does not need. `explainValues` reports both numbers side by side. |
| **D6** | **Company origin lives on `organizations`** (additive nullable address + `latitude`/`longitude`), edited from a new "Company details" settings page in `directory`, cloned from the shipped organization-branding route/page pair. | Every module already carries `organization_id`, so no consumer needs a cross-module ORM relation or an FK snapshot. Reuses `directory.organizations.manage` — no new ACL feature, no `sync-role-acls` for existing tenants. |
| **D7 (revised)** | **Distance is computed from coordinates that already exist**, behind one resolution seam. `customer_addresses` already carries `latitude`/`longitude` (unencrypted); the origin gains them under D6. Phase 1: zone averages (the code path that already exists) **plus** a computed great-circle distance × a configurable road-winding factor whenever both endpoints have coordinates — it wins over the zone. Phase 2 (only if measurement proves it necessary): a stored per-address override. A routing provider becomes a drop-in behind the same seam. | **No new table in phase 1**, no manual kilometre entry, no external dependency, no data egress. Honours the governing principle: the coordinates are already in the system. `logisticsCost.ts` is edited once and never again. |
| **D8** | **Roles: backend `distributor`, portal reuses `buyer`.** Backend role slug is ASCII lowercase English, Polish only in `auth.roles.distributor`. The portal "Klient" is the existing default `buyer` role with a Polish label; no new `customer_roles` row. | Matches the `wms` `operator`/`supervisor` precedent and the `t('auth.roles.'+name, name)` lookup at `auth/backend/roles/page.tsx:79`. |

---

## Deliverable A — Seed data (catalog + customers)

**Placement.** `apps/mercato/src/modules/distributor_workspace/` with `cli.ts` default-exporting
`ModuleCli[]`. App-module `cli.ts` files are imported as TS source through
`.mercato/generated/modules.cli.generated.ts`, so no package build is required — verified at
`packages/cli/src/lib/generators/module-registry.ts:4520-4527`.

**Commands** (space-separated dispatch, `packages/cli/src/mercato.ts:873`, `:2627-2646`):

```
yarn mercato distributor_workspace seed-horeca-catalog --tenant <t> --org <o> [--count 200] [--dry-run]
yarn mercato distributor_workspace seed-horeca-customers --tenant <t> --org <o> [--count 40] [--dry-run]
yarn mercato distributor_workspace seed-distributor-accounts --tenant <t> --org <o>
yarn mercato distributor_workspace purge-demo --tenant <t> --org <o>
```

**Hard requirements.**

- **No `setup.ts` hook.** Demo data must never reach a new tenant automatically. The module declares
  `defaultRoleFeatures` and `ensureRoles` in `seedDefaults` (roles only, see Deliverable A3) — never the
  catalog or customer seed.
- **Idempotent by `handle`**, following `seedCatalogExamples` (`catalog/seed/examples.ts:837-846`,
  `:868-871`): load existing products by `handle IN (...)`, skip per-handle. Second run creates nothing.
- **Must not touch the 4 existing core products.** Handles are namespaced `horeca-*`.
- **Reuses catalog entities.** No new product tables. `CatalogProduct` requires only
  `organization_id`, `tenant_id`, `title`; everything else is nullable or defaulted
  (`catalog/data/entities.ts:63-285`).
- **PLN price kind** must exist before products are priced — `loadPriceKinds` throws when a kind is
  missing (`examples.ts:858-862`). The seeder ensures a `regular` kind in PLN rather than inventing a new
  kind, per risk R10 of the companion spec (`seedCatalogPriceKinds` soft-deletes non-default kinds).
- **Purchase cost.** Each seeded product gets a `pricing_purchase_positions` row with
  `last_delivery_unit_cost`, `last_delivery_at` and a rebate tier — otherwise `product_cost` has no source
  and the whole pipeline degrades. Flagged `is_demo = true`.
- **Customers** get `CustomerEntity` (company kind) + `CustomerAddress` with `purpose = 'delivery'`,
  a Polish city/postal code, and **`latitude`/`longitude` populated** so Deliverable B phase 2 has data.
- **Never through the API.** `POST /api/customer_accounts/signup` sends a verification email and
  `admin/users` emits an event that notifies staff by email — 200 accounts would attempt 200 emails.
  Seeders use `em.create` directly. `OM_DISABLE_EMAIL_DELIVERY=1` is the belt-and-braces guard.

**A3 — roles and accounts.** `seedDefaults` calls `ensureRoles(em, { tenantId, roleNames: ['distributor'] })`
and declares `defaultRoleFeatures: { distributor: [...] }`, exactly as `wms/setup.ts:12-26`. **Ordering
matters:** `ensureDefaultRoleAcls` runs *before* `seedDefaults`, so grants land only in the
`ensureCustomRoleAcls` second pass (`packages/cli/src/mercato.ts:1225-1226`). For the already-provisioned
Acme tenant the seeder must be followed by
`yarn mercato auth sync-role-acls --tenant 04b4e92a-94a3-4b7d-8a7e-2450fc538b23`.

Backend accounts are created with the `setupInitialTenant` shape (`auth/lib/setup-app.ts:411-451`):
bcrypt cost 10, `emailHash` set explicitly via `computeEmailHash` (it is **never** derived automatically,
and this install has tenant data encryption ON), `isConfirmed: true`, then `UserRole` links.
Portal accounts follow `customer_accounts/setup.ts:257-296`: probe on `emailHash`, `em.create`,
`emailVerifiedAt: new Date()`, link to `customer_entity_id`, one `flush()` at the end.

**Escalation to flag:** `sales.returns.create` depends on `sales.orders.manage` (`sales/acl.ts:80-84`);
a read-mostly role cannot file a return without full order-write. The `distributor` feature set omits
`sales.returns.create` unless the owner asks for it.

---

## Deliverable B — Origin and distance

**B1 — Origin (D6).** One additive migration on `organizations`: `address_line1`, `address_line2`, `city`,
`region`, `postal_code`, `country`, `latitude numeric(10,6)`, `longitude numeric(10,6)`, all nullable.
Five edit sites in `directory/commands/organizations.ts` (`serializeOrganization`,
`OrganizationUndoSnapshot`, the create apply block, the update apply block, the validator). New route
`api/directory/company-address/route.ts` and page `backend/directory/company/page.{tsx,meta.ts}`, both
near-literal copies of the branding pair, which already resolves the current org from request scope.
`Organization: asValue(Organization)` is added to the currently-empty `directory/di.ts` so optional
consumers can `tryResolve` it without an ORM relation.

**B2 — Distance seam (D7).** A single function in the engine:

```ts
resolveDeliveryDistance(ctx, deps): {
  distanceKm: string
  driveMinutes: string
  stops: number
  vehicleCode: string
  source: 'address' | 'zone' | 'postal_code' | 'routing'
  confidence: 'measured' | 'estimated' | 'default'
}
```

`logisticsCost.ts` calls it instead of reading the zone directly, **once**. `source` and `confidence` flow
into `ComponentResult.params` and therefore onto the assumptions panel and the coverage screen — the
operator always sees *which* distance was used and how good it is.

Resolution order, most precise first:

| Order | Branch | Source of truth | `confidence` |
|---|---|---|---|
| 1 | `routing` | a future routing provider behind this seam | `measured` |
| 2 | `coordinates` | **great-circle distance between `organizations.latitude/longitude` (D6) and `customer_addresses.latitude/longitude` (already present), multiplied by a configurable road-winding factor** | `estimated` |
| 3 | `zone` | `pricing_delivery_zones.avg_distance_km` for the customer's assigned zone — the code path that already exists and is covered by 13 unit tests | `estimated` |
| 4 | — | no source: returns 0 with warning `deliveryZoneMissing`, exactly as today | `default` |

**Phase 1 — no new table, no manual data entry.** Both endpoints' coordinates already exist in the system,
so branch 2 needs only arithmetic plus two parameters: the road-winding factor (a straight line is not a
road) and an average speed used to derive drive minutes from kilometres. Both are ordinary versioned
component params, editable from the parameter screens of Deliverable D4, and both appear on the
assumptions panel — the operator sees *"38 km po prostej × 1.35 = 51 km drogą, ~48 min przy 64 km/h"*,
not a black box. Branch 3 stays as the fallback for an address with no coordinates. Also in phase 1: CRUD
+ `CrudForm` for `pricing_delivery_zones`, `pricing_vehicles` and `pricing_fuel_prices`, and the callers
start sending the delivery address / zone. This alone turns delivery cost from a silent zero into a real,
explainable number.

**Phase 2 — only if measurement proves it necessary.** A stored per-address override is *not* planned up
front: it duplicates data the system already holds, which the governing principle forbids. It becomes
justified only when a real winding factor turns out to vary too much between zones to be a single number —
at which point the honest fix is a per-zone factor (a column on the existing `pricing_delivery_zones`),
not a new distance table. A real routing provider remains the escalation path, behind the same seam and
subject to the Ask First rule on external dependencies and customer-data egress.

---

## Deliverable C — Margin panel

Per the governing principle, the margin view is **primarily an extension of the documents that already
exist**, not a screen beside them. It ships as two surfaces sharing one component:

**C1 — a tab on the sales document (the primary surface).** Injected into
`sales.document.detail.{order|quote}:tabs` via `extension-points.ts`, so an order or a quote gains a
"Marża" tab **without a single edit to `packages/core`**. It prices the document's own lines and its own
customer — no re-entry of anything. This is the surface a sales rep actually uses, because the basket is
already on screen.

**C2 — a standalone calculator** at `/backend/pricing/margin` in the `pricing_engine` package, for the
case the owner named explicitly: a **theoretical** customer and a hypothetical basket, before any document
exists. It reuses the same component tree as C1, differing only in where the basket comes from.

**Shared screen body.** For C2 pick a customer (`LookupSelect`), a delivery address, and an order
scenario, then build a basket (`LookupSelect` for product + `CounterInput` for quantity, following
`warranty_claims/backend/components/productLookup.tsx`). For C1 all three come from the document. Then,
identically in both:

- **KPI row:** revenue net, total cost, **profit amount** (`totalNet − totalCostNet`, computed client-side
  — the API exposes no such field), margin %, markup %.
- **Cost breakdown** per component (material / labour / packaging / warehouse / delivery / physical
  aspects), amount and share of revenue, reusing the existing `PriceWaterfall` composition
  (`ChartContainer` + stacked `BarChart`, `var(--chart-1..5)`) rather than a new primitive.
- **Assumptions panel** — the point of the whole screen. One row per component rendered from
  `explainKey` + `explainValues` + `params` + `confidence`, so the operator sees the hourly rate, the
  overhead %, the turnover days, the distance and its `source`, and the rebate tier that produced the
  number. Rows with `confidence: 'default'` are visually marked as assumed, per the companion spec's D6.
- **Explicit net/VAT banner.** The engine is net-only (grep for `tax|vat|gross` in the package source
  returns nothing). The panel states it rather than letting the reader assume gross.

**Data path.** `POST /api/pricing/quote` via `apiCallOrThrow` — never raw `fetch`. Writes (saving a
scenario) go through `useGuardedMutation(...).runMutation(...)`.

**API additions** (allowed: `BACKWARD_COMPATIBILITY.md` §7 classifies API routes as STABLE and explicitly
permits new optional response fields):
- `profitNet` and per-line `profitNet` on the quote response — derived, but computing it server-side keeps
  one rounding authority.
- Persist per-line `unitPriceNet` / `unitCostNet` / `marginPercent` on `PricingCalculationLine`'s parent
  so a multi-line calculation replays correctly (fixes problem 4).

**D5 implementation.** `targetMargin.ts` accepts `targetMarginPercent`, converts to a multiplier, clamps
`margin >= 100%` with a warning, and reports both figures in `explainValues`.


---

## Deliverable E — Who sees what (owner decision, 2026-09-18)

The customer portal is an **ordering surface**, not a calculator. The distributor is the only party
that simulates, inspects cost, or sees margin.

| Party | Surface | May see |
|---|---|---|
| Customer (portal session) | Catalog browse, basket, place order / request quote | **The price they pay, and nothing else** |
| Distributor operator (backend session) | Margin tab on a document, standalone calculator, volume simulator, rule screens | Everything: cost breakdown, margin, markup, assumptions, guardrail headroom |

### The portal projection is a security boundary, not a UI choice

`POST /api/pricing/quote` returns `unitCostNet`, `markupPercent`, `marginPercent`, a nine-entry
`breakdown` carrying the purchase cost, labour rates and warehouse assumptions, plus `warnings` naming
the missing data sources. Handing that response to a portal session would tell a customer exactly what
the distributor pays and earns — verified live: a seeded line prices at 83.52 PLN on a purchase cost of
26.07 PLN, and both numbers are in the same payload.

Therefore the portal-facing endpoint is a **separate route with its own narrow response type**, never a
pass-through of the staff route:

```ts
// The ONLY fields a portal session ever receives.
export type PortalPriceLine = {
  productId: string
  sku: string | null
  quantity: string
  unitPriceNet: string
  totalPriceNet: string
  currencyCode: string
}
export type PortalPriceResponse = { lines: PortalPriceLine[]; totalNet: string; currencyCode: string }
```

Rules that make this enforceable rather than aspirational:

- The portal route authenticates a **customer** session (`requireCustomerAuth` / `requireCustomerFeatures`
  with `portal.catalog.view`), never a staff feature such as `pricing.quote`.
- It derives `customerId` from the session's `customerEntityId` claim and **ignores any customer id in the
  request body** — otherwise one customer could price as another.
- It maps the engine result into `PortalPriceResponse` by construction — building the narrow object field
  by field, never by deleting keys from the full response, so a new engine field cannot leak by default.
- A test asserts the serialized portal payload contains none of `unitCostNet`, `markupPercent`,
  `marginPercent`, `breakdown`, `warnings`, `calculationId`, `parameterSetVersion` — by scanning the JSON
  string, so the assertion survives a refactor of the type.

### Volume sensitivity belongs to the distributor

"How does the price change with volume" is a backend screen: the operator picks a product (and optionally
a customer), the engine is run across a quantity ladder, and the result is a curve of unit price, unit
cost, margin % and profit against quantity — with the rebate-tier step visible where
`pricing_purchase_positions.next_tier_volume` is crossed. It runs through `POST /api/pricing/simulate`,
which persists nothing, so a simulation never pollutes the calculation ledger.



---

## Deliverable F — Operator-defined objectives and weights

Owner decision, 2026-09-18: the distributor defines **their own** objectives and weights ("to co sam
ustali"), at full scope precedence (global → product group → customer group → customer).

### Why weights need a metric, and what that buys

A weight is only meaningful if the engine can measure the thing being weighted on a concrete
suggestion. A free-text objective the engine cannot evaluate is decoration that silently contributes
nothing to a ranking while looking like it does. So an objective is operator-defined in **name, weight,
direction and which metric it tracks** — and the metric is drawn from what a quote already emits.

```ts
export type PricingObjective = {
  code: string                  // operator-chosen, stable, used as the row key
  label: string                 // operator-chosen, shown in the UI
  metric: PricingObjectiveMetric
  direction: 'maximise' | 'minimise'
  weight: string                // decimal string; 0 disables without deleting the row
}

export type PricingObjectiveMetric =
  | 'marginPercent'      // margin on price
  | 'profitNet'          // totalNet - totalCostNet, the absolute money
  | 'revenueNet'         // totalNet
  | 'unitCostNet'        // fully loaded cost to serve one unit
  | 'productCost'        // component 1
  | 'operationalCost'    // component 2 — labour, the lever repeat orders move
  | 'packagingCost'      // component 3
  | 'warehouseCost'      // component 4
  | 'logisticsCost'      // component 5
```

Every metric above is already present in the quote response or derivable from it without a new
computation, so an objective can be scored the day it is created.

### Storage — no migration, no new entity

Objectives live in `pricing_component_params` under the synthetic component code `objective_weights`.
Verified: `loadParameters` loads **every** `PricingComponentParam` row for the tenant with no filter on
code (`lib/params.ts:102`), and `componentPayload(code, refs)` matches a free-text code through the full
scope chain (`lib/params.ts:228`, `:158-170`). The engine therefore already supports this; nothing in the
data model changes.

```jsonc
// component_code: 'objective_weights', scope: 'customer_group', scope_ref_id: 'szpital'
{ "objectives": [
  { "code": "volume",  "label": "Udział u klienta", "metric": "revenueNet",    "direction": "maximise", "weight": "45" },
  { "code": "profit",  "label": "Zysk kwotowy",     "metric": "profitNet",     "direction": "maximise", "weight": "40" },
  { "code": "margin",  "label": "Marża",            "metric": "marginPercent", "direction": "maximise", "weight": "15" }
] }
```

This inherits, for free: time versioning (`valid_from`/`valid_to`), the scope precedence customer →
customer_group → product → product_group → global, and the rule-editing screens of Deliverable D4.

### How a ranking is computed

For a suggestion with a before/after pair, each objective contributes

```
contribution = weight × normalise(direction × (after[metric] − before[metric]))
score        = Σ contribution / Σ weight
```

Normalisation is per metric against the before-value, so a percentage-point change in margin and a
złoty change in profit are comparable. The panel shows the per-objective contributions, not only the
total — a ranking nobody can decompose is a ranking nobody will trust.

**Guardrails outrank weights.** No weighting may push a price below `min_margin_percent`; the objective
score orders the suggestions that are already legal, it never authorises an illegal one.



---

## Deliverable G — Shelf-life markdown (expiry-driven salvage pricing)

Owner decision, 2026-09-18: a gentle three-stage ladder at 25% / 10% / 5% of remaining shelf life, and a
disposal cost charged **per kilogram**.

### Why the ordinary margin floor is wrong here, and not merely strict

Purchase cost is sunk the moment the goods arrive. For a lot approaching expiry the choice is not
"sell at a margin or sell below cost" — it is "recover something or recover nothing". A `min_margin_percent`
floor applied to an expiring lot instructs the operator to **decline a sale and write off 100%**, which is
the worst available outcome. Measured on the seeded tenant at the time of writing: **92 lots carry an
expiry, 14 of them expire within 30 days, and 20 227 PLN of purchase value sits in that 30-day window** —
15% of the chemical stock. The nearest lot expires in 7 days.

So the floor stops being a margin and becomes a **salvage value**. This is a deliberate, bounded override
of the guardrail, never a disabling of it.

### The ladder

Thresholds are a **fraction of the product's own shelf life**, not fixed days, so a 12-month disinfectant
and a 24-month degreaser are treated consistently.

| Remaining shelf life | Effective floor | Meaning |
|---|---|---|
| above 25% | the normal guardrail (`min_margin_percent`) | nothing changes |
| 25% to 10% | margin floor drops to **5%** | early, shallow markdown while the goods still move normally |
| 10% to 5% | floor drops to **0% margin** — sell at cost | recover the cash, abandon the profit |
| below 5% | floor drops to **salvage**: `−(weightKg × disposalRatePerKg)` | below cost, and below zero when disposal is not free |

`disposalRatePerKg` is a versioned parameter, seeded as an assumption (2.50 PLN/kg standard, 6.00 PLN/kg
for goods flagged hazardous) and replaced from the operator's real waste contract through the parameter
screens. The weight already exists on the catalog product, so nothing new has to be measured.

**The salvage floor is genuinely negative for hazardous goods.** If destroying a unit costs 6 PLN, giving
it away for 1 PLN is 7 PLN better than scrapping it. A floor of zero would quietly forbid the best
available outcome.

### Which lot is being sold

The engine prices a product; stock lives in lots. Under FEFO the earliest-expiring available lot goes
first, so the markdown applies to **the quantity that lot actually holds**. When the ordered quantity
exceeds it, the line is priced as a **weighted blend** across the lots FEFO would consume — part marked
down, the remainder at the normal floor. Marking down an entire line because one crate inside it is old
would give away margin that was never at risk.

### It must be visible, or it will be distrusted

A price below cost that appears without explanation reads as a bug. Every marked-down line states, in the
assumptions panel: the lot number, its expiry date, days remaining, the ladder stage it triggered, the
amount the price sits below cost, and the write-off that would otherwise occur. Not *"price 28 PLN"* but
*"28 PLN, 11 PLN below cost, because lot L-CHEM-0070 expires in 7 days and the alternative is writing off
1 307 PLN"*.

### Boundaries

- The markdown may **never** be applied to a product with no lot, no expiry, or ample remaining life —
  otherwise it becomes a general-purpose discount with a plausible excuse.
- It is bounded below by the salvage floor and can never produce a price below it.
- `negotiated_price_precedence` still decides who wins when an agreed price and a markdown collide.
- Every marked-down calculation is recorded in the ledger with the lot id, so the decision is auditable
  after the goods are gone.

### Data in place

`wms_inventory_lots` carries `manufactured_at`, `best_before_at`, `expires_at` and `status`;
`wms_inventory_balances.lot_id` links stock to its lot; `ProductInventoryProfile.track_expiration` and
`default_strategy = 'fefo'` mark the goods that perish. The seeder populates 92 lots across the chemical
categories with a deterministic spread of remaining life, so every ladder stage has cases to exercise.
Paper, film and disposable packaging deliberately receive no lot — inventing an expiry for them would
manufacture a markdown pressure that does not exist.


---

## Deliverable D — Navigation / IA (separate, later change)

Three layered mechanisms; each boundary was verified in code, not inferred:

1. **Trim `apps/mercato/src/modules.ts`** — removing a module removes its pages from
   `backend-routes.generated.ts`, hence from `GET /api/auth/admin/nav`. Candidates: `example`
   (+`example_customers_sync`), `design_system`, `eudr`, `workflows`, `business_rules`, `inbox_ops`,
   `staff`+`resources`+`planner`, `messages`, `api_docs` — **~50 of 96 main entries and 8 groups**.
2. **`overrides.routes.pages` + `overrides.nav.groupOrder`** in the same file — the **only** verified
   mechanism that moves a page into a different, business-named group. Page overrides are keyed globally
   by path (`packages/shared/src/modules/overrides.ts:1487-1512`), so one app-side block can re-home pages
   owned by core modules. `navHidden: true` hides the ~18 stray "create" rows without 404-ing their URLs.
3. **The `distributor` role** differentiates personas at runtime within that one IA
   (`packages/ui/src/backend/utils/nav.ts:317-323`).

**Rejected, with reasons:** menu injection is add-only and appends new groups last
(`mergeMenuItems.ts:58-61`); role sidebar preferences cannot move an item between groups
(`sidebarPreferencesService.ts:262-268`) and their stored `itemOrder` is **never read server-side**;
sidebar component replacement is impossible today (the registry exposes four handle shapes and none is
the shell). Editing core `page.meta.ts` is a behaviour change for every tenant and is out of scope except
for one upstream-safe cleanup: `navHidden: true` on the ~18 create pages and removal of 4 dead
main-context group declarations whose groups render nowhere.

**Constraints on the target IA.** Anything under `/backend/config/*` can never be promoted into the main
sidebar while a sibling settings page remains (href-prefix filter, `nav.ts:178-193`). The "Dostawy" group
**must not be declared until Deliverable B ships its screens** — it would be empty.

Target groups (Polish, app-owned keys in `apps/mercato/src/i18n/*.json`): Sprzedaż, Wyceny i marże,
Klienci, Katalog, Magazyn, Dostawy, Rozliczenia, Reklamacje.

---

## Testing

Per `.ai/qa/AGENTS.md`, integration tests ship **in the same change** as the API path they cover, create
their own fixtures (prefer API fixtures), clean up in `finally`, and never rely on seeded/demo data.

| Deliverable | Coverage |
|---|---|
| A | Seeder unit tests: second run creates nothing; the 4 core products are untouched; PLN price kind present; purchase positions created for every seeded product. CLI `--dry-run` writes nothing. |
| A3 | Role created idempotently; feature set is dependency-closed; seeded backend account authenticates; **no email is sent** (assert with `OM_TEST_MODE` capture). |
| B | `logisticsCost` returns a non-zero cost with a zone and a per-address override; `source`/`confidence` propagate to `ComponentResult.params`; company-address CRUD round-trips with a 409 optimistic-lock conflict. |
| C | `POST /api/pricing/quote` with a multi-line basket returns per-line profit; `GET /calculations/[id]` replays per-line prices; the margin page renders KPIs, breakdown and assumptions; `targetMarginPercent` produces the same price as the equivalent markup; `margin >= 100%` is rejected. |
| D | Nav snapshot: expected group set and entry count; a `distributor`-role session sees the reduced set; every overridden page path still resolves. |

**Note on the auth helper:** `POST /api/auth/login` takes **form-encoded** bodies. A JSON body parses to
empty credentials and returns a misleading 400. Test helpers must use form encoding.

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Currency drift.** PLN engine over a USD catalog produces numbers that look right and are meaningless. | D1: seed PLN. Add a validation that rejects a quote whose product price currency differs from the supplier profile currency, rather than silently proceeding. |
| R2 | **Assumptions read as measurements.** Every seeded rate is `is_demo = true` and `confidence: 'default'`. | The assumptions panel marks them; the coverage screen lists them; no seeded number is ever presented as measured. |
| R3 | **`customer_group_id` is a dangling FK** — catalog and sales carry the uuid, no group table exists, and the engine uses a free-text `customerGroupCode`. | Out of scope here; the companion spec already routes the canonical group entity to the `customers` module as its own change. This spec does not fake one. |
| R4 | **Promotions (SPEC-055, Approved) owns discount math** and does not exist. | The panel labels its figure "cena z silnika wycen", not "cena sprzedaży". Reconciliation with invoiced amounts is explicitly out of scope until the sales decoration exists. |
| R5 | **The sales calculation seam cannot see the customer.** `SalesCalculationContext` carries only `tenantId`, `organizationId`, `currencyCode` and a `metadata` holding just `shippingMethod` / `paymentMethod` (`sales/lib/types.ts:131-137`, `documents.ts:2861-2886`). `resolve` is declared and populated by **zero** call sites, so a registered line hook also has no container. Four of the engine's five parameter scopes are unreachable from there. | Deliberately designed around: the margin view reads the document (which *does* carry `customerEntityId`) and calls `/api/pricing/quote` itself. The write path is a separate, later decision — see *Reading vs writing* below. |
| R6 | **IIA change breaks bookmarks.** Deleting a module deletes its URLs. | Prefer `navHidden` over module deletion for anything a user might have bookmarked; module deletion is reserved for `example`, `design_system` and genuinely unused modules. |
| R7 | **Migration hygiene.** `yarn db:generate` may emit unrelated migrations. | Per root AGENTS.md: delete unrelated output, keep only the intended SQL, update the affected module's `.snapshot-open-mercato.json`. **Never** run `yarn db:migrate` to quiet the generator — ask the owner first. |


---

## Reading vs writing — why the panel does not need the risky seam

Verified by a seven-agent pass over the seam, including an adversarial review whose only job was
to break the integration. Three findings moved this decision:

1. **`mode` is a label, not a guard.** Nothing in the pipeline or in any of the nine components reads
   `PricingContext.mode`; it is stamped onto the result (`pricingService.ts:157`) and the ledger row
   (`:188`) and that is all. Every safety property attributed to "shadow mode" has still to be written.
2. **The sanctioned hook route leaks tenants by construction.** `register(container)` runs on every
   request (`packages/shared/src/lib/di/container.ts:248-252`), `salesCalculations` is a process-global
   (`sales/lib/calculations.ts:410`), and `registerLineCalculator` is an unconditional `push` with no
   dedup (`:276-283`). Registering a line hook there appends one closure per request, each pinning a
   different tenant's container. The repo's only production hook guards this with a module-level
   `totalsRegistered` flag (`sales/lib/providers/totals.ts:19`); no such guard ships for line hooks.
3. **`pricingService.quote()` flushes outside the sales transaction.** It calls `em.flush()`
   (`pricingService.ts:228`) on the request EntityManager, while sales commands work on a `.fork()`
   (`documents.ts:7028`) and the calculation runs before `withAtomicFlush`. Ledger rows therefore commit
   on a different unit of work and survive a rollback of the order they describe.

None of the three blocks the owner's actual goal, because the goal is **reading**, not repricing:

| Capability | Needs the seam? | Where it lives |
|---|---|---|
| Revenue / cost / margin / assumptions for a customer + basket | **No** | Margin tab widget (C1) reads the document's own `customerEntityId` and lines, calls `POST /api/pricing/quote` |
| Parameter screens (rates, steps, packaging, warehouse, zones, vehicles, fuel, guardrails) | **No** | `makeCrudRoute` + `CrudForm` inside `pricing_engine` |
| Company origin + computed distance | **No** | `directory` (D6) + the distance seam (D7) |
| Recording what the engine *would* have charged, per sales line | Yes — DI decoration only | `pricing_engine/di.ts`, shadow observations, no amount mutated |
| The engine **overwriting** a document's price | Yes, plus a `sales` edit | Ask First; only after shadow data exists and the currency question is settled |

The DI decoration — never `registerSalesLineCalculator`, for reason 2 — is therefore sequenced after
the panel, not before it, and the three defects above are fixed inside `pricing_engine` as part of it.


---

## Business inputs the owner must supply

Every one of these is currently a demo value flagged `is_demo = true`; none can be derived from the repo.
The engine works without them and marks each as an assumption, so they do not block implementation.

| Input | Seeded value | Question |
|---|---|---|
| Labour rates PLN/h | sales_rep 85, warehouse 48, driver 55, accounting 75, collections 90 | Real loaded rates? |
| Overhead | 22% for all five roles | One rate for all, or per role? |
| Process durations | intake 6 min, picking 2.5, packing 1.5, dispatch 4, invoicing 3, dunning 12 | Measured? (`dunning` can never fire — every seeded scenario has an empty `extra_step_codes`.) |
| Warehouse | 95 PLN / pallet-slot / month, EUR-pallet geometry 1.728 m³ / 800 kg | Real racking cost and geometry? |
| Turnover | 30 days for every product | Real days-on-hand — one figure or per product group? |
| Capital cost | 9% annual | Cost of debt, WACC, or an internal hurdle rate? |
| Target margin | 66% *markup* tenant-wide (= 39.76% margin) | Real per-product-group table, expressed as margin per D5. |
| Guardrails | 8% min margin, 25% max discount | Real floors? **`max_discount_percent` is stored and echoed but clamps nothing today** — should it? |
| Packaging | pc 0.12 PLN + 0.2 min, box 1.85 + 1.5, pallet 38.00 + 12 | Real? (box and pallet rows are dead data until unit conversions are loaded) |
| Fuel | one seeded observation; logistics refuses to price without one | Current price per litre per fuel type; import cadence? |
| Vehicles | van 11.5 l/100 km, 4200 PLN/month fixed | Real fleet: consumption, fixed cost, capacity, driver role, count. |
| Fleet utilisation | 21 working days × 1 trip/day | Real divisor — it moves every delivered line's price directly. |
| Delivery zones | warszawa_poludnie 34 km / 55 min / 3 stops; mazowieckie_daleko 145 km / 190 min / 1 stop | Real zone list. |
| Purchase costs | none outside the seed | Supplier price-list import, goods-receipt feed, or manual entry? Determines whether A needs an importer. |
| Cost staleness | 60 days → downgraded to `estimated` | Right threshold for these categories? |

---

## Changelog

| Date | Change |
|---|---|
| 2026-09-18 | Initial draft. Research by 16 parallel agents over the pricing engine, cost model, logistics, company address, UI reuse, seeding, module wiring, QA, navigation, backend RBAC and portal identity, with an adversarial completeness pass. Owner decisions D1–D8 recorded. |
