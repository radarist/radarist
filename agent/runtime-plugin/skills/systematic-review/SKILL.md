---
name: systematic-review
description: Use for a comprehensive, reproducible survey of the literature or signal corpus — "what does the research say about X?", "comprehensive review of …", "systematic review", "what's the evidence base for …". Structures the process around PRISMA 2020 with an audit trail of why each source was included or excluded.
---

# Systematic Review

Produce a reproducible survey of the evidence on a topic, following PRISMA 2020 reporting standards.

## When to invoke

Trigger on phrases like "systematic review of", "comprehensive review", "survey the literature on", "what's the evidence base for", "what does the research say about …", or when the user is preparing a report that will be peer-reviewed / cited.

Skip when the user wants a quick scan (use `web-research` directly) or a single grounded answer (use `grounded-answer`). Systematic reviews take meaningful work — only invoke when the reproducibility is worth it.

## The PRISMA 2020 flow

```
Identification: {N1} records found through search
  └─ {N1a} database queries, {N1b} graph queries, {N1c} citation snowballing
Screening: {N2} records after duplicate removal
  └─ {N2 - N3} excluded at title/abstract level
Eligibility: {N3} full texts assessed
  └─ {N3 - N4} excluded, with reasons:
     - Out of date window: {count}
     - Wrong population / scope: {count}
     - Insufficient evidence grade: {count}
Included: {N4} records in qualitative synthesis
  └─ {N5} of those in quantitative synthesis
```

Every arrow in that diagram needs a count and, for exclusions, a reason.

## Procedure

### 1 — Pre-register the protocol

Before searching, write down:

- **Question** (PICO if clinical: Population, Intervention, Comparator, Outcome; PECO, or free-form for non-clinical)
- **Inclusion criteria**: what makes a source in-scope (date, source type, domain, language)
- **Exclusion criteria**: what knocks a source out (e.g. "opinion pieces without primary data")
- **Search strategy**: the exact queries to run against each source (graph, web, databases)
- **Quality threshold**: minimum Admiralty grade and/or RoB rating for inclusion

Save the protocol at the top of the review. If the protocol changes mid-review, note the change and why. This is the difference between "systematic" and "ad hoc."

### 2 — Identification (cast the net)

Run all searches listed in the protocol. Sources:

- **Graph**: `searchKnowledgeGraph`, `getCommunityReports`, `queryActiveEdges` on relevant edge types
- **Web**: `webSearch` with the pre-registered queries (the `exa` MCP's `web_search_exa` is an additional source where it is wired)
- **Academic**: `searchPapers` — keyless OpenAlex + Crossref + Semantic Scholar; follow with `resolveOpenAccess` to screen full text rather than abstracts
- **Snowballing**: cited references in any source that passes eligibility

Record the raw count per source. Deduplicate (by DOI / URL / title hash).

### 3 — Screening (title + abstract)

For each record, decide INCLUDE / MAYBE / EXCLUDE from title + abstract only:

- **INCLUDE**: clearly meets criteria → move to eligibility
- **MAYBE**: can't tell from title alone → move to eligibility (err on the side of inclusion at this stage)
- **EXCLUDE**: clearly fails criteria (wrong topic, wrong date, wrong language) → log the exclusion reason

A second reviewer (a second skill pass, or a human) re-screens a 10% sample to estimate inter-rater agreement. If agreement < 80%, refine the inclusion criteria and re-screen.

### 4 — Eligibility (full text)

Read the full text of every surviving record. Apply the protocol's criteria strictly. Common exclusion reasons:

- Insufficient methodological detail (can't assess bias)
- Outside the pre-registered date window
- Doesn't actually measure the outcome of interest
- Secondary source that re-reports a primary already in the set

Log every exclusion with reason. This list is the audit trail.

### 5 — Grade the included set

For each included source:

- **Admiralty grade** via `rate-source-admiralty`
- **Risk of bias** via `assess-study-bias` (for empirical studies) or a lighter heuristic for non-empirical sources
- **Sample size / n** if applicable
- **Key finding** in one sentence

This grading feeds into synthesis weights — higher-quality sources get more weight.

### 6 — Synthesize (qualitative)

For each sub-question within the review, narrate what the included sources collectively say:

- Convergent findings (what most sources agree on)
- Divergent findings (where they disagree, and why — different methods, populations, definitions)
- Gaps (questions the literature doesn't answer, or doesn't answer well)

Cite each claim with the specific sources. Use `cite-ieee` for the reference list.

### 7 — Synthesize (quantitative, if applicable)

If the included sources report comparable quantitative outcomes and you have effect sizes + sample sizes, consider a meta-analytic pooling:

- Fixed-effect if heterogeneity is low
- Random-effects (DerSimonian-Laird) if heterogeneity is high

Report I² (heterogeneity statistic) alongside the pooled estimate. If I² > 75%, pooling is probably inappropriate — describe heterogeneity instead.

Most Radarist reviews will be qualitative. Only reach for meta-analysis when the numerical alignment is genuinely there.

### 8 — Render

Use `write-imrad-report` for the final document. The Methods section IS the pre-registered protocol (with any amendments logged). The Results section reports the PRISMA flow diagram + the synthesis.

## Anti-patterns

- Do **not** skip the protocol. Searching first and writing the criteria after is ad-hoc, not systematic.
- Do **not** hide excluded sources. The exclusion list (with reasons) is part of the review, not an appendix to be quietly dropped.
- Do **not** pool effect sizes that aren't comparable. Two studies measuring "accuracy" with different test sets are not the same outcome.
- Do **not** claim a systematic review when you did a casual survey. Call a casual survey a "scan" and reserve "systematic review" for the full PRISMA flow.
- Do **not** over-trust a single-reviewer screen. A second pass (or a sanity-check sample) is standard.

## Output shape

```
# Systematic Review: {topic}

**Protocol (pre-registered {date})**:
- Question: {PICO or free-form}
- Inclusion: {criteria}
- Exclusion: {criteria}
- Sources searched: {list}
- Quality threshold: {Admiralty ≤ X, RoB = Low-Some concerns}

**PRISMA flow**:
{the diagram with counts}

**Included sources** ({N}):
{table: citation, year, source type, Admiralty grade, RoB, key finding}

**Synthesis**:
{IMRAD Results + Discussion}

**Excluded sources** ({N}):
{table: citation, exclusion reason}

**References**:
{IEEE list via cite-ieee}
```

## Reference

- M. J. Page et al., "The PRISMA 2020 statement: an updated guideline for reporting systematic reviews," _BMJ_, vol. 372, p. n71, Mar. 2021. doi: 10.1136/bmj.n71
- J. P. T. Higgins et al. (eds.), _Cochrane Handbook for Systematic Reviews of Interventions_, version 6.4. Cochrane, 2023. https://training.cochrane.org/handbook
- Pairs with `assess-study-bias` (per-study RoB), `write-imrad-report` (final doc), `cite-ieee` (references), `rate-source-admiralty` (quality threshold), and `grounded-answer` (each synthesized claim should be internally verifiable).
