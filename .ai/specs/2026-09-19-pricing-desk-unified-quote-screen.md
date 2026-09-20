# SPEC — Biurko wyceny: jeden ekran „dodaj, dodaj, liczymy, lecimy”

**Status:** Implemented (2026-09-19)
**Owner module:** `@open-mercato/pricing-engine` (`backend/pricing/calculator`) + additive links from `apps/mercato/src/modules/distributor_workspace`
**Companion specs:** `2026-09-18-distributor-margin-workspace.md` (Deliverable C — margin panel, calculator, advisor), `2026-09-18-pricing-engine-module.md`

---

## TLDR

The distributor priced a basket on four screens that did not talk to each other: the margin
calculator (basket → margin, one `LookupSelect` card list per line, a "Calculate" button), the
advisor (one product → suggestions, its own form), the playground (raw ids) and the price
comparison (an existing WZ → offer ladder). Predicted orders could "price a basket" but the result
was a two-line readout with no way to work on it. Every path needed the operator to re-type the
same basket.

This spec folds the calculator and the advisor into **one screen at the calculator's URL**,
`/backend/pricing/calculator`, that prices on every change and ends in a sales document. Every
existing route, API and injection stays where it was; the other screens gain a one-click link into
the desk carrying their basket.

## Owner instruction (2026-09-19)

> analiza wszystkich ekranów, połączenie ich i poprawienie dla dostawcy żeby to było ładniejsze;
> wszystkie połączenia muszą zostać jak były, ale musi to być łatwiejsze i ciekawsze, bo teraz dużo
> klikania a powinno być dodaj to, dodaj to i liczymy i lecimy

Read as: keep every API, route and widget contract; remove clicks; make the screen answer as you
type; let the flow end in a document.

## What changed

### 1. The desk (`backend/pricing/calculator/`)

| Was | Is |
|---|---|
| A customer `LookupSelect`, two selects, N basket rows each with its own card-list lookup, a "Calculate" button, results below | One context bar (customer picker, channel as one row of wrapping toggle buttons, zone only when zones exist), **one product search box** — type, `Enter`, the line is in; the box stays focused for the next product |
| Calculation only on click | **Auto-price** 350 ms after any change (`/api/pricing/simulate`), advice in parallel (`/api/pricing/advise` on the whole basket). Stale responses are dropped by sequence number |
| Per-line floor in a separate table | Floor, unit price, unit cost, margin and line total **inline in the basket table**; the margin cell is coloured against the engine's own target and guardrail |
| Advisor on its own page, single product | **"Jak dać lepszą cenę"** strip: compact suggestion cards with an **Apply** button that edits the basket (quantity, product swap, channel switch) and re-prices; "Details" opens the full `SuggestionCard` with the objective breakdown |
| Volume sensitivity table on the advisor | **Quantity ladder chips** for the selected line (from `volumeSensitivity`): click a rung to set that quantity |
| Waterfall + assumptions for a dropdown-selected line | Click a basket row → **"Jak powstała cena"** for that line (same `PriceWaterfall` + `MarginAssumptions`) |
| No exit | **"Lecimy"**: *Zapisz jako ofertę* (`POST /api/sales/quotes`) or *Od razu zamówienie* (`POST /api/sales/orders`), engine unit prices on the lines, then navigate to the document. Writes go through `useGuardedMutation` |
| No entry | **URL state** `?customerId=&scenario=&zone=&lines=<productId>:<qty>,…` — every other screen links in with its basket; *Kopiuj link* shares the desk state. With a customer chosen: **"Wczytaj ostatnie zamówienie"** (last 5 orders of that customer via `/api/sales/orders?customerId=` + `/api/sales/order-lines?orderId=`) |

Pure helpers (URL parse/build, suggestion application, target/floor derivation from the
breakdown, floor merge) live in `lib/frontend/basketDesk.ts` and are unit-tested in
`__tests__/basketDesk.test.ts`.

### 2. Links into the desk (additive, nothing removed)

| From | Link | Carries |
|---|---|---|
| Predicted orders — each delivery card (`distributor_workspace/backend/predicted-orders`) | *Wyceń w kalkulatorze* | customer + predicted lines |
| Company → "Przewidywane zamówienia" tab (`customer-order-forecast` widget) | *Wyceń w kalkulatorze* on each basket | customer + predicted lines |
| Company → "Warunki cenowe" tab (`customer-pricing-tab` widget) | *Wyceń koszyk dla tego klienta* | customer |
| Order / quote → "Marża" tab (`document-margin-tab` widget) | *Przelicz w kalkulatorze* | customer + the document's product lines |
| Price comparison (`distributor_workspace/backend/pricing/comparison`) | *Otwórz ten koszyk w kalkulatorze* | customer + WZ lines at the selected multiplier |
| Advisor page (kept at its URL) | banner *Te podpowiedzi pojawiają się teraz w kalkulatorze wyceny…* with *Otwórz kalkulator wyceny* | product + quantity + customer + channel |

The comparison API gains two optional response fields: `order.customerEntityId` and
`lines[].productId`. Both additive (`BACKWARD_COMPATIBILITY.md` §7).

### 3. Navigation

`/backend/pricing/advisor` joins `distributorNavHiddenPages` in `apps/mercato/src/modules.ts`
(mirrored in the create-app template): the page still renders at its URL and from the banner
link, but the sidebar shows one pricing entry point instead of two that overlap. The "Wycena"
group is now: calculator, deadstock.

## Not changed

- `/api/pricing/simulate`, `/api/pricing/advise`, `/api/pricing/quote` — request and response
  contracts untouched.
- `DocumentMarginPanel`, `MarginSummary`, `SuggestionCard`, `PriceWaterfall`, `MarginAssumptions`
  — reused, not forked.
- WZ prices are never rewritten (see the comparison spec); the desk only reads them into a
  what-if basket.
- The pricing ledger: the desk simulates (`persist: false`); a record is written only when the
  operator saves a quote or an order, by the sales module.

## Tenant data prerequisite found while verifying

`POST /api/sales/quotes` and `/api/sales/orders` assert every line's quantity unit against the
tenant's `unit` dictionary (`sales/commands/documents.ts` → `assertUnitExists`). The Skalo Hurt
tenant, created by an import script rather than `yarn initialize`, had no `unit` dictionary at
all, so every document creation — the desk's, and the forecast tab's "Create draft order" — failed
with `uom.unit_not_found`. Fixed as data, not code: the demo tenant's 41 default units were
mirrored into a `unit` dictionary for Skalo Hurt plus the Polish units the imported lines and
products actually carry (`szt` as default, `szt.`, `sztuki`, `kpl`, `op`, `kart`). Running
`mercato seed:defaults --module catalog` was rejected for this because catalog's `seedDefaults`
also seeds example products and rewrites price kinds on every organization.

## Integration coverage

- Unit: `packages/pricing-engine/src/modules/pricing_engine/__tests__/basketDesk.test.ts` (URL
  round-trip, suggestion application per kind, target/floor derivation, floor merge).
- Existing: `documentMarginTab.test.tsx`, `customerPricingTab.test.tsx`, `navigationGroups.test.ts`
  keep passing.
- Manual QA path (verified live on the Skalo Hurt tenant): open the desk, add two products by
  typing, change channel, apply a suggestion, open a line, save as quote, land on the quote.

## Changelog

- 2026-09-19 — Implemented: desk screen, links from five screens, advisor hidden from the sidebar.
- 2026-09-19 — Owner rule: a "cheaper equivalent" priced below half of the current line is a freebie, not a substitute; the advisor no longer emits it (`lib/advisor/suggestions/cheaperEquivalent.ts`, `MIN_EQUIVALENT_PRICE_SHARE`).
