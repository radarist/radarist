---
name: rate-source-admiralty
description: Use to record how trustworthy a source is — an incoming signal, an evidence snippet, a report citation, a claim entering the knowledge graph. Assigns a two-axis NATO Admiralty grade (A1–F6) covering source reliability and information credibility. For a first-look check on an unfamiliar web source use `sift-source-check` instead; for verifying a specific stated value use `grounded-fact-check` instead.
---

# Rate Source (Admiralty Code A1–F6)

## Why two axes, not one

A New York Times article reporting a typo is a **reliable source carrying bad information**. A random blog post reporting that water boils at 100 °C is an **unreliable source carrying good information**. Single-number trust scores conflate these. The NATO Admiralty Code separates them.

## The two axes

### Axis 1 — Source reliability (A–F)

| Grade | Label                | Meaning                                                                                                                     |
| ----- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **A** | Completely reliable  | No doubt about authenticity, competence, or history of reliability. Govt filings, peer-reviewed papers, company 10-K, USPTO |
| **B** | Usually reliable     | Minor doubt. Established news outlets with editorial standards (NYT, FT, Reuters, Nature News), Anthropic/OpenAI blogs      |
| **C** | Fairly reliable      | Some doubt. Industry publications, vendor marketing, Wikipedia, well-maintained community wikis                             |
| **D** | Not usually reliable | Significant doubt. Aggregators without editorial oversight, personal blogs, unclear provenance, LinkedIn posts              |
| **E** | Unreliable           | History of invalid information. Known misinformation vectors, pure opinion                                                  |
| **F** | Cannot be judged     | No basis to evaluate (brand new source, anonymous post, blank profile)                                                      |

### Axis 2 — Information credibility (1–6)

| Grade | Label            | Meaning                                                                      |
| ----- | ---------------- | ---------------------------------------------------------------------------- |
| **1** | Confirmed        | Logical, consistent with other information, confirmed by independent sources |
| **2** | Probably true    | Logical, consistent, not yet independently confirmed                         |
| **3** | Possibly true    | Possible but not logical. Not confirmed.                                     |
| **4** | Doubtful         | Not logical but possible. No corroboration                                   |
| **5** | Improbable       | Not logical, contradicted by other information                               |
| **6** | Cannot be judged | No basis to assess (too novel, orthogonal to prior evidence)                 |

## Output

Return a JSON object on one line:

```json
{
  "reliability": "B",
  "credibility": 2,
  "combined": "B2",
  "rationale": "Reuters article (editorial standards = B). Not yet independently corroborated but consistent with Apr 2026 Anthropic blog post (credibility = 2)."
}
```

Always include `rationale` — a one-sentence justification tying the grade to the actual source characteristics. Ungrounded grades ("B2 because it feels right") defeat the whole point of the code.

## When to invoke

- **Before `proposeVerifiedRelation`**: grade the evidence source and include the grade and rationale in the proposal evidence for human review.
- **Before approving a signal**: grade the signal's `sourceUrl` before `approveSignalForImport`.
- **When adding a citation to a report**: grade each source before including in the references list (the `cite-ieee` skill will append the grade to the reference).
- **When evaluating disagreement**: when two sources conflict, grade both — higher-combined wins unless there's a deliberate reason to prefer the lower.

Reachability: `proposeVerifiedRelation` mounts on `impulse-entities`, which every profile carries, so the grade can travel with the proposal itself. `captureEvidence` still mounts only on `impulse-reports`, which only the **creator** profile carries — treat that one as a handoff. Either way, emit the grade and rationale in your output (and, when you record the candidate via `recordAgentObservation`, put the grade in the summary) so it is never lost.

## Anti-patterns

- Do **not** default to B2 for everything. If you don't know, use F6 and call out the gap; vague grades corrupt the entire trust ledger.
- Do **not** grade source reliability on whether you agree with the claim. "NYT said X which is wrong" is a B5 (reliable source, improbable claim), not a D3.
- Do **not** collapse to a single score. The letter+digit stays together throughout the pipeline; downstream consumers decide whether to weight reliability or credibility more.

## Reference

- NATO STANAG 2511, _Intelligence Reports_, Admiralty Code (also: "NATO System Rating," "6x6 Reliability/Credibility Matrix"), standardized form reproduced in many OSINT textbooks. Public description at U.S. Army FM 2-22.3 (Human Intelligence Collector Operations), Appendix B.
