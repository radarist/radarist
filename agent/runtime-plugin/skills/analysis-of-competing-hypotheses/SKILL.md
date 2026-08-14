---
name: analysis-of-competing-hypotheses
description: Use when a question has several plausible explanations and the wrong pick is costly — adoption stalls, competitive shifts, unexplained failures, surprising signals. Runs Heuer's ACH — enumerate hypotheses, score evidence C/N/I/NA, favour fewest inconsistencies. For stress-testing an already-chosen plan use `premortem-analysis` instead.
---

# Analysis of Competing Hypotheses (ACH)

Confirmation bias — the tendency to interpret evidence as supporting a favored hypothesis — is the single most robust failure mode of open-source analysis. ACH is the standard antidote, originally developed at the CIA by Richards J. Heuer Jr. It forces the analyst to **disconfirm** rather than confirm.

## When to invoke

Invoke when:

- A landscape question has 2+ plausible answers and the stakes are high: "why is adoption of X stalling?", "is Y about to pivot?", "which technology wins this ring?", "is this signal genuine or noise?".
- Before a Creator report's executive-summary conclusion ships.
- Before a Strategist emits a "most likely" recommendation.
- Before a Scout reports a surprising finding that could have multiple explanations.

Do NOT invoke when:

- The question is factual and has one right answer (use `grounded-answer` instead).
- There's only one plausible hypothesis — running ACH on a single hypothesis is theatre.
- The stakes are low (an internal summary, a status check). ACH takes time; reserve for consequential claims.

## The eight steps (Heuer's original)

### 1 — Enumerate hypotheses

Write down every plausible answer. Aim for 3-7. Include:

- The "obvious" answer (it's often right, but also often the anchor you need to disconfirm).
- At least one answer you're sure is wrong (forces the matrix to reject real evidence, not just absent evidence).
- At least one "null" answer ("nothing is actually happening — we're seeing noise").
- Variant hypotheses that differ in cause ("competitors accelerated" vs "we slowed" vs "market shrunk").

Do not skip unlikely hypotheses. The method only works if the full space is enumerated.

### 2 — List evidence and arguments

Collect every observation, signal, data point, quote, or logical argument that might bear on the question. Be over-inclusive. Include:

- Direct evidence (facts, quotes, numbers).
- Absence of expected evidence (silence is data — "if X were true, Y should exist; Y doesn't exist").
- Contradicting evidence (things that look wrong for the leading hypothesis).
- Base-rate evidence (how often has this kind of thing happened before?).

### 3 — Build the matrix

Rows = evidence, columns = hypotheses. For each cell, grade the evidence against the hypothesis:

| Mark   | Meaning                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------- |
| **C**  | Consistent — if this hypothesis were true, this evidence is what you'd expect to see.                |
| **I**  | Inconsistent — if this hypothesis were true, this evidence shouldn't exist (or would be in tension). |
| **N**  | Neutral — the evidence is equally likely under this hypothesis as any other.                         |
| **NA** | Not applicable — the evidence doesn't bear on this hypothesis at all.                                |

Important: grade each cell **ignoring** the other cells. Don't look at the matrix as a whole yet — anchor on one piece of evidence at a time and ask "if hypothesis N were true, would this evidence surprise me?"

### 4 — Refine

Walk the matrix:

- Evidence rows marked **C** across all hypotheses add no diagnostic value. Consider dropping them.
- Evidence rows marked **N / NA** across all hypotheses add no value. Drop.
- Evidence with **C** on some hypotheses and **I** on others is **diagnostic**. Keep those.

You want the final matrix to be mostly diagnostic rows.

### 5 — Score

For each hypothesis, count:

- Number of **I** marks (inconsistencies) — the hypothesis with the **fewest I's** is the strongest, per Heuer.
- Do not count C's. "Most C's" rewards confirmation bias.

If two hypotheses tie on I count, break the tie by considering which I's are most damaging.

### 6 — Sensitivity check

For the top 2-3 hypotheses, ask:

- Which single piece of evidence, if wrong or missing, would flip the ranking?
- Is that pivotal evidence from a high-reliability source (Admiralty A1-B2)?
- If a single C-class source (Admiralty C3-D4) is load-bearing, go re-source or mark the conclusion as tentative.

### 7 — Report

Emit:

1. Ranked hypotheses with I-count.
2. The single-most-diagnostic piece of evidence per ranking.
3. The sensitivity: "if [evidence X] were retracted, ranking would flip to [H_N]."
4. Leftover uncertainty: which hypotheses have insufficient evidence to rule out; what would it take to disconfirm each.

### 8 — Look for loose ends

Which evidence is inconsistent with the winning hypothesis? Don't sweep it away — name it and say why you think the hypothesis still wins despite it. If the loose ends are too many, the winning hypothesis is wrong.

## Example matrix shape

```
                           H1: Adoption         H2: Pivot to       H3: Market shrank     H4: Null (noise)
                           is genuinely slow    different segment
─────────────────────────────────────────────────────────────────────────────────────────────────────────
E1: Q4 rev -8% YoY         C                    C                  C                     I
E2: No new customers in    C                    N                  I                     I
    roadmap-aligned ICP
E3: CEO quote "we are      I                    C                  N                     N
    re-evaluating market
    fit" on earnings call
E4: Headcount flat         C                    I                  C                     C
─────────────────────────────────────────────────────────────────────────────────────────────────────────
Inconsistencies (I):       1                    1                  1                     2
```

Tie between H1/H2/H3 → pivotal evidence is E3. E3 must be re-sourced (is that quote accurate? from which call?) before concluding.

## Anti-patterns

- Do **not** skip hypotheses you "know" are wrong — those are the ones the matrix needs to visibly reject.
- Do **not** grade a cell by the other cells. Grade it in isolation.
- Do **not** report "H1 wins because most C's". Report "H1 wins with fewest I's". The mental model matters.
- Do **not** use ACH for factual lookups. It's for interpretive questions with multiple plausible causes.
- Do **not** present the conclusion without the sensitivity check. A conclusion that flips on one piece of evidence isn't a conclusion, it's a guess.

## Reference

- R. J. Heuer Jr., _Psychology of Intelligence Analysis_. Center for the Study of Intelligence, Central Intelligence Agency, 1999. Chapter 8 — Analysis of Competing Hypotheses.
- R. J. Heuer Jr. and R. H. Pherson, _Structured Analytic Techniques for Intelligence Analysis_, 2nd ed. CQ Press, 2014 — Chapter 7 expands ACH to diagnostic and contrarian variants.
