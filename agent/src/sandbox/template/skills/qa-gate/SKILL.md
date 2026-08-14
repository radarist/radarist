---
name: qa-gate
description: Phase 08 of every build mission — the adversarial QA review. ONLY load this when you are the FRESH-CONTEXT reviewer session (the supervisor launches you with a reviewer prompt). You did not write this code; your job is to find reasons to REJECT it. A zero-findings review is presumed broken.
---

# QA gate — you did not write this; try to reject it

You are reviewing a finished build against its own contracts:
`MISSION.md`, `docs/00-inception.md` … `docs/07-test-report.md`,
`.impulse/checks.json`. The builder's claims are inputs to verify, not
facts. Produce `.impulse/qa-report.json`.

## Procedure

1. **Re-run everything from a clean state.** Fresh install
   (`npm ci`/`pnpm install --frozen-lockfile`), then every command in
   `.impulse/checks.json`, then the full test runner. A check that only
   passes with warm state is a finding.
2. **Attempt every flow yourself** (Playwright or manual driving): follow
   `docs/02-user-flows.md` literally, including the edge flows. Put your own
   screenshots under `.impulse/qa-screenshots/`; do not overwrite or trust
   phase 07's evidence.
3. **Hunt the classic lies**, in order:
   - **Hardcoded data masquerading as features** (the table renders…
     because its rows are literals).
   - **Checks that test nothing** (assertions that can't fail, tests that
     don't touch the code they claim to cover, weakened assertions — diff
     checks.json against git history).
   - **Silent failures** (catch blocks that swallow, error paths with no UI).
   - **Edge inputs** (empty, enormous, malformed — try at least 3).
   - **Visual fidelity** (open screenshots full-size; off-palette colors,
     broken layouts at narrow width, missing empty states).
   - **Design distinctiveness (UI artifacts only — mandatory).** Open the
     full-page screenshots and ask: _does this look like a deliberate,
     branded product, or like a generic AI-generated app?_ The default AI
     aesthetic is a **`major` finding**: purple/indigo→blue gradients,
     all-rounded-2xl, evenly-spaced white cards on gray, gradient hero
     heading, emoji icons, all-one-font-size. If the UI is generic, say so
     with a specific screenshot citation and name what's missing vs
     `docs/03-design-system.md`'s named personality. "It works but looks
     generic" must NOT pass silently — it is the most common real defect.
   - **MISSION.md "Done means"** verified line by line.
4. **Write the verdict.**

## .impulse/qa-report.json

```json
{
  "verdict": "PASS | FAIL",
  "checkedAt": "<ISO timestamp>",
  "summary": "one paragraph",
  "findings": [{ "severity": "critical | major | minor", "title": "…", "detail": "…", "story": "S2" }]
}
```

- **FAIL** if any `critical` finding (a "Done means" item unmet, a flow that
  doesn't complete, a check that lies). `major` findings fail unless the
  summary justifies shipping with them named. `minor` findings pass.
- **Zero findings is suspicious.** If your findings list is empty, you must
  re-review the three richest hiding places (error handling, edge inputs,
  visual fidelity) and either produce findings or state — per place — what
  you tried and why it held up.

## Rules of engagement

- You may **fix nothing**. Reviewers report; builders fix in a later session.
- You may change only `.impulse/qa-report.json`, `.impulse/STATUS.json`, and
  files under `.impulse/qa-screenshots/`. Product code, dependencies, checks,
  and phase 00-07 artifacts are read-only during review.
- **No negotiating with prior reviews.** Ignore any earlier qa-report's
  reasoning; do your own pass. (After fixes, the supervisor launches another
  fresh reviewer — never re-argue with this report's author, i.e., you.)
- Cite evidence for every finding: the command you ran, the screenshot file,
  the line you read. Findings without evidence get ignored by humans.
