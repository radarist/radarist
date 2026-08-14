---
name: cheapest-experiment
description: Use when a brief contains recommendations or a next-steps section — "what should we invest in?", "should we pilot X?", "should we acquire Y?". Forces every recommendation to name the smallest validating test, its cost and duration, and an explicit pass/fail decision rule.
---

# Cheapest Experiment

One recommendation, one smallest test, one cost-and-duration line, one decision rule with named pass/fail thresholds, one "what we'd learn" sentence.

## When to invoke

Trigger on phrases like "recommend", "should we …?", "next steps", "actions to take", "investment options", "pilot proposals", "buy or build", "go/no-go", "MVP", "validate", "learn whether …".

Particularly valuable when:

- A creator is writing a recommendations or "actionable next steps" section
- A strategist is presenting an investment thesis to a decision-maker
- A premortem has surfaced failure modes and the next pass needs validating tests
- A foresight prediction has high uncertainty (confidence < 0.7) — the cheapest experiment reduces the uncertainty before the bigger commitment

Skip for:

- Pure descriptive briefs (current-state snapshots, ecosystem maps with no recommendations)
- Recommendations that are themselves experiments — don't recurse the framework on its own output
- Decisions with no reversibility — when the only path is full commitment, framing it as an experiment is dishonest

## The method in five steps

### 1 — State the recommendation in one sentence

Subject + verb + object + scope. No preamble.

- Good: `Pilot Eightfold AI Talent Insights for engineering reqs in EMEA Q3 2026.`
- Good: `Acquire Harver before Q4 2026.`
- Bad: `We should consider exploring potential AI tools for our talent strategy.` — five hedge words and no verb-led commitment.

If you can't write the recommendation in one sentence, the brief isn't ready for an experiment design — clarify the bet first.

### 2 — Name the smallest test that would validate the recommendation

Smallest = the test whose negative result would change the decision. Not the smallest test technically possible — the smallest test that _resolves the uncertainty_. If you can run a 50-req pilot for $80k that tells you whether to commit $5M, that's the right test. If the cheapest version of the test wouldn't change your mind regardless of outcome, it's theatre.

The test must be:

- **Bounded in scope** — N reqs, N customers, N regions, N weeks
- **Operationally executable today** — no "after we hire a Director of AI" preconditions
- **Independent of the full commitment** — failing the test costs only the test, not the full bet

- Good: `8-week pilot on 50 engineering reqs in one EMEA office, agent stops at offer-letter generation (no autonomous offer extension).`
- Bad: `Run a thorough internal evaluation.` — no scope, no timebox, no operational mechanism.
- Bad: `Deploy globally for one quarter.` — that's the bet, not the test.

### 3 — State cost and duration explicitly

Both numbers, with units.

- Cost: dollar range (low end - high end), all-in (vendor fees + internal time + opportunity cost)
- Duration: weeks or months from kickoff to the decision moment

- Good: `Cost: $80k-$120k all-in. Duration: 10 weeks (8 weeks pilot + 2 weeks readout).`
- Bad: `Cost: TBD. Duration: a few months.` — drop the recommendation rather than ship this. Without numbers, the reader can't compare this experiment against the next one.

If you genuinely don't know the cost, write a 2-week scoping spike as the smallest test, not the pilot.

### 4 — Write the decision rule with named pass/fail thresholds

Both directions, both with metrics.

```
Decision rule: pass if <metric> <comparator> <threshold> AND <metric> <comparator> <threshold>; fail if either misses.
```

- Good: `Decision rule: pass if cost-per-hire down ≥20% AND interviewer satisfaction ≥3.5/5 AND zero EEOC findings on bias audit; fail if any miss.`
- Good: `Decision rule: pass if pipeline-conversion improves ≥15% over 8 weeks; fail if conversion is unchanged or worse.`
- Bad: `Decision rule: pass if it works.` — undefined. The decision rule is the antidote to escalation; without explicit thresholds, the reader will rationalize whatever happened as "working."

Note: pass thresholds should be the lower bound of the conviction case, not the stretch goal. If a 15% improvement would change your mind, write 15% — not 25%.

### 5 — One sentence on what we would learn

The asymmetry between "test passes" and "test fails" is what makes the experiment worth running. State it.

- Good: `What we'd learn: whether agentic narrows the funnel correctly (pass → roll out to 10 offices) or widens it pathologically (fail → exit, save $4M committed budget).`
- Good: `What we'd learn: whether Harver's assessment IP transfers to engineering reqs (pass → acquisition rationale holds) or only to volume hiring (fail → reset thesis to volume-only).`
- Bad: `What we'd learn: whether it's a good idea.` — circular.

If both branches lead to the same next action, the experiment isn't worth running — pick a different test.

## Output format (mandatory)

When invoked in a report or analysis, emit one fenced block per recommendation, labelled `experiment`:

```experiment
Recommendation: <subject + verb + object + scope, one sentence>

Smallest test: <bounded scope, operationally executable today>
Cost: $<low>-$<high> all-in. Duration: <weeks/months from kickoff to decision>.
Decision rule: pass if <metric> <comparator> <threshold> [AND/OR additional]; fail if <inverse>.
What we would learn: <one sentence with the asymmetry between pass and fail outcomes>
```

This block is machine-parseable. The L1 quality gate (`mission-quality.ts:SKILL_PROCEDURE_MARKERS`) detects two markers — `Smallest test:` line and `Decision rule:` block with `pass if` / `fail if` — and counts the experiment design as the `cheapest-experiment` skill-procedure marker.

## Anti-patterns to refuse

- **Vague pilots without scope** — "run a pilot" is not an experiment design; "run a pilot on 50 reqs in one EMEA office for 8 weeks" is.
- **Pass/fail rules without thresholds** — "pass if it works" is escalation in disguise.
- **Symmetric outcomes** — if the experiment's pass and fail branches lead to the same next action, the experiment isn't worth running. Pick a test where the outcomes diverge.
- **Costs marked TBD** — when the numbers aren't known, the smallest test is a scoping spike, not the pilot itself.
- **Stretch-goal thresholds** — pass thresholds should be the _lower bound of conviction_, not the aspirational target. Setting an unreachable bar guarantees a "fail" verdict you won't honour.
- **Experiments designed to validate, never to falsify** — the test must be capable of changing the decision. If you can't describe the failure scenario plausibly, you're not designing an experiment.

## Working with other skills

- After `premortem-analysis` enumerates failure modes → run `cheapest-experiment` on each recommendation to give the reader the smallest test that would surface the failure mode early.
- Before `foresight` predicts when a milestone arrives → use `cheapest-experiment` to design the in-flight check that confirms the prediction is on track.
- Use with `red-team-claim` on the decision rule itself — would a hostile reviewer accept these thresholds, or call them rigged?
- Use with `triangulate-sources` on cost estimates — single-source pilot quotes can be off by 2-3×; cross-check with at least one comparable customer reference.
- Pair with `jtbd-framing` — the experiment validates whether the recommended technology actually serves the named job for the named segment, not just whether it ships.

## Confidence notes

The experiment block doesn't carry an explicit confidence on its own — the confidence belongs to the _cost estimate_ and the _expected outcome_. If the cost is sourced (vendor quote, prior pilot reference), confidence is high. If it's reasoned ("typical pilot in this category runs $80-120k"), confidence is medium. Mark the cost line with `(estimate)` when it's reasoned, not sourced.

## Radarist binding

Keep this skill at the altitude of _designing_ the test. Dispatching it is a separate,
human-gated decision — do not treat execution as part of the method.

**In scope for this skill:**

- `getArtifactFindings` — if a prior experiment already ran for this bet, read its result before proposing another. A test that has already been run is not the cheapest test. It mounts on `impulse-reports`, so only the **creator** profile can call it; from strategist or evaluator treat it as a handoff and rely on the two below.
- `searchInitiatives` / `getEntityTimeline` — has this bet been probed before, and what happened? Both are reachable from every profile.

**Explicitly NOT part of this skill:** `dispatchBuildMission`, `dispatchTechnologyEvaluation`
and `iterateBuildArtifact`. Those are paid orchestration — the server refuses the first call
and returns an exact `CONFIRM SPEND ...` phrase that the authenticated user must echo before
anything runs, and they mount only on the `impulse-reports` server that the creator profile
carries. That separation is a deliberate spend boundary, not a gap to route around.

**The correct ending** is a handoff, not a tool call: state the experiment, its cost, its
duration and its pass/fail rule, and say plainly that running it needs an explicit dispatch
the operator confirms. Naming the decision is the deliverable.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
