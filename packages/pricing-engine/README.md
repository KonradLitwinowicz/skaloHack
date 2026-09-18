# @open-mercato/pricing-engine

Cost-to-serve pricing engine for B2B distribution.

It prices a basket from an ordered pipeline of cost and margin components — purchase cost, process
labour, packaging, warehouse occupancy, logistics, product aspects, customer behaviour, volume, target
markup, guardrails, rounding — and stores every calculation with its inputs, the parameter versions
used, and a one-sentence explanation per component that a sales representative can read to a customer.

Default runtime mode is `shadow`: the engine computes and records, and invoiced prices are unchanged.

- Spec: [`.ai/specs/2026-09-18-pricing-engine-module.md`](../../.ai/specs/2026-09-18-pricing-engine-module.md)
- Agent guide: [`AGENTS.md`](./AGENTS.md)

## Screens

| URL | Purpose | Feature |
|---|---|---|
| `/backend/pricing/playground` | Price a basket and inspect the component waterfall | `pricing.quote` |
| `/backend/pricing/coverage` | What each component's data actually rests on, and what is assumed | `pricing.audit.read` |

## API

| Method | Path | Feature |
|---|---|---|
| `POST` | `/api/pricing/quote` | `pricing.quote` |
| `POST` | `/api/pricing/simulate` (persists nothing) | `pricing.simulate` |
| `GET` | `/api/pricing/calculations/:id` | `pricing.audit.read` |
| `GET` | `/api/pricing/coverage` | `pricing.audit.read` |

## Enabling

Add the module **after** `sales` in your app's `src/modules.ts`:

```ts
{ id: 'sales', from: '@open-mercato/core' },
{ id: 'pricing_engine', from: '@open-mercato/pricing-engine' },
```

Then `yarn generate`, `yarn db:generate`, apply the migration, and `yarn mercato auth sync-role-acls`.
