---
name: benchmark-model-claims
description: Use when a vendor, paper, or release claims performance — "X% on HumanEval", "outperforms GPT-5", "SOTA on MMLU", "3× faster than competitor", leaderboard entries. Checks baseline freezing, contamination risk, seed averaging, evaluator blinding, and metric cherry-picking; emits a ReliabilityScore 0–5 with risk tags.
---

# Benchmark Model Claims

ML-benchmark specialization of the general study-bias framework. Cochrane RoB-2 generalizes; this specializes to the failure modes unique to benchmark comparisons.

## When to invoke

Trigger on phrases like "X% on {HumanEval, MMLU, GSM8K, HELM, BIG-Bench, GPQA, SWE-Bench, ARC, TriviaQA, MATH}", "outperforms {model}", "SOTA", "beats state-of-the-art", "Xx faster than", "leaderboard rank #N", "top of the {benchmark}", or any numerical claim of model quality anchored to a named evaluation.

Do NOT invoke for qualitative/UX claims ("more intuitive", "better reasoning") — those are not benchmark claims. Do NOT invoke for claims that already carry peer-review + independent replication + effect-size reporting (skip in favor of `assess-study-bias` for full methodology audit).

## The six integrity domains

For each claim, score each domain 🟢 / 🟡 / 🔴:

| Domain                         | Question                                                                        | Low-risk indicator                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **D1. Data contamination**     | Was the test set in the model's training data?                                  | Pre-training cutoff precedes benchmark release; or canary-string check passed; or held-out variant used |
| **D2. Baseline freshness**     | Is the comparison model pinned to a fixed version + prompt + decoding settings? | Exact model ID (e.g. `gpt-4o-2024-08-06`) + identical prompt templates + identical temperature/top-p    |
| **D3. Seed variance**          | Was the reported number averaged over ≥3 seeds or runs?                         | Mean ± std reported; or paper specifies "averaged over N runs"                                          |
| **D4. Evaluator independence** | Is the team reporting the score the same team that built the model?             | Third-party benchmark leaderboard (HELM, LMSys) or peer-reviewed eval by disjoint authors               |
| **D5. Metric selection**       | Was the reported metric pre-registered, or was it chosen after seeing results?  | Pre-registered eval plan; or all canonical metrics reported (not just the favorable one)                |
| **D6. Test-set size**          | Is N large enough to distinguish the reported delta from noise?                 | Apply `test-significance` — pooled SE × 1.96 should be smaller than the claimed delta                   |

## Procedure

### 1 — Extract the claim into a normal form

`{Model A} achieves {metric} = {value} on {benchmark}, {comparator phrase}`.

If the claim lacks a named benchmark or comparator, flag as **unstructured** and stop — it can't be scored.

### 2 — Score each domain

Score all six domains 🟢 / 🟡 / 🔴 with a one-sentence rationale per domain. Every 🔴 costs a point; every 🟡 costs half. Starting score = 5.

```
ReliabilityScore = max(0, 5 − (count(🔴) × 1) − (count(🟡) × 0.5))
```

A score of **5** means the claim clears all six domains. A score of **0** means all six are red and the claim is noise.

### 3 — Emit named risk tags

For each 🟡/🔴, emit a tag from this vocabulary:

- `contamination-unverified`, `contamination-likely`
- `baseline-unpinned`, `baseline-version-drift`
- `single-seed`, `seed-unreported`
- `self-evaluated`, `conflict-of-interest`
- `metric-cherry-picked`, `metric-selected-post-hoc`
- `n-too-small`, `underpowered-delta`

These tags are machine-readable and can attach to the Signal entity downstream.

### 4 — Format

```
## Benchmark Claim Audit — {claim}

**Normal form:** {Model} {metric} {value} on {benchmark}, {comparator}
**Primary source:** {URL / DOI / arXiv ID}

| Domain | Score | Rationale |
|---|---|---|
| D1. Data contamination | 🟢/🟡/🔴 | {1 sentence} |
| D2. Baseline freshness | 🟢/🟡/🔴 | {1 sentence} |
| D3. Seed variance | 🟢/🟡/🔴 | {1 sentence} |
| D4. Evaluator independence | 🟢/🟡/🔴 | {1 sentence} |
| D5. Metric selection | 🟢/🟡/🔴 | {1 sentence} |
| D6. Test-set size | 🟢/🟡/🔴 | {1 sentence} |

**ReliabilityScore:** {0–5}
**Risk tags:** [{tag}, {tag}, ...]

**What this supports:** {claims that survive the audit}
**What this does NOT support:** {claims invalidated by red/yellow flags}
**Replication test I'd run:** {the specific additional data needed to raise the score}
```

### 5 — Feed downstream

Pass the ReliabilityScore into `analysis-of-competing-hypotheses` as evidence weight (5 → full; 0 → excluded). Pair with `rate-source-admiralty` on the source publishing the claim.

## Common contamination traps

- **HumanEval** — code solutions have been scraped + memorized since 2022; use EvalPlus or HumanEval+ (2024-fresh).
- **MMLU** — test items have leaked to web mirrors; require a held-out variant or a recent fork.
- **GSM8K** — has a reported contamination case; use GSM-Plus or GSM-Symbolic.
- **Leaderboards run by the model's vendor** — auto-lower D4 to 🔴 unless a third-party re-evaluation exists.

## Anti-patterns

- Do **not** treat a high leaderboard rank as evidence of quality. The leaderboard is a metric, not a verdict.
- Do **not** skip the contamination check for models released after the benchmark. The cutoff date isn't self-documenting.
- Do **not** average a 🔴 D1 with a 🟢 D2 into a "mixed" verdict. One critical red kills the claim.
- Do **not** use this for non-ML claims (it's calibrated to the specific failure modes of model evaluation).

## Reference

- P. Liang et al., "Holistic Evaluation of Language Models (HELM)," arXiv:2211.09110, 2022.
- D. Kiela et al., "Dynabench: Rethinking Benchmarking in NLP," NAACL 2021.
- I. Magar and R. Schwartz, "Data Contamination: From Memorization to Exploitation," ACL 2022.
- Pairs with `assess-study-bias` (general RoB for empirical studies), `test-significance` (is the reported delta larger than noise?), `analysis-of-competing-hypotheses` (weighs this skill's score as evidence).

## Radarist binding

Contamination risk and reproducibility are lookups:

- `searchPapers` → `resolveOpenAccess` — the paper's date and evaluation protocol decide contamination risk.
- `searchOssHealth` — is there a reproduction repository, and is it maintained?

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
