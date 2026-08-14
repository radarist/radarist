---
name: test-significance
description: Use when a claim rests on "X is significantly better/bigger/faster than Y" — "Model A scored 87% vs Model B's 85%", "12% more clicks", "the new variant improved conversion". Checks whether the gap is meaningful given sample size and variance, and names the statistic to report.
---

# Test Significance

Distinguish real differences from noise before repeating a claim.

## When to invoke

Trigger on phrases like "significantly better than", "improved by X%", "Model A outperforms Model B", "A/B test result", "benchmark comparison", or any numerical comparison where the user (or source) is treating a small gap as a real difference.

Do NOT invoke for claims that already cite a p-value or confidence interval — those need only a sanity check that the interval crosses zero or not.

## Procedure

### 1 — Extract the four numbers

Every significance check needs these:

- **Group A**: metric value, sample size (n_A)
- **Group B**: metric value, sample size (n_B)

If the source only reports the gap ("+12% over baseline") with no n, flag the claim as **unverifiable** and stop. Do not guess sample sizes.

### 2 — Choose the right test

| Data type                                                             | Test                                    |
| --------------------------------------------------------------------- | --------------------------------------- |
| Two proportions (click rate, pass rate, accuracy on a fixed test set) | Two-proportion z-test or Fisher's exact |
| Two means (latency, token count, score on a continuous metric)        | Welch's t-test (unequal variances)      |
| Paired observations (same users on two variants)                      | Paired t-test                           |
| Binary outcome, small n (< 30)                                        | Fisher's exact                          |
| Non-normal continuous                                                 | Mann-Whitney U                          |

When in doubt, Welch's t-test is the safer default for continuous metrics.

### 3 — Compute the statistic

Use the analyst-friendly formulation. For a two-proportion z-test:

```
z = (p_A - p_B) / sqrt( p_pooled * (1 - p_pooled) * (1/n_A + 1/n_B) )
p_pooled = (x_A + x_B) / (n_A + n_B)
```

`|z| > 1.96` → p < 0.05 (two-sided). `|z| > 2.58` → p < 0.01.

For Welch's t: use the standard formula; `scipy.stats.ttest_ind(..., equal_var=False)` or `R`'s `t.test` work.

### 4 — Report the 95% confidence interval on the difference

A p-value alone is not enough. Report the CI on the difference:

- If the CI crosses zero → no significant difference
- If the CI is entirely on one side → directionally significant; the width tells you precision

For a proportion difference: `(p_A - p_B) ± 1.96 * sqrt( p_A(1-p_A)/n_A + p_B(1-p_B)/n_B )`.

### 5 — Report an effect size, not just significance

Statistical significance says "probably not noise." Effect size says "how much it matters."

- **Cohen's h** for proportions: `2 * (arcsin(sqrt(p_A)) - arcsin(sqrt(p_B)))`. Benchmarks: 0.2 small, 0.5 medium, 0.8 large.
- **Cohen's d** for means: `(mean_A - mean_B) / pooled_sd`. Same thresholds.
- **Relative lift**: `(p_A - p_B) / p_B`. Good for intuitive communication but not a formal effect size.

A result can be statistically significant and practically trivial (tiny effect at huge n). Always report both.

### 6 — Render the verdict

```
## Significance check — {comparison}

- Group A: {metric} = {value} (n = {n_A})
- Group B: {metric} = {value} (n = {n_B})
- Test used: {Welch's t / two-proportion z / Fisher's exact}
- **p-value**: {p}
- **95% CI on difference**: [{lo}, {hi}]
- **Effect size**: {Cohen's h / d} = {value} ({small/medium/large})

**Verdict**: {significant / not significant / underpowered / inconclusive}

**What this means**: {one sentence in plain language}
```

### 7 — Call out underpowered comparisons

If `n_A` or `n_B` is small (say, n < 30 for continuous or n\*p < 5 for proportions), the CI will be wide and a null result likely means "we don't know" rather than "no difference." Say so explicitly — do not report a non-significant result as "equivalent."

## Common traps

- **Multiple comparisons**: if 20 subgroups are tested, one will be p < 0.05 by chance. Apply Bonferroni (divide α by number of tests) or FDR.
- **Early stopping**: if the A/B test was stopped as soon as it hit p < 0.05, the p-value is inflated. Always check whether the stopping rule was pre-registered.
- **Base-rate fallacy**: a "significant" improvement at 0.1% base rate with n=1000 each has very few positive examples and is unreliable. Check absolute counts, not just rates.
- **Same data, different metric**: "significantly better on metric X" may quietly be "significantly worse on metric Y." Ask what was pre-registered.

## Anti-patterns

- Do **not** treat p < 0.05 as a binary pass/fail. Report the CI and effect size.
- Do **not** report a significant result without sample size. "+12%" with no n is not a claim.
- Do **not** convert non-significant to "equivalent." Absence of evidence ≠ evidence of absence, especially at low n.
- Do **not** use one-sided tests unless the hypothesis was genuinely pre-specified as one-sided. The default is two-sided.

## Reference

- R. A. Fisher, _Statistical Methods for Research Workers_, 14th ed. Oliver and Boyd, 1970 — origin of p < 0.05 convention.
- J. Cohen, _Statistical Power Analysis for the Behavioral Sciences_, 2nd ed. Routledge, 1988 — effect-size thresholds.
- ASA statement on p-values: R. L. Wasserstein and N. A. Lazar, "The ASA Statement on p-Values: Context, Process, and Purpose," _The American Statistician_, vol. 70, no. 2, pp. 129–133, 2016. doi: 10.1080/00031305.2016.1154108
- Pairs with `assess-study-bias` (significance on a biased study is still unreliable) and `analysis-of-competing-hypotheses` (effect size drives evidence weight in ACH).
