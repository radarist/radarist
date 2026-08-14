---
name: three-horizons
description: Use when a brief proposes a portfolio of bets, capabilities, or technologies — investment briefs, transformation roadmaps, "where should we focus?", "what's our portfolio across the next 5 years?". Tags every bet H1 (0–12 months), H2 (1–3 years), or H3 (3–5 years) with a time-to-revenue-impact estimate.
---

# Three Horizons

One horizon tag per bet. One time-to-revenue-impact estimate. One implication for the rest of the recommendations.

## When to invoke

Trigger on phrases like "where should we focus?", "investment portfolio", "transformation roadmap", "5-year plan", "balanced bets", "what's the right time to invest in X?", "core vs. exploratory".

Particularly valuable when:

- The brief recommends multiple investments that span time horizons
- The reader is allocating attention or capital across a portfolio (not just a single decision)
- A prior brief mixed core-business optimisations with breakthrough bets and got the same evidence bar applied to both
- A foresight prediction at H2/H3 needs to live alongside H1 operational decisions in the same brief

Skip for:

- Single-bet briefs (use `cheapest-experiment` to design the bet's validation instead)
- Pure descriptive briefs (current-state snapshots, ecosystem maps with no portfolio implications)
- Time horizons already settled by the prompt ("we're choosing a Q1 pilot — what's the best one?")

## The three horizons (McKinsey Baghai/Coley/White)

| Horizon | Time        | Purpose                                                        | Evidence bar                                                    | Right method                                                   |
| ------- | ----------- | -------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| **H1**  | 0-12 months | Defend and extend core business                                | Hard ROI, validated demand, named customers                     | Operational excellence, ROI thresholds, Stage-Gate go/no-go    |
| **H2**  | 1-3 years   | Build emerging businesses with visible (but uncertain) revenue | Pilot data, named early customers, validated leading indicators | Innovation accounting, validated learning, build-measure-learn |
| **H3**  | 3-5 years   | Create options for breakthrough businesses                     | Weak signals, hypothesis quality, optionality preserved         | Probes, theses-not-plans, foresight-driven monitoring          |

The framework is **portfolio-balance**, not sequencing. Healthy portfolios run all three concurrently — Baghai/Coley/White's canonical mix is roughly 70% H1 / 20% H2 / 10% H3. The whole point is to avoid starving any of them.

## The method in three steps

### 1 — Tag every bet with an explicit horizon

For every named investment, capability, or recommendation, ask:

- Will this generate revenue (or measurable cost reduction) in the next 12 months? → H1
- Will it materially impact revenue 1-3 years from now, with pilot evidence already? → H2
- Is it a thesis whose payoff is 3-5+ years out, with weak signals only? → H3

Write the tag inline:

```
**Horizon:** H2 (1-3 yr to revenue impact)
```

Don't hedge "H2 to H3" — the act of picking is the work. If you genuinely can't decide, default to the lower horizon (H2 over H3) and write the rationale, then pair with `cheapest-experiment` to design the next 12 months of validation.

### 2 — State the time-to-revenue-impact estimate

Both numbers, with units:

- Time horizon: months or years to first measurable impact
- Confidence in the estimate: high / medium / low

- Good: `Horizon: H2. Time-to-revenue: 18-24 months. Confidence: medium (one named lighthouse pilot, no second comparable).`
- Bad: `Horizon: H2. Time-to-revenue: a few years.` — drop the bet from the recommendation list rather than ship vague.

### 3 — One implication line per bet

Translate the horizon to an evidence-bar expectation:

- H1 → "This is a defend-and-extend move. Apply hard-ROI thresholds; expect ≥X% in Y months or kill."
- H2 → "This is an emerging-business build. Apply innovation-accounting metrics (named leading indicators); expect validated learning, not revenue, at the 12-month mark."
- H3 → "This is an option-preserving play. Apply weak-signal monitoring (`foresight`-style watchlist); evaluate quarterly against named signposts."

The reader needs the implication to know which evidence bar applies to the bet — not to assume H1's hard-ROI bar covers an H3 thesis.

## Output format (mandatory)

For every named bet in a portfolio brief, emit one fenced block labelled `horizon`:

```horizon
Bet: <name of bet, capability, or recommendation>

Horizon: <H1|H2|H3>
Time-to-revenue impact: <range with units, e.g., "0-12 months", "18-24 months", "3-5 years">
Evidence bar: <hard ROI | innovation-accounting (validated learning) | weak-signal monitoring>
Right method: <Stage-Gate | build-measure-learn | thesis-and-watchlist>
Implication: <one sentence telling the reader how to evaluate this bet>
```

Pair with the brief's portfolio summary if the brief lists ≥3 bets:

```portfolio
H1 bets: <list>
H2 bets: <list>
H3 bets: <list>

Portfolio mix: <%H1 / %H2 / %H3 by capital, attention, or count — say which>
Imbalance flag: <none | over-indexed on H1 | starving H3 | …>
```

The L1 quality gate (`mission-quality.ts:SKILL_PROCEDURE_MARKERS`) detects two markers — the `Horizon: H1/H2/H3` line and any `Three Horizons` reference — and counts the tagging as the `three-horizons` skill-procedure marker.

## Anti-patterns to refuse

- **Tag-without-time** — `Horizon: H2` with no time-to-revenue estimate is decorative. The unit-bearing estimate is the discipline.
- **All bets at H1** — if every recommendation is H1, the portfolio has no future. Either find the H2/H3 bets that complement, or label the brief honestly as "operational" rather than "strategic."
- **Sequencing instead of portfolio** — Three Horizons is concurrent, not sequential. "First we'll do H1, then H2 next year" misuses the framework.
- **H3 hand-waving** — H3 isn't a place to hide bets without evidence. Even H3 bets need a thesis statement, named weak signals to monitor, and a quarterly review cadence.
- **Wrong evidence bar applied** — applying H1's hard-ROI threshold to an H3 thesis kills the thesis prematurely; applying H3's weak-signal patience to an H1 bet wastes the year. The whole point of the tag is to match evidence bar to horizon.

## Working with other skills

- Pair with `cheapest-experiment` on every H1 and H2 bet — H1 experiments are pilots with hard ROI thresholds; H2 experiments are validated-learning probes.
- Pair with `foresight` on every H3 bet — `foresight`'s named accelerants/blockers/kill-signals become the H3 watchlist.
- Pair with `evolution-stage` on every named technology — H1 bets often involve Product or Commodity stages; H3 bets often involve Genesis or Custom-built.
- Use with `premortem-analysis` on the portfolio level — what would make the whole portfolio fail (over-indexing on one horizon, or starving another)?
- Run with `cynefin-classification` at the brief level — H3 bets are almost always Complex (probe-sense-respond); H1 bets are usually Clear or Complicated.

## Confidence notes

Horizon tags carry confidence on two axes — confidence in the time estimate (high if pilot data exists, medium if comparable references exist, low if reasoned-from-priors) and confidence in the evidence bar match (high if the bet's metrics align with horizon-appropriate measures). The brief's overall confidence should reflect the lower of the two.

## Radarist binding

The portfolio already exists as entities — tag the real one, not a hypothetical list:

- `searchInitiatives` / `getInitiativeDetails` — the bets actually running.
- `listRadars` / `getRadarDetails` — current ring placements as the H1/H2 evidence base.
- `recommendTechInvestments` — graph-ranked candidates for the H3 slot.
- `getEntityTimeline` — how long a bet has been in its current horizon; a bet that has been "H2" for three years is really H3 or dead.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
