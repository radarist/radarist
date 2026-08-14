---
name: staged-build
description: Phase 06 of every build mission — implementation discipline. Walking skeleton first, exactly one story in flight, one commit per story, tests written with the story not after it. Load this when phase 05's ADR is committed and re-read it whenever you notice yourself working on two things at once.
---

# Staged build — skeleton first, one story at a time

## Order of work

1. **Scaffold** per the ADR. First commit: `chore(scaffold): <stack>` — the
   app boots, serves on `0.0.0.0:3000`, imports the design tokens, renders a
   shell page. Nothing else. The scaffold includes a `.gitignore`
   (`node_modules/`, `dist/`, `test-results/`, `playwright-report/`) and
   keeps the unit and e2e runners separated (e.g. vitest
   `exclude: ['tests/e2e/**']`) so the full unit run stays meaningful —
   "Done means" requires the whole suite to exit 0.
2. **Walking skeleton = S1.** Ugly but end-to-end: every layer touched,
   deployable, S1's checks green.
3. **Remaining stories in the phase-04 order.** Per story:
   - Set the story `in-progress` in `.impulse/STATUS.json`.
   - Write the test(s) its `Check:` commands name **with** the
     implementation, not after the story "works".
   - Run the story's checks yourself (`.impulse/checks.json` has the
     commands). Green → mark `done`, commit `feat(S<n>): <title>`.
   - The PostToolUse hook re-runs affected checks on every edit; a hook
     failure is feedback, not noise — fix before moving on.

## Hard rules

- **One story in flight.** If story S3 reveals a problem in S2, finish or
  honestly revert the S3 work, fix S2 (its checks must pass again), then
  resume.
- **Never weaken a check to make it pass.** Editing a `Check:` command or
  test assertion requires a dated justification appended to STATUS `notes`.
  Deleting a failing test is a QA finding waiting to happen.
- **Use the design tokens.** Hardcoded colors/sizes that bypass
  `docs/03-design-system.md` tokens are defects, not shortcuts.
- **Code and artifacts must not drift.** When implementation legitimately
  deviates from the ADR or design system (different chart form, changed
  port, swapped library), update the document in the same commit with one
  line of why — the QA reviewer reads the docs as contracts, and
  undocumented deviation is a finding even when the code is better.
- **Honest empty/error states** per the edge flows in phase 02 — every list
  has an empty state with an action, every failure path shows the user
  something.
- **Tests must own their server.** The e2e runner's webServer config must
  start and own the app under test (`reuseExistingServer: false`, or an
  explicit guard asserting the served app's identity) — a suite that
  silently connects to whatever already squats on the port is a suite that
  can pass or fail against the wrong application.
- **Commit hygiene:** working tree clean at every story boundary; commits
  follow the message convention so the git log reads as the build narrative.

## When stuck (same failure twice)

Stop repeating the fix. Write the failure into STATUS `notes`, state your
new hypothesis, and try a _different_ approach — the supervisor escalates
sessions that loop on an identical failing-check output, and a third
identical failure pauses the mission for a human. Make your second attempt
genuinely different.
