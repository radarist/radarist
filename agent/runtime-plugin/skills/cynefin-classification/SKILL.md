---
name: cynefin-classification
description: Use at the start of a strategic brief that recommends action under uncertainty — "what should we do about X?", "how do we navigate this market?", "what's our move in {emerging area}?". Opens the brief with the decision domain (Clear / Complicated / Complex / Chaotic per Snowden) and its matching decision mode.
---

# Cynefin Classification

One sentence on the decision domain. One sentence on the matching decision mode. One implication line that tells the reader how to consume the rest of the brief.

## When to invoke

Trigger on phrases like "what should we do?", "how do we navigate {space}?", "is this a known-good pattern?", "should we copy what worked at {comparable}?", "best practices for {emerging area}".

Particularly valuable when:

- The brief addresses an emerging or fast-moving space (agentic AI, new regulation, novel business model)
- The reader is a decision-maker who otherwise treats the analysis as a definitive answer
- The downstream recommendations are actually probes (small bets) but get described in the language of best practices
- A prior premortem found "we treated this like a Complicated problem when it was Complex"

Skip for:

- Pure descriptive briefs (current-state snapshots, ecosystem maps with no recommended action)
- Decisions in well-understood Clear domains (a routine procurement of a commodity SaaS) — the classification is overkill
- Briefs where the prompt explicitly already names the domain ("we know this is a complex space; help us decide…")

## The four domains (Snowden's Cynefin)

| Domain                                | Causation                                         | Decision mode            | Right approach in a brief                                                                   |
| ------------------------------------- | ------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| **Clear** (formerly Obvious / Simple) | Cause and effect are obvious                      | sense-categorize-respond | Apply best practice, cite the playbook                                                      |
| **Complicated**                       | Cause and effect can be discovered with expertise | sense-analyze-respond    | Apply good practice, cite expert analysis, allow more than one valid solution               |
| **Complex**                           | Cause and effect are visible only in retrospect   | probe-sense-respond      | Run small experiments, surface emergent practice, treat each recommendation as a hypothesis |
| **Chaotic**                           | No useful cause-effect relationships              | act-sense-respond        | Stabilize first (any action that creates order), then reclassify                            |

Most emerging-tech briefs are **Complex** but get written in **Complicated** language. The whole point of this skill is to surface that mismatch.

## The method in three steps

### 1 — Classify the domain

Ask three diagnostic questions:

- **Are causes and effects predictable from priors?** Yes → Clear. No → next.
- **Can experts analyse and predict cause-effect with effort?** Yes → Complicated. No → next.
- **Will causation only be visible in hindsight?** Yes → Complex. No → next.
- **Is the situation acutely unstable, with no useful patterns?** Yes → Chaotic.

Write the classification in one bold line at the brief's open:

```
**Decision domain:** Complex (causation visible only in hindsight)
```

Don't hedge with "between Complicated and Complex" — pick one. If you really can't pick, that itself is a Complex signal.

### 2 — Name the matching decision mode

For each domain, the decision mode is named:

- Clear → **sense-categorize-respond** (recognise the pattern, apply the playbook)
- Complicated → **sense-analyze-respond** (gather data, run the analysis, decide)
- Complex → **probe-sense-respond** (run small experiments, observe what emerges, amplify what works)
- Chaotic → **act-sense-respond** (act decisively to stabilise, then reclassify)

Write it as a labelled phrase in the brief's framing:

```
The right mode here is probe-sense-respond, not sense-analyze-respond.
```

### 3 — One implication line for the reader

Tell the reader how to consume the rest of the brief.

- Complex example: `Implication: this brief outlines probes, not best-practice answers. Treat each recommendation as a hypothesis to falsify. Pair recommendations with cheapest-experiment design to derive learning, not commitments.`
- Complicated example: `Implication: this brief draws on expert-grade analysis and authoritative sources. The recommendations are good practices for this category — multiple options below are all defensible.`
- Clear example: `Implication: this is a known-pattern decision; the recommended path is the documented best practice with low novelty risk.`
- Chaotic example: `Implication: act first to stabilise. Once a workable pattern is established, this brief should be re-run as a Complex or Complicated analysis.`

## Output format (mandatory)

Emit the classification at the top of the brief (just below any executive summary), as three short lines:

```cynefin
**Decision domain:** <Clear|Complicated|Complex|Chaotic> (<one-line reason>)
**Decision mode:** <sense-categorize-respond|sense-analyze-respond|probe-sense-respond|act-sense-respond>
**Implication:** <one sentence telling the reader how to consume the rest of the brief>
```

This block is machine-parseable. The L1 quality gate (`mission-quality.ts:SKILL_PROCEDURE_MARKERS`) detects two markers — the `Decision domain:` line and the matching decision-mode language — and counts the classification as the `cynefin-classification` skill-procedure marker.

## Anti-patterns to refuse

- **Classifying as Complicated to flatter the analysis** — most agentic-AI / new-regulation / new-market briefs are Complex; defaulting to Complicated lets the brief sound expert without the honest uncertainty.
- **Hedge-classifications** — "between Complex and Complicated" is the same as no classification. Pick one. The act of picking exposes which decision mode the recommendations actually need.
- **Domain without decision mode** — naming the domain without naming the mode makes the classification decorative. The mode is what changes how the brief is read.
- **Complicated-mode language inside a Complex classification** — if the classification says Complex but the recommendations read "based on best practice" or "the proven approach," the classification is being ignored. Rewrite the recommendations as probes or change the classification.
- **Complex-mode probes without bounded scope** — Complex calls for probe-sense-respond, but a probe is still bounded (small, fast, safe-to-fail). Pair with `cheapest-experiment` to give probes the discipline they need.

## Working with other skills

- Run **before** `cheapest-experiment` for any recommendation — the domain classification tells you whether to design the experiment as a probe (Complex) or a pilot (Complicated) or a deployment (Clear).
- Pair with `premortem-analysis` — premortem assumes you've chosen a path; Cynefin asks whether the path is even the right kind of bet.
- Use with `foresight` on any prediction in a Complex domain — predictions in Complex domains decay faster than in Complicated, so pair with shorter review horizons.
- Use with `apply-hype-cycle` — Genesis-stage tech is almost always Complex; mature Plateau-of-Productivity tech is almost always Clear or Complicated.

## Confidence notes

The classification itself doesn't carry an explicit confidence — it's a categorical judgement. But its honesty has implications: a brief that classifies as Complex but recommends commitments without probes is internally inconsistent, and the reader should downgrade the brief's overall confidence accordingly. Note any inconsistencies in the brief's Limitations section.
