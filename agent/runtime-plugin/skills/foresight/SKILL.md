---
name: foresight
description: Use for "when will X happen?", "is this accelerating or stalling?", "what should we watch?", "by what date…?" — a dated prediction about one technology, trend, or market shift. Names the prediction, accelerants, blockers, weak signals to monitor, kill-signals, and a review horizon. For branching futures use `scenario-planning` instead; to score the prediction once resolved use `brier-score-calibration` instead.
---

# Foresight

One prediction, three accelerants, three blockers, three weak signals, three kill-signals, one review date.

## When to invoke

Trigger on phrases like "when will {X} happen?", "by when...?", "will {Y} cross the chasm?", "how do we know if this is real?", "what should we watch?", "early indicators for {Z}", "forecast {horizon}", "timeline for {tech}", "milestones through 202{n}".

Particularly valuable when:

- The user is deciding whether to wait or commit (timing question)
- The Creator is writing a brief that makes a dated claim
- The Strategist is picking the next investment window
- A prior scenario-planning call picked a winner and the user now wants to track whether it's playing out

Skip for:

- Branching "what could happen?" questions over 3–10 year horizons — use `scenario-planning` (that's a 2x2, this is one line)
- Single-point current state questions — use `position-competitor` or `apply-hype-cycle`
- Risk questions on a chosen plan — use `premortem-analysis` (that's failure modes, this is timing)
- Unfalsifiable fuzzies ("AI will change everything") — insist on a concrete prediction first

## The method in six steps

### 1 — Name the prediction

Write one sentence with four parts: **subject + verb + dated milestone + confidence**.

- Good: "Open-weight models at Llama-3-70B capability will run on sub-$5000 consumer hardware by Q4 2026 (confidence: 0.7)."
- Bad: "Open-weight models will continue to improve." — no milestone, no date, no confidence.

The date must be absolute (Q4 2026, 2028-06, "within 18 months of now") — no "eventually" or "soon". The confidence must be a number, not a vibe.

If you can't write the sentence, the question isn't ripe for foresight — push back.

### 2 — List three accelerants

Three forces that would pull the milestone **earlier or more likely**. Each one should be **observable** (something happens, can be named) — not abstract ("the market matures") but concrete ("NVIDIA ships a sub-$2000 SKU with 48GB VRAM").

For each accelerant, note the **lead time**: how many months ahead of the milestone would this indicator appear? That's your early-warning window.

### 3 — List three blockers

Three forces that would push the milestone **later or less likely**. Symmetric to accelerants: concrete, observable, each with a lead time.

The point is not to predict which will happen — it's to build a watchlist. If you're thinking "this prediction is obvious," you're missing the blockers.

### 4 — Commit to three weak signals to monitor NOW

Weak signal = an observable thing today that, if it changes, you'd update your confidence. Weak because it's below threshold — nobody else is watching it yet. That's the edge.

Good weak signals:

- A specific benchmark number crossing a threshold (MMLU on open 8B > 75%)
- A specific company shipping a specific capability (Mistral releasing a coding-tuned model)
- A specific regulation passing or failing (EU AI Act Schedule III updates)
- A specific hire / org change (an incumbent's top researcher moves to an open-source lab)

Bad weak signals (too vague):

- "Sentiment shifts"
- "More adoption"
- "Continued investment"

Each weak signal should name the **source** where it'd be observed (arXiv, a specific company's blog, a regulator's gazette) so the watcher knows where to look.

### 5 — Commit to three kill-signals

Kill-signal = a specific observable event that would make you retract the prediction. These are harder to write than accelerants because they force you to say what would prove you wrong — and most forecasts avoid that.

Each kill-signal must be:

- **Specific**: a named event, not a vibe
- **Observable**: will leave a public trace
- **Sufficient**: if it happens, the prediction is dead (not merely weakened)

Good kill-signals:

- "NVIDIA announces a $50k minimum for cards with >48GB VRAM with no consumer variant through 2027"
- "EU AI Act banned-use schedule adds capable open-weight models to Annex III"
- "All three frontier labs (OpenAI, Anthropic, Google) publish capability claims that open-weight models can't close within 18 months"

A prediction without kill-signals is a prediction you don't believe. If you can't write three, lower confidence below 0.5 or walk away.

### 6 — Set the review horizon

One date — when do you revisit this? Pick based on:

- **Half the time-to-milestone**: if the milestone is Q4 2026, review mid-2025
- **Just after the next expected weak signal**: if a key conference is in March, review in April
- **Shorter if confidence > 0.8**: high-confidence predictions decay faster; verify sooner

Write: `Review: {date} — look for {specific thing}`.

## Output format (mandatory)

When invoked in a report or analysis, emit **one** fenced block labelled `foresight`:

```foresight
Prediction: {subject} {verb} {dated milestone} (confidence: 0.{nn})

Accelerants:
- {accelerant 1} (lead time: {months}m)
- {accelerant 2} (lead time: {months}m)
- {accelerant 3} (lead time: {months}m)

Blockers:
- {blocker 1} (lead time: {months}m)
- {blocker 2} (lead time: {months}m)
- {blocker 3} (lead time: {months}m)

Weak signals to watch NOW:
- {weak signal 1} → observed at {source}
- {weak signal 2} → observed at {source}
- {weak signal 3} → observed at {source}

Kill signals (if observed, retract):
- {kill signal 1}
- {kill signal 2}
- {kill signal 3}

Review: {YYYY-MM-DD} — {specific thing to look for}
```

This block is machine-parseable. Keep the labels exactly as shown; downstream tools (briefing, verification) will read it.

## Confidence calibration

| Confidence | What it means                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| 0.9+       | Milestone has happened or is imminent (weeks). Rare — most "0.9" forecasts are overconfident.        |
| 0.7 – 0.9  | Two independent lines of evidence point to the milestone within the stated horizon. Normal range.    |
| 0.5 – 0.7  | One strong line of evidence; reasonable counterarguments exist. Mark as `directional` in the report. |
| < 0.5      | Don't publish as a foresight prediction. Write it as an open question instead.                       |

## Anti-patterns to refuse

- **Undated predictions** — "within a few years" is not a date.
- **Un-fire-able kill signals** — kill signals like "if the market doesn't grow" are vibes. Kill signals must be specific observable events.
- **Accelerants without lead times** — without a lead time you can't use the watchlist to time a decision.
- **Recycled general trends as weak signals** — "more enterprise adoption" is not a weak signal; "{specific-company} shipping {specific-feature}" is.

## Working with other skills

- After `scenario-planning` picks a winning scenario → run `foresight` on the specific trajectory to track it.
- Before `premortem-analysis` of a chosen plan → `foresight` gives you the accelerants/blockers; premortem gives you the failure modes.
- Use with `rate-source-admiralty` on every weak signal source — a B3 source is not a weak signal, it's noise.
- Use with `triangulate-sources` on accelerants and blockers — single-sourced forces should be marked as such.

## Radarist binding

A prediction nothing watches is a sentence, not a forecast. Make it resolvable:

- `recordAgentObservation` — write the prediction and its kill-signals into the briefing pipeline so a later run can find them.
- `getAgentObservations` — read what a prior run already predicted about this entity, so a new forecast supersedes it explicitly instead of quietly duplicating it. `brier-score-calibration` uses the same read to score them.
- `getChangedSince` / `queryActiveEdges` — the mechanism a later run uses to check whether a kill-signal fired.
- `getEntityTimeline` — the base rate for how fast this entity has moved before.
- `getTrends` / `getTrendDetails` — observed trend data rather than recalled direction.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
