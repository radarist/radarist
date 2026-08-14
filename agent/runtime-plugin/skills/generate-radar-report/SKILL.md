---
name: generate-radar-report
description: Use when creating a radar landscape or strategic report. Gathers placements by ring and quadrant, identifies movements against the previous period, renders the radar figure inline, and ships through the draft-then-publish path.
---

# Generate Radar Report

## Steps

1. **Gather radar data** — query all placements, grouped by ring and quadrant
2. **Identify trends** — compare with previous period (temporal queries)
3. **Analyze movements** — technologies that changed ring/quadrant
4. **Generate narrative sections**:
   - Executive summary (2-3 sentences)
   - Key movements (what changed and why)
   - Emerging technologies (Assess ring highlights)
   - Strategic recommendations (based on Adopt ring + competitive landscape)
5. **Render the radar figure** — call `super-graph` `renderDiagram` (kind `tech-radar`) and embed the returned inline `<svg>` exactly as returned
6. **Compile HTML report** — combine narrative + the inline radar SVG + data tables (no remote `<img>` URLs — the publication policy rejects off-origin resources)
7. **Publish** — `draftReport` with the final HTML, then `publishReport` (draft-then-publish is the only save path)

## Radarist binding

Ordered route — these five. Note the creator profile does not mount the `radar` server, so placements are read through the universal `graph` server:

1. `getEntityContext` — placements, rings and quadrants.
2. `getChangedSince` — the movements section is a temporal delta, not a recollection.
3. `renderRadarDiagram` — embed the returned inline SVG exactly as returned; no remote `<img>`.
4. `draftReport`
5. `publishReport` — draft-then-publish is the only save path.

Reachability: `draftReport` and `publishReport` mount on `impulse-reports`, which only the **creator** profile carries, and they are additionally mission-bound (hidden without a bound mission). That is correct for this skill — producing the report is creator's job. Any other profile running it must stop at the drafted HTML and hand off; do not look for another save path, there isn't one.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
