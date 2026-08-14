---
name: triangulate-sources
description: Use when a claim warrants more than one source — a relation at confidence ≥ 75, an executive-summary claim, a signal flagged for auto-apply, an assertion that will propagate through graph traversals. Requires two independent corroborating sources, grades each, and emits a combined confidence with explicit source diversity. For verifying one stated value use `grounded-fact-check` instead.
---

# Triangulate Sources

A single source can be wrong. Two sources that agree are meaningfully less likely to both be wrong — provided they are actually independent.

## When to invoke

- **Before** a `proposeVerifiedRelation` call with confidence >= 75 (0-100 scale; the candidate remains pending until human review).
- **Before** flagging a signal for auto-apply (SIGNAL_AUTO_APPROVE_THRESHOLD, currently 85).
- **Before** putting a claim in a report's executive summary, headline, or recommendation.
- **Before** the creator agent produces a numbered quantitative claim (market share, funding amount, valuation, headcount).

Skip for peripheral color, hedge language, or claims already in Admiralty grade A1 (fully reliable + confirmed) — one source suffices.

Reachability: `proposeVerifiedRelation` mounts on `impulse-entities`, which every profile carries, so the corroboration verdict can be carried in the proposal's own evidence. Emit it in your output as well, so it survives if the proposal call fails.

## The four tests of independence

Two sources are independent when ALL FOUR of these hold. If any fails, they are the same source wearing different clothes.

### 1 — Different author / byline

Reuters quoted by TechCrunch and Reuters direct are **the same source**. `techcrunch.com/X` and `reuters.com/Y` may look like two URLs but carry one journalist's text. Check the byline chain:

- If one source says "Reuters reports..." and another is Reuters, they collapse to one.
- If both derive from the same press release, they collapse to one.

### 2 — Different first-hand chain

If both sources trace back to the same document (SEC filing, company blog post, patent grant), they are one source. Example: five news articles about Nvidia's Q4 earnings all derive from the same 10-Q filing → one primary source with five amplifications.

- Walk each source to its first-hand evidence. If the root documents differ → independent. If they converge → not independent.

### 3 — Different publication time

A 2024 article and its 2026 re-tweet are one source. A 2024 article and a 2026 update with new content are two. The tell: does the later publication have data post-dating the earlier?

### 4 — Different institutional incentives

Two analyst reports from firms that are both paid by the vendor are one incentive structure. A vendor blog + a government filing + a skeptical journalist are three incentive structures. Diversity of incentive matters more than diversity of URL.

## The procedure

1. **Draft the claim.** One sentence, specific.
2. **Gather candidate sources.** Call `webSearch`, `searchKnowledgeGraph`, `arxiv` MCP, or specialist tools as appropriate. Collect 3-5 candidates.
3. **Grade each with `rate-source-admiralty`.** Letter + digit + rationale.
4. **Apply the four independence tests.** Deduplicate sources that fail any of them; keep the highest-graded in each deduped cluster.
5. **Check corroboration.** At the end, you should have ≥ 2 independent sources agreeing. If not:
   - 1 independent source → output the claim with `[single-source]` marker; invoke `abstain-or-escalate` to decide whether to hold the claim or escalate.
   - 0 sources → invoke `abstain-or-escalate`.
   - Sources disagree → surface the disagreement per `abstain-or-escalate` step 2, do not paper over.
6. **Emit the triangulated claim.** Include in the output:
   - The claim itself.
   - Every contributing source (graded) in citation form.
   - The combined confidence: higher of the sources' reliability letters for reliability; majority credibility digit for credibility; mention "triangulated across N independent sources" in rationale.

## Output shape

```json
{
  "claim": "Anthropic closed a $3.5B Series E at a $61.5B post-money valuation in March 2025.",
  "sources": [
    { "citation": "...", "grade": "B2", "role": "primary — Anthropic blog announcement" },
    { "citation": "...", "grade": "A2", "role": "independent confirmation — TechCrunch citing SEC Form D" },
    { "citation": "...", "grade": "A1", "role": "primary — SEC Form D filing" }
  ],
  "independence_check": {
    "distinct_authors": true,
    "distinct_first_hand_chains": true,
    "distinct_publication_times": true,
    "distinct_institutional_incentives": true,
    "passes": true
  },
  "combined_confidence": {
    "admiralty": "A1",
    "triangulated_across": 3,
    "rationale": "Primary source (SEC filing, A1) + company confirmation (B2) + independent news (A2) all corroborate."
  }
}
```

## Anti-patterns

- Do **not** count two syndications of the same wire story as two sources.
- Do **not** ignore the incentive-structure test. Two favorable analyst reports from paid research houses are one source for the purpose of triangulation.
- Do **not** average the Admiralty digits. Grading is ordinal, not cardinal. Use majority + keep the most-reliable letter.
- Do **not** force a triangulation where sources genuinely disagree. Surface the disagreement and let the user decide.

## Reference

- J. Fetters, "Achieving Integration in Mixed Methods Designs — Principles and Practices," _Health Services Research_, vol. 48, no. 6, pt. 2, pp. 2134–2156, 2013.
- N. K. Denzin, _The Research Act: A Theoretical Introduction to Sociological Methods_, 3rd ed. Prentice Hall, 1989 (source-triangulation as methodology).

## Radarist binding

The platform already computes corroboration — read it rather than re-deriving it, or the skill's number can contradict the claim chip the user is looking at.

**Route** (minimum viable = the 2 marked ★):

1. ★ `getRelationEvidence` — the actual evidence set behind the edge, with source identities.
2. ★ `getClaimHealth` — the computed corroboration and support level.
3. `getEntityAssertions` — assertion-level view when the claim is not yet an edge.
4. `explainRelation` — renders why the platform believes the claim, including the asserter.

**Contract.** Distinct source identities drive the nudge (0–1 → +0, 2 → +5, 3 → +10, 4+ → +15). `user_assertion`, `edge_annotation` and first-party `entity_field` evidence are excluded from corroboration. If your independent count disagrees with `getClaimHealth`, investigate before publishing either number.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named below, then record the gap with `recordKnowledgeGap` rather than inventing the value.
