---
name: evaluate-signal
description: Use when scoring a new signal for trust and relevance before triage. Grades source reliability, data completeness, and corroboration into an overall trust score with an explicit triage decision.
---

# Evaluate Signal

## Steps

1. **Assess source reliability** (0-100):
   - Academic/research: 95; patents/official records: 90
   - Named reputable technology/industry sources: 75-95
   - Trends: 60; Twitter: 50; Reddit: 45
   - LLM search/custom agent: 70
   - Unknown: 50

2. **Assess data completeness** (0-100):
   - Required fields are title, description, source, URL, date, and type
   - If any required field is missing: `(populated required / 6) * 50`
   - If all are present: 50 base, plus up to 50 for populated `aiSummary`, `expandedContent`, `metadata`, `relevanceScore`, `alignmentScore`, `alignedStrategies`, and `linkedEntities`

3. **Assess corroboration** (0-100):
   - Search for the same claim in other sources
   - 0-1 distinct confirming URL identities: 40
   - 2 distinct confirming URL identities: 70
   - 3 distinct confirming URL identities: 85
   - 4+ distinct confirming URL identities: 95
   - URL diversity is not proof of editorial independence; use `triangulate-sources` before describing sources as independent

4. **Compute overall trust score**:
   `overall = sourceReliability * 0.30 + completeness * 0.25 + corroboration * 0.25 + aiConfidence * 0.20`

5. **Triage decision**:
   - >= configured `SIGNAL_AUTO_APPROVE_THRESHOLD` (default 85): Eligible Technology profiles may be flagged for auto-apply only when `SIGNAL_AUTOPILOT_ENABLED` and the two-source gate both pass
   - Company, trend, rejected, archived, or stale expansions remain in triage
   - An unresolved Google redirect is inconclusive and does not count; it keeps the signal in triage only when fewer than two other confirming URL identities remain
   - Otherwise >= 70: "Review recommended" — queue for user triage
   - 50-69: "Manual review needed"
   - < 50: "Low confidence — verify before acting"

## Radarist binding

Ordered route — these four:

1. `getSignalDetails` — read actual field completeness rather than assuming it.
2. `expandSignal` — enrich a thin signal before judging it thin.
3. `getSignalFeedbackPatterns` — what this operator approved and rejected before. The only genuinely personalised input available.
4. `approveSignalForImport` — or `rejectSignalWithReason`.

Low source count is not the same as low trust — a genuine weak signal is sparse by nature. See `weak-signal-triage` before discarding a single-source item.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
