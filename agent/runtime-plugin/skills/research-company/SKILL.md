---
name: research-company
description: Use when discovering or enriching a company entity. Checks the graph first, researches primary sources, creates or updates the entity, and proposes evidence-backed relations for human review.
---

# Research Company

## Steps

1. **Check graph first** — call `searchKnowledgeGraph` with company name
   - If entity exists: note existing data, skip to step 4 (enrichment)
   - If not: proceed to step 2

2. **Web research** — call `search_with_grounding` with "{company name} company overview funding team"
   - Extract: founding year, HQ, funding, team size, sector, key products

3. **Create entity** — call `createCompany` with extracted data
   - Include: name, sector, description, websiteUrl, fundingStage

4. **Discover relations** — call `searchKnowledgeGraph` for related technologies and use cases
   - For each evidence-backed match with confidence >= 70: call `proposeVerifiedRelation`
   - Include evidence source URL from step 2

5. **Verify data quality** — check completeness:
   - Has description? Has sector? Has at least 1 relation?
   - If incomplete: flag for future enrichment

## Quality Criteria

- Every fact must have a source URL
- Confidence scores on all relations
- Prefer recent sources (< 12 months old)

## Radarist binding

Ordered route — these five, in this order:

1. `searchKnowledgeGraph` — exists already? Enrich rather than duplicate.
2. `searchSecFilings` — authoritative for funding, revenue and structure of a filer. Prefer it to press coverage for any number.
3. `researchCompanyComprehensive` — the bundled fallback when filings do not cover it.
4. `createCompany` — or update the existing entity.
5. `proposeVerifiedRelation` — proposals only, each citing a source that supports that specific relation.

Reachability: `proposeVerifiedRelation` and `listPendingProposedRelations` mount on `impulse-entities`, which every profile carries — propose each candidate relation directly and it stays pending until a human decides. Do not substitute `createRelationWithEvidence`: it writes the relation rather than proposing it, and this skill proposes only. If a proposal call fails, record that candidate with `recordAgentObservation` (`observationType: 'connection'`, citing the source URL) and name it in the output for triage.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
