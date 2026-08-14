---
name: app-inception
description: Phase 00 of every build mission — turn the brief into a one-page inception document before any other thinking happens. Use immediately after reading MISSION.md, even when the brief seems complete; briefs state solutions, inception recovers the job the user is hiring the artifact to do.
---

# App inception — recover the job before choosing a solution

Write `docs/00-inception.md`, one page maximum, with exactly these sections:

## 1. Objective (one sentence, measurable)

Restate the brief's objective in one sentence a stranger could verify. If the
brief's objective is not measurable, make it measurable and note the
interpretation you chose.

## 2. Users

Who touches this artifact, in 1–3 lines per user type. No personas theater —
role, context, what they know.

## 3. Job statement (JTBD, verb-led)

Format: _When [struggling moment], I want to [verb-led job], so I can
[outcome with metric]._

- The **struggling moment** is the situation that triggers reaching for this
  tool. If you cannot name one, the brief is solution-first — derive the
  moment from the objective and say you did so.
- Name the **non-consumption alternative**: what the user does today without
  this artifact (spreadsheet, email, nothing). The artifact competes with
  that, not with imaginary rivals.

## 4. Success criteria

2–4 observable statements that would make the mission a success. These must
be consistent with `MISSION.md`'s "Done means" section — copy those checks in
and add any the brief implies but doesn't state.

## 5. Constraints

Hard limits from the brief (out-of-scope list, stack constraints, data
sources) plus constraints you infer (e.g., "no backend available — local
persistence only"). Inferred constraints are marked _(inferred)_.

## 6. Demo narrative _(only if the artifact ships sample/demo data)_

A stranger given only the running app and its seed data must understand the
value in ~60 seconds. Coherent sample data is not decoration — it is what makes
the value obvious. Name, before building:

- **Domain & hero record.** One realistic domain (not a generic "items" list),
  opening on a single named **hero record** a stranger recognizes as real (e.g.
  "State of AI 2026", "Acme Q3 Pipeline") and richly linked to the rest of the
  data — so one screen tells a story, not a table of rows.
- **Seed & reset command.** An explicit, reversible command that loads the demo
  data (e.g. `npm run seed:demo`) and one that clears it. First run / production
  stays **empty** — demo data is strictly opt-in.
- **One screenshot screen.** The single route that best shows the value; name it
  so the README/demo can point at it.
- **No generic filler.** Never `foo`, `bar`, `baz`, `test123`, `lorem ipsum`,
  "Test User", or placeholder emails — realistic labels and copy only.

_(Scope note: this section owns the demo narrative — hero, coherent data,
screenshot screen, anti-generic. Positive copy/craft grading and the visual
gate live in the design-system / qa-gate / dataviz skills, not here.)_

## Definition of Done

- Sections 1–5 non-empty; §6 present whenever the artifact ships sample/demo
  data; total ≤ 1 page.
- Objective is measurable; job statement is verb-led and names the
  struggling moment and the non-consumption alternative.
- If demo data ships: §6 names a hero record, an explicit seed/reset command,
  and one screenshot screen, and uses realistic labels (no `foo/bar/test123`).
- Committed as `docs(00): inception`, and `.impulse/STATUS.json` phase
  advanced to `01-brainstorm`.
