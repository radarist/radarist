---
name: oss-project-health
description: Use when assessing an open-source project's viability — "is this project maintained?", "bus factor", "is it dying?", "should we depend on this?". Reads `searchOssHealth` signals — release cadence, contributor concentration, issue latency — into a maintenance verdict.
---

# OSS Project Health

A CHAOSS-style vitality read of one repository — not a hype placement, not a TRL score.

## When to invoke

Trigger on phrases like "is {X} well-maintained?", "bus factor of {X}?", "is this project dying?", "OSS health of {X}", "can we depend on {library}?", "is {repo} actively developed?".

Skip for:

- Market-narrative questions ("is {X} overhyped?") — that's `apply-hype-cycle`. A project can be healthy and unhyped, or hyped and unhealthy; the two axes are independent.
- Deployment-maturity questions ("what TRL is {X}?") — that's `score-technology-readiness`. A TRL-9 de-facto-standard project can still be one burned-out maintainer away from abandonment; this skill catches that risk, TRL doesn't.
- A project with no GitHub presence (internal-only, closed-source) — `searchOssHealth` needs an `owner/repo` slug; there's nothing to fetch.

## Procedure

### 1 — Fetch

Call `searchOssHealth` with the full `owner/repo` slug (not a bare project name — resolve the owner first if unknown, e.g. `pgvector/pgvector` not `pgvector`). Note which fields came back null; Ecosyste.ms doesn't cover every metric for every repo, and a null field means "data not found," not zero.

### 2 — Adoption

Read stars trajectory and, when available, downloads/dependents. A high star count with flat or declining recent growth signals past-peak attention, not necessarily unhealthy — pair with cadence (step 4) before calling a verdict.

### 3 — Bus factor

Read contributor concentration. Few contributors (especially one dominant committer) = fragile — the project depends on a small number of people continuing to show up. Many active contributors spreads the risk.

### 4 — Cadence

Read last-commit recency and release rhythm. A long gap since the last commit is a stronger abandonment signal than a low raw commit count — a stable, feature-complete library can commit rarely and still be alive (see anti-patterns). Look for the combination: no commits _and_ no releases _and_ no response to open issues.

### 5 — Responsiveness

Where issue/PR latency data is available, read how quickly maintainers respond and close/merge. Long-open, unanswered issues alongside a stalled commit cadence reinforce an at-risk read; a single stat alone doesn't.

### 6 — Risk

Check for open security advisories. Any unpatched advisory older than a normal fix window is a direct risk factor, independent of the other four signals — surface it even if the project otherwise reads healthy.

### 7 — Verdict

Call one of:

- **Healthy** — active cadence or a stable feature-complete pattern, no unpatched advisories, contributor base not critically concentrated
- **At-risk** — one or two concerning signals (e.g. bus factor of 1, or slow issue response) but not full stall
- **Abandoned** — no commits, no releases, no issue response, sustained over a long window

State the single biggest risk driving the verdict.

### 8 — Format

```
## OSS Project Health — {owner/repo}

**Project:** {owner/repo}

**Adoption:** {stars, trajectory}; downloads/dependents: {value or "data not found"}

**Bus factor:** {contributor concentration read} — {fragile / spread}

**Cadence:** last commit {date}; release rhythm: {value or "data not found"}

**Advisories:** {open advisory count/summary, or "none found"}

**Verdict: {healthy / at-risk / abandoned}** — biggest risk: {one sentence}

**Confidence:** {low / medium / high} — {reason, e.g. "issue-latency and downloads fields were null for this repo"}

**Data:** Ecosyste.ms (CC-BY-SA 4.0)
```

## Anti-patterns

- Do **not** equate stars with health. Star count reflects past attention, not current maintenance — a project can be starred heavily and still be unmaintained for years.
- Do **not** call a stable, feature-complete project "abandoned" purely on low commit cadence. Some libraries are simply _done_ — check for release activity, issue responsiveness, and advisory handling before concluding decline rather than stability.
- Do **not** guess at a null metric. When `searchOssHealth` returns a null/missing field, say "data not found" for that field — never fill it in from memory or estimation.
- **Always preserve the CC-BY-SA attribution** ("Data: Ecosyste.ms (CC-BY-SA 4.0)") in the output whenever any number from `searchOssHealth` is quoted in a report, chat answer, or graph note — this is a license requirement, not a style preference.

## Pairs with

- `apply-hype-cycle` — orthogonal: hype is market narrative, health is repo-level engineering vitality.
- `score-technology-readiness` — orthogonal: TRL is deployment-evidence maturity, health is current-state maintenance risk on one repo.
- `evolution-stage` — a Wardley-stage "Product" or "Commodity" call should be checked against health; a commodity-stage technology with an abandoned reference implementation is a flagged risk, not a contradiction.
- `abstain-or-escalate` — when `searchOssHealth` returns mostly-null data, escalate rather than force a verdict from an incomplete read.
