---
name: position-competitor
description: Use when placing a company or technology on a 2D competitive landscape — "where does X sit vs Y?", "competitive positioning", "market map", "who are the leaders in category Z?", "magic quadrant for …". Axis selection, evidence-based placement, whitespace, orthogonality check. For industry structure use `five-forces-analysis` instead.
---

# Position Competitor

Strategic positioning done defensibly. The output is _analysis_, not a table of vendor names.

## When to invoke

Trigger on phrases like "where does {X} sit vs {Y}?", "position these on a 2×2", "competitive map of the {space}", "who are the leaders in {category}?", "magic quadrant for {category}", "landscape view of {category}".

Skip when:

- Only one competitor in the space — positioning requires ≥3 entities for a meaningful map.
- The question is purely feature-comparison ("does {X} have feature F?") — use a feature table.
- The market is in hypergrowth (>3× YoY) — the map will be obsolete in 6 months. Flag this and recommend `analysis-of-competing-hypotheses` instead, which is more robust under churn.

## The 4-step procedure

### 1 — Select the axis pair

Good axes are **orthogonal** (low correlation), **material** (matter to the buyer), and **measurable** (from evidence, not vibes).

Common axis pairs:

- **Cost ↔ Quality** — "low-cost commodity" vs "premium boutique"
- **Integrated ↔ Modular** — "all-in-one platform" vs "best-of-breed components"
- **Enterprise ↔ SMB** — "top-down complex sales" vs "PLG self-serve"
- **Proprietary ↔ Open source** — "closed vendor" vs "open-core or fully open"
- **Focused ↔ Full-stack** — "one sharp thing" vs "suite"
- **Generalist ↔ Specialist** — "horizontal tooling" vs "vertical-specific"

**Axis choice rule**: if the axis pair is correlated (all low-cost players are also commodity-quality → cost and quality are not orthogonal, they're the same axis), pick a different pair. Explicitly document why you picked these two.

### 2 — Place each competitor with evidence

For each entity, place it with a **one-sentence evidence justification**. Placements by vibes are the anti-pattern here.

Examples:

- "Anthropic: high quality axis (Claude 3.5 Sonnet leads on SWE-Bench, HumanEval, MMLU-Pro), high integration axis (Claude.ai + SDK + Messages API + Batch + Files — unified ecosystem)."
- "Mistral: medium quality axis (Large 2 competitive but not SOTA), high modularity axis (open-weight models, self-hostable, function-calling compatible)."

Place entities with approximate coordinates (e.g. "upper-right quadrant, high-right corner") rather than precise numbers — the map is directional, not quantitative.

### 3 — Identify the whitespace

The whitespace is the _empty_ region of the map — the quadrant with no current entry.

Ask:

- Is this quadrant empty because no one has tried, or because it's unviable?
- Would a new entrant succeed here, or would the constraints that keep it empty also block them?
- If whitespace exists, what would a player in that quadrant look like? (this becomes the "opportunity" or "threat-of-new-entrant" section of the downstream report)

Whitespace is often the most valuable output of positioning. Do not skip.

### 4 — Run two sanity checks

- **Swap check**: if you swap one axis for a different one from the list, does the map tell a materially different story? If the ordering of entities is stable under axis swap, your axes aren't capturing the real variance — pick sharper axes.
- **3-year check**: where was each entity on this map 3 years ago? If nothing has moved, the axes may be measuring an ossified dimension (e.g. vendor size) that doesn't capture competitive dynamics.

## Output shape

```
## Competitive Positioning — {category}

**Axes chosen:** {X-axis} (horizontal) × {Y-axis} (vertical)
**Why these axes:** {one sentence on why these capture the variance best; why not {alternative}}
**Orthogonality check:** {why X and Y are independent, not correlated}

**Placements:**

| Entity | X-axis coordinate | Y-axis coordinate | Evidence |
|---|---|---|---|
| {A} | {low/med/high} | {low/med/high} | {one sentence citing a source} |
| {B} | ... | ... | ... |
| {C} | ... | ... | ... |
| ... | ... | ... | ... |

**Map (ASCII visualization, optional):**

```

(Y-axis ↑ "high")
|
[D] | [A]
|
-------+---------(X-axis →)
|
[C] | [B]
|
(Y-axis ↓ "low")

```

**Quadrant analysis:**

- **Upper-right (leaders)**: {who's here, why, what they share}
- **Upper-left**: {who's here, why}
- **Lower-right**: {who's here, why}
- **Lower-left (laggards / entrants)**: {who's here, why}

**Whitespace:** {which quadrant is empty, and is it empty because unviable or because unaddressed? what would a player in that region look like?}

**Movement (optional, 3-year back-cast):** {who has moved? in which direction?}

**Limitations:** {why this map is stale in X months; which dimensions it ignores}
```

## Anti-patterns

- Do **not** place entities by vibes. Every placement needs a citation.
- Do **not** skip the whitespace. "All quadrants are occupied" is a valid answer, but it must be argued — most landscapes have at least one empty region.
- Do **not** use correlated axes (e.g. company-size × revenue — same dimension). The map will tell you nothing new.
- Do **not** apply this to <3 entities — a 2×2 with 2 entities is a line, not a map.
- Do **not** produce a 2×2 for a market in hypergrowth. The map goes stale before publication.

## Reference

- M. E. Porter, _Competitive Strategy: Techniques for Analyzing Industries and Competitors_, Free Press, 1980 (five-forces + positioning foundations).
- Gartner Magic Quadrant methodology (publicly documented on gartner.com/en/research/methodologies).
- W. C. Kim and R. Mauborgne, _Blue Ocean Strategy_, Harvard Business Press, 2005 (whitespace framework).
- Pairs with `analysis-of-competing-hypotheses` (for markets in churn where positioning is unstable), `write-imrad-report` (final doc), and `grounded-answer` (placement evidence must verify).

## Radarist binding

**Route** (minimum viable = the 2 marked ★):

1. ★ `compareCompetitors` — the purpose-built comparison; start here rather than assembling one by hand.
2. `findVendors` — who actually supplies this category, from the graph rather than recall.
3. ★ `listCommunityClusters` / `getCommunityReports` — Louvain communities give **empirically derived** market segments. Prefer them to two axes chosen by intuition, and say which axis came from data.
4. `findSimilarEntities` / `getGraphNeighbors` — near neighbours and whitespace.
5. `renderDiagram` (kind `risk-matrix` or `bubble`) — the quadrant should render, not be described in prose.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named below, then record the gap with `recordKnowledgeGap` rather than inventing the value.
