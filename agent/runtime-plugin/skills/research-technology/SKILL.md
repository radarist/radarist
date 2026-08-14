---
name: research-technology
description: Use when discovering or enriching a technology entity. Checks the graph, gathers academic and patent evidence, assesses readiness and key players, then creates or updates the entity and proposes a radar placement.
---

# Research Technology

## Steps

1. **Check graph first** — call `searchKnowledgeGraph` with technology name
2. **Academic search** — check arXiv / Google Scholar for recent papers
3. **Patent check** — search for recent patent activity
4. **Industry assessment**:
   - TRL (Technology Readiness Level): 1-9
   - Key players (companies working on it)
   - Use cases (applications in radar's domain)
   - Competitive alternatives
5. **Create/update entity** — call `createDecoupledTechnology` or update existing
6. **Propose radar placement** — based on TRL:
   - TRL 1-3: Assess ring
   - TRL 4-6: Trial ring
   - TRL 7-8: Trial/Adopt ring
   - TRL 9: Adopt ring
7. **Link to companies** — create relations to companies identified in step 4

## Radarist binding

Ordered route — these five, in this order:

1. `searchKnowledgeGraph` — exists already? Enrich rather than create.
2. `searchPapers` — the maturity evidence (keyless).
3. `searchPatents` — filing activity (keyless).
4. `createDecoupledTechnology` — or update the existing entity.
5. `placeTechnologyOnRadar` — the TRL terminates in a placement, not a sentence.

Confidence is 0–100. A machine-asserted claim below 75 stays `proposed` and materializes no edge.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
