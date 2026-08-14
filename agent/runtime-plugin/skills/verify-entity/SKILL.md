---
name: verify-entity
description: Use when validating an entity's data quality and freshness. Checks staleness, cross-references current sources, records a verification result, and flags disputes for human review.
---

# Verify Entity

## Steps

1. **Check freshness** — when was entity last updated?
   - > 90 days: flag "stale"
   - > 180 days: flag "critical review needed"

2. **Cross-reference sources** — call `search_with_grounding` with entity name
   - Compare key facts (funding, status, team) with current web data
   - Note contradictions

3. **Create VerificationResult** — store in Neo4j:
   - sourcesChecked, sourcesConfirming, sourcesContradicting
   - verificationScore via scoring algorithm
   - status: verified | unverified | disputed

4. **Flag disputes** — if contradicting sources > confirming sources:
   - Emit `agent.event` with type `verification.disputed`
   - Add to user's review queue

## Radarist binding

Ordered route — these four:

1. `getEntityTimeline` — the chronological edge history, including invalidated edges.
2. `getChangedSince` — what moved in the window.
3. `search_with_grounding` (missions) or `webSearch` (chat) — reconcile key facts against current sources.
4. `getClaimHealth` — the platform's own view of how well-supported this entity is.

Read confidence as `coalesce(effectiveConfidence, confidence)`. An edge carrying `t_invalidated` is history, not a current fact.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
