---
name: mission-methodology
description: MASTER skill for every build mission. Load this FIRST, before reading any code or writing any file — it defines the phase state machine, the STATUS.json contract, and the session protocol. Every other skill in this pack is invoked through the phase table below. Use even when the brief looks trivial; trivial briefs are where discipline is cheapest and skipping it is most tempting.
---

# Mission methodology — the phase state machine

You are executing a build mission defined in `MISSION.md`. You are not a code
generator; you are a disciplined product team of one. Work moves through
phases **in order**. Each phase ends by writing its artifact and committing it.

## Phase table

| Phase            | Skill to load               | Artifact (Definition of Done)                      | Commit message               |
| ---------------- | --------------------------- | -------------------------------------------------- | ---------------------------- |
| 00-inception     | `app-inception`             | `docs/00-inception.md`                             | `docs(00): inception`        |
| 01-brainstorm    | `brainstorm-with-objective` | `docs/01-brainstorm.md`                            | `docs(01): options analysis` |
| 02-user-flows    | `user-flows`                | `docs/02-user-flows.md`                            | `docs(02): user flows`       |
| 03-design-system | `design-system`             | `docs/03-design-system.md` + token file            | `docs(03): design system`    |
| 04-user-stories  | `user-stories`              | `docs/04-stories.md` + `.impulse/checks.json`      | `docs(04): stories + checks` |
| 05-architecture  | `simplest-path`             | `docs/05-adr.md`                                   | `docs(05): ADR`              |
| 06-build         | `staged-build`              | one commit per story, story checks green           | `feat(S<n>): <story title>`  |
| 07-self-test     | `staged-testing`            | `docs/07-test-report.md` + `.impulse/screenshots/` | `test(07): self-test report` |
| 08-qa            | `qa-gate`                   | `.impulse/qa-report.json` with verdict             | `chore(08): qa verdict`      |

## Hard rules

1. **No application code before the ADR is committed** (end of phase 05).
   Exploration is allowed only under `/workspace/spikes/` — spike code never
   migrates into the app tree by copy-paste without going through a story.
2. **One phase at a time, one story in flight at a time.** Never start phase
   N+1 while phase N's artifact is missing or uncommitted.
3. **Update `.impulse/STATUS.json` after every phase transition and every
   story status change.** Stale STATUS is a blocking defect: the supervisor
   and the stop gate read it, not your intentions.
4. **Iterate artifacts, not vibes.** If you discover mid-build that a story is
   wrong, go back: edit `docs/04-stories.md` and `.impulse/checks.json`,
   record why in STATUS `notes`, then resume building.
5. **Never weaken a Check command to make it pass.** Changing any `Check:` in
   `.impulse/checks.json` requires a justification line in STATUS `notes`.
6. **Phase 08 requires a fresh session.** If you completed phase 07 in this
   session, commit, write the handoff (`nextObjective: "run the qa-gate as
a fresh-context reviewer"`), and stop. Never review your own build in
   the same session — a reviewer who watched the build happen is not a
   reviewer.

## STATUS.json contract

Path: `.impulse/STATUS.json`. Schema (all fields required unless marked):

```json
{
  "phase": "00-inception | 01-brainstorm | 02-user-flows | 03-design-system | 04-user-stories | 05-architecture | 06-build | 07-self-test | 08-qa | done",
  "readyForQa": false,
  "stories": [
    { "id": "S1", "title": "Add patent to watchlist", "status": "todo | in-progress | done", "cuttable": false }
  ],
  "blocked": null,
  "handoff": { "reason": "session budget reached", "nextObjective": "implement S3, then run its checks" },
  "notes": []
}
```

- `stories` is empty until phase 04 completes; afterwards it mirrors
  `docs/04-stories.md` exactly.
- `readyForQa` flips to `true` only when every non-cuttable story is `done`
  and phase 07's report exists.
- `blocked` is a string only when you genuinely cannot proceed without a
  human decision; say precisely what decision is needed.
- `notes` is an append-only array of dated strings (scope changes, cut
  stories, check edits).
- After the QA verdict is PASS, set `phase` to `done`.

## QA verdict handling

When `.impulse/qa-report.json` exists, the verdict decides the transition
(commit the report first if a prior session left it uncommitted):

- **PASS** → set STATUS `phase: "done"`, commit, stop.
- **FAIL** → you are now the builder again. Reopen every story named by a
  `critical` or `major` finding (`status: "in-progress"`, finding summary
  appended to `notes`); fix `minor` findings too unless you record a
  reasoned decision not to. **Fix the defect class, not the instance**:
  before re-running phase 07, search the code for analogous occurrences of
  each finding (same pattern, sibling feature, parallel code path) — a
  reviewer who finds your fix didn't generalize will fail you again. Make
  the sweep verifiable: append to STATUS `notes` the search you ran per
  finding (e.g. a grep pattern → N hits, each fixed or justified) — an
  unrecorded sweep is presumed not to have happened. A fix
  must never trade the symptom for a silent failure (e.g. catching an
  error while success feedback still fires). Set `phase` back to
  `06-build`, fix, re-run the affected phase-07 steps (checks, flows,
  screenshots), update the test report — then rule 6 applies: stop, so a
  **fresh** session runs the re-review. Never edit or argue with the
  existing qa-report; the supervisor archives it before the fixer starts.

## Session protocol (you may be one of several bounded sessions)

**On session start:** read `MISSION.md`, `.impulse/STATUS.json`, and
`git log --oneline -15`. Resume from STATUS, not from scratch. If
`handoff.nextObjective` exists, that is your first task.

**Reconcile before new work:** if the working tree or git log contains work
beyond what STATUS records (a previous session ended badly), reconciliation
is your first task — run the relevant checks, set story statuses to the
truth, commit with honest per-story messages, update STATUS. Never redo
work that already exists, and never trust STATUS over the tree.

**On session end** (you are about to stop for any reason): commit all work,
update STATUS honestly — current phase, story statuses, and a `handoff` with
`reason` and a concrete `nextObjective`. The stop gate refuses a dirty
working tree, stale STATUS, or failing checks on stories marked `done`.

**If the stop gate blocks you:** your ONLY remaining actions are (1) commit
all work, (2) make STATUS honest including the handoff, (3) stop. Resuming
feature work after a blocked stop is a defect — the gate keeps blocking,
and you burn turns producing work the next session must reconcile.

## Degradation rule

When budget or time pressure is signalled (by the supervisor in your prompt,
or by repeated check failures), ship through the last completed non-cuttable
story and cut `cuttable: true` stories, recording each cut in `notes`. A
smaller working artifact beats a larger broken one, always.
