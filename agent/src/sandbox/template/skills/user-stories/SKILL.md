---
name: user-stories
description: Phase 04 of every build mission — slice the chosen approach into stories whose acceptance criteria each carry a RUNNABLE Check command, and emit .impulse/checks.json. This is the load-bearing wall of the whole mission: the supervisor, the hooks, and the QA reviewer all verify you through these checks, never through your self-report.
---

# User stories — every criterion gets a runnable check

Write `docs/04-stories.md` **and** `.impulse/checks.json`, then mirror the
story list into `.impulse/STATUS.json`.

## Story format

```
### S1 — Add a patent to the watchlist   (flow: F1, cuttable: no)
As an analyst, I want to add a patent by number and title, so the watchlist
reflects what I'm tracking.

Acceptance criteria:
- AC1: Given an empty watchlist, when I submit number+title, then a row appears.
  Check: npx playwright test tests/e2e/s1-add.spec.ts
- AC2: Given invalid input (empty number), when I submit, then an inline error
  shows and nothing is persisted.
  Check: npx vitest run tests/unit/validate.test.ts
```

Rules:

- Every story references the flow(s) it implements (`F1`…), is independently
  shippable, and is ordered into a **walking skeleton** sequence: story S1
  must touch every layer end-to-end, ugly but deployable.
- Every acceptance criterion carries a `Check:` line — a shell command with
  unambiguous exit-code pass/fail. Acceptable forms: a unit-test file, a
  Playwright spec, a `curl`+assert script, a small `node` script. "Manually
  verify…" is **forbidden**; if you cannot write the check, rewrite the
  criterion until you can.
- Mark stories `cuttable: yes` when the mission survives without them. At
  least the last 20% of stories should be cuttable — that is the budget
  degradation plan.

## .impulse/checks.json

```json
{
  "checks": [
    {
      "id": "S1-AC1",
      "story": "S1",
      "files": ["src/**", "tests/e2e/s1-add.spec.ts"],
      "command": "npx playwright test tests/e2e/s1-add.spec.ts",
      "description": "row appears after valid submit"
    }
  ]
}
```

- `files` are glob patterns: when an edit touches a matching path, the
  PostToolUse hook re-runs this check automatically. Scope globs honestly —
  `src/**` for integration-level checks, narrower for unit checks.
- Check commands must work from the workspace root with no env setup beyond
  what the ADR will install.
- The checks may not all pass yet (their test files don't exist until phase 06) — but each command must be _runnable_ (correct paths, real runner).

## Definition of Done

- Every story has ≥1 criterion; every criterion has a Check; checks.json is
  valid JSON listing every check; STATUS `stories` mirrors the doc.
- Walking-skeleton ordering is explicit; cuttable stories marked.
- Committed as `docs(04): stories + checks`; STATUS phase → `05-architecture`.
