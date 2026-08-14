---
name: estimate-market-size
description: Use when sizing a market — "how big is the X market?", "TAM / SAM / SOM for …", "multi-billion market", "expected to reach $X by Y", "market valued at". Triangulates a top-down and a bottom-up estimate that must agree within an order of magnitude, else the claim is rejected as unsupported.
---

# Estimate Market Size

Fermi-estimation applied to markets. Single-source market sizes are a known hallucination surface — this skill forces triangulation.

## When to invoke

Trigger on phrases like "how big is the {X} market?", "what's the TAM for {X}?", "market size of {X}", "market valued at $X", "expected to reach $Y by {year}", "total addressable market", "sizable opportunity".

Skip when:

- The question is about unit-level pricing ("what does {X} cost per user?") — not aggregate market size.
- The user explicitly asks for a single-source answer ("what does Gartner say?") — honor that; don't force triangulation.
- The market is smaller than $10M — the rigor costs more than the accuracy gained.
- The market is in pre-revenue / pre-product stage — sizing a non-existent market is forecasting, not estimation; flag and recommend scenario analysis instead.

## The three market-size layers

| Layer                             | Definition                                                                                  | Typical ratio |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ------------- |
| **TAM** (Total Addressable)       | Everyone who could theoretically buy the product in the entire market                       | 100%          |
| **SAM** (Serviceable Addressable) | The segment the vendor can actually reach given their geography, regulation, language, etc. | 10–30% of TAM |
| **SOM** (Serviceable Obtainable)  | The realistic near-term share the vendor can capture                                        | 1–10% of SAM  |

Be explicit about which layer the claim refers to. "$50B market" is meaningless without specifying TAM vs SAM vs SOM — a 10× difference between TAM and SOM is normal.

## The two independent estimates

Every defensible market size needs **two** estimates from different directions:

### Top-down

Start from a known **larger** market total and apply a segment ratio to derive the target.

```
Target Market = Larger Market × Share-of-Category × Share-of-Geography × Share-of-Segment
```

Example: Cloud AI services market size

- Larger: Global cloud services market = $800B (Gartner 2026)
- Share of AI within cloud: ~15% = $120B
- Share addressable (North America + EU): ~60% = $72B
- Share of enterprise segment (vs consumer): ~80% = $58B
- **Top-down TAM estimate: ~$58B**

Cite every ratio. "Share-of-AI = 15%" needs a source.

### Bottom-up

Start from **unit economics** and multiply.

```
Target Market = (Number of buyers) × (Adoption rate) × (Average revenue per user / year)
```

Example: Cloud AI services — bottom-up

- Number of enterprises (>500 employees) in NA+EU: ~80,000 (Census + Eurostat)
- Adoption rate of AI services: ~40% (survey data, 2026)
- ARPU for AI services: ~$1.8M/year (based on typical enterprise AI spend reports)
- **Bottom-up TAM estimate: 80,000 × 0.40 × $1.8M = $57.6B**

Cite every multiplier. "Adoption rate = 40%" needs a source.

### Compare

- If the two estimates agree within **an order of magnitude** (say, 0.33× to 3×), the claim is supported. Report the geometric mean or the narrower of the two.
- If they disagree by **>3×**, reject the claim as unsupported. Either the top-down ratios are wrong, or the bottom-up ARPU/adoption is wrong, or the market definition differs between the two approaches.

**Disagreement is information.** It tells you which input to re-investigate. Do not paper over it.

## Procedure

### 1 — Fix the market definition

Specify: **which product category × which buyers × which geography × which time frame**. Example: "LLM API services for enterprise developers in North America in 2026."

Vague definitions ("the AI market") are unsizable. Narrow until the claim is testable.

### 2 — Pick the layer (TAM, SAM, or SOM)

If the source doesn't specify, default to TAM and note the ambiguity.

### 3 — Run the top-down estimate

Document each ratio with a citation. End with a single dollar figure.

### 4 — Run the bottom-up estimate

Document each multiplier with a citation. End with a single dollar figure.

### 5 — Compute the ratio

`top-down / bottom-up`. If 0.33 ≤ ratio ≤ 3, claim is supported. Otherwise, reject.

### 6 — Report with honest uncertainty

Market sizes are inherently noisy. Report a range, not a point:

```
Estimated TAM: $45B – $65B (mid-point $55B, based on top-down + bottom-up triangulation).
```

### 7 — Format

```
## Market Size Estimate — {market definition}

**Market definition:** {product category} × {buyer segment} × {geography} × {time frame}
**Layer:** TAM / SAM / SOM

### Top-down estimate

Starting: {larger market} = {$ amount} ({source})
× share of {category}: {%} ({source})
× share of {geography}: {%} ({source})
× share of {segment}: {%} ({source})
= **{top-down total}**

### Bottom-up estimate

Buyer count: {N} ({source})
× Adoption rate: {%} ({source})
× ARPU: {$ per year} ({source})
= **{bottom-up total}**

### Triangulation

- Top-down: {$X}
- Bottom-up: {$Y}
- Ratio: {X/Y} (supported if 0.33 ≤ ratio ≤ 3, reject otherwise)

**Verdict:** {supported / rejected}
**Estimated market size:** {$low – $high}, midpoint {$mid}
**1σ uncertainty:** ~{%}

**Assumptions most likely to be wrong:** {the input whose sensitivity dominates the estimate}
**Sources to verify first:** {which citations would most change the answer if incorrect}
```

## Anti-patterns

- Do **not** take a single source's number at face value. Gartner, IDC, McKinsey publish different numbers for the same market; the spread is informative.
- Do **not** mix TAM from one source with bottom-up from a completely different market definition. They must cover the same product × buyer × geography × time.
- Do **not** hide disagreement. If top-down and bottom-up diverge by >3×, that is the report — not a problem to hide.
- Do **not** report a point estimate. Markets are uncertain; report ranges.
- Do **not** forecast without an explicit forecast period. "Expected to reach $X by {year}" needs to separate current market size from growth assumptions.

## Reference

- E. Fermi, "Fermi Estimation" (original back-of-envelope method; see e.g. _How Many Piano Tuners in Chicago?_).
- McKinsey & Company, "Market-Sizing Primer," internal guide.
- D. Osterwalder and Y. Pigneur, _Business Model Generation_, Wiley, 2010 (TAM/SAM/SOM framework).
- Fermi-style estimation practice: Guesstimate.com, _Back of the Envelope_ by J. Hughes.
- Pairs with `triangulate-sources` (requires ≥2 independent sources per input), `rate-source-admiralty` (grade each source of a ratio/multiplier), and `abstain-or-escalate` (when the top-down/bottom-up disagreement exceeds 3×).

## Radarist binding

The bottom-up leg needs real revenue-per-customer, and filings disclose it:

- `searchSecFilings` — segment revenue, customer counts, ARPU, disclosed TAM claims by filers.
- `searchEntities` / `getGraphAnalytics` — how many entities of this type the graph already knows, as a sanity denominator.
- `searchHackerNews` — pricing and adoption anecdotes for order-of-magnitude checks.

Market figures are the highest-risk claim class this platform emits. Every headline number carries its source, and a top-down/bottom-up gap beyond one order of magnitude is reported as unsupported rather than averaged.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
