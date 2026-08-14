---
name: critique-report
description: Use after a report or brief is drafted and before it reaches a user. Runs a 10-point structural self-review — question answered, evidence sourced, anti-patterns avoided, reproducible, confidence honest — plus three conditional innovation-practice points. For a single headline claim use `red-team-claim` instead.
---

# Critique Report

A mandatory self-review gate before publication. Catches the failures that reviewers would catch before they see it.

The base 10 points always apply. Three conditional points (11–13) apply only when the brief's structure invokes them — they cover innovation-practice discipline (JTBD framing, Wardley evolution-stage, Three Horizons) for the brief types that need them. Smart gating, not blanket enforcement.

## When to invoke

Trigger after:

- `write-imrad-report` produces a draft
- `write-srl-brief` produces a brief
- `generate-radar-report` produces a landscape report
- `systematic-review` produces its synthesis
- Any structured multi-section output ≥ 400 words heading to a user

Skip for:

- Short chat replies (no structured report to critique)
- Intermediate notes / scratch work (only the user-facing deliverable is gated)
- Outputs already reviewed (don't loop forever — one pass is enough unless you've made structural changes)

## The 10-point review

For each point: **pass ✅**, **fix needed ⚠️**, or **critical block 🔴**. Any 🔴 blocks publication; ⚠️ are fixes to apply before shipping.

### 1. Does it answer the question that was asked?

The user's original question: restate it in one sentence. Does the report answer _that_, or does it answer an adjacent question?

**Pass**: user's question is explicitly restated in intro/summary, and the report delivers a specific answer.
**Fix**: user's question is implicit or the answer is hedged.
**Block**: the report answers a different question than the one asked.

### 2. Is the evidence sourced?

Every factual claim has a citation. Either inline numbers `[1]`, `[2]` or an end-of-section footnote.

**Pass**: every non-trivially-true claim has a citation; citations are in the reference list.
**Fix**: some claims are un-cited but trivially verifiable.
**Block**: significant un-cited claims, OR citations that don't resolve.

Run `verify-citations` in parallel to catch broken DOIs / arXiv IDs.

### 3. Are the anti-patterns avoided?

Check against known anti-patterns for the report type:

- IMRAD: interpretation in Results section (belongs in Discussion)
- SRL brief: editorializing in Situation (belongs in Assessment)
- Radar report: unsourced ring placements
- Systematic review: hidden exclusion list

**Pass**: no anti-patterns detected.
**Fix**: minor anti-pattern (e.g. one phrase of interpretation in Results).
**Block**: systematic anti-pattern pervades the report.

### 4. Is the structure reproducible?

Could another analyst re-derive the report from the same sources? The Methods section (IMRAD) or equivalent must specify:

- Which sources queried
- Which queries ran
- Which selection criteria applied

**Pass**: methods are specific enough to reproduce.
**Fix**: methods mentioned but vague.
**Block**: no methodology disclosed; results appear as assertions.

### 5. Is confidence honest?

Every recommendation or headline claim carries a confidence score. Confidence should match evidence quality:

- A1 source + triangulated → 0.85–0.95
- A2 single source → 0.70–0.85
- B2 or lower → 0.40–0.70
- Un-triangulated claim → < 0.7

**Pass**: confidence scores match evidence grades.
**Fix**: confidence is over- or under-stated by >0.1.
**Block**: recommendations have no confidence score, or confidence is inflated relative to evidence.

### 6. Are limitations stated?

Every non-trivial report has limitations. What did the analysis NOT cover? What assumptions are load-bearing?

**Pass**: explicit limitations section; at least 3 limitations named.
**Fix**: limitations implicit or only 1-2 named.
**Block**: no limitations stated; report reads as if complete.

### 7. Is the audience calibrated?

Who is this for? An executive (SRL brief) reads differently than an analyst (IMRAD). Check:

- Jargon level matches audience
- Length matches attention span
- Recommendations match authority level of reader

**Pass**: voice, density, and length match the audience.
**Fix**: some sections mis-calibrated (too technical / too casual).
**Block**: wrong format entirely (IMRAD served to an exec; SRL brief served to an analyst expecting depth).

### 8. Have counter-evidence and dissent been addressed?

Every report has a perspective. Does it acknowledge evidence that cuts against it?

**Pass**: counter-evidence named and addressed.
**Fix**: counter-evidence mentioned but not engaged.
**Block**: one-sided — no acknowledgment of disconfirming evidence.

If the report is based on ACH, ACH's scoring already encodes this — check that the top-runner-up hypothesis is named. If not based on ACH, run `red-team-claim` to surface counter-evidence.

### 9. Are numbers defensible?

Quantitative claims need:

- Units specified
- Date of measurement
- Baseline (for comparisons)
- Methodology (for computed figures)

**Pass**: all numbers have units + date + baseline + method.
**Fix**: some numbers missing one of these.
**Block**: headline numbers are unsourced or un-unit-ed.

Run `test-significance` or `estimate-market-size` if the numbers are doing heavy lifting — "a $50B market" needs triangulation.

### 10. Is the next action actionable?

Every report should end with "what next?" — even IMRAD has a "Recommended next steps" subsection. This must be:

- Specific (not "further research is needed")
- Owned (who does it)
- Dated (when by)

**Pass**: concrete next actions with owners + dates.
**Fix**: vague "should look into X" language.
**Block**: report has no call to action.

## Conditional points (11–13)

The 10 points above are mandatory for every report. The next 3 points apply only when the brief's structure invokes them — skip with an explicit `N/A — <condition not met>` rationale otherwise. These cover innovation-practice discipline (Christensen/Ulwick, Wardley, Baghai/Coley/White McKinsey) and exist to prevent silent gaps on briefs where the discipline is load-bearing.

### 11. (Conditional) Is every named technology framed by its job-to-be-done?

**Applies when:** the brief names **≥3 distinct technologies / vendors / products** AND the brief is a tech-comparison, landscape, ecosystem, or buy-vs-build report (NOT a single-prediction foresight, single-tech deep dive, or pure prose narrative).

If the condition is not met, mark `N/A — <reason>` and move on. Do not force JTBD onto a foresight report or a single-tech profile.

**Pass**: every named technology in the brief has a verb-led `Job:` statement (Ulwick outcome-driven format: minimize/maximize/reduce/identify/accelerate the metric it takes to + object + context) + a 2–4 competing-solutions list (including non-consumption) + a struggling-moment in the customer's voice.
**Fix**: some technologies have JTBD framing, others don't, OR the Job: line uses solution language instead of verb-led outcome.
**Block**: ≥3 technologies named without any JTBD framing — peer comparisons are tautological without the underlying job.

If failed: invoke `jtbd-framing` skill on each named technology before re-reviewing. Each tech gets one fenced `jtbd` block. The `mission-quality.ts:checkCreatorJtbdPresence` L1 soft check mirrors this point — failing it surfaces as `creator-jtbd-presence: REVISE` post-mission, which is the same gap this point catches pre-publication.

### 12. (Conditional) Is every named technology placed on the Wardley evolution axis?

**Applies when:** the brief names **≥3 distinct technologies / vendors / products** AND the brief makes any method/maturity claim (adopt/pilot/buy/build/commodify, TRL placement, Adopt/Trial/Assess/Hold ring, "this category is mature/emerging").

If the condition is not met, mark `N/A — <reason>` and move on.

**Pass**: every named technology has a Wardley evolution-stage tag (Genesis / Custom-built / Product / Commodity) with a one-line rationale anchored in observable evidence (number of customer references, integration time, vendor roadmap, breaking-changes log) — not vendor self-positioning.
**Fix**: some technologies are placed, others aren't, OR the rationales rely on vendor self-positioning alone.
**Block**: brief makes method/maturity claims without any evolution-stage placement — strategic-method-fit (Agile vs Lean vs Six-Sigma vs Utility purchase) is unanchored.

If failed: invoke `evolution-stage` skill on each named technology before re-reviewing. Each tech gets one fenced `evolution-stage` block. The `mission-quality.ts:checkCreatorEvolutionStage` L1 soft check mirrors this point.

### 13. (Conditional) Is every bet tagged with a horizon (H1/H2/H3)?

**Applies when:** the brief proposes **≥3 distinct bets / recommendations / acquisition targets / capability investments** that span more than one time horizon (i.e., the brief is a portfolio, multi-year roadmap, corp-dev brief, transformation roadmap, or investment opportunities brief).

If the brief is a current-state snapshot, single-prediction foresight, or has fewer than 3 bets, mark `N/A — <reason>` and move on.

**Pass**: every bet carries a Three Horizons tag (H1: 0–12 mo, H2: 1–3 yr, H3: 3–5 yr) with a time-to-revenue-impact estimate and a one-line evidence-bar implication (hard ROI for H1 / innovation accounting for H2 / weak-signal monitoring for H3).
**Fix**: some bets have horizon tags, others don't, OR the bar applied is wrong (H1's hard-ROI threshold applied to an H3 thesis kills the thesis prematurely; H3's patience applied to an H1 bet wastes the year).
**Block**: ≥3 bets without any horizon tagging — portfolio balance can't be assessed and the reader can't tell which bets are this-year operational moves vs. multi-year option-preserving plays.

If failed: invoke `three-horizons` skill on each bet before re-reviewing. Each bet gets one fenced `horizon` block, plus a `portfolio` summary if ≥3 bets are present. The `mission-quality.ts:checkCreatorThreeHorizons` L1 soft check mirrors this point.

### 14. (Conditional) Does the HTML conform to the Radarist editorial brand?

**Applies when:** the deliverable is an HTML report (presence of `<html>` / `<body>` tags). Skip with `N/A — non-HTML deliverable` for plain-markdown SBAR briefs, IMRAD whitepapers in plaintext, JSON outputs, or short chat answers.

The canonical stylesheet is `public/css/report-brand.css`. The agent's PROFILE.md "Visual Design System (mandatory)" section spells out the rules; this point is the pre-publish gate that runs them.

**Pass**: all four mechanical checks below pass.

1. **Brand stylesheet linked.** First `<link>` in `<head>` after `<title>` and viewport meta is `<link rel="stylesheet" href="/css/report-brand.css" />`.
2. **No variable shadowing.** No agent `<style>` block redeclares `--bg-*` / `--accent-*` / `--text-*` / `--border` / `--gradient-gold` / `--shadow-hover`. The brand tokens are owned by the stylesheet.
3. **Citations use `.cite` class.** Every `<sup>` element wrapping a `[N]`-shaped citation carries `class="cite"`.
4. **No banned class-name patterns.** The agent uses brand vocabulary instead of reinventing classes like `rec-card`, `profile-card`, `vendor-card`, `vendor-header`, `experiment-box`, `confidence-tag`, `audience-tag`, `admiralty`, `hero-badge`, `hero-tag`, `tag-adopt/-trial/-assess/-hold`, `evolution-pill`, `evo-badge`, `ev-product/-custom/-early/-growth`, `evo-genesis/-custom/-product/-commodity`, `jtbd-card`, `stat-grid`, `refs-list`, or `data-table`.

**Fix**: one or two checks fail (e.g. the link is present but a couple of `<sup>` citations forgot the class). Patch and re-review.
**Block**: ≥3 banned class-name patterns present, OR brand variables redeclared (this last one means the agent is fighting the brand, not following it). Re-write the affected sections; do not ship. A missing brand-stylesheet link is a **Fix**, not a Block — the exporter inlines the brand CSS bytes regardless of the authored link, so its absence marks authoring method, never final pixels; add the link and re-review.

If failed: read the class vocabulary in `public/css/report-brand.css`. Pick the brand class that matches your need; do not invent a new name. The `mission-quality.ts:checkCreatorBrandCompliance` L1 soft check mirrors this point — failing it surfaces as `creator-brand-compliance: REVISE` post-mission, the same gap this point catches pre-publish.

## Procedure

### 1 — Get the draft

Take the full draft as input. Don't critique fragments.

### 2 — Walk the 10 points

For each: ✅ / ⚠️ / 🔴 with a one-sentence rationale.

### 3 — Compute the verdict

- **All ✅**: approve. Ship.
- **Any ⚠️, no 🔴**: fix list. Revise before ship.
- **Any 🔴**: block. Rewrite the affected section before re-reviewing.

### 4 — If fixes are needed: specify them

A critique without actionable fixes is just complaint. For each ⚠️ / 🔴:

- What specifically to change
- Where in the draft (section + paragraph, or line range)
- What "fixed" looks like (the new version passes the point)

### 5 — Format the review

```
## Critique — {report title}

**Report type:** {IMRAD / SRL brief / radar / systematic review / corp-dev / other}
**Audience:** {exec / analyst / technical}

**Review:**

| # | Point | Status | Rationale |
|---|---|---|---|
| 1 | Answers the question | ✅/⚠️/🔴 | {one sentence} |
| 2 | Evidence sourced | ✅/⚠️/🔴 | {one sentence} |
| 3 | Anti-patterns avoided | ✅/⚠️/🔴 | {one sentence} |
| 4 | Reproducible | ✅/⚠️/🔴 | {one sentence} |
| 5 | Confidence honest | ✅/⚠️/🔴 | {one sentence} |
| 6 | Limitations stated | ✅/⚠️/🔴 | {one sentence} |
| 7 | Audience calibrated | ✅/⚠️/🔴 | {one sentence} |
| 8 | Counter-evidence addressed | ✅/⚠️/🔴 | {one sentence} |
| 9 | Numbers defensible | ✅/⚠️/🔴 | {one sentence} |
| 10 | Next action actionable | ✅/⚠️/🔴 | {one sentence} |
| 11 | (Conditional) JTBD framing per technology | ✅/⚠️/🔴/N/A | {one sentence — N/A if <3 techs or non-comparison brief} |
| 12 | (Conditional) Wardley evolution-stage per technology | ✅/⚠️/🔴/N/A | {one sentence — N/A if no method claim or <3 techs} |
| 13 | (Conditional) Three Horizons tag per bet | ✅/⚠️/🔴/N/A | {one sentence — N/A if <3 bets or single-horizon brief} |
| 14 | (Conditional) Brand-compliant HTML | ✅/⚠️/🔴/N/A | {one sentence — N/A if non-HTML deliverable; cite which check failed} |

**Verdict: {APPROVE / REVISE / BLOCK}**

{if revise or block, list specific fixes:}

**Fixes required:**
1. [location] {specific change}
2. [location] {specific change}
...

**Re-review after fixes:** {yes / no — no if only ⚠️ fixes, yes if any 🔴}
```

## Pair with adjacent skills

- `red-team-claim` — claim-level adversarial review (narrower scope)
- `verify-citations` — citation-format check (Point 2 automation)
- `test-significance` — Point 9 numeric-defensibility support
- `abstain-or-escalate` — if Point 5 (confidence) is inflated, consider abstaining
- `write-imrad-report` / `write-srl-brief` — producer skills this critiques
- `jtbd-framing` — Point 11 producer (run on each named technology when applicable)
- `evolution-stage` — Point 12 producer (Wardley placement when applicable)
- `three-horizons` — Point 13 producer (H1/H2/H3 tagging when applicable)
- `claim-provenance` — sentence-level discipline complementary to Point 9 (`[validated, source]` / `[assumption, retire-by milestone]` brackets)
- `cynefin-classification` — open the brief with the decision domain when the prompt asks for action under uncertainty

## Anti-patterns

- Do **not** skip any of the 10 points, even if the report is short. Brevity isn't an excuse for missing the audit.
- Do **not** produce a review that says "looks good" with no specific points. The 10-point table is the deliverable.
- Do **not** let ⚠️ slide without fixes. The whole point is to fix before publication.
- Do **not** critique your own report charitably. Apply the same rigor you would to someone else's.
- Do **not** auto-re-review in an infinite loop. One critique → one revision cycle → one final check. If a third iteration is needed, the report has a deeper structural issue — hand off to a human.

## Reference

- Strunk and White, _The Elements of Style_, 4th ed. Longman, 2000 — compositional self-review principles.
- A. Galef, _The Scout Mindset_, Portfolio, 2021 — on steel-manning your own work.
- Anthropic's skill-creator best practices — "critique before emit" as a recommended pattern (docs.claude.com/agents-and-tools/agent-skills).
- Pairs with `red-team-claim` (claim-level), `abstain-or-escalate` (when Point 5 fails), `verify-citations` (Point 2 automation), `write-imrad-report`/`write-srl-brief` (report-producing skills that this critiques).

## Radarist binding

Point 2 ("is evidence sourced?") is a lookup, not a self-assessment:

- `getArtifactFindings` — the mission's own recorded findings for this artifact.
- `getClaimHealth` — whether the cited entities are actually well-supported.
- `getRelationEvidence` — spot-check the load-bearing claims against their evidence.

Reachability: `getArtifactFindings` mounts on `impulse-reports`, which only the **creator** profile carries. That matches how this skill is used — creator critiques its own artifact — but if another profile runs it, that lookup is a handoff and the other two calls, both reachable everywhere, carry Point 2 alone.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
