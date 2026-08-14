---
name: write-imrad-report
description: Use for a scientific or research-style long-form report — a technical whitepaper, an empirical finding document, a landscape analysis needing academic rigor. Structures it as IMRAD (Introduction / Methods / Results / Discussion) with an optional executive summary and references. For a one-page decision brief use `write-srl-brief` instead.
---

# Write IMRAD Report

IMRAD (Introduction / Methods / Results / Discussion) is the scientific writing convention used across most life-science, physical-science, and social-science journals. When Creator or Strategist produces a report that will be cited or read by someone who reviews evidence-backed claims, this shape is what they expect.

## When to invoke

Trigger when:

- The user asks for a "scientific" / "academic" / "journal-style" / "whitepaper" report.
- The report will include empirical results (data points, measurements, comparisons).
- The report will be cited externally (linked from a user-facing site, shared with reviewers).

Skip when:

- The user asks for a "landscape report" — use `generate-radar-report` instead (that's our platform-native shape).
- The user asks for a "newsletter" / "digest" / "executive summary" — IMRAD is too heavy.
- The report is < 600 words — the structure costs more than it delivers.

## The structure

### Executive Summary (optional, 100-200 words)

For reports going to executives, lead with this. State: what was studied, the single-most-important finding, the confidence level, and the one recommended action. If the reader reads only this paragraph, they know what to do.

### 1 — Introduction (200-400 words)

1. Background: context the reader needs to understand the problem. Cite 2-4 anchor references.
2. Gap: what is not yet known / answered / resolved.
3. Question: the specific question this report answers. One sentence.
4. Hypothesis or objective: what would a "yes" or "no" look like.

Do not report any results here. Introduction sets up the question only.

### 2 — Methods (150-400 words)

Say exactly what you did:

- **Data sources**: which graph queries, which external APIs, which documents, which time window. Link each (use `cite-ieee`).
- **Procedure**: step-by-step so another analyst could reproduce. "We ran searchKnowledgeGraph with query X; then queryActiveEdges on each returned entity; then grounded-answer on each claim."
- **Selection criteria**: what was included, what was excluded, and why.
- **Tools**: which skills / MCPs / models were used.
- **Limitations known upfront**: sources that were not available, date windows that constrained the answer.

If the methods feel pre-written (copy-pasted from a template), you're doing it wrong — methods are specific to the question.

### 3 — Results (variable)

Report findings objectively, without interpretation:

- Lead with the headline number or finding.
- Use tables for comparisons, timelines, or paired data.
- Use inline citations for every external claim.
- Include **null findings** ("no evidence of X was found") — absence of evidence is data.
- Separate signal from noise explicitly — "of 47 candidates, 12 met the criteria; the other 35 were ruled out because..."

Do NOT write "the results show that X is important." That is interpretation — it belongs in Discussion.

### 4 — Discussion (300-500 words)

Now interpret:

- What do the results mean?
- Do they answer the question from the Introduction?
- How do they relate to prior work (the anchor references from Introduction)?
- What are the implications for the user / the platform / the decision at hand?
- **Limitations**: what this report does not answer. Which claims rest on thin evidence. Where a follow-up would be high-value.
- **Recommended next steps**: concrete, actionable, with owners if possible.

End with a single-sentence conclusion that maps back to the opening question.

### 5 — References

Use `cite-ieee` for the numbered reference list. Every factual claim inline must map to a numbered reference here.

## Anti-patterns

- Do **not** blend interpretation into Results. "The study shows Anthropic is dominant" mixes data and opinion. Split: Results = "Anthropic appears in 34/47 documents"; Discussion = "This suggests Anthropic has higher mind-share than peers, though ..."
- Do **not** skip Methods. Without it, Results are unverifiable.
- Do **not** write a "pre-registered" hypothesis after you've seen the data. If you're reasoning from the data backwards, mark that section "post-hoc" and say so.
- Do **not** put References anywhere other than the end. IMRAD is a convention; breaking it confuses readers.
- Do **not** use IMRAD for marketing reports. The voice is wrong and the audience is wrong.

## Reference

- J. W. Creswell, _Research Design: Qualitative, Quantitative, and Mixed Methods Approaches_, 5th ed. SAGE, 2018, Chapter 6 — IMRAD reporting structure.
- D. Ankers, "The IMRAD Format — A History," _Journal of the Medical Library Association_, vol. 92, no. 3, pp. 364–367, Jul. 2004. doi: 10.1195/jmla.2004.92.3.364
- Pairs with `cite-ieee` (References), `grounded-answer` (every claim verified), and `analysis-of-competing-hypotheses` (when Results admit multiple interpretations).
