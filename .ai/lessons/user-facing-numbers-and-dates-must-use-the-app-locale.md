---
title: "User-facing numbers and dates must use the app locale, never navigator.language"
modules: ["ui","pricing_engine"]
areas: ["backend-ui","testing"]
topics: ["ui-components","testing"]
---

# User-facing numbers and dates must use the app locale, never navigator.language

**Context**: Two dashboard widgets built the same week — `distributor_workspace.dashboard.nextActions` and `pricing_engine.dashboard.deadstock` — independently reached for the browser locale to format money, dates and counts. One used a local `useBrowserLocale()` hook reading `navigator.language`; the other called `toLocaleString(undefined, …)`, which resolves to the same thing.

**Problem**: The operator chooses the interface language in the application; the browser's language is a different, unrelated setting. With the UI set to Polish and the browser installed as `en-US`, the widgets rendered `Sep 19, 2026 — PLN 520.94` and `83,794.76 PLN` beside neighbouring widgets writing `19 wrz 2026` and `83 794,76 PLN`.

The separators are the dangerous half. `PLN 7,466.10` reads to a Polish speaker as seven point four, not seven thousand four hundred — the number is not merely styled wrong, it is read wrong, and nothing on the screen signals that anything is off.

**Why tests never catch it**: both widgets had green unit tests. Assertions render with a fixed dictionary and compare label text, so a formatter that obeys the wrong locale produces output the test still matches. The defect only exists when the app locale and the browser locale disagree, which is exactly the combination a test environment does not reproduce. Both cases surfaced from looking at the running screen.

**Rule**: derive the locale from the i18n context — `useLocale()`, or `useOptionalLocale()` in components that may render outside an `I18nProvider` (galleries, tests). Pass it explicitly to every `Intl.NumberFormat` / `Intl.DateTimeFormat`. Never pass `undefined`, never read `navigator.language`, and give helper signatures a required locale parameter (`formatAmount(value, currencyCode, locale)`) so the wrong call cannot be written.

Use one locale source per card: a count formatted differently from the currency two centimetres away on the same row reads as two different kinds of number.

**Related trap, so nobody "fixes" it**: Polish CLDR does not group four-digit numbers. `2702,59` without a separator and `15 847,62` with one are one correct format, not two — grouping starts at five digits. Verify with `Intl.NumberFormat('pl-PL').format(...)` before reporting a grouping inconsistency as a defect.
