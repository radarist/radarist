---
name: read-patent-landscape
description: Use when reading a cluster of patents for competitive or white-space signal — "who owns the IP around X?", "patent landscape for X", "is this space getting crowded?", "where's the white space?". Reads assignee concentration, family growth, CPC clustering, and filing velocity. For one filing's claims use `analyze-patent-claims` instead.
---

# Read Patent Landscape

A cluster-level read across many filings — not a single-patent claim dissection.

## When to invoke

Trigger on phrases like "who owns the IP around {X}?", "patent landscape for {X}", "is this space getting crowded?", "where's the white space in {X}?", "IP concentration in {category}", "is anyone else filing in {CPC class}?".

Skip for:

- A single named patent or filing ("US11234567", "this patent") — that's `analyze-patent-claims`. This skill only starts once there are _multiple_ filings to compare.
- Trademark or design-patent clusters — different IP type/claims structure; defer.
- A cluster with fewer than ~5 filings found — too small to read concentration or velocity; say so rather than forcing a landscape read.

## Procedure

### 1 — Scope the cluster

Define the cluster by one of: a named assignee (all filings by a company), a CPC/IPC class (all filings in a technical area), or a topic/keyword (all filings matching a search term). Gather the candidate set with the `searchPatents` tool (keyless Google Patents) — pass the topic/keyword or assignee name; it returns real filings (patent number, title, assignee, priority/filing dates) plus `totalResults`, the full match count that is itself the crowding signal. Supplement with patent-specialist press (Lexology, IPWatchdog) or patent numbers from `analyze-patent-claims` runs when useful. Record how many filings the cluster contains and how they were found (this is the reproducibility trail). If `searchPatents` returns an error (it rate-limits bursts), say patent search was temporarily unavailable and retry — never fabricate filings or counts.

> **CPC/IPC note:** `searchPatents` does not return CPC/IPC codes (the search endpoint doesn't carry them). Step 4's classification read is therefore best-effort from titles/abstracts, or defer the class-level detail to `analyze-patent-claims` on specific filings.

### 2 — Assignee concentration

Tally filings per assignee. Read the shape:

- **Crowded / open** — filings spread across many assignees, no single holder above ~20-25% of the cluster
- **Concentrated** — one or two assignees hold a large share (Herfindahl-style: square each assignee's share, sum; a high sum means a few players dominate)

Name the top 3-5 holders by filing count.

### 3 — Family growth + filing velocity

Bucket filings by priority/filing year. Rising year-over-year filing counts = an active race (competitors racing to stake claims); flat or declining counts = the filing wave has passed, or the area has moved to trade-secret rather than patent protection.

### 4 — CPC/IPC clustering

Tally filings by CPC/IPC (sub-)class (see `analyze-patent-claims` §4 for the common Radarist-domain classes: `G06N`, `G06F`, `G16H`, `G01N`, `A61K`). Identify which sub-classes carry the most filings — that's where the technical crowding actually sits, which can differ from where the topic keyword search suggests.

### 5 — White-space

Identify CPC/IPC sub-classes or claim combinations _adjacent_ to the dense clusters that have little or no filing activity. A white-space observation is not automatically an opportunity — pair it with a demand signal (a named customer pain point, a funding-round thesis, a `research-technology` finding) before treating it as one.

### 6 — Format

```
## Patent Landscape — {cluster scope: assignee / CPC class / topic}

**Cluster:** {scope definition}, {N} filings found ({how found, e.g. "Google Patents search + press aggregation"})

**Top assignees:** {name: count, name: count, name: count} — {crowded/open or concentrated, with concentration rationale}

**Filing velocity:** {year-by-year counts} — {accelerating / flat / declining}

**Dense sub-areas (CPC/IPC):** {class: count, class: count}

**White-space:** {sub-class or combination with little activity} — demand signal: {present / absent}

**Confidence:** {low / medium / high} — {reason, e.g. "cluster assembled from press aggregation, not a full patent-office query"}
```

## Anti-patterns

- Do **not** treat filing volume as commercialization. A crowded filing cluster can still have zero shipped products — patents are filed years before (or instead of) launch.
- Do **not** read white-space as opportunity without a demand signal. An empty CPC sub-class can mean "nobody's found the idea yet" or "nobody wants it" — the landscape alone can't tell you which.
- Do **not** run this on a single filing. If the cluster has fewer than ~5 filings, use `analyze-patent-claims` on each one individually instead.
- Do **not** conflate distinct family members (US continuation, EP divisional, CN national phase) as separate filings when tallying — dedupe by patent family before counting concentration or velocity.

## Note on tooling

This skill operates on web/patent search results assembled manually today (Google Patents links, patent-specialist press, `analyze-patent-claims` outputs accumulated across a session). It fully lights up when a dedicated `searchPatents` tool lands — at that point step 1 becomes a single structured query instead of an assembled search.

## Pairs with

- `analyze-patent-claims` — run per-filing once the landscape flags a cluster worth reading claim-by-claim.
- `estimate-market-size` / `detect-funding-round` — a demand signal to validate (or invalidate) a white-space read.
- `position-competitor` — assignee concentration feeds directly into a competitive map's IP-moat axis.
- `triangulate-sources` — corroborate a filing-velocity read with non-patent signals (hiring, funding, product launches) before calling a space "an active race."
