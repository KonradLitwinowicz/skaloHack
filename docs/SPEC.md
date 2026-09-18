# SPEC — Pricing Engine Module (`pricing_engine`)

**Status:** Draft — awaiting owner approval (Step 0 checkpoint). No implementation started.
**Owner:** new package `@open-mercato/pricing-engine`
**Date:** 2026-09-18
**Related guides:** root `AGENTS.md`, `packages/core/AGENTS.md`, `packages/core/src/modules/sales/AGENTS.md`, `packages/core/src/modules/customers/AGENTS.md`, `packages/cli/AGENTS.md`, `packages/ui/AGENTS.md`, `.ai/qa/AGENTS.md`, `BACKWARD_COMPATIBILITY.md`
**Related specs:** `SPEC-055-2026-02-23-promotions-module.md` (approved, **not implemented**), `SPEC-033-2026-02-18-omnibus-price-tracking.md`, `SPEC-024-2026-02-11-financial-module.md`

---

## TLDR

A B2B wholesale distributor (HoReCa: chemicals, packaging, paper) needs to quote every customer the
best price that still preserves a target margin. Today the price comes from a price list plus a sales
rep's negotiation; nobody computes the **fully loaded cost of serving that specific customer**.

`pricing_engine` is a new, optional module that computes a quoted unit price from an ordered,
auditable pipeline of 11 cost/margin components — purchase cost, process labour, packaging, warehouse
occupancy and frozen capital, logistics (fleet, fuel, route), product physical aspects, customer
behaviour indicators, volume effects, target margin, guardrails, rounding — and persists every
calculation with its inputs, parameters and a plain-language explanation per component.

It also returns **upsell suggestions** that genuinely lower the customer's unit price while protecting
or improving the distributor's profit, and it onboards a new distributor from a directory of CSV/YAML
files plus one CLI command — no code changes.

Default runtime mode is `shadow`: the engine computes and records, the invoice keeps using today's price.

---

## Problem Statement

1. **Cost of service is invisible.** The repo stores **no purchase cost anywhere** (verified: no
   `cost_price` / `purchase_price` / `unit_cost` column exists in `catalog`, `wms`, `sales`,
   `data_sync` or any other module; `wms` has no inventory valuation at all). Margin today is a
   sales-side fiction.
2. **Labour, packaging, warehouse and transport are never attributed to a line.** A phone order for
   one carton and a structured-file order for a pallet cost wildly different amounts to serve, and
   both are priced identically.
3. **The distributor's own purchasing position is not represented.** Annual purchase volume and the
   supplier's rebate thresholds are the biggest single lever on the buy price and are invisible.
4. **No audit trail.** A sales rep cannot explain a price. Nothing can be reproduced with the rates
   that were in force at the time.
5. **Onboarding another distributor means forking.** Every rate is a business input, not code.

---

## Scope

### In scope (v1)

- New optional module + package: pricing pipeline, parameter versioning, calculation audit, guardrails.
- Supplier (distributor) configuration model: labour, process, packaging, warehouse, fleet, fuel,
  delivery zones, purchase positions, target margins.
- Customer pricing profile + 9 behaviour indicators with scheduled + event-driven recomputation.
- `POST /quote`, `POST /simulate`, `GET /calculations/:id`, `GET /coverage` API.
- Four admin screens: playground (waterfall), coverage register, parameters (with impact preview),
  shadow comparison.
- Supplier import/validate/scaffold CLI, idempotent and transactional, with `--dry-run`.
- Self-service distributor onboarding: `onboarding` wizard steps + in-app package upload sharing the
  CLI's importer and validator.
- Calibrated demo seed for one HoReCa distributor.
- Optional, non-breaking integration with `sales` so cart = quote = order price.

### Explicitly NOT in v1 (per owner instruction)

- Generic rule builder or DSL for pricing rules. Components are TypeScript functions.
- Machine learning, demand prediction, self-tuning. Data is captured for it; nothing is modelled.
- Competitor price scraping. A `competitorPriceProvider` interface with a single `manual`
  implementation and nothing else.
- Switching any tenant to `live` mode. Default is `shadow`; the flip requires explicit owner sign-off.
- Any change to core framework code. Everything goes through extension points, DI and overrides.

---

## Key Architectural Decisions

Owner-set decisions (D1–D6), plus decisions derived from reading this repo (D7–D14).

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Rules as code, parameters in the database.** Every price component is a registered TypeScript function; every rate/threshold/percentage is a versioned DB row editable from admin. | Avoids a DSL nobody can debug. Matches the repo's rejection of generic engines for math (see D9). |
| **D2** | **One source of truth.** The engine exposes `pricingService`. Cart, quote and order all price through `salesCalculationService`, which `pricing_engine` decorates. | Cart price must never diverge from the invoice. |
| **D3** | **Every calculation is persisted with its breakdown** (`pricing_calculations` + `pricing_calculation_lines`). | Without audit the engine is unusable by a sales rep. |
| **D4** | **Parameters are time-versioned** (`valid_from` / `valid_to`). A March quote must be reproducible with March rates. | Determinism requirement; also the only way shadow-mode comparison is meaningful. |
| **D5** | **A distributor is configuration, not code.** All distributor-specific values are data. | Second distributor = one data package + one command. |
| **D6** | **Zero invented data.** Missing source data is marked `TODO(data-source)` in code and registered in the coverage register. No sample numbers on production paths. Demo data lives only in `seedExamples` and is flagged `is_demo = true`. | Coverage screen must be brutally honest. |
| **D7** | **New workspace package `@open-mercato/pricing-engine` holding one module `pricing_engine`**, mirroring `packages/checkout`. | ~20 entities, a CLI, 4 admin screens and a scheduler worker do not belong in `@open-mercato/core`, and the module must stay optional/disableable. |
| **D8** | **The engine owns purchase cost.** Because no module in the repo stores a purchase/cost price, `pricing_engine` introduces `pricing_purchase_positions` keyed by `catalog_product_id` (+ optional `catalog_variant_id`) with **last-delivery price and date**, never a period average. | See the moving-average trap in *Risks*. `catalog_product_variant_prices` is sell-side only and is read by the sell-side resolver — writing cost rows there would corrupt `selectBestPrice`. |
| **D9** | **Do not reuse `business_rules`.** It returns `{ allowed: boolean }`, has no numeric output channel, hits the DB per execution (rule discovery + `rule_execution_logs`), allows outbound HTTP inside actions, and budgets up to 60 s. | All four are disqualifying inside a per-line price calculation. Its `condition_expression jsonb` *shape* is reused for optional gating predicates only. |
| **D10** | **The primary seam is a DI decoration of `salesCalculationService`**, using the `record_locks` pattern (`packages/enterprise/src/modules/record_locks/di.ts:33`): `pricing_engine/di.ts` re-registers the same DI key with a wrapper that implements the same `SalesCalculationService` interface and delegates to the default. **The `registerSalesLineCalculator` hook is NOT usable as the primary seam** — `SalesCalculationContext.resolve` is declared (`sales/lib/types.ts:136`) but **never populated** by `buildCalculationContext` (`sales/commands/documents.ts:2861`), so a hook has no container access. The decorator closes over the container and therefore does. | Verified in code. The decorator runs before `salesCalculations.calculateLine`, i.e. before every adjustment, provider surcharge and any future promotion. |
| **D11** | **Registration happens inside `pricing_engine/di.ts` `register(container)`, never via a side-effect import.** DI registrar order follows the app's `apps/mercato/src/modules.ts` order (`di.generated.ts`), so `pricing_engine` MUST be listed **after** `sales`. | Root `AGENTS.md` bans cross-module side-effect imports. Awilix re-registration is last-wins, and `record_locks` establishes this exact precedent for overriding a platform DI key. |
| **D12** | **Money is `numeric(18,4)`, rates are `numeric(7,4)`, factors `numeric(24,12)`, mapped to `string` in TypeScript**, matching `sales`/`catalog`. Arithmetic happens in a single decimal helper inside the module. | Repo-wide convention; avoids float drift in an audit ledger. |
| **D13** | **The calculation ledger is append-only** and therefore exempt from the `updated_at` optimistic-lock requirement. **Every operator-editable parameter entity carries `updated_at`** and returns `updatedAt` from its CRUD responses so `CrudForm` locks by default. | `packages/core/AGENTS.md` → Database Entities. |
| **D14** | **Quantity/packaging comes from `catalog_product_unit_conversions`, not from new columns.** "Carton = 12 pc" is an existing conversion row (`unit_code`, `to_base_factor numeric(24,12)`). Physical aspects come from existing `weight_value`/`weight_unit`/`dimensions jsonb` on product and variant. | No duplicate packaging model; `product_aspects` and the "round up to a full carton" suggestion read catalog. |

---

## Architecture

### Placement

```
packages/pricing-engine/                       # new workspace package @open-mercato/pricing-engine
├── package.json · build.mjs · tsconfig.json · jest.config.cjs · AGENTS.md · README.md
└── src/modules/pricing_engine/
    ├── index.ts                 metadata
    ├── di.ts                    pricingService, pricingAdvisorService, entity asValue bindings,
    │                            salesCalculationService decoration, sales line-calculator hook
    ├── acl.ts                   features
    ├── setup.ts                 defaultRoleFeatures, onTenantCreated, seedDefaults, seedExamples
    ├── ce.ts                    custom-field containers for parameter entities
    ├── events.ts                createModuleEvents(...)
    ├── search.ts                calculations searchable by customer / sku
    ├── translations.ts          translatable labels on component/indicator definitions
    ├── cli.ts                   pricing:* commands
    ├── extension-points.ts      declared UMES hosts for the four screens
    ├── analytics.ts             shadow-report aggregates
    ├── data/{entities,validators,extensions,enrichers}.ts
    ├── migrations/              module-scoped + .snapshot-open-mercato.json
    ├── lib/
    │   ├── decimal.ts           the ONLY money arithmetic
    │   ├── pipeline.ts          component registry + ordered execution
    │   ├── components/*.ts      the 11 components, one file each
    │   ├── params.ts            time-versioned parameter resolution + scope precedence
    │   ├── coverage.ts          data-source / confidence registry
    │   ├── indicators/*.ts      the 9 customer indicators
    │   ├── advisor/*.ts         the 5 suggestion generators
    │   └── supplierPackage/     schema, parser, validator, importer for suppliers/<slug>/
    ├── commands/                registerCommand(...) at import time; ids pricing_engine.<entity>.<action>
    │   └── index.ts             barrel of `import './x'` (shared.ts / factory.ts are skipped by the scanner)
    ├── services/
    │   ├── pricingService.ts
    │   ├── pricingAdvisorService.ts
    │   ├── pricingParameterService.ts
    │   └── competitorPriceProvider.ts        interface + `manual` implementation only
    ├── api/…                    quote, simulate, calculations/[id], coverage, CRUD per parameter entity
    ├── backend/pricing/…        each page.tsx has a DEFAULT export + a sibling page.meta.ts
    ├── subscribers/             order-completed → indicator recompute
    ├── workers/                 indicator sweep, supplier import job
    ├── widgets/                 injection into sales document lines (price explanation)
    ├── i18n/{en,pl,de,es,ko}.json
    ├── __tests__/               unit tests per component + golden cases
    └── __integration__/         Playwright specs
```

### Route contracts (verified against `di.generated.ts` / `api-routes.generated.ts`)

- API routes are auto-derived as `'/' + [moduleId, ...segments]` with the module id dashed
  (`shipping_carriers` → `/api/shipping-carriers/...`), **but `export const metadata = { path: '…' }` on the
  route file overrides it verbatim** (`resolveApiPathFromMetadata`, `packages/cli/src/lib/generators/module-registry.ts:1593`).
  The engine therefore serves the requested paths exactly: **`/api/pricing/quote`**, `/api/pricing/simulate`,
  `/api/pricing/calculations/[id]`, `/api/pricing/coverage`. The `path` value is a frozen contract surface from
  the first release.
- **Backend page routes are NOT auto-prefixed**: `backend/pricing/playground/page.tsx` →
  `/backend/pricing/playground` exactly as requested.

### The pipeline contract

```ts
export type PricingMode = 'shadow' | 'advisory' | 'live'

export type PricingContext = {
  tenantId: string
  organizationId: string
  productId: string
  variantId?: string | null
  quantity: string                 // decimal string, base unit
  enteredQuantity?: string | null  // as typed by the customer
  enteredUnitCode?: string | null  // e.g. 'box'
  currencyCode: string
  customerId?: string | null
  customerGroupCode?: string | null
  orderScenarioCode?: string | null
  deliveryZoneCode?: string | null
  basketLines?: BasketLine[]       // basket-level components need the whole basket
  date: Date                       // determinism: resolves the parameter version set
  mode: PricingMode
}

export type ComponentConfidence = 'measured' | 'estimated' | 'default'

export type ComponentResult = {
  code: string
  label: string                    // i18n key, resolved at the edge
  effect: 'add' | 'mul'
  value: string                    // decimal string: currency amount (add) or factor (mul)
  inputs: Record<string, unknown>  // what was fed in
  params: Record<string, unknown>  // which parameter rows / versions were used
  explain: string                  // one sentence a sales rep can read to a customer
  confidence: ComponentConfidence
  warnings?: string[]
}

export type PriceComponent = {
  code: string
  order: number
  level: 'line' | 'basket'
  compute(ctx: PricingContext, base: string, deps: ComponentDeps): Promise<ComponentResult>
}
```

`ComponentDeps` carries `em`, the resolved parameter set for `ctx.date`, the catalog snapshot, the
customer indicator snapshot, the supplier profile, and a `logger` child. Components are **pure with
respect to the DB**: everything they read is prefetched by `pricingService` before the loop, so a
basket of N lines performs O(1) parameter queries, not O(N).

`explain` is produced from an i18n key plus interpolated values — never a hard-coded Polish string
(root `AGENTS.md`: never hard-code user-facing strings).

### Integration with `sales` (D2, D10, D11)

```
sales command (quotes/orders create|update, lines.upsert, adjustments.*, returns.*)
   └─ salesCalculationService.calculateLine(...)                    # DI key owned by sales
        └─ [pricing_engine DECORATOR]                               # ← our seam
             ├─ resolves pricingService from the container it closed over
             ├─ prices the line, persists pricing_calculations + _lines
             └─ sets result.line.unitPriceNet / unitPriceGross (live mode only), then
        └─ default.calculateLine(...)
             └─ buildBaseLineResult(line)       net = unit×qty − discount; tax = net×rate
             └─ 'sales.line.calculate.before'
             └─ registered line calculators
             └─ 'sales.line.calculate.after'
   └─ salesCalculationService.calculateDocumentTotals(...)
        └─ default → order adjustments → provider totals hook (shipping/payment surcharges)
```

- The decorator resolves `pricingService` inside `try/catch` (the optional-peer pattern) and **passes the
  call straight through** when the engine is absent, the tenant has no `pricing_supplier_profiles` row, or
  the document kind is out of scope.
- **What actually persists the unit price:** `convertLineCalculationToEntityInput`
  (`sales/commands/documents.ts:3114`) stores `line.unitPriceNet ?? netAmount / quantity`. So in `live`
  mode the decorator must write `result.line.unitPriceNet` / `unitPriceGross` **and** recompute
  `netAmount` / `grossAmount` / `taxAmount` / `discountAmount` consistently — it cannot only set a price.
- In `shadow` mode the decorator does **not** touch any amount; it records the calculation and attaches
  `result.line.metadata.pricingEngine = { calculationId, engineUnitPriceNet, deltaPercent }`, plus a
  `pricing_shadow_observations` row.
- In `advisory` mode it additionally surfaces the engine price as a suggestion in the UI.
- Today sales performs **no server-side price resolution at all** — `unitPriceNet`/`unitPriceGross` are
  client-supplied by `LineItemDialog` from `GET /api/catalog/prices`, and `catalogPricingService` /
  `selectBestPrice` are never called by sales. The engine therefore *adds* server-side pricing where none
  existed, rather than replacing an existing resolver.
- Promotions (SPEC-055) are a downstream consumer of a settled unit price and need no change; when that
  module is implemented, the engine still runs first by construction.

#### Coverage gaps in the sales path (must be handled, not assumed)

| Path | Today | v1 handling |
|---|---|---|
| `sales.quotes.convert_to_order` (`documents.ts:6260`) | Copies quote line prices and totals **verbatim**; never recalculates | Correct for D2 — the quote price is the agreed price. The decorator records a `pricing_shadow_observations` row at conversion so a stale quote is visible, and does not re-price |
| `sales.invoices.create` (:8903), `sales.credit_memos.create` (:9402) | Take totals straight from the request payload; never call `salesCalculationService` | Out of scope for v1; documented so nobody assumes the engine covers invoicing. Flagged on the coverage screen |
| Shipped lines | `SHIPPED_LINE_NUMERIC_PRICING_FIELDS` (`documents.ts:6770`) blocks price edits | The decorator passes through unchanged for shipped lines |

### Determinism and parameter versioning (D4)

`pricingParameterService.resolve(scopeChain, code, date)` returns the row whose
`[valid_from, valid_to)` contains `date`, choosing the most specific scope first:

```
customer → customer_group → product → product_group → global
```

A `parameter_set_version` (monotonic integer per tenant, bumped on every parameter write) is stamped on
each `pricing_calculations` row, so a calculation can be replayed exactly.

---

## Data Model

Table prefix `pricing_`; module-owned, `uuid` PKs, `tenant_id` + `organization_id` on every row,
`created_at` / `updated_at` / `deleted_at` per repo convention. `is_demo boolean not null default false`
on every table so demo data can be purged in one command (D6).

### A. Distributor profile and own costs

| Table | Key columns |
|---|---|
| `pricing_supplier_profiles` | `slug`, `name`, `currency_code`, `default_target_markup numeric(7,4)`, `mode text ('shadow'\|'advisory'\|'live') default 'shadow'`, `rounding_policy jsonb`, `parameter_set_version integer` |
| `pricing_labor_rates` | `role_code`, `label`, `hourly_rate numeric(18,4)`, `overhead_rate numeric(7,4)`, `valid_from`, `valid_to` |
| `pricing_process_steps` | `code`, `label`, `role_code`, `duration_minutes numeric(18,4)`, `is_per_line boolean`, `is_per_order boolean`, `valid_from`, `valid_to` |
| `pricing_order_scenarios` | `code` (`ideal_file`, `nonstandard_file`, `phone`, `sms`, `email`, `rep_visit`), `label`, `step_multipliers jsonb` (step code → multiplier), `extra_step_codes jsonb`, `valid_from`, `valid_to` |
| `pricing_packaging_costs` | `unit_code` (FK-less link to the catalog unit dictionary), `material_cost numeric(18,4)`, `pack_minutes numeric(18,4)`, `role_code`, `valid_from`, `valid_to` |
| `pricing_warehouse_costs` | `basis text ('m2'\|'pallet_slot')`, `cost_per_month numeric(18,4)`, `capital_cost_annual_rate numeric(7,4)`, `default_turnover_days integer`, `valid_from`, `valid_to` |
| `pricing_vehicles` | `code`, `label`, `capacity_kg`, `capacity_m3`, `capacity_pallets`, `fuel_type`, `consumption_l_per_100km numeric(18,4)`, `fixed_cost_month numeric(18,4)`, `driver_role_code`, `is_active` |
| `pricing_fuel_prices` | `fuel_type`, `price_per_litre numeric(18,4)`, `observed_on date` — a time series, never one number |
| `pricing_delivery_zones` | `code`, `label`, `avg_distance_km numeric(18,4)`, `avg_drive_minutes numeric(18,4)`, `typical_stops integer`, `default_vehicle_code` |
| `pricing_purchase_positions` | `catalog_product_id uuid`, `catalog_variant_id uuid null`, `annual_volume numeric(18,4)`, `current_tier_code`, `current_tier_discount numeric(7,4)`, `next_tier_volume numeric(18,4)`, `next_tier_discount numeric(7,4)`, **`last_delivery_unit_cost numeric(18,4)`**, **`last_delivery_at timestamptz`**, `last_delivery_quantity numeric(18,4)`, `sold_quantity_period numeric(18,4)` |

### B. Customer

| Table | Key columns |
|---|---|
| `pricing_customer_profiles` | `customer_id uuid` (FK-id into `customers`, no ORM relation), `customer_group_code`, `delivery_zone_code`, `default_order_scenario_code`, `negotiated_prices jsonb`, `negotiated_price_expires_at` |
| `pricing_customer_indicator_definitions` | `code`, `label`, `description`, `direction ('increases_price'\|'decreases_price')`, `weight numeric(7,4)`, `algorithm_version integer`, `source text`, `is_active` |
| `pricing_customer_indicators` | `customer_id`, `code`, `value numeric(18,6)`, `normalized_value numeric(7,4)`, `window_from`, `window_to`, `computed_at`, `algorithm_version`, `confidence` |

v1 indicators: `volume_12m`, `order_regularity`, `basket_predictability`, `avg_basket_value`,
`order_channel_cost`, `payment_behavior`, `return_rate`, `special_requests_load`, `delivery_density`.

### C. Components, guardrails, audit

| Table | Key columns |
|---|---|
| `pricing_components` | `code`, `label`, `position integer`, `effect ('add'\|'mul')`, `level ('line'\|'basket')`, `is_active` |
| `pricing_component_params` | `component_code`, `scope ('global'\|'product_group'\|'product'\|'customer_group'\|'customer')`, `scope_ref_id`, `payload jsonb`, `valid_from`, `valid_to`, `created_by_user_id`, `change_note` |
| `pricing_guardrails` | `code`, `min_margin_percent numeric(7,4)`, `max_discount_percent numeric(7,4)`, `floor_price numeric(18,4)`, `rounding jsonb`, `negotiated_price_precedence text`, `scope`, `scope_ref_id`, `valid_from`, `valid_to` |
| `pricing_calculations` *(append-only, no `updated_at`)* | `context_snapshot jsonb` (versioned, `{ version: 1, … }`), `final_unit_price_net numeric(18,4)`, `final_total_net`, `margin_percent numeric(7,4)`, `mode`, `parameter_set_version`, `triggered_by ('api'\|'sales_hook'\|'cli'\|'simulate')`, `triggered_by_user_id`, `duration_ms`, `warnings jsonb`, `calculated_at` |
| `pricing_calculation_lines` *(append-only)* | `calculation_id`, `component_code`, `position`, `effect`, `value numeric(18,4)`, `running_total numeric(18,4)`, `inputs jsonb`, `params jsonb`, `explain_key`, `explain_values jsonb`, `confidence`, `warnings jsonb` |
| `pricing_coverage_entries` | `component_code`, `source_kind`, `source_ref`, `freshness_days integer`, `confidence`, `missing_reason`, `last_checked_at` |
| `pricing_shadow_observations` | `calculation_id`, `sales_document_kind`, `sales_document_id`, `sales_line_id`, `invoiced_unit_price_net`, `engine_unit_price_net`, `delta_absolute`, `delta_percent`, `observed_at` |

`context_snapshot` follows the repo's established versioned-snapshot pattern (`SalesLineUomSnapshot`
in `sales/lib/types.ts:9`): explicit `version`, decimals as strings, provenance and the rounding policy
that was in force.

---

## Price Components

Executed in `position` order. `base` is the running value; `add` components add currency, `mul`
components multiply. Every component returns `confidence` and an `explain` i18n key.

| # | `code` | Formula (v1) | Primary source | Default confidence |
|---|---|---|---|---|
| 1 | `product_cost` | `last_delivery_unit_cost × (1 − current_tier_discount)` | `pricing_purchase_positions` | `measured` when `last_delivery_at` ≤ 60 days, else `estimated` + warning |
| 2 | `operational_cost_base` | `Σ over steps active for the scenario: duration_minutes × multiplier / 60 × hourly_rate × (1 + overhead_rate)`; per-order steps divided across basket lines by line-net share | `pricing_process_steps` × `pricing_order_scenarios` × `pricing_labor_rates` | `measured` if the distributor supplied times, else `default` |
| 3 | `packaging_cost` | `Σ over pack units: material_cost + pack_minutes/60 × hourly_rate × (1 + overhead_rate)`; pack-unit count from `catalog_product_unit_conversions.to_base_factor` | `pricing_packaging_costs` + catalog | `measured` / `default` |
| 4 | `warehouse_cost` | `occupancy × cost_per_month × (turnover_days / 30) + product_cost × capital_cost_annual_rate × turnover_days / 365` | `pricing_warehouse_costs` + catalog `dimensions`/`weight` | `estimated` (turnover is a default until stock history exists) |
| 5 | `logistics_cost` | `((avg_distance_km × 2 × consumption_l_per_100km / 100 × price_per_litre) + (avg_drive_minutes/60 × driver_hourly_rate × (1+overhead)) + (fixed_cost_month / working_days / trips_per_day)) / load_share`, then `× delivery_density_factor` | `pricing_delivery_zones` + `pricing_vehicles` + `pricing_fuel_prices` | `estimated` |
| 6 | `product_aspects` | multiplicative corrections for oversize / heavy / fragile / storage-regime, read from catalog `weight_value`, `dimensions`, `hazmat_class`, `requires_prescription`, `is_excise_good` | catalog + `pricing_component_params` | `measured` for physical facts, `default` for the multipliers |
| 7 | `customer_profile` | `Π over active indicators: (1 + direction_sign × weight × normalized_value)` | `pricing_customer_indicators` | **`estimated` in v1 — see the data caveat below** |
| 8 | `volume_effect` | tiered factor from this line's quantity and the customer's trailing volume | `pricing_component_params` | `estimated` |
| 9 | `target_margin` | `× (1 + target_markup_percent_for_product_group)` — markup on accumulated cost; the response also reports the derived `margin_percent` | `pricing_component_params` scoped by product group | `measured` |
| 10 | `guardrails` | clamp to `min_margin_percent`, `max_discount_percent`, `floor_price`; **negotiated price takes precedence per `negotiated_price_precedence`** | `pricing_guardrails` + `pricing_customer_profiles.negotiated_prices` | `measured` |
| 11 | `rounding` | apply `rounding_policy` (mode + scale + psychological ending) | `pricing_supplier_profiles.rounding_policy` | `measured` |

**Basket-level components** (2 partially, 5, and the advisor) receive the whole basket; line-level
components do not. `pipeline.ts` runs line-level passes first, then redistributes basket-level costs.

---

## Upselling — `pricingAdvisorService`

Input: a priced basket. Output: `Suggestion[]`, each with **both sides computed**.

```ts
export type Suggestion = {
  code: 'volume_threshold' | 'full_pack_rounding' | 'delivery_consolidation'
      | 'cheaper_equivalent' | 'order_channel_change'
  titleKey: string
  explain: string
  change: { productId?: string; fromQuantity?: string; toQuantity?: string; toProductId?: string
            toOrderScenarioCode?: string; toDeliveryDate?: string }
  customerUnitPriceBefore: string
  customerUnitPriceAfter: string
  supplierProfitBefore: string
  supplierProfitAfter: string
  breakEvenCondition: string          // when the suggestion stops being worth it
  raisesCustomerPrice: boolean        // flagged separately; suppressed in `live` without rep approval
}
```

A suggestion that increases supplier profit **and** raises the customer's price is marked
`raisesCustomerPrice: true`, is excluded from the `live`-mode response, and is only shown to a sales rep
holding `pricing.quote`.

---

## API Contracts

All routes export `openApi`. Zod validation on input **and** output. Tenant/org scope derived from the
authenticated context, never from the request body.

| Method | Path | Feature | Purpose |
|---|---|---|---|
| `POST` | `/api/pricing/quote` | `pricing.quote` | Price a basket; persists a `pricing_calculations` row |
| `POST` | `/api/pricing/simulate` | `pricing.simulate` | What-if with parameter overrides; **persists nothing** |
| `GET` | `/api/pricing/calculations/[id]` | `pricing.audit.read` | Replay a stored calculation with its breakdown |
| `GET` | `/api/pricing/coverage` | `pricing.audit.read` | Data-coverage register |
| `GET` | `/api/pricing/shadow` | `pricing.audit.read` | Shadow deltas per line / per customer |
| CRUD | `/api/pricing/<parameter-entity>` | `pricing.params.write` | `makeCrudRoute` + `indexer: { entityType }` per parameter entity |

`POST /quote` response:

```jsonc
{
  "calculationId": "uuid",
  "currencyCode": "PLN",
  "mode": "shadow",
  "parameterSetVersion": 41,
  "lines": [{
    "sku": "CHEM-014", "productId": "uuid", "quantity": "24",
    "unitPriceNet": "18.4200", "totalPriceNet": "442.0800",
    "marginPercent": "21.4000",
    "breakdown": [ /* ComponentResult[] — 11 entries */ ]
  }],
  "totalNet": "442.0800",
  "totalMarginPercent": "21.4000",
  "suggestions": [ /* Suggestion[] */ ],
  "explanation": "…",
  "warnings": ["pricing.warnings.purchaseCostStale"]
}
```

Write routes that are not `makeCrudRoute` wire the mutation-guard registry
(`getAllMutationGuardInstances` + `bridgeLegacyGuard` + `runMutationGuards`) per `packages/core/AGENTS.md`.

### RBAC (`acl.ts`)

`acl.ts` exports an array of **objects** (`{ id, title, module, dependsOn? }`) plus a default export —
not bare strings:

```ts
export const features = [
  { id: 'pricing.view',            title: 'View pricing engine',      module: 'pricing_engine' },
  { id: 'pricing.quote',           title: 'Create price quotes',      module: 'pricing_engine', dependsOn: ['pricing.view'] },
  { id: 'pricing.simulate',        title: 'Run pricing simulations',  module: 'pricing_engine', dependsOn: ['pricing.view'] },
  { id: 'pricing.params.read',     title: 'View pricing parameters',  module: 'pricing_engine', dependsOn: ['pricing.view'] },
  { id: 'pricing.params.write',    title: 'Edit pricing parameters',  module: 'pricing_engine', dependsOn: ['pricing.params.read'] },
  { id: 'pricing.audit.read',      title: 'View pricing audit trail', module: 'pricing_engine', dependsOn: ['pricing.view'] },
  { id: 'pricing.supplier.import', title: 'Import supplier package',  module: 'pricing_engine', dependsOn: ['pricing.params.write'] },
  { id: 'pricing.mode.change',     title: 'Change pricing mode',      module: 'pricing_engine', dependsOn: ['pricing.params.write'] },
] as const
export default features
```

`setup.ts` `defaultRoleFeatures`: `admin: ['pricing.*']`,
`employee: ['pricing.view', 'pricing.quote', 'pricing.audit.read']`.
`pricing.mode.change` reaches `admin` only — flipping to `live` is a privileged act.
Followed by `yarn mercato auth sync-role-acls`.

API route files declare features **per method** in `export const metadata`, and pages declare them in
`page.meta.ts` via `requireFeatures` — never `requireRoles`.

---

## Admin Screens

All four use `Page`, `DataTable`, `CrudForm`, `FilterBar`, `KpiCard`/`BarChart` from
`@open-mercato/ui`, `apiCall` for every request, `useT()` for every string, and DS tokens only.

1. **`/backend/pricing/playground`** — pick customer, lines, order scenario, delivery zone, date.
   Renders the 11-component **waterfall**: purchase cost → each component (green/red bar, delta, running
   total) → final price. Each row expands to inputs, parameters used and the one-sentence explanation.
   Side panel: upsell suggestions with both-sides profit math.
   *Note:* the DS ships no waterfall chart. v1 composes one from `ChartContainer` + a stacked `BarChart`
   with transparent risers using `var(--chart-1..5)`, per `.ai/ui-backend-components.md` rule 1 — no new
   primitive, no raw hex. (See *Open Questions* Q6.)
2. **`/backend/pricing/coverage`** — one row per component: data source, freshness, `measured` /
   `estimated` / `default`, what is missing. Brutally honest by design (D6).
3. **`/backend/pricing/params`** — `CrudForm`-based parameter editing with change history and an impact
   preview ("this rate changes the price on 340 positions by +1.2% on average"), computed through
   `POST /simulate` so nothing is written while previewing.
4. **`/backend/pricing/shadow`** — engine price vs. invoiced price, per line and per customer, with the
   delta distribution. The decision screen before any `live` flip.

Widget injection: a read-only "why this price" panel on sales document lines via
`crud-form:sales.order_line:fields` / `data-table:sales.orders.list:row-actions`, declared in
`extension-points.ts`.

---

## Onboarding Another Distributor

```
suppliers/<slug>/
  supplier.yaml          profile, currency, target margin, mode
  labor-rates.csv        roles and hourly rates
  process-steps.csv      steps, durations, roles
  order-scenarios.csv    scenarios and the steps they trigger
  packaging.csv          materials and pack times
  warehouse.yaml         space cost, capital cost
  fleet.csv              vehicles, consumption, fixed costs
  delivery-zones.csv     zones, distances
  purchase-positions.csv volumes, rebate tiers, last delivery cost + date
  products.csv           mapping to the catalog + last delivery cost
  customers.csv          groups, zones, scenarios, negotiated prices
  margins.csv            target margin per product group
```

CLI invocation in this repo is **space-separated** — `yarn mercato <moduleId> <command> [--flags]`
(`packages/cli/src/mercato.ts:873`), and `cli.ts` default-exports `ModuleCli[]` where each entry is
`{ command, run(argv) }`. Argument parsing is hand-rolled per module (the `parseArgs` helper in
`customers/cli.ts:1097` is the pattern to copy), and `--dry-run` follows
`const dry = Boolean(args['dry-run'] || args.dry)` as in `entities/cli.ts:472`.

| Command | Behaviour |
|---|---|
| `yarn mercato pricing_engine scaffold-supplier --slug <slug>` | Writes the empty directory with headers and **Polish inline comments** — a template to fill in, not documentation to read |
| `yarn mercato pricing_engine validate-supplier --dir <dir>` | Reports empty files, rows not mapping to the catalog, and which components will fall back to defaults. Exit code ≠ 0 on blocking errors |
| `yarn mercato pricing_engine import-supplier --dir <dir> [--dry-run]` | **Idempotent and transactional.** Keyed on `(tenant_id, slug, natural_key)`; re-running updates in place. `--dry-run` writes nothing and prints the same report as `validate-supplier` plus the planned row counts |
| `yarn mercato pricing_engine recompute-indicators --supplier <slug>` | Recomputes the 9 customer indicators |
| `yarn mercato pricing_engine shadow-report --supplier <slug> --from <date> --to <date>` | Shadow deltas as CSV/table |
| `yarn mercato pricing_engine purge-demo --supplier <slug>` | Deletes every `is_demo = true` row for that supplier |

Catalog lookups during import go through the sanctioned seam
`resolveProductBySkuOrExternalId(em, { sku, externalId }, scope)`
(`packages/core/src/modules/catalog/lib/productResolution.ts:34`) and the query engine —
never a direct ORM relation.

Long imports create a `ProgressJob` (`packages/core/src/modules/progress/AGENTS.md`) so
`ProgressTopBar` tracks them.

---

### Self-service onboarding for the next distributor

The CSV/YAML package + CLI is the bulk path. It is **not** the only path — a new distributor must be able
to register and fill its own rates in the app, without a developer.

1. **Wizard steps in `@open-mercato/onboarding`.** The engine contributes idempotent wizard steps
   (`packages/onboarding/AGENTS.md`: steps must be idempotent, all copy in `i18n/<locale>.json`):
   *company & currency → labour rates → process steps & order scenarios → packaging → warehouse →
   fleet & zones → target margins*. Every step can be **skipped**; a skipped step leaves that component
   on `confidence: 'default'` and produces a row on the coverage screen. The engine works from step one
   and gets sharper as steps are filled.
2. **`/backend/pricing/params` is the permanent editing surface** — `CrudForm` per parameter entity, with
   change history, the impact preview, and optimistic locking. This is where a distributor maintains rates
   after onboarding.
3. **Upload instead of CLI.** `/backend/pricing/params` offers an *Import package* action that accepts the
   same `suppliers/<slug>/` files as a zip, runs the identical validator, shows the same dry-run report,
   and runs the import as a `ProgressJob`. The CLI and the UI share one importer — no second code path.
4. **A seeded test distributor with assumed rates** ships via `seedExamples` so the screens are never
   empty on a fresh install. Every assumed value is `is_demo = true`, carries `confidence: 'default'`,
   and is listed on the coverage screen as an assumption — per D6, nothing invented is allowed to look
   measured.

## Demo Data

Seeded from `setup.ts` → `seedExamples` (skipped by `mercato init --no-examples`, and by
`overrides: { setup: { seedExamples: false } }` in an app's `modules.ts`), every row `is_demo = true`.

**`is_demo` is an invention, deliberately.** A repo-wide grep returns zero hits for
`is_demo` / `isDemo`; the house style for seed idempotency is a *content probe*
(`customers/cli.ts` → `seedCustomerExamples` checks for known example titles). A probe is fine for
"has this been seeded?" but cannot answer "delete exactly the demo rows and nothing else", which
`purge-demo` requires on a table an operator also writes to by hand. The column is module-owned,
defaults to `false`, and is never read by any other module. Seeding stays idempotent by probing on
`(tenant_id, slug)` as well, matching the house style.
One HoReCa distributor, ~1200 positions, 7.5 months of history, calibrated to:

- net sales ≈ 3.08 M PLN, purchases ≈ 2.05 M PLN, gross profit ≈ 1.15 M PLN
- median markup 66%; markup falls with purchase volume — quartiles 83% / 73% / 67% / 58%
- ≈17% of positions (≈207) produce 80% of profit
- ≈100 long-tail positions with median annual profit ≈ 35 PLN; ≈40 positions bought and never sold
- distributor cost structure: goods ≈60%, people ≈10%, warehouse + logistics ≈10%, other ≈20%
- order-handling cost by channel, spread ≈3.6 PLN (ideal file) to ≈25.6 PLN (phone/SMS)

### The data caveat that must not be papered over

The available history is an **aggregate per product** — it carries no customer, order or basket.
Therefore in v1 the nine customer indicators are computed on **synthetic seed data**, are stamped
`confidence: 'estimated'`, and appear on the coverage screen as a **missing source**. The engine must
never present them as measured.

---

## i18n

- `i18n/{en,pl,es,de,ko}.json` — **all five, from day one**; every module in the repo ships all five.
- Flat dot-notation, alphabetically sorted, full key parity across locales (enforced by
  `yarn i18n:check-sync`). `en` is the reference; `en` + `pl` are authored here, the remaining three are
  scaffolded by `yarn i18n:fix` and left for translation.
- Every key is prefixed `pricing_engine.` — including the component `label` and `explain` keys, the
  indicator definitions, the suggestion titles, the coverage reasons and every warning code.
- Client: `useT()` with an English fallback as the second argument. Server: `resolveTranslations()`.
- Purely internal `throw new Error(...)` / `createCrudFormError(...)` messages are prefixed `[internal]`
  so `yarn i18n:check-hardcoded` treats them as opted out.
- `explain` is stored in the ledger as `explain_key` + `explain_values jsonb`, never as a rendered
  sentence, so a historical calculation can be re-rendered in any locale.

## Testing

| Layer | Content |
|---|---|
| Unit — components | One suite per component (11), table-driven: inputs → expected `value`, `confidence`, `explain` key |
| Unit — parameters | Scope precedence and `valid_from`/`valid_to` resolution, including boundary dates |
| Unit — decimal | Rounding, half-up behaviour, no float drift across a 11-step pipeline |
| Golden cases | 10 end-to-end fixtures committed as JSON: small customer/phone, large customer/ideal file, long-tail position, volume-threshold position, customer in collections, far delivery zone, basket below the logistics minimum, negotiated-price override, stale purchase cost, missing zone. A price change in a golden case must be deliberate and visible in the diff |
| Guardrails | Property-style sweep: no parameter combination yields a price below the margin floor |
| Determinism | Same context + same date ⇒ byte-identical result; a historical date uses that period's parameters |
| Calibration | Statistical: median markup over the seed within 66% ± 5 p.p., and the markup-falls-with-volume trend holds |
| Import | Demo package imports from empty; second run is a no-op (idempotence); `--dry-run` writes nothing |
| Decoupling | `module-decoupling.test.ts`-style: the app boots and sales prices normally with `pricing_engine` disabled |
| Integration (Playwright, `__integration__/`) | `POST /quote`, `POST /simulate`, `GET /calculations/[id]`, `GET /coverage`, `GET /shadow`, one parameter CRUD route, plus the UI paths: playground renders a waterfall, coverage lists all 11 components, params edit round-trips with a 409 conflict, shadow screen loads. Self-contained fixtures created in setup and cleaned up in `finally` — never relying on seeded data (`.ai/qa/AGENTS.md`) |
| Sales integration | Cart price = quote price = order price for the same context in `live` mode; no price change at all in `shadow` mode |

---

## Risks & Impact Review

| # | Risk | Severity | Area | Mitigation | Residual |
|---|---|---|---|---|---|
| R1 | **False losses from average-cost markup.** Comparing average sell price to average buy price over a period reports fake negative margins on slow-moving positions (a batch bought, a few units sold from the previous batch). | High | `product_cost`, calibration | `product_cost` uses **last delivery price + date**, never a period average (D8). `validate-supplier` warns when bought vs. sold quantity diverge by more than 30%. Golden case for a long-tail position. | Low — the warning is advisory; a distributor can ignore it |
| R2 | **Customer indicators presented as measured** when they are synthetic. | High | Trust | Hard-coded `confidence: 'estimated'`, a missing-source row on the coverage screen, and a UI badge on every indicator-derived component. | Low |
| R3 | **Registry singletons are not tenant-scoped.** `salesCalculations` line calculators and `catalog` pricing resolvers are module-level arrays shared by every tenant in the process. | High | Multi-tenancy | The registered hook branches on `context.tenantId` and returns unchanged when no `pricing_supplier_profiles` row exists for that tenant. Covered by a test that runs two tenants through one process. | Low |
| R4 | **DI ordering.** If `pricing_engine` is listed before `sales` in `modules.ts`, the decoration is overwritten silently. | Medium | Boot | Documented ordering requirement + a boot-time assertion that logs an error when `salesCalculationService` is not the decorated instance. | Low |
| R5 | **Price divergence between cart and invoice** if the engine is consulted in one path but not another. | High | Correctness | Single seam (D2/D10): everything prices through `salesCalculationService`. Integration test asserts cart = quote = order. | Low |
| R6 | **Performance.** 11 components × N lines with per-component DB reads would be O(N × 11) queries. | Medium | Latency | All parameters, catalog rows and indicators are prefetched once per `quote` call; components receive data, never an EM. Budget: p95 < 300 ms for a 50-line basket, asserted in an integration test. | Medium — needs measurement on real volumes |
| R7 | **Audit table growth.** Every cart recalculation writing a calculation + 11 lines. | Medium | Storage | `sales_hook` writes are deduplicated per (document, line, parameter version, context hash); `simulate` never persists; a retention worker prunes `triggered_by='sales_hook'` rows older than N days (configurable, default 180). | Low |
| R8 | **Flipping to `live` too early.** | High | Business | Default `shadow`; `pricing.mode.change` is admin-only; the shadow screen is the gate; the owner's explicit approval is required per the brief. | Low |
| R9 | **`selectBestPrice` tie-break is a behavioural contract.** Its asymmetric `minQuantity` ordering (issue #1706) is pinned by `catalog/lib/__tests__/pricing.test.ts:177,207`. | Medium | Backward compatibility | v1 does **not** register a catalog pricing resolver (D10) and does not touch `selectBestPrice`. | None in v1 |
| R10 | **`seedCatalogPriceKinds` soft-deletes non-default price kinds** on re-run (`catalog/lib/seeds.ts:129`). | Low | Seeding | The engine introduces no catalog price kind. If one is ever needed, it must be added to catalog's default list, not seeded independently. | None in v1 |
| R12 | **Invoices and credit memos never call `salesCalculationService`** (`documents.ts:8903`, `:9402` take totals from the payload), and **quote→order conversion copies prices verbatim** (`:6484`). A naive reading of D2 would claim end-to-end coverage the engine does not have. | Medium | Correctness / honesty | Both gaps are documented in *Coverage gaps in the sales path*, surfaced on the coverage screen, and asserted by a test that the engine does **not** silently re-price at conversion. | Low |
| R13 | **`SalesCalculationContext.resolve` is dead code** (declared, never populated). A future contributor may wire a line-calculator hook and find no container. | Low | Extensibility | D10 pins the DI-decoration seam; the module's `AGENTS.md` records why the hook route was rejected. Optionally propose populating `resolve` upstream as a separate, additive PR to `sales`. | Low |
| R11 | **No customer-group entity exists in the repo** — `customer_group_id` is an opaque uuid everywhere. | Medium | Data model | `pricing_customer_profiles.customer_group_code` is engine-owned and self-consistent; mapping to any future customers-module group is an additive column. See *Open Questions* Q3. | Medium |

---

## Migration & Backward Compatibility

Per `BACKWARD_COMPATIBILITY.md`, this change is **purely additive** and touches no contract surface:

- **No core file is modified.** No change to auto-discovery, public types, signatures, import paths,
  event ids, widget spot ids, existing API routes, existing DB schema, DI keys owned by other modules
  (the `salesCalculationService` decoration re-registers the *same* key with a wrapper implementing the
  *same* `SalesCalculationService` interface), ACL features, notification ids, CLI commands or generated
  files.
- **New contract surfaces introduced by this module** (frozen from first release): module id
  `pricing_engine`, table prefix `pricing_`, DI keys `pricingService` / `pricingAdvisorService` /
  `pricingParameterService`, event ids `pricing.*`, ACL features `pricing.*`, API paths
  `/api/pricing/*` (pinned via route `metadata.path`), CLI commands `pricing_engine <command>`, the supplier package file names, and the
  `context_snapshot` / `ComponentResult` shapes (both explicitly versioned).
- **With the module disabled**, `sales` behaves exactly as today — asserted by a decoupling test.
- **Deprecation protocol** applies from the first release onward to every id above.

---

## Resolved by code inspection (no longer open)

| Was | Resolved |
|---|---|
| Module id vs. the requested `/api/pricing/*` paths | Route `metadata.path` pins the path verbatim; module id stays `pricing_engine` |
| Can a sales calculator hook reach DI? | No — `SalesCalculationContext.resolve` is never populated. Use the DI decoration (D10) |
| Locale coverage | Every module in the repo ships all five (`en`, `pl`, `es`, `de`, `ko`); `pricing_engine` does the same. `en` + `pl` authored, the rest scaffolded by `yarn i18n:fix` and left for translation |
| Does an `is_demo` convention exist? | No — this module introduces one, scoped to itself (see *Demo Data*) |
| Does a customer-group entity exist? | No — `customer_group_id` is an opaque uuid in both `catalog` and `sales`. The engine owns `customer_group_code` |
| Does any module store purchase cost? | No — the engine owns it (D8) |

## Decisions taken (owner, 2026-09-18) — Step 1 unblocked

| # | Decision |
|---|---|
| **Q1** | Follow the framework's own module conventions: a dedicated workspace package `packages/pricing-engine` → `@open-mercato/pricing-engine` → `src/modules/pricing_engine/`, exactly as `checkout`, `search`, `scheduler` and `ai-assistant` are structured. Nothing added to `@open-mercato/core`. |
| **Q2** | Implementer's call → **Option A**. The `salesCalculationService` decorator is wired for `quotes.*` and `orders.*` only, in `shadow` mode. It records and observes; it changes no amount. `advisory` and `live` arrive in Step 3 behind `pricing.mode.change`. |
| **Q3** | Customer groups are to be **owned properly, not faked inside pricing**. Two-part delivery — see *Customer groups* below. |
| **Q4** | The engine computes on **net**. VAT is applied afterwards by the existing `taxCalculationService`; the engine never touches gross. See *Markup vs. margin* below for the resolved semantics of the configured target. |
| **Q5** | **Option A** — basket-level costs (per-order process steps, logistics) are allocated to lines **proportionally to line net value**. |
| **Q6** | **Option A** — the waterfall is composed from `ChartContainer` + a stacked `BarChart` with transparent risers, `var(--chart-1..5)` tokens only. No new DS primitive. |
| **Q7** | Example rates are assumed by the implementer for the seeded test distributor. Every assumed value is `is_demo = true`, `confidence: 'default'`, and listed on the coverage screen as an assumption. Real rates replace them through the params screen or a supplier package. |

### Markup vs. margin (resolving the ambiguity in Q4)

The distributor's own data is expressed as **markup on cost** (`mediana narzutu 66%`), not as margin on
price. Storing one and labelling it the other is exactly the kind of silent error this engine exists to
remove, so:

- The **configured** value is `target_markup_percent` — `price = cost × (1 + markup)`.
  A 66% markup on a cost of 100 gives a price of 166.
- The **reported** value is `margin_percent = (price − cost) / price` — derived, never configured.
  The same case reports a margin of 39.76%.
- `pricing_guardrails.min_margin_percent` stays a **margin** floor, because that is the quantity a floor
  must protect. The params screen labels both explicitly and shows the conversion inline.
- The calibration test asserts the seed's **median markup** is 66% ± 5 p.p., matching the source data.

### Customer groups (resolving Q3)

Split so Step 1 is not blocked by a change to another core module:

1. **Now, in this module:** `pricing_customer_profiles.customer_group_code` (text) is the working key,
   populated from `customers.csv` or the params screen. It is engine-local and self-consistent.
2. **Separately, handed to where it belongs:** a companion spec proposes the canonical customer-group
   entity in the `customers` module. That is a change to a core module's data model that downstream
   modules will copy, so per `packages/core/src/modules/customers/AGENTS.md` (*Ask First*) it ships as its
   own spec and its own PR, not folded into this one.
3. **When it lands:** `pricing_customer_profiles` gains an additive, nullable `customer_group_id uuid`
   column; `customer_group_code` is kept as the fallback for one minor version and then deprecated per the
   protocol in `BACKWARD_COMPATIBILITY.md`. No pricing logic changes — only the resolution order in
   `params.ts`.

> If the intent was instead that the `customers` entity must land **before** Step 1, that is one word and
> I will sequence it first — it is a separate PR either way.

---

## Phasing

| Step | Deliverable | Demo |
|---|---|---|
| **0** | This spec, approved | — |
| **1** | Package + module skeleton, entities, migrations, DI, `product_cost` + `operational_cost_base` + `target_margin`, `POST /quote`, playground waterfall, demo seed, unit + golden + integration tests | One line priced with a full breakdown |
| **2** | `packaging_cost`, `warehouse_cost`, `logistics_cost` (fleet, fuel, zones), `product_aspects`, coverage screen | The same line for two delivery zones × two order scenarios |
| **3** | Customer indicators, `customer_profile`, `volume_effect`, CLI recompute + order-completed subscriber + scheduled sweep, guardrails, shadow mode + shadow screen | Engine price vs. invoiced price across the seeded history |
| **4** | `pricingAdvisorService`, `scaffold-supplier`, `validate-supplier`, the onboarding wizard steps + in-app package upload, Polish onboarding documentation | A basket with five suggestion types with both-sides profit; a second distributor onboarded end-to-end from the wizard with no developer involvement |

After every step: green `yarn test`, `yarn lint`, `yarn typecheck`, a changelog entry here, and one
sentence naming what is newly demonstrable.

---

## Final Compliance Report

Completed at implementation time, per `.ai/specs/AGENTS.md`. Checklist to satisfy:
module files present (`acl.ts`, `ce.ts`, `di.ts`, `events.ts`, `index.ts`, `search.ts`, `setup.ts`,
`translations.ts`, `analytics.ts`); `openApi` exported from every route; `indexer: { entityType }` on
every CRUD route; writes through commands with undo snapshots; `withAtomicFlush` / `runCrudCommandWrite`
where multi-phase; `updated_at` + returned `updatedAt` on every operator-editable entity; zod validators
in `data/validators.ts` with `z.infer` types and no `any`; `findWithDecryption` where encryption applies;
tenant + organization scoping on every query; DS-token-only styling with a full `error`-severity
`om-ds/*` block added to `eslint.ds.config.mjs`; no hard-coded user-facing strings; `yarn generate` and
`yarn mercato configs cache structural --all-tenants` run after module registration;
`yarn mercato auth sync-role-acls` run after ACL changes; `yarn agents:check-budget` green after the new
`AGENTS.md` lands.

---

## Changelog

| Date | Change |
|---|---|
| 2026-09-18 | Initial draft. Step 0 deliverable. |
| 2026-09-18 | Step 1 implemented: package `@open-mercato/pricing-engine`, 20 entities + migration, DI, ACL, setup/seed, `product_cost` + `operational_cost_base` + `target_margin` + `guardrails` + `rounding`, `/api/pricing/{quote,simulate,coverage,calculations/[id]}`, playground waterfall and coverage screens, five locales, 32 unit tests. Ledger invariant fixed: running totals are quantized to the money scale so `unitPrice x quantity === totalPriceNet` and the waterfall sums to the printed price. Module-facts JSON budget cap raised 4.00M → 4.10M (measured +68.5KB). |
| 2026-09-18 | Owner decisions recorded for Q1–Q7. Resolved markup-vs-margin semantics (`target_markup_percent` configured, `margin_percent` derived). Split customer groups into an engine-local code now plus a companion `customers` spec. Step 1 unblocked. |
