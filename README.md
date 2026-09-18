# pricing_engine — cost-to-serve pricing for B2B distribution

> **NOTICE.** This repository contains a single Open Mercato module, `@open-mercato/pricing-engine`,
> targeting **Open Mercato 0.7.0 (MIT)**. The Open Mercato platform itself is **not** included here.
> The module's own code is published under the same MIT terms (see [`LICENSE`](LICENSE)); to run it
> you must obtain Open Mercato separately and graft this package into it.

`pricing_engine` prices a B2B wholesale basket from an ordered, auditable pipeline of cost and margin
components, and stores every calculation with its inputs, the parameter versions it used, and a
one-sentence explanation per component that a sales representative can read aloud to a customer.
It answers the question a price list cannot: what it actually costs to serve *this* customer on
*this* line, and what price at that cost preserves the target margin.

**This repository is not a runnable application.** It holds one module plus its documentation —
there is no app, no server and no database here.

## Start here

- **[`URUCHOMIENIE.md`](URUCHOMIENIE.md)** — the setup runbook (in Polish). How to get Open Mercato
  0.7.0, drop this package into it, register the module, patch the `Dockerfile`, and bring the stack
  up under Docker. Written for someone who has never seen the project.
- **[`docs/SPEC.md`](docs/SPEC.md)** — the design spec: data model, per-component formulas, risks and
  the staged plan.
- **[`packages/pricing-engine/AGENTS.md`](packages/pricing-engine/AGENTS.md)** — the rules for working
  on the module's code.

## Status, without varnish

- The target pipeline has **11 price components. 5 are implemented**: `product_cost`,
  `operational_cost_base`, `target_margin`, `guardrails`, `rounding`. The remaining 6 are declared so
  the coverage screen lists them as *not implemented* rather than silently omitting them.
- The engine runs in **`shadow` mode**: it computes and records, and **changes no invoiced price**.
- **83 unit tests across 7 files pass**, golden pipeline cases included. The module has **not** been
  exercised against a live database — no migration, seed, screen or endpoint has been run against a
  running Postgres.

## Screens

| URL | Purpose | Feature |
|---|---|---|
| `/backend/pricing/playground` | Price a basket and inspect the component waterfall | `pricing.quote` |
| `/backend/pricing/coverage` | What each component's data actually rests on, and what is assumed | `pricing.audit.read` |

## API

| Method | Path | Purpose | Feature |
|---|---|---|---|
| `POST` | `/api/pricing/quote` | Price a basket; **persists** the calculation to the audit ledger | `pricing.quote` |
| `POST` | `/api/pricing/simulate` | Same pipeline, **persists nothing** — for what-if scenarios | `pricing.simulate` |
| `GET` | `/api/pricing/calculations/:id` | Replay a stored calculation with its full breakdown | `pricing.audit.read` |
| `GET` | `/api/pricing/coverage` | Data coverage register for all 11 components | `pricing.audit.read` |

Default login after `yarn mercato init`: `superadmin@acme.com` / `secret`
(override with `OM_INIT_SUPERADMIN_EMAIL` / `OM_INIT_SUPERADMIN_PASSWORD`).

## Layout

```
packages/pricing-engine/   the module (src/, migrations, tests, package manifest, build config)
docs/SPEC.md               design spec
URUCHOMIENIE.md            Polish setup runbook
LICENSE                    MIT
```

`packages/pricing-engine/README.md` and `AGENTS.md` are verbatim copies from the monorepo and link to
`.ai/specs/2026-09-18-pricing-engine-module.md`; in this repository that document is `docs/SPEC.md`.
