---
name: discover-relations
description: Use when finding evidence-backed connections between entities for human review. Proposes candidates with honest per-relation evidence and never auto-applies. For an exact current user directive naming both entities use the curated `createRelation` path instead.
---

# Discover Relations

## Steps

1. **Select entity pair** — pick two entities that may be related
2. **Check existing relations** — query graph for existing edges
3. **Assess confidence** (0-100):
   - Direct evidence (URL, document, claim): 80+
   - Inferred from shared attributes: 50-70
   - Weak semantic similarity only: 30-50
4. **Propose, never auto-apply**:
   - Evidence-backed discovery creates a durable `proposeVerifiedRelation` candidate for human review.
   - Confidence controls ranking and whether a weak candidate should be withheld; it does not grant write authority.
   - Below the configured proposal threshold, abstain or record the knowledge gap instead of creating graph noise.
5. **Include honest evidence** — every proposal must cite at least one source that actually supports the specific relation.
6. **Keep direct human instructions separate** — only a current authenticated user directive naming both exact entities may use the direct curated `createRelation` path. That is not relationship discovery.

## Radarist binding

Ordered route — these five, in this order:

1. `getRelatedEntities` — what edges already exist around the pair?
2. `getEntityAssertions` — read the existing assertions before adding another.
3. `getRelationEvidence` — read the evidence behind them.
4. `proposeVerifiedRelation` — the only write. Never auto-apply.
5. `recordKnowledgeGap` — below the threshold, record the gap instead of creating noise.

Reachability: `proposeVerifiedRelation` and `listPendingProposedRelations` mount on `impulse-entities`, and `getEntityAssertions` / `getRelationEvidence` on `impulse-graph` — both universal, so linker, scout and curator can run this skill end to end: check what is already pending, then propose each candidate, which stays pending until a human decides. Do **not** substitute `createRelationWithEvidence` — it writes the assertion instead of proposing it, which is exactly the auto-apply this skill forbids. If a proposal call fails, record that candidate with `recordAgentObservation` (`observationType: 'connection'`, one per candidate, citing the source) and state it in the output for triage rather than dropping it.

Confidence is 0–100 and controls ranking, not write authority. Corroboration is computed by the platform from distinct evidence sources — do not restate it by hand; `entity_field` evidence never counts as independent. Same-turn discovery and approval is forbidden.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
