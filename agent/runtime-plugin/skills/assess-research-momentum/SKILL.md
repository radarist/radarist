---
name: assess-research-momentum
description: Use for "is research on X heating up?", "is this a hot area?", "publication trend for X", "is the field maturing?". Reads a `searchPapers` result set into a momentum signal — publication S-curve, citation velocity, author concentration, research-front vs mature.
---

# Assess Research Momentum

A quantitative read of _one search result set_ — not a market-narrative placement, not a literature synthesis.

## When to invoke

Trigger on phrases like "is research on {X} heating up?", "is {X} a hot area?", "publication trend for {X}", "is the field maturing or fading?", "how much academic attention is {X} getting?".

Skip for:

- Market-narrative questions ("is {X} overhyped?") — that's `apply-hype-cycle`. Momentum is the quantitative _input_ to a hype placement, not the placement itself.
- Requests for a comprehensive, reproducible literature survey with inclusion/exclusion criteria — that's `systematic-review`. This skill reads publication _metadata_ (counts, citations, authors), not the papers' findings.
- Deployment-readiness questions ("is {X} production-grade?") — that's `score-technology-readiness`, an orthogonal axis. A research area can have red-hot publication momentum while the underlying technology is still TRL 2.

## Procedure

### 1 — Gather

Call `searchPapers` for the area (narrow the query the same way `apply-hype-cycle` narrows a technology — "AI" is not momentum-assessable, "diffusion models for protein structure prediction" is). Use `yearFrom` to pull a multi-year window; don't cap the result to a single year's papers.

### 2 — Publication curve

Bucket the returned papers by publication year. Read the shape:

- **Rising** — year-over-year counts increasing, no plateau yet
- **Plateau** — counts flat for 2+ consecutive years after a rise
- **Decline** — counts falling for 2+ consecutive years
- **Too sparse to call** — fewer than ~15 papers total, or fewer than 3 years of coverage

### 3 — Citation velocity

Compute mean citations/paper/year (citation count ÷ years since publication, averaged across the set). Compare the velocity of the most recent third of the window against the earliest third:

- **Accelerating** — recent papers accumulating citations faster per elapsed year than older papers did at the same age
- **Steady** — comparable rate
- **Decelerating** — recent papers picking up citations more slowly

Citation counts for very recent papers (< 1 year old) are noisy by construction — note this rather than over-reading a low count as "ignored."

### 4 — Concentration

Count distinct authors and distinct institutions (when affiliation data is available) across the set:

- **Few distinct authors/institutions** (a handful of labs) → nascent or proprietary — the field is not yet a broad front
- **Many distinct authors/institutions across the set** → broad research front, harder for any one group to dominate

### 5 — Verdict + what would move it

Call one of: **research front** (rising curve, accelerating citations, broadening concentration) or **maturing/mature** (plateaued or declining curve, steady/decelerating citations, concentration no longer broadening). State the single observation that would flip the call (e.g., "a plateau read would flip to rising if the next 12 months add 2× the current annual count").

### 6 — Format

```
## Research Momentum — {area}

**Area:** {area}

**Window:** {yearFrom}–present, {N} papers ({source: openalex/crossref/semantic-scholar/all})

**Publication trend:** {rising / plateau / decline / too sparse to call} — {one-line evidence, e.g. "18 → 34 → 61 papers/year, 2023→2025"}

**Citation velocity:** {mean citations/paper/year}, {accelerating / steady / decelerating}

**Concentration:** {N} distinct authors / {M} distinct institutions — {nascent / broad front}

**Verdict:** {research front / maturing / mature}

**Confidence:** {low / medium / high} — {reason, e.g. "only 12 papers in the window, below the ~15 reliability floor"}

**What would move this:** {specific next-window observation that would flip the call}
```

## Anti-patterns

- Do **not** infer momentum from a single year's count. A momentum call needs at least 3 years of buckets.
- Do **not** equate citation count with quality or correctness — a highly-cited paper can still be a widely-cited retraction candidate; this skill measures attention, not truth.
- Do **not** call momentum on fewer than ~15 papers — state confidence as **low** and say the result set is too sparse for a reliable curve read instead of forcing a verdict.
- Do **not** conflate this with a hype-cycle placement. A rising publication curve is one _indicator_ that feeds Stage 1/2 of `apply-hype-cycle` — it is not itself a stage.

## Pairs with

- `apply-hype-cycle` — momentum is the quantitative input; hype-cycle is the market-narrative placement built from it plus press/VC/deployment indicators.
- `systematic-review` — reach for a full PRISMA review when the _content_ of the papers (not just their volume/velocity) needs synthesis.
- `score-technology-readiness` — orthogonal: TRL tracks what's been built and deployed, not how much the literature is talking about it.
- `triangulate-sources` — corroborate a momentum call with non-academic signals (HN discussion volume, funding rounds) before treating it as decision-grade.
