---
name: assess-study-bias
description: Use to evaluate a clinical trial, empirical study, benchmark comparison, or published experiment for methodological weakness — "is this study reliable?", "assess bias in …". Applies the Cochrane RoB-2 five domains — selection, performance, detection, attrition, reporting.
---

# Assess Study Bias

Apply Cochrane Risk of Bias (RoB-2) to a study and flag what its conclusions can and cannot support.

## When to invoke

Trigger on phrases like "assess this study", "is this trial reliable?", "what's the risk of bias in …", "evaluate this benchmark comparison", "how trustworthy is this result?". Also appropriate when a downstream skill (like `analysis-of-competing-hypotheses`) needs to grade the quality of an input study.

Do NOT invoke for non-empirical claims ("X is the market leader" — that's a marketing claim, not a study).

## The five RoB-2 domains

1. **Randomization process** — was allocation truly random? Was the sequence concealed?
2. **Deviations from intended intervention** — did participants get what they were supposed to? Were deviations balanced across arms?
3. **Missing outcome data** — how many dropouts? Were they balanced?
4. **Measurement of outcome** — was the outcome assessed in a way that could differ between arms? Was the assessor blinded?
5. **Selection of reported result** — was the reported analysis pre-specified? Are there signs of p-hacking or selective reporting?

For non-randomized or observational studies, use ROBINS-I (seven domains including confounding and participant selection) instead — noted at the end.

## Procedure

### 1 — Classify the study type

- **RCT** (randomized controlled trial) → RoB-2
- **Observational / cohort / case-control** → ROBINS-I
- **Benchmark / leaderboard comparison** (e.g. ML benchmark) → adapt RoB-2 thinking to "data contamination, cherry-picked seeds, unblinded evaluators, selective reporting"
- **Single-arm study, case series** → note that RoB-2 doesn't apply; the study is hypothesis-generating, not confirmatory

### 2 — Score each domain

For each domain, answer with one of:

- 🟢 **Low risk** — the study addresses this domain well
- 🟡 **Some concerns** — partially addressed, or insufficient info to judge
- 🔴 **High risk** — serious methodological weakness

Document the specific evidence for each score — cite the page / section / figure.

### 3 — Derive the overall judgment

Cochrane rule of thumb:

- **Low risk overall** = all five domains 🟢
- **Some concerns overall** = at least one 🟡, no 🔴
- **High risk overall** = at least one 🔴

Don't soften a 🔴. One high-risk domain is sufficient to invalidate the study's conclusions for downstream use, unless the claim being made doesn't depend on that domain.

### 4 — Write the assessment

```
## Risk of Bias — {study title}, {authors, year}

**Study type**: {RCT / cohort / benchmark / case series}
**Framework**: {RoB-2 / ROBINS-I / adapted}

| Domain | Judgment | Rationale |
|---|---|---|
| 1. Randomization | 🟢/🟡/🔴 | {one sentence} |
| 2. Intervention | 🟢/🟡/🔴 | {one sentence} |
| 3. Missing data | 🟢/🟡/🔴 | {one sentence} |
| 4. Outcome measurement | 🟢/🟡/🔴 | {one sentence} |
| 5. Selective reporting | 🟢/🟡/🔴 | {one sentence} |

**Overall**: {Low / Some concerns / High} risk

**What this supports**: {claims that survive the bias check}

**What this does NOT support**: {claims invalidated by bias in specific domains}

**Follow-up to strengthen**: {what a replication study should do differently}
```

### 5 — Link back upstream

If the study was being used as evidence for a graph claim (via `grounded-answer` or `triangulate-sources`), downgrade the claim's confidence when bias is high. Confidence uses an integer **0–100** scale: a 🔴 study as sole source → confidence ≤ 50. A 🔴 study paired with a 🟢 replication → average the two on the 0–100 scale.

## Adaptations for benchmark / ML studies

ML benchmarks rarely use Cochrane, but the thinking transfers. Score:

- **Data contamination** (test set seen during training) = randomization + selection bias combined
- **Seed / run variance** (one-shot vs averaged over seeds) = missing data domain
- **Evaluator blinding** (same team that built the model scoring it) = outcome measurement
- **Cherry-picked metrics** (reporting only the metric you win on) = selective reporting

High risk in any of these invalidates the benchmark ranking for general use.

## Anti-patterns

- Do **not** give a "3/5 domains are fine" overall pass. One 🔴 is enough.
- Do **not** assess bias in isolation — the study's conclusions need to be restated alongside the bias, so the reader can re-calibrate.
- Do **not** use RoB-2 for single-arm studies. They are hypothesis-generating; the framework doesn't fit.
- Do **not** confuse "small sample" with "high risk of bias." Small sample → low power, which is a precision issue, not a bias issue.

## Reference

- J. A. C. Sterne et al., "RoB 2: a revised tool for assessing risk of bias in randomised trials," _BMJ_, vol. 366, p. l4898, Aug. 2019. doi: 10.1136/bmj.l4898
- J. A. C. Sterne et al., "ROBINS-I: a tool for assessing risk of bias in non-randomised studies of interventions," _BMJ_, vol. 355, p. i4919, Oct. 2016. doi: 10.1136/bmj.i4919
- Pairs with `analysis-of-competing-hypotheses` (ACH evidence weight depends on study quality), `systematic-review` (PRISMA flow requires per-study RoB), and `triangulate-sources` (one biased source ≠ corroboration).

## Radarist binding

RoB-2 domains are assessed from the methods section, not the abstract:

- `resolveOpenAccess` — keyless route to full text; without it this skill grades the abstract, which is where bias hides least.
- `getChunkContent` / `searchDocuments` — when the study is already ingested.

Reachability: `getChunkContent` and `searchDocuments` mount on `impulse-reports`, which only the **creator** profile carries. Evaluator and scout run this skill and must treat them as a handoff — use `searchKnowledgeGraph` (reachable from every profile) or re-fetch the full text through `resolveOpenAccess`, and say in the output that the ingested copy was not consulted.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
