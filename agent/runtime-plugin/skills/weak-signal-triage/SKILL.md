---
name: weak-signal-triage
description: Use when a signal is sparse but potentially important — one source, an unknown actor, an anomaly that does not fit current models, "is this noise or early?", "too early to tell". Scores amplitude and potential impact as two separate axes so a genuine weak signal is not discarded for being sparse. For an already well-sourced signal use `evaluate-signal` instead.
---

# Weak Signal Triage

A weak signal is, by Ansoff's definition, an early and ambiguous indication of a potentially significant development — visible **before** its shape and impact are clear. Low source count is intrinsic to it, not evidence against it.

This matters because the ordinary trust rubric penalises exactly that. `evaluate-signal` scores corroboration on distinct source count (0–1 → lowest band), so a real weak signal and pure noise both land near the bottom and get discarded together. A radar that only surfaces well-corroborated items is a lagging indicator with extra steps.

## When to invoke

Invoke when a signal is **sparse but strange**:

- one source, or sources that all trace to a single origin;
- an actor nobody in the graph knows yet;
- a claim that does not fit the current model of the domain;
- something recurring at the fringe — a preprint cluster, a niche forum, a standards working group, a patent family with no product;
- the operator says "too early to tell" or "probably nothing, but…".

Skip when the signal is already well-sourced — run `evaluate-signal`. Skip when it is simply false — a debunked claim is not a weak signal; run `grounded-fact-check`.

## The two axes

Score these **independently**. Collapsing them into one number is the failure this skill exists to prevent.

**Axis A — amplitude (how loud is it?)** — sources, corroboration, actor prominence, publication reach. A weak signal scores LOW here by definition. Low amplitude is not a defect.

**Axis B — potential impact (if true, what breaks?)** — how much of the current model would have to change, how many graph entities are downstream, whether it touches an Adopt-ring technology or a live initiative.

|                    | Low potential impact                   | High potential impact                                |
| ------------------ | -------------------------------------- | ---------------------------------------------------- |
| **High amplitude** | Noise with reach — ignore, or log once | Known trend — hand to `evaluate-signal`              |
| **Low amplitude**  | Discard                                | **WEAK SIGNAL — the quadrant this skill exists for** |

Only the low-amplitude / high-impact quadrant is a weak signal. Everything else routes elsewhere.

## Procedure

### 1 — Establish that amplitude is genuinely low, not just unmeasured

Sparse is a finding; unsearched is laziness. Check the primary sources that would carry an early signal before concluding it is alone: preprints, patent filings, OSS activity, practitioner forums, standards bodies.

### 2 — Separate the signal, the issue, and the interpretation

Hiltunen's three dimensions, and conflating them is the most common error:

- **Signal** — the observable event. ("Three unrelated groups published on X this quarter.")
- **Issue** — what it might be about. ("A technique that was impractical may be becoming practical.")
- **Interpretation** — what it would mean for us. ("Our Assess-ring placement for Y would be wrong.")

Report all three, labelled. An interpretation stated as a signal is a fabrication.

### 3 — Score potential impact against the graph, not against intuition

The graph knows what is downstream. Count entities that would be affected, check whether any sit in the Adopt ring, and check whether a live initiative depends on the assumption this signal challenges.

### 4 — Decide the disposition

- **Monitor** — the default for a genuine weak signal. Name a concrete trigger that would promote it, and a date to re-check. A weak signal with no named trigger is just a bookmark.
- **Probe** — impact is high enough that waiting is expensive; hand to `cheapest-experiment` for the smallest test that would resolve it.
- **Promote** — amplitude has risen since first sighting; hand to `evaluate-signal` as an ordinary signal.
- **Discard** — low on both axes. Say so explicitly; silent discard loses the record that it was considered.

### 5 — Record it so it can mature

A weak signal's value is only realised if the _second_ sighting can find the first. Persist it with its trigger and re-check date.

## Output shape

```
SIGNAL          {the observable event, verbatim}
ISSUE           {what it might be about}
INTERPRETATION  {what it would mean here — labelled as interpretation}
AMPLITUDE       low | medium | high  ({n} distinct source identities; searched: {which primary sources})
IMPACT          low | medium | high  ({n} graph entities downstream; Adopt-ring touched: yes/no)
DISPOSITION     monitor | probe | promote | discard
TRIGGER         {the concrete observation that would change the disposition}
RE-CHECK        {date}
```

## Anti-patterns

- Do **not** score amplitude and impact as one number. That collapse is the bug.
- Do **not** promote a weak signal to a graph claim. It is a monitoring item until amplitude rises; write it as an observation, not an assertion.
- Do **not** call an anomaly a weak signal without an issue statement. "Something odd happened" is not actionable.
- Do **not** leave a weak signal without a trigger and a date. Undated monitoring is forgetting with extra steps.
- Do **not** use this to rescue a debunked claim. Weak means early, not wrong.

## Reference

- H. I. Ansoff, "Managing Strategic Surprise by Response to Weak Signals," _California Management Review_, vol. 18, no. 2, 1975.
- F. Aguilar, _Scanning the Business Environment_. Macmillan, 1967 — environmental scanning as a management discipline.
- E. Hiltunen, "The Future Sign and Its Three Dimensions," _Futures_, vol. 40, no. 3, 2008 — signal / issue / interpretation.
- Pairs with `evaluate-signal` (the well-sourced path), `cheapest-experiment` (the probe path), `rate-source-admiralty` (grading the one source you do have), and `graph-as-instrument` (impact scoring).

## Radarist binding

Ordered route — these five:

1. `getAgentObservations` — first, check whether an earlier run already logged this signal with a trigger and a re-check date. A second sighting should compound the amplitude evidence, not restart the triage.
2. `searchPapers` or `searchPatents` — whichever primary source fits the domain. Sparse is a finding; unsearched is laziness.
3. `analyzeImpact` — what is downstream of the entity this signal touches.
4. `getGraphNeighbors` — the affected neighbourhood, for the impact axis.
5. `recordAgentObservation` — persist the monitoring item with its trigger and re-check date.

An empty primary-source result is itself amplitude evidence: record that you searched and found nothing, which differs from not having searched.

Honest limit: the read-back is real, but there is no resolution state — nothing marks a monitoring item closed, so it keeps coming back. Still state the trigger and date in the output so a human can carry it.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
