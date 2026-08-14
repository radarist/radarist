---
name: premortem-analysis
description: Use before committing to a strategy, recommendation, roadmap, or investment — "should we invest in X?", "is this the right strategy?", "what could go wrong?", "before we commit to this plan…". Kahneman's premortem — assume it failed 12 months out, work backwards to failure modes, likelihoods, and mitigations. For choosing between rival explanations use `analysis-of-competing-hypotheses` instead.
---

# Premortem Analysis

Before committing — imagine it failed. Work backwards.

## When to invoke

Trigger on phrases like "should we do X?", "is this the right bet?", "what could go wrong?", "before we commit to Y…", "risks with this approach?", "postmortem-in-advance", "stress-test this plan", "is this plan robust?".

Particularly valuable before:

- The Strategist emits a recommendation
- The Creator publishes a headline claim in a report
- A user commits to a roadmap or investment

Skip for:

- Recommendations with confidence < 0.5 — they haven't earned a premortem yet; run `abstain-or-escalate` instead
- Purely tactical/reversible decisions (the cost of thinking > cost of undoing)
- Decisions already made — use `postmortem` (retrospective), not premortem

## The core question

> _"Imagine it's {date + 12 months}. The decision we're about to make has failed — decisively. Work backwards from that failure. What happened? Why?"_

The technique forces people past optimism bias by treating failure as given, not speculative.

## The five failure domains

Every premortem must cover these five domains. For each: identify 1–3 failure modes, rate **likelihood** (low/med/high), rate **severity** (low/med/high), and propose **one pre-emptive mitigation**.

| Domain                    | Typical failure modes                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **1. Technical**          | Core tech doesn't work at scale; latency / cost / accuracy regressions; dependency rot; architecture mismatch |
| **2. Market**             | Demand wasn't there; timing wrong; competitor beat us to it; buyer persona shifted                            |
| **3. Execution**          | Team too small; wrong skills; internal politics; missed milestones; founder burnout                           |
| **4. Regulatory / legal** | Law changed; prior commitment conflicts; antitrust; IP challenge; compliance failure                          |
| **5. External shock**     | Macro downturn; key partner collapse; platform risk (rule change by upstream vendor); geopolitical event      |

A premortem without at least one failure mode from each domain is incomplete.

## Procedure

### 1 — Fix the decision

State the decision in one sentence. "We will ship X by Y to achieve Z."

If the decision is ambiguous, pause the premortem and run `decompose-research-question` first.

### 2 — Imagine the failure

In present tense, write a 2–3 sentence vignette of what failure looks like:

> _"It's 2027-04. We shipped X in Q3 2026 but never hit the revenue milestone Z. We're reviewing whether to kill the product."_

The vignette is a commitment device — it forces the rest of the analysis into concrete terms.

### 3 — Enumerate failure modes per domain

Walk the five domains. For each, write 1–3 specific failure modes. Be concrete — "team is bad" is not a failure mode; "senior eng leaves in month 4 and the model-training pipeline goes dark" is.

### 4 — Rate likelihood × severity

| Mode | Likelihood | Severity  | Risk score                     |
| ---- | ---------- | --------- | ------------------------------ |
| ...  | L / M / H  | L / M / H | L×S (0–9 scale: L=1, M=2, H=3) |

Sort by risk score. The top 3 by score are the ones that demand mitigation design.

### 5 — Design pre-emptive mitigations

For each top-3 risk, propose ONE mitigation that:

- Is actionable before launch (not a post-launch response plan)
- Is testable (you can verify the mitigation is in place)
- Is cheaper than the expected loss

Example: if the top risk is "DPR on proprietary model is contaminated" (likelihood M, severity H, score 6), the mitigation is "evaluate on held-out variant before the launch decision." That's actionable, testable, cheap.

### 6 — Assign a "kill threshold"

A premortem without a kill threshold is decoration. Specify: **"We kill this if … by …"**.

Examples:

- "We kill this product if we haven't signed 3 paying pilots by end of Q2."
- "We abandon the acquisition if the antitrust review extends past 18 months."

The kill threshold makes failure visible early rather than late.

### 7 — Emit the structured output

```
## Premortem — {decision}

**Decision:** {one-sentence decision statement}

**Failure vignette:** {2-3 sentence present-tense story of failure, dated}

**Failure modes by domain:**

| # | Domain | Mode | Likelihood | Severity | Risk score | Mitigation |
|---|---|---|---|---|---|---|
| 1 | Technical | {concrete mode} | L/M/H | L/M/H | N | {actionable mitigation} |
| 2 | Market | ... | ... | ... | ... | ... |
| ... | ... | ... | ... | ... | ... | ... |

**Top 3 risks (by risk score):**
1. {mode} — mitigation: {X}
2. {mode} — mitigation: {Y}
3. {mode} — mitigation: {Z}

**Kill threshold:** We kill/abandon/pivot this if {condition} by {date}.

**Confidence in this premortem:** {0.0-1.0} — depends on how well the failure modes match known domain history.
```

### 8 — Pair downstream

- Feed the top-3 risks into the project plan as explicit pre-launch checkpoints.
- Feed the kill threshold into the Strategist's roadmap as a decision gate.
- If any mitigation is infeasible, **abstain** from the recommendation via `abstain-or-escalate`.

## Anti-patterns

- Do **not** run premortem without a specific decision. "What are the risks of AI?" is not a decision; "Should we ship Claude-powered auto-complete by Q3?" is.
- Do **not** skip any of the 5 domains. The domain you skip is the one that kills you (survivor bias in mitigation design).
- Do **not** write vague failure modes. "Execution is hard" is not a premortem — "the only eng who understands the RAG pipeline leaves in month 5 and docs are insufficient for handoff" is.
- Do **not** propose mitigations that are just restatements of the risk. "Mitigation for 'we don't have enough engineers' is 'hire more engineers'" — that's not a mitigation, it's the same problem.
- Do **not** stop at failure enumeration — the kill threshold is what makes the premortem actionable.

## Reference

- D. Kahneman, _Thinking, Fast and Slow_, Farrar, Straus and Giroux, 2011, Ch. 22 — on prospective hindsight and overcoming optimism bias.
- G. Klein, "Performing a Project Premortem," _Harvard Business Review_, Sept. 2007.
- P. Schoemaker, _Profiting from Uncertainty_, Free Press, 2002 — scenario-based risk assessment.
- Pairs with `analysis-of-competing-hypotheses` (ACH picks the winning hypothesis → premortem stress-tests it), `scenario-planning` (branching futures for the winning plan), `red-team-claim` (adversarial check on the report's final claim), and `abstain-or-escalate` (if mitigation infeasible).

## Radarist binding

The best predictor of how a plan fails here is how similar plans failed here:

- `getSignalFeedbackPatterns` — the recorded human rejection history, an empirical base rate.
- `getClaimHealth` / `findDataGaps` — weakly-supported claims are the likeliest failure seeds.
- `getEntityTimeline` — has this bet already stalled once?

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
