# Pricing Engine Package — Agent Guidelines

`@open-mercato/pricing-engine` holds one module, `pricing_engine`: a cost-to-serve pricing engine for
B2B distribution. Spec: [`.ai/specs/2026-09-18-pricing-engine-module.md`](../../.ai/specs/2026-09-18-pricing-engine-module.md).

## Always

- Do all money arithmetic through `lib/decimal.ts`. It is the only place BigInt/decimal math is allowed.
- Quantize a running price to the money scale after every component, so the printed waterfall adds up
  to the printed price and `unitPrice x quantity === totalPriceNet`.
- Give every component an `explainKey` + `explainValues`, never a rendered sentence — a stored
  calculation must be re-renderable in any locale.
- Return `confidence: 'measured' | 'estimated' | 'default'` honestly. Assumed rates are `default`.
- Prefetch everything a component reads before the pipeline loop. Components receive data, never an
  `EntityManager`.
- Keep `pricing_engine` listed **after** `sales` in `apps/*/src/modules.ts` — DI registrars run in that
  order, and `di.ts` wraps the `salesCalculationService` binding `sales` registers. The wrapper
  RECORDS what the engine would have charged (`services/salesShadowObserver.ts`) and returns the base
  service's own result object untouched; it never alters a sales amount, and it is off unless
  `OM_PRICING_SHADOW_OBSERVE` says otherwise. Listing this module first leaves the binding unwrapped
  and the observation silently dead.
- Ship all five locales (`en`, `pl`, `es`, `de`, `ko`), flat and alphabetically sorted. Every key a
  component can emit must exist in `en` AND `pl` — `__tests__/i18nKeys.test.ts` sweeps five branch paths
  and fails on a missing key or an unsupplied `{placeholder}`.
- Chain `.proxy()` on any `asFunction` factory with a destructured parameter. The container runs in
  Awilix CLASSIC mode and resolves by parameter name, so without it `em` arrives `undefined` at
  runtime. `packages/core/src/__tests__/di-classic-proxy.test.ts` enforces this.
- Read a specific earlier component through `args.componentValues[CODE]`, not through
  `args.unitCostNet`. The running total is the wrong base whenever you need one particular figure —
  frozen capital finances the goods, not the labour not yet spent on them.
- Clamp every configured multiplier on a `mul` component to a sane band and warn on rejection. A
  configured `0` would zero the price outright and a negative one would invert it.
- Validate anything used as a divisor (`div()` returns 0 on a zero divisor, so a bad config makes a
  cost silently vanish rather than fail loudly) and anything that reaches confidence: a payload that
  merely EXISTS is not a configured payload — check that it carries every figure you consumed.
- The shelf-life ladder is a **FLOOR, not a price**: `guardrails.ts` only ever raises a price up to
  `weightedFloorUnitPrice`, never pulls one down to it. Setting the price would quote cost to every
  customer asking about a product with one ageing pallet — including the one who would have paid full,
  and for the part of the line never at risk. An expiry buys PERMISSION to go low: the panel reports
  `shelfLifeFloorUnitPrice`, `floorHeadroomPerUnit` and `writeOffAvoided`, and a person decides.
  `writeOffAvoided` is measured on `componentValues[PRODUCT_COST_CODE]`, never `unitCostNet` — unsold
  goods never incur picking, packing or delivery.
- Rotation is measured **only** at `rotation.source === 'movements'` with a non-null `coverDays`; every
  other source means `defaultTurnoverDays` was used and must say so (`warehouseTurnoverAssumed` + the
  reason). No production path writes `pick`/`ship` today — `wms` writes `adjust`, `receipt`,
  `cycle_count` and an intra-warehouse `move` that nets to zero — so real deployments stay on the
  default. Even a measured rotation cannot lift the component to `measured`: the pallet-slot geometry is
  assumed, and the component reports the lower of occupancy and rotation.
- Objectives and weights live in `pricing_component_params` under the synthetic code `objective_weights`
  — no entity, no migration. Never add a "guardrail beats weights" filter there: every suggestion is
  priced by the full pipeline and is legal by construction, and a filter re-deriving the floor from
  `min_margin` alone would delete exactly the suggestions on expiring stock.
- `dedupeByChange` covers only changes carrying `toQuantity` or `toProductId`. `basket_consolidation`
  records nothing in `change` that tells its options apart, so collapsing on that payload would drop four
  of five merge options — deduplication must not become deletion.

## Ask First

- `mode` is a REPORTED LABEL, NOT A GUARD. Nothing reads `PricingContext.mode`; it is stamped onto the
  quote result (`services/pricingService.ts:157`) and the ledger row (`:188`), and that is all. Ask
  before giving it behaviour, and never describe `shadow` as a safety property until one is written.
- Ask before changing a golden-case expectation in `__tests__/pipeline.golden.test.ts` — a price move
  there must be deliberate.
- Ask before adding a production dependency. The decimal layer is dependency-free on purpose.
- Ask before touching `customers`, `catalog` or `sales` source. This module extends them through DI and
  their published seams only.

## Never

- Never invent a rate, cost or indicator on a production path. Mark the gap `TODO(data-source)` and add
  a coverage row.
- Never write a cost row into `catalog_product_variant_prices` — that table is sell-side and is read by
  `selectBestPrice`.
- Never call `registerSalesLineCalculator` / `registerSalesTotalsCalculator` from this module — not from
  `di.ts`, not from a side-effect import. `register(container)` runs on EVERY request
  (`shared/lib/di/container.ts:248-252`), `salesCalculations` is a process global
  (`sales/lib/calculations.ts:410`), and `registerLineCalculator` is an unconditional `push` with no
  dedup (`:276-283`): one closure per request, each pinning a different tenant's container — a
  cross-tenant leak by construction. Only the totals hook guards this, with a module-level flag
  (`sales/lib/providers/totals.ts:19`). Wrap the `salesCalculationService` binding instead, so the
  wrapper's lifetime is the request's.
- Never let a decorator outlive its request: everything it closes over must come from the `container`
  handed to `register()`, which is built per request and pins exactly one tenant.
- Never add `updated_at` to the append-only ledger tables (`pricing_calculations`,
  `pricing_calculation_lines`, `pricing_shadow_observations`).
- Never use raw `<table>` in backend pages — `om-ds/*` runs at `error` for this package.

## Validation Commands

```bash
yarn workspace @open-mercato/pricing-engine test
yarn workspace @open-mercato/pricing-engine typecheck
yarn generate
yarn db:generate
```

## Markup vs. margin

`target_markup_percent` is what an operator configures: `price = cost x (1 + markup)`.
`margin_percent` is derived and reported: `(price - cost) / price`. A 66% markup is a 39.76% margin.
Guardrail floors are expressed as **margin**. Never store one under the other's name.

## Layout

| Path | Contents |
|---|---|
| `lib/decimal.ts` | The only money arithmetic |
| `lib/pipeline.ts` | Ordered component runner + basket allocation |
| `lib/components/` | One file per price component; `index.ts` declares the full eleven-code pipeline |
| `lib/params.ts` | Time-versioned parameter resolution, scope precedence customer > group > product > product group > global |
| `lib/catalog.ts` | Optional-peer catalog prefetch via the DI-registered `CatalogProduct` class |
| `lib/inventory.ts` | Optional-peer WMS prefetch (4 queries, flat in basket size): lots, balances, rotation. `ComponentDeps.inventory` is optional — no WMS means an empty snapshot and zero queries |
| `lib/advisor/` | Suggestion generators, objective scoring, ranking and deduplication |
| `lib/seedDefaults.ts` | Assumed starting rates — assumptions, not measurements |
| `services/pricingService.ts` | Orchestration + audit ledger write |
| `api/` | Routes pin their public path with `metadata.path` (`/api/pricing/*`) |
