---
name: design-pass
description: Use when creating a visual report with charts or infographics. Establishes and enforces ONE design brief — theme, brand-exact palette, typography — across every chart, every infographic, and the report HTML. Two paths — CONCEPTION up front, and REVIEW before `publishReport`.
---

# Design Pass

Keeps a report visually coherent end-to-end. The single source of truth is the mission's **DesignBrief** (`mission.designBrief` — theme + palette + typography), resolved once and applied to charts, infographics, and the report HTML. You never re-specify colors per chart — they flow from the brief.

## Conception — runs up front (assistant proposes, mission finalizes)

1. **User specified a look** (theme / palette / sections / "light report") → honor it verbatim; the brief's `source` is `user`.
2. **User said nothing** → use the brand default (**brand-dark editorial**, brand-exact chart sequence — gold leads) and tell the user which default you picked (`source: 'auto'`), e.g. "you didn't specify a theme, so I used dark editorial — say the word for light."
3. The brief is attached at mission creation. The chart renderer (`renderDiagram`, on the `super-graph` server) and the infographic generator (`gemini-image`) read it automatically and produce **brand-exact** colors. Pass `theme: 'brand-light' | 'brand-dark'` to `startMission` when the user asked for a specific look.

## Review — before `publishReport`

1. The brand analyzer checks the drafted HTML against the brief, including **chart palette-conformance** (every SVG `fill` should be in the brief palette; CSS/prose/neutrals are ignored). Brand and palette findings are recorded for telemetry but do not withhold the artifact.
2. **Off-palette CHART** → re-render it via `renderDiagram` on the `super-graph` server (it applies the brief theme). Never hand-color SVG fills.
3. **Off-brand INFOGRAPHIC** → regenerate it **once** by calling the image tool again with the brief's exact hexes restated in the prompt. Cap at one regeneration; if it's still off, ship it with the verdict recorded.
4. `publishReport` also runs deterministic WCAG contrast checks. Ratios below **3.0:1** are hard failures; the **3.0–4.5:1** band is advisory. A hard contrast failure persists the artifact as `needs-review`, preventing public sharing until it is repaired or explicitly approved.
5. An analyzer error never becomes a silent pass. The artifact is persisted with `designPassVerdict: 'UNREVIEWED'` and retained as `needs-review`.
6. A brand-only `FAIL` remains owner-visible and `published`, with `designPassDetails` retained for inspection. The publish tool persists the artifact in every case; "published" here is the private lifecycle state, not permission to invent or expose a public `/share/report/...` URL.

## When to invoke

- **Conception:** at the start of any report/creator mission (automatic via mission creation).
- **Review:** after the report HTML is drafted, before `publishReport`.

## Reachability

`publishReport` and `startMission` mount on `impulse-reports`, which only the **creator** profile carries; `publishReport` is additionally mission-bound. That matches how this skill runs — creator publishes its own artifact. Named from any other profile they are a handoff: apply the brief to the drafted HTML and hand the artifact on, rather than looking for another publish route.

## When to skip

- Non-visual outputs (plain-text SBAR/IMRAD briefs, chat replies) — no charts/infographics to align.
