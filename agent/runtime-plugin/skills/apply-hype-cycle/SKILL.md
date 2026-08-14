---
name: apply-hype-cycle
description: Use for "is X overhyped?", "peak hype?", "past the trough?", "Gartner Hype Cycle for …", "adoption stage of X", "is this a fad?". Places a technology on Gartner's five stages from observable indicators, plus a years-to-plateau estimate. For one dated prediction use `foresight` instead; for branching futures use `scenario-planning` instead.
---

# Apply Hype Cycle

The Gartner Hype Cycle from first principles — not "where did Gartner put it last year."

## When to invoke

Trigger on phrases like "is {X} overhyped?", "is {X} peak hype?", "past the trough?", "hype cycle stage for {X}", "adoption curve position", "is {X} a fad?", "how long until {X} is productive?", "trough of disillusionment", "plateau of productivity".

Skip for:

- Non-tech signals (a funding round is not hype-cycle stageable — funding is a _symptom_ of hype, not a stage).
- Technologies <6 months post-public-announcement (insufficient signal density).
- Sustaining improvements to established tech (hype cycle applies to **discontinuous** innovation, not incremental improvements). A new CPU generation is not hype-cycle stageable; a new computing paradigm (quantum, neuromorphic) is.

## The 5 stages

| Stage                                | Description                                                                   | Duration (typical) |
| ------------------------------------ | ----------------------------------------------------------------------------- | ------------------ |
| **1. Innovation Trigger**            | First public demos, research papers, proof-of-concepts                        | 6–18 months        |
| **2. Peak of Inflated Expectations** | Mass media coverage, over-promising vendors, fortune-making predictions       | 6–24 months        |
| **3. Trough of Disillusionment**     | Failed deployments public, vendors pivot or fold, press turns skeptical       | 12–36 months       |
| **4. Slope of Enlightenment**        | Early success stories, ref architectures emerge, second-generation tools work | 18–60 months       |
| **5. Plateau of Productivity**       | Mainstream adoption, commoditization, boring-infrastructure status            | indefinite         |

Average Trigger-to-Plateau time: **5–8 years** per Gartner's own retrospectives; some (blockchain) stall in the Trough indefinitely.

## Indicators per stage

Count matches on a 0–N basis for each stage. The stage with the most matched indicators is the current stage.

### Stage 1 — Innovation Trigger

- 🔍 A seminal paper or demo has appeared in the last 6–24 months
- 🔍 A handful of research groups or startups exist; no Fortune 500 deployments
- 🔍 Mainstream press coverage is low; specialized press may have early articles
- 🔍 VC investment is nascent (< 20 funded companies in the space)
- 🔍 Use cases are speculative (slide-deck futures, not live customers)

### Stage 2 — Peak of Inflated Expectations

- 🔍 Multiple front-page stories in mainstream press (NYT, WSJ, FT, The Economist)
- 🔍 Frequent vendor claims of "transformational" / "revolutionary" / "game-changer"
- 🔍 VC investment surges (>100 funded companies; multi-billion round sizes)
- 🔍 Forecasts of trillion-dollar markets by major consulting firms
- 🔍 Incumbents scramble to add it to their roadmaps
- 🔍 Reference customers are mostly internal or pilot-only — few named commercial deployments

### Stage 3 — Trough of Disillusionment

- 🔍 High-profile failed deployment publicly reported (name the failure)
- 🔍 Vendor pivots, consolidations, or shutdowns in the space
- 🔍 Press turns skeptical ("X was supposed to change everything, but…")
- 🔍 Magic-bullet claims are explicitly retracted or quietly dropped
- 🔍 Second-generation products appear that _narrow_ the scope

### Stage 4 — Slope of Enlightenment

- 🔍 Ref architecture patterns published and widely cited
- 🔍 Named customer case studies with measured ROI (not just "happy partner")
- 🔍 Open-source implementations mature and production-ready
- 🔍 Second- and third-wave vendors launch specialized variants for specific verticals
- 🔍 Integration standards emerge; hype is replaced by specifics

### Stage 5 — Plateau of Productivity

- 🔍 Technology is mentioned as infrastructure, not news
- 🔍 A generic skill or role exists (e.g. "SRE", "data engineer")
- 🔍 Replaced or commoditized rather than "hyped" — the boring-infrastructure stage
- 🔍 Analyst coverage shifts from "is this real?" to "how do we use it?"
- 🔍 Adjacent hype cycles reference it as a building block

## Procedure

### 1 — Define the technology

Narrow scope is critical. "AI" is not stageable; "LLM-based autonomous agents for enterprise task automation" is. The narrower the scope, the sharper the placement.

### 2 — Gather current indicators

Run through the 5 stages' indicator lists. For each indicator, either confirm (with a citation) or skip. Count matches per stage.

### 3 — Place on the stage with the most matches

Tie-breaker: pick the _earlier_ stage if the technology is still evolving rapidly (the later stage indicators may be ahead of their actual emergence).

Edge case: a technology can **stall** in Stage 3 (Trough). If it's been in the Trough for 5+ years without advancing, note this — it may never reach Plateau.

### 4 — Estimate time-to-plateau

From current stage, use:

- Stage 1 → Stage 5: 5–8 years
- Stage 2 → Stage 5: 4–7 years
- Stage 3 → Stage 5: 3–5 years (or never, if stalled)
- Stage 4 → Stage 5: 1–3 years

Report with 1σ uncertainty (a range, not a point estimate).

### 5 — Compare against historical peer trajectories

Pick one or two past technologies that went through a similar cycle and note where their Trigger-to-Plateau time landed. This calibrates the estimate.

Examples:

- Agentic AI frameworks ~ Big Data analytics circa 2012 (took ~4 years from peak hype → plateau)
- Quantum computing ~ Optical computing 1980s (stalled in Trough; caution)
- LLM-based coding assistants ~ IDE autocomplete evolution (accelerated cycle)

### 6 — Format

```
## Hype Cycle Placement — {technology}

**Subject:** {narrow-scoped technology}

**Current stage: {N}. {stage name}**

**Indicator matches:**
- Stage 1: {matches}/5
- Stage 2: {matches}/6
- Stage 3: {matches}/5 ← current (most matches)
- Stage 4: {matches}/5
- Stage 5: {matches}/5

**Supporting evidence (cited):**
- {indicator}: {citation}
- {indicator}: {citation}
- ...

**Peer trajectory calibration:**
- Similar arc: {named past technology, brief note on its timeline}

**Time-to-plateau estimate:** {range, e.g. 3–6 years} (1σ uncertainty; wide because {reason})

**Plateau-vs-stall risk:** {low / medium / high — and why}

**What would move this placement:** {specific indicator shifts that would re-place the technology}
```

### 7 — Pair downstream

- Feed the placement into radar ring assignment (Trigger/Peak → outer ring; Enlightenment/Plateau → inner ring).
- Combine with `score-technology-readiness` (orthogonal: TRL = _what you have_; hype = _how the market talks about it_). A TRL-8 technology in Trough is "underappreciated infrastructure"; a TRL-3 technology at Peak is "overhyped research."

## Anti-patterns

- Do **not** just cite "where Gartner puts it." That's their placement, not a derivation. This skill earns the placement from indicators.
- Do **not** apply to markets. Hype cycle is per-technology; a market is an ecosystem of technologies at varying stages.
- Do **not** claim certainty. Hype cycles have wide variance; report 1σ uncertainty.
- Do **not** skip peer-trajectory calibration. It's the sanity check on your time-to-plateau estimate.

## Reference

- J. Fenn, "Understanding Gartner's Hype Cycles," Gartner Research Note, 2008 (original methodology).
- M. Mullany, "8 Lessons from 20 Years of Hype Cycles," Medium essay, 2016 (critiques and empirical analysis of forecast accuracy).
- E. M. Rogers, _Diffusion of Innovations_, 5th ed. Free Press, 2003 (the adoption-curve underpinning).
- Pairs with `score-technology-readiness` (orthogonal axis; combine for 2D placement), `position-competitor` (competitive map uses hype stage as color-coding), and `analysis-of-competing-hypotheses` (when hype placement is contested between hypotheses).

## Radarist binding

All five stage indicators are measurable rather than recalled:

- **Publication volume and trend** → `searchPapers` (pairs with `assess-research-momentum`).
- **Practitioner attention** → `searchHackerNews`.
- **Investment** → `searchSecFilings`.
- **Reference implementations** → `searchOssHealth`.
- **Our own observation history** → `getEntityTimeline` and `getTemporalEdgeStats` — how long has this been in the graph, and is edge activity rising or flat?

State which indicators you counted and which you inferred. A stage placement with zero counted indicators is an opinion.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
