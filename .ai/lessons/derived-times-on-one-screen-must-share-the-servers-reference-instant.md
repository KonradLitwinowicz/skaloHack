---
title: "Derived times on one screen must share the server's reference instant, not the browser clock"
modules: ["ui","pricing_engine"]
areas: ["backend-ui","testing"]
topics: ["ui-components","data-integrity"]
---

# Derived times on one screen must share the server's reference instant, not the browser clock

**Context**: Two widgets built the same week computed "how many days until X" from `new Date()` while every other figure beside them — the counts, the classifications, the costs, the ordering — had been computed server-side at a single instant carried in the payload (`lastUpdatedAt`, `asOf`, `generatedAt`).

**Problem**: one badge tick on its own clock next to numbers frozen at another moment. With a freshly loaded page the two agree and the defect is invisible. They stop agreeing when the screen is left open across a shift, when the workstation clock is skewed, or simply when the payload is a few hours old: `termin za 2 dni` sits beside data computed eight hours earlier, and nothing on screen reveals the mismatch. The same lot can also change its day count purely because the page was opened in the evening rather than the morning, with no change in the data at all.

**Rule**: derive every relative time from the reference instant the payload carries, and pass it explicitly. Fall back to the wall clock only when the payload's instant is missing or unparseable, and treat that as a degraded path, not the default. Compare whole UTC days (`startOfUtcDay`, or floor both sides to day boundaries) so the hour of day cannot move the number.

This also makes the behaviour reproducible: a function taking `(deadline, referenceInstant)` can be tested at a boundary, while one reading `new Date()` internally cannot be tested there at all — see [[logic-that-cannot-be-imported-has-no-test-coverage]].

**Test that catches it**: pass one deadline with two different reference instants and assert the verdict changes. A test that only checks the happy value will pass whether or not the parameter is honoured — the version that ignored its argument entirely was green.

**Adjacent failure, same family**: the window itself must come from one place and be compared with one operator. A closed interval in the WMS screens and a half-open one in a dashboard route gave two different counts for a lot expiring exactly at the boundary midnight; importing the shared constant was not enough, because it was the comparison that differed, not the number.
