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
  order and this module decorates `salesCalculationService`.
- Ship all five locales (`en`, `pl`, `es`, `de`, `ko`), flat and alphabetically sorted. Every key a
  component can emit must exist in `en` AND `pl` — `__tests__/i18nKeys.test.ts` sweeps five branch
  paths and fails on a missing key or an unsupplied `{placeholder}`.
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

## Ask First

- Ask before switching any tenant out of `shadow` mode. `advisory`/`live` change invoiced prices.
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
- Never register a sales/catalog hook through a side-effect import; register inside `di.ts`.
- Never treat the module-level `salesCalculations` / catalog resolver registries as tenant-scoped —
  branch on `context.tenantId` inside the hook.
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
| `lib/seedDefaults.ts` | Assumed starting rates — assumptions, not measurements |
| `services/pricingService.ts` | Orchestration + audit ledger write |
| `api/` | Routes pin their public path with `metadata.path` (`/api/pricing/*`) |
