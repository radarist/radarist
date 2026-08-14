# Confidence, Evidence, and Feedback

Radarist uses scores to prioritize review. A displayed percentage is a workflow
heuristic, not a calibrated probability and not proof that a claim is true.

## Three distinct concepts

| Concept | Use | Does not prove |
| --- | --- | --- |
| proposal confidence | ranks an AI-proposed relation for review | correctness, freshness, or source independence |
| effective relation confidence | combines asserted confidence with bounded corroboration and feedback adjustments | probability or permission to skip review |
| signal trust score | summarizes source type, completeness, corroboration, and producing-model confidence | truth or equivalent meaning to relation confidence |

Do not compare scores from different workflows as though they share one scale.

### Current calculations

Effective relation confidence is computed as:

`assertedConfidence + corroborationNudge + feedbackDelta`

For example, `80 + 10 - 5 = 85`.

A successful recalculation clamps the result to 5-100.
A failed best-effort recalculation leaves the stored value unchanged; it must
not be treated as a successful update.

Signal trust uses a separate weighted score:

- `sourceReliability * 30%`
- `dataCompleteness * 25%`
- `corroboration * 25%`
- `aiConfidence * 20%`

## Evidence

Evidence can preserve a source URL or record, snippet, location, timestamp, and
other provenance. This makes a claim inspectable. It does not establish that:

- the source is authentic or correct;
- multiple URLs are independent publishers;
- a snippet supports the exact relation and direction;
- the information remains current;
- contradictory evidence has been resolved.

There is no universal, system-wide definition of an "independent source."
Different URLs from one publisher count separately. Verified signals instead
normalize publishers. Contradiction handling is not universal. Inspect the
actual sources instead of relying on the count alone.

## Relation review

Before approving a proposed relation:

1. verify the exact source entity, target entity, direction, and predicate;
2. open the cited sources and read the surrounding context;
3. look for copied reporting or common ownership;
4. check dates and reconcile contradictions;
5. approve only the specific relation the evidence supports.

Use **Reject** for a currently unsupported or incorrect proposal. Use
**Dismiss** only when the same proposal identity should remain suppressed.
Feedback can adjust later prioritization, but the write may be asynchronous and
does not retroactively make evidence stronger.

Proposal identities are suppressed for 30 days, regardless of whether new evidence arrives.
After that window, a proposal can be proposed again even from unchanged evidence.
Treat suppression as queue behavior, not a truth judgment.

## Signal review

Before approving a signal:

1. open the source;
2. confirm it supports the title and claimed event;
3. inspect publication and detection dates;
4. check whether corroborating sources are actually independent;
5. reject misleading, stale, or unsupported signals with a useful reason.

Skipping a queue item is not the same as rejecting it and may write no feedback.

## Reports and decisions

Treat reports as editable drafts. Verify citations, distinguish observation
from inference, preserve uncertainty, and record the human decision separately.
High confidence changes review priority; it never transfers accountability from
the operator to the model.

See [Responsible AI](../RESPONSIBLE-AI.md) and
[Limitations](../LIMITATIONS.md) for the v0.1 operating boundary.
