---
title: "Logic that cannot be imported has no test coverage, however many component tests exist"
modules: ["ui","pricing_engine"]
areas: ["testing","backend-ui"]
topics: ["testing","ui-components"]
---

# Logic that cannot be imported has no test coverage, however many component tests exist

**Context**: A deadstock row rendered an expiry badge whose window logic lived inline in the component and was never exported. The package had 572 green tests at the time. The badge printed `termin za -10 dni` for any lot already past its date, because `days <= EXPIRING_SOON_DAYS` is also true for negative numbers, and it computed the difference from raw timestamps, so the same lot showed a different number depending on the hour the page was opened.

**Problem**: neither defect was reachable by a test. Component tests render a tree and assert visible text, so they exercise the helper only through whatever inputs the fixture happens to produce — never the boundary, never the negative case, never the same instant at two times of day. The helper was invisible to the suite, and the suite's size said nothing about it.

**Evidence that this is about reachability, not diligence**: extracting the function to `lib/frontend/` and giving it an explicit reference instant made seven boundary tests writable immediately — the day at `EXPIRING_SOON_DAYS` caught, the day after not, a past-due lot returning a positive count under a different variant, and the same lot at `00:00:01` and `23:59:59` producing one answer. None of those could be expressed against the component.

**Rule**: any function that decides a value — a threshold comparison, a classification, a derived count, a remainder — belongs in an importable module, not inside the component that renders it. Components should receive decisions and lay them out. A useful smell: if a test would have to render a tree in order to check an inequality, the inequality is in the wrong place.

The counter-example in the same codebase: `resolveGapBreakdown` in the stock-gaps widget is exported, which is precisely why its containment edge cases (critical greater than total, total zero with a positive critical count) have direct tests while the badge's did not.

**Related**: prefer variants over signed numbers at boundaries. `{kind: 'pastDue', days: 10}` forces the caller to pick different wording; a bare `-10` invites it to print the number and produce a phrase that is a sentence in no language.
