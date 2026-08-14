---
name: scenario-planning
description: Use when the future is genuinely uncertain and a single-point forecast is inadequate — "what could happen to X over the next 3–5 years?", "plausible futures", "2x2 scenarios", "alternative futures", "driver analysis". Shell's method — two critical uncertainties, a 2×2 matrix, each future narrated with triggers. For one dated prediction use `foresight` instead.
---

# Scenario Planning

Shell's GBN methodology — used to predict the 1970s oil shock. Still works.

## When to invoke

Trigger on phrases like "how will {X} evolve?", "future of {Y}", "what could happen in 3-5 years?", "scenarios for {Z}", "plausible futures for {domain}", "planning horizon beyond 12 months".

Skip for:

- Short-horizon questions (<12 months) — single-point forecasts work there
- Questions about current state (use `position-competitor` + `apply-hype-cycle`)
- Questions with <2 material uncertainties — scenarios need branching to be useful

## The method in five steps

### 1 — Frame the focal question

What decision does this scenario-planning inform? Examples:

- "Should we invest $100M in agentic AI infrastructure over 3 years?"
- "Will foundation-model APIs commoditize or stay premium?"
- "How will enterprise AI procurement evolve through 2028?"

The question fixes the time horizon (typically 3–10 years) and the decision-maker.

### 2 — Identify driving forces

Brainstorm 10–20 factors that could shape the future of the focal question. Categorize using PEST:

- **P**olitical — regulation, geopolitics, policy
- **E**conomic — macro, capital availability, demand
- **S**ocial — adoption patterns, preferences, labor
- **T**echnological — capability frontier, cost curves, platform shifts

For each factor, note **which direction it could swing** (not just what it is).

### 3 — Sort by impact × uncertainty

Score every factor on two axes:

- **Impact** (L/M/H) — if this factor moves, how much does it change the outcome?
- **Uncertainty** (L/M/H) — how unpredictable is this factor over the horizon?

Create a 3×3 grid. The **top-right quadrant** (High impact × High uncertainty) is where the action is — these are the **critical uncertainties**.

The rest:

- High impact × Low uncertainty = predetermined elements (known futures — just incorporate as constants)
- Low impact × High uncertainty = noise (ignore)
- Low impact × Low uncertainty = trivia (ignore)

### 4 — Pick two critical uncertainties as axes

From the top-right quadrant, pick **two** uncertainties that are:

- **Orthogonal** — movements in one don't predict movements in the other
- **Distinct** — they illuminate different scenarios
- **Binary-extremable** — each has a clear "high case" and "low case"

Example for "future of enterprise AI agents by 2028":

- Axis X: **Model capability trajectory** (saturating vs. accelerating)
- Axis Y: **Regulatory regime** (permissive vs. restrictive)

These are orthogonal (capability doesn't predict regulation), distinct (they drive different dynamics), and binary-extremable.

**Rejecting bad axes**: if you find yourself arguing "axis X already implies axis Y," they're correlated — pick a different pair.

### 5 — Build and narrate the four scenarios

Each corner of the 2×2 is a scenario. For each:

- **Name** — memorable, 2–3 words that convey the scenario's essence
- **Vignette** — a present-tense 3–5 sentence story of the world in year {horizon}
- **Triggers** — 2–3 observable early signals that would indicate the world is heading to this corner
- **Implications for focal question** — what the decision-maker should do in this scenario

#### Example: Enterprise AI agents by 2028

|                            | Capability accelerating                                                                                       | Capability saturating                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Permissive regulation**  | **"Cambrian Agents"** — millions of vertical agents deployed; AI-first enterprises displace traditional SaaS. | **"Utility Plateau"** — AI a commodity layer; competition on distribution + brand, not model quality.        |
| **Restrictive regulation** | **"Walled Garden"** — a few compliant vendors dominate; capability concentrated in Big Tech.                  | **"Frozen Winter"** — AI investment dries up; deployment held by compliance complexity; 2002 dot-com analog. |

For each: name, vignette, triggers, implications.

### 6 — Stress-test and robust-strategy search

A good scenario-plan identifies **strategies that are robust across all four scenarios** — not strategies that win in one scenario and lose in three.

Example: "Invest in data-labeling infrastructure" might be robust across all four scenarios (still needed in Cambrian, Utility, Walled Garden, and Winter). "Invest in vertical-specific agents" works only in Cambrian.

The robust-strategy insight is often the main output of scenario planning.

### 7 — Format the output

```
## Scenario Plan — {focal question}

**Focal question:** {question}
**Decision-maker:** {who is this informing}
**Horizon:** {years}

**Driving forces analyzed:** {N factors across PEST}

**Predetermined elements** (High impact × Low uncertainty — treat as constants):
- {element}: {why it's baked in}
- {element}: {why it's baked in}

**Critical uncertainties selected as axes:**
- **X-axis: {uncertainty name}** — {low case} ↔ {high case}
- **Y-axis: {uncertainty name}** — {low case} ↔ {high case}

**Orthogonality check:** {why X and Y don't predict each other}

**Four scenarios:**

### Scenario 1: {NAME} — {corner coordinates}
**Vignette:** {3-5 sentences, present tense, year {horizon}}
**Early signals:**
- {observable indicator}
- {observable indicator}
**Implications for {decision-maker}:**
- {what to do in this scenario}

### Scenario 2: {NAME}
...

### Scenario 3: {NAME}
...

### Scenario 4: {NAME}
...

**Robust strategies (work in ≥3 scenarios):**
- {strategy}
- {strategy}

**Scenario-specific bets:**
- Only in Scenario N: {bet} — high upside, only valid if early signals of Scenario N appear

**Monitoring plan:**
- Check {metric} quarterly; it's the earliest signal for {scenario}
- Check {metric} annually; it's the signal for {other scenario}
```

## Pair with adjacent skills

- `apply-hype-cycle` — single-trajectory view of maturity; scenarios add the branching
- `five-forces-analysis` — static industry structure; scenarios project how forces could evolve
- `premortem-analysis` — failure-oriented; scenarios are balanced across good/bad futures
- `analysis-of-competing-hypotheses` — present-state reasoning; scenarios are future-state

## Anti-patterns

- Do **not** use scenario planning for short horizons (<12 months). It's overkill and the branching adds noise.
- Do **not** build scenarios around 2 correlated axes. If "AI capability" and "AI adoption" are both axes, you're just drawing a diagonal — pick orthogonal dimensions.
- Do **not** treat the four scenarios as equally likely. Assign rough weights (e.g. 40/30/20/10) based on judgment — explicit is better than implicit.
- Do **not** skip the robust-strategy search. The scenarios are the setup; robust strategies are the deliverable.
- Do **not** name scenarios vaguely ("Scenario A"). The name carries the memory — "Walled Garden" sticks; "Scenario 3" doesn't.
- Do **not** build >4 scenarios. Two axes × two values = four; more than four dilutes the analysis.

## Reference

- P. Schwartz, _The Art of the Long View_, Doubleday, 1991 (founded by ex-Royal Dutch Shell planning group; the canonical text).
- K. van der Heijden, _Scenarios: The Art of Strategic Conversation_, Wiley, 1996.
- P. Schoemaker, "Scenario Planning: A Tool for Strategic Thinking," _Sloan Management Review_, vol. 36, no. 2, pp. 25–40, 1995.
- The 1970s Shell oil-shock case — the signature application of this method (documented in _The Art of the Long View_).
- Pairs with `apply-hype-cycle` (single-trajectory input), `five-forces-analysis` (structural baseline), `premortem-analysis` (failure-focused complement), and `analysis-of-competing-hypotheses` (present-state reasoning).

## Radarist binding

Critical uncertainties should be drawn from observed trends, not brainstormed:

- `getTrends` / `getTrendDetails` / `getTrendSummary` — the observed drivers.
- `getChangedSince` — which drivers are actually moving right now.
- `renderDiagram` — the 2×2 should render rather than be described.
- `recordAgentObservation` — persist each scenario's trigger so a later run can detect which future is arriving.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
