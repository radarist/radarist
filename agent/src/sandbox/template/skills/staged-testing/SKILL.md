---
name: staged-testing
description: Phase 07 of every build mission — the self-evaluation pass. Run the test pyramid, then drive the REAL app with Playwright through every phase-02 flow, take full-page screenshots, and visually inspect each one against the design system. Passing tests are not proof for visual work; rendering is. Load when every non-cuttable story is done.
---

# Staged testing — prove it runs, then look at it

Write `docs/07-test-report.md` and fill `.impulse/screenshots/`.

## 1. Pyramid sweep

- Run **all** unit and integration tests (not just per-story checks):
  the full runner (`npx vitest run` or equivalent) must exit 0.
- Run **every** command in `.impulse/checks.json` from the workspace root;
  record per-check pass/fail in the report table.

## 2. Flow drive (Playwright against the live app)

For each flow `F<n>` in `docs/02-user-flows.md`:

1. Start the dev server (`0.0.0.0:3000`), wait for ready.
2. Drive the flow's numbered steps with Playwright.
3. Assert the flow's **Success signal**.
4. Capture a **full-page screenshot** at the flow's end state to
   `.impulse/screenshots/F<n>.png` (plus mid-flow shots where a step's
   "sees" is non-obvious).
5. Capture the browser console: any error-level message during a flow is a
   defect — record it.

## 3. Visual inspection (mandatory, not optional)

**Read each screenshot file and look at it full-size.** For each, compare
against `docs/03-design-system.md`:

- Colors on screen ∈ the palette table? (Spot-check real pixels, not your
  memory of the code.)
- Typography scale respected? Spacing consistent with the scale?
- Empty/error states match the edge flows — visible, actionable, on-theme?
- Would a stranger call this coherent with the named theme?
- **Distinctiveness (be honest):** does it look like a deliberate, branded
  product — or like a generic AI-generated app (purple/blue gradients,
  rounded-2xl white cards on gray, gradient hero, emoji icons, one font
  size)? If generic, that is a defect to FIX now, not ship — phase 08 QA
  will fail it as a `major` finding otherwise. Push it toward the named
  personality in `docs/03-design-system.md`.

Record a per-screenshot verdict (`matches | generic — fixing: … | discrepancies: …`)
in the report. Fix what you find, re-shoot, and keep the old verdict in the
report as history — the QA reviewer checks that this pass actually looked
AND judged distinctiveness.

## 4. The report

`docs/07-test-report.md`: results table (suite → pass/fail), checks table
(check id → pass/fail), flow table (flow → signal asserted? → screenshot →
visual verdict), console findings, fixes applied during this phase.

## Definition of Done

- Full test run exits 0; every checks.json command green; every flow driven
  with its success signal asserted; every flow has a screenshot **and** a
  recorded visual verdict; console clean or findings fixed.
- Committed as `test(07): self-test report`; STATUS `readyForQa: true`,
  phase → `08-qa`.
