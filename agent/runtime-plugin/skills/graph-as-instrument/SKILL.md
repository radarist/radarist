---
name: graph-as-instrument
description: Use before answering a question the knowledge graph could answer better than recall — "what changed on my radar?", "which claims are contradicted?", "what are we missing?", "where are things converging?", "what should I look at next?". Opens with structure, gaps, temporal deltas, and claim health rather than a web search. For a single factual lookup use `grounded-answer` instead.
---

# Graph as Instrument

Most analysis skills reason _about_ a topic. This one reasons _from the graph_ — treating Radarist's temporal, evidence-bearing knowledge graph as a measuring instrument rather than a lookup table.

The graph holds things no web search can produce: what a claim rested on, whether that support has since been contradicted, which entities the structure says are converging, and what is provably absent. Those are the questions worth opening with.

## When to invoke

Invoke when the question is about **the state of what we know**, not about a single external fact:

- "What changed since I last looked, and does it invalidate a decision I already made?"
- "Which of my Adopt-ring technologies rests on evidence that has since been contradicted?"
- "Where is the graph seeing convergence before an analyst said so?"
- "What do we _not_ know that would most change this recommendation?"
- "What should I look at next?"

Skip when the answer is a single external fact — use `grounded-answer`. Skip when you need one entity's history only — `getEntityTimeline` alone is enough.

## The four passes

Run them in this order. Each narrows the next.

### 1 — Structure: what shape is this neighbourhood in?

- `listCommunityClusters` — the Louvain communities the graph actually found. These are empirical groupings; prefer them to categories you would have invented.
- `getCommunityReports` — the batch-generated narrative overlay per community.
- `getGraphAnalytics` — size, density and distribution, so you know whether the neighbourhood is rich enough to reason about at all.

A cluster that contains two technologies nobody has connected in prose is a convergence finding. Say so, and record it with `recordAgentObservation` so it reaches the briefing pipeline.

### 2 — Gaps: what is provably missing?

- `findConceptGaps` — concepts the graph expects but does not hold.
- `findDataGaps` — entities with structurally incomplete data.
- `getGapAnalysis` — the combined view.
- `findOrphanedEntities` — entities with no edges, which are usually an ingest failure rather than a real isolate.

A gap is a finding, not a failure. The highest-value output of this pass is often "the thing that would most change the answer is absent, and here is its shape" — which is the input `abstain-or-escalate` and `key-assumptions-check` need.

### 3 — Time: what moved, and what died?

- `getChangedSince` — the delta over a window. This is the honest basis for any "what's new" claim.
- `queryActiveEdges` — current facts only. An edge carrying `t_invalidated` is history and must not be quoted as present tense.
- `getTemporalEdgeStats` — is edge activity around this entity accelerating or flat?
- `getEntityTimeline` — one entity's full arc, including superseded edges.

### 4 — Trust: how well-supported is what remains?

- `getClaimHealth` — the platform's computed support and corroboration.
- `getRelationEvidence` / `getEntityAssertions` — the actual evidence behind a specific claim.
- `explainRelation` — why the platform believes an edge, and who asserted it.

**Read rule.** Order and filter on `coalesce(effectiveConfidence, confidence)` — never raw `confidence`. Corroboration is computed by the platform from distinct evidence sources; `entity_field` evidence is first-party and never counts as independent.

## Optional fifth pass — what next?

- `getPersonalizedRecommendations` — PageRank seeded from the entities the user currently cares about.
- `findEntitiesByMeaning` / `findByConcept` — semantic reach when the name match came up short.
- `findSimilarEntities` / `findDuplicateEntities` — structural neighbours, and duplicates that are corrupting the counts.

## Output shape

```
STRUCTURE   {n} communities in scope; notable cluster: {members} — {why it matters}
GAPS        {n} concept gaps, {n} data gaps; the one that would most change the answer: {gap}
TIME        {n} edges changed since {date}; {n} invalidated — affected conclusions: {list}
TRUST       claim health {level}; weakest load-bearing claim: {claim} ({n} distinct sources)
SO WHAT     {the decision this changes, or "no decision changes — here is why"}
```

## Anti-patterns

- Do **not** run a web search first. If the graph can answer it, the graph's answer is the one with provenance attached.
- Do **not** quote an invalidated edge in the present tense. Check `t_invalidated` before asserting a fact is current.
- Do **not** report a community as a "trend". A Louvain cluster is a structural observation; calling it a trend without temporal evidence is an overclaim.
- Do **not** treat an empty gap result as "no gaps". Confirm the finder actually ran against a populated scope — an empty graph produces empty gaps.
- Do **not** run all four passes for a trivial question. One pass, named, beats four passes skimmed.

## Reference

- Radarist relation-write contract — write through the assertion layer; read confidence as `coalesce(effectiveConfidence, confidence)`; treat corroboration as a confidence nudge rather than a duplicate fact; and never present a temporally invalidated assertion as current.
- Pairs with `abstain-or-escalate` and `key-assumptions-check` (both consume the gaps pass), `red-team-claim` (consumes the trust pass), and `generate-radar-report` (consumes structure + time).

## Radarist binding

Every tool named above is on the `graph` MCP server, which `UNIVERSAL_MCP_SERVERS` unions into all seven agent profiles — so this route is available to every agent with no configuration.

**Minimum viable route (3 calls):** `getChangedSince` → `getClaimHealth` → `findDataGaps`. That trio alone answers "what moved, is it still supported, and what's missing" inside a bounded turn budget.

In chat, note that `getClaimHealth`, `findConceptGaps`, `findSimilarEntities` and `executeCypher` are **not** in the chat tool surface — substitute `queryGraph`, `getGraphNeighbors` and `searchKnowledgeGraph`, and say which pass you could not run rather than implying you ran it.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap with `recordKnowledgeGap` rather than inventing the value.
