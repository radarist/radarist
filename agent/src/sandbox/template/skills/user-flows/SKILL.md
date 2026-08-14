---
name: user-flows
description: Phase 02 of every build mission — map the user flows BEFORE stories exist, because stories sliced without flows produce screens that don't connect. Each flow written here becomes a Playwright script in phase 07, so write flows you are willing to be tested against.
---

# User flows — the artifact phase 07 will hold you to

Write `docs/02-user-flows.md`.

## What to produce

- **Primary flows** (1–5): the paths that deliver the job statement. If you
  need more than 5, the scope is wrong — go cut something in inception.
- **Edge flows** (1–2): the most likely failure/empty paths (empty state on
  first load, invalid input, no results).

## Format per flow

```
### F1 — Add a patent to the watchlist
1. User lands on / (sees: empty-state card with "Add patent" action)
2. User clicks "Add patent" (sees: form with number + title fields)
3. User submits valid input (sees: row appears in table, toast confirms)
Success signal: table contains the new row after reload.
```

Rules:

- Every step names what the user **does** and what they **see** — both
  observable in a browser. "System validates input" is not a step; "user sees
  inline error under the field" is.
- Every flow ends with a **Success signal**: one observable fact a Playwright
  script can assert. No signal, no flow.
- Number flows `F1, F2, …` — stories in phase 04 and Playwright specs in
  phase 07 reference these IDs.
- Edge flows state what the user sees when things are absent or wrong —
  empty states must offer an action, errors must be visible, never silent.

## Definition of Done

- All primary flows cover the inception success criteria (check each
  criterion against a flow; orphaned criteria mean a missing flow).
- Every flow has numbered do/see steps and an assertable success signal.
- Committed as `docs(02): user flows`; STATUS phase → `03-design-system`.
