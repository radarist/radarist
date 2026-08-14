---
name: decompose-research-question
description: Use when a question is too large, vague, or multi-part to answer directly — "what's the future of X?", "analyze the {broad domain}", "compare all the Y", "help me understand Z". Breaks it into a tree of independently answerable sub-questions that recombine.
---

# Decompose Research Question

Before doing research — decide what research to do.

## When to invoke

Trigger when the user's question:

- Contains ≥ 3 distinct sub-questions inside one sentence
- Is open-ended ("what should we think about X?", "help me understand Y")
- Spans multiple domains (business × technical × regulatory)
- Has a horizon that exceeds single-skill capability (a year of market trends needs breaking up)
- Would take >2000 words to answer directly

Skip when:

- The question is atomic and has a direct answer (use the appropriate domain skill)
- The question is a factual lookup (use `grounded-answer`)
- The question is a classification (which framework applies?) — answer directly

## The decomposition framework

Two patterns work well depending on question shape:

### Pattern A — 5W+H decomposition

For broad "what about X?" questions:

- **What** — the object or state to describe
- **Why** — the causal mechanism or motivation
- **Who** — the stakeholders, actors, buyers, decision-makers
- **When** — the time dimension (current, past trajectory, future horizon)
- **Where** — geography, market, context
- **How** — process, method, execution pathway

Not every W applies to every question — pick the 3–5 that carry the most analytic weight.

### Pattern B — Self-Ask decomposition

For narrower analytical questions (from the Self-Ask paper, arXiv:2210.03350):

Given the main question Q, ask: "_What question would I need answered first, to even start on Q?_"

Keep asking until each leaf question is atomic — one skill can answer it.

Example:

- Q: "Which agent framework will dominate enterprise deployment in 2027?"
- Sub-Q1: "Who are the relevant agent frameworks today?" → use web research
- Sub-Q2: "What are their current maturity levels?" → use `score-technology-readiness`
- Sub-Q3: "What are their competitive dynamics?" → use `five-forces-analysis` + `position-competitor`
- Sub-Q4: "What scenarios could play out by 2027?" → use `scenario-planning`
- Sub-Q5: "Which hypothesis best explains current trajectories?" → use `analysis-of-competing-hypotheses`
- Sub-Q6: "What are the main failure modes of the leading hypothesis?" → use `premortem-analysis`

## Procedure

### 1 — Restate the question

Write the user's question verbatim. Then write your understanding of what they're actually asking (often differs).

If the two differ materially, ask a clarification before decomposing.

### 2 — Pick the pattern

- Broad "what about X?" → 5W+H
- Narrower analytical → Self-Ask
- Comparative ("compare A vs B vs C") → decompose by entity × dimension matrix
- Temporal ("how will X evolve?") → decompose by time slices

### 3 — Produce the tree

Draw the decomposition as a tree:

```
Main question
├── Sub-question 1
│   ├── Sub-sub-question 1a
│   └── Sub-sub-question 1b
├── Sub-question 2
│   └── Sub-sub-question 2a
└── Sub-question 3
```

Stop decomposing when each leaf is:

- Atomic (one skill or one tool call away from an answer)
- Orthogonal to its siblings (no overlap)
- Necessary (can't answer parent without answering this)

### 4 — Assign a skill to each leaf

Every leaf maps to at least one skill. If no skill applies, the leaf is a raw question requiring direct research (grounded-answer + web search).

### 5 — Order the leaves

Some leaves block others:

- "What frameworks exist?" must be answered before "How mature is each framework?"

Draw a dependency order. Run independent leaves in parallel; run dependent leaves sequentially.

### 6 — Specify the recombination

How will the leaf answers be combined into the main answer? The recombination is its own choice:

- **Linear synthesis** — Methods, Results, Discussion (use `write-imrad-report`)
- **Matrix synthesis** — comparison table (for comparative decomposition)
- **Scenario matrix** — 2×2 scenarios (use `scenario-planning`)
- **ACH synthesis** — evidence matrix (use `analysis-of-competing-hypotheses`)
- **Briefing** — SBAR short form (use `write-srl-brief`)

### 7 — Format the decomposition plan

```
## Decomposition — {original question}

**Original question:** {verbatim from user}

**Restated understanding:** {one-sentence paraphrase}

**Pattern:** {5W+H / Self-Ask / comparative / temporal}

**Tree:**
- {main question}
  - {sub-question 1} → skill: `{skill-name}` — ~{time}
    - {sub-sub-question 1a} → skill: `{skill-name}`
    - {sub-sub-question 1b} → skill: `{skill-name}`
  - {sub-question 2} → skill: `{skill-name}`
  - {sub-question 3} → skill: `{skill-name}`

**Dependency order (parallelizable groups):**
- Group 1 (parallel): sub-Q1, sub-Q3 (independent)
- Group 2 (after Group 1): sub-Q2 (needs sub-Q1's answer)

**Estimated total time:** {N} minutes

**Recombination method:** {how leaf answers combine}

**Final deliverable shape:** {IMRAD report / SBAR brief / ACH matrix / radar report / custom}

**Confidence gates:**
- Abstain if any leaf has confidence < 0.5
- Proceed only if ≥ 70% of leaves resolve with confidence ≥ 0.7
```

### 8 — Hand off to execution

The decomposition plan is the output. Execution happens in subsequent turns (each leaf → one skill invocation). The orchestrator can now dispatch in parallel where possible.

## Example decomposition

User question: **"Should we invest in the foundation-model API space?"**

Decomposition:

```
Should we invest in foundation-model API space?
├── What is the current market structure? → `five-forces-analysis`
├── Who are the competitors, how positioned? → `position-competitor`
├── What's the hype-cycle stage? → `apply-hype-cycle`
├── How big is the TAM? → `estimate-market-size`
├── What scenarios could play out over 3 years? → `scenario-planning`
│   ├── Commodity scenario → driver: capability saturation
│   └── Premium scenario → driver: capability divergence
├── What could go wrong? → `premortem-analysis`
└── Final recommendation → `write-srl-brief` (SBAR) + `critique-report`
```

Dependency order:

- Parallel group 1: `five-forces`, `position-competitor`, `apply-hype-cycle`, `estimate-market-size` (all independent)
- Sequential: `scenario-planning` (uses group 1 outputs)
- Sequential: `premortem-analysis` (stress-tests scenarios)
- Sequential: `write-srl-brief` (consumes everything)
- Final: `critique-report` (audits the brief)

Estimated total time: ~30 minutes.

Recombination: SBAR brief with confidence 0.7+ recommendation.

## Pair with adjacent skills

- All skills — this is a **meta-skill** that orchestrates them.
- `grounded-answer` — if a leaf requires direct factual retrieval.
- `critique-report` — final gate before delivery to the user.
- `abstain-or-escalate` — if decomposition reveals the question is fundamentally un-answerable (no data, out of scope, too speculative).

## Anti-patterns

- Do **not** decompose questions that don't need it. "What is Anthropic's latest funding round?" does not need decomposition — it needs `detect-funding-round`.
- Do **not** build a tree with overlapping leaves. Sibling leaves must be orthogonal.
- Do **not** leave leaves un-skilled. Every leaf needs either a skill or "direct research" as its disposition.
- Do **not** ignore dependency order. Running dependent leaves in parallel produces inconsistent context.
- Do **not** decompose to more than 8 leaves. Beyond that, the recombination complexity exceeds the value — split into two separate research streams.
- Do **not** skip the recombination method. A tree of answers with no plan to recombine is just a pile of fragments.

## Reference

- O. Press et al., "Measuring and Narrowing the Compositionality Gap in Language Models (Self-Ask)," arXiv:2210.03350, 2022.
- S. Yao et al., "ReAct: Synergizing Reasoning and Acting in Language Models," arXiv:2210.03629, 2022 — complementary reason-act loop.
- T. Khot et al., "Decomposed Prompting: A Modular Approach for Solving Complex Tasks," arXiv:2210.02406, 2022.
- P. Drucker, "Managing Oneself," _Harvard Business Review_, 1999 — on asking the right question before answering.
- Pairs with all other skills — this is the orchestrator-level skill that routes questions to the right subordinates.

## Radarist binding

Drive the decomposition from what the graph does **not** know:

- `findConceptGaps` / `findDataGaps` / `getGapAnalysis` — the actual holes, which make the best sub-questions.
- `getConceptMap` — how the topic is already structured, so sub-questions align to real boundaries.
- `findEntitiesByMeaning` — what the graph already answers, so you do not re-ask it.
- `listCapabilities` — which sub-questions the platform can answer itself.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
