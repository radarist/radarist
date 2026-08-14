---
name: brier-score-calibration
description: Use to score a prediction once its outcome is known, or to grade a set of probabilistic forecasts — "how accurate was that forecast?", "score my predictions", "was I overconfident?", "calibration check", "Brier score". Computes Brier's strictly-proper score and decomposes it into reliability and resolution. Closes the loop on `foresight`, which makes dated predictions that nothing currently scores.
---

# Brier Score & Calibration

A prediction of "70%" only means something once you've checked whether your 70%-calls come true about 70% of the time. The Brier score is the ruler: it penalizes confident-wrong calls hardest, and it's **strictly proper** — you can't game it by hedging; your expected score is best when you report your true belief.

## When to invoke

Trigger on phrases like "how good were my forecasts?", "was {X} well-calibrated?", "score my predictions", "calibration curve", "did our Delphi do better than guessing?", "evaluate forecaster {Y}", "Brier score", "forecast accuracy review".

Skip for:

- Predictions that aren't probabilistic or aren't dated — Brier needs a number and a resolution date. A vague "this will probably happen" can't be scored.
- One-off, already-decided questions — a single Brier score tells you little; calibration is a _set_ property.
- "Did we make the right call?" postmortems on deterministic decisions — that's `premortem-analysis` territory (retrospective). Brier is about the _probabilities_, not the choice.

## The score

For binary outcomes, the Brier score over N forecasts is the mean squared error:

```
BS = (1/N) · Σ (fₜ − oₜ)²
```

- `fₜ` = the probability you forecast (0–1)
- `oₜ` = the outcome (1 if it happened, 0 if not)
- Lower is better. **0 = perfect**; 1 = worst (single binary forecast). 0.25 = the score of a forecaster who always says 50/50 (i.e., no skill on balanced questions).

**Why it's the right ruler** (not "just count how many you got right"):

- A forecaster who said 99% on something that didn't happen is **punished hard** (0.99² ≈ 0.98). A forecaster who said 55% and was wrong is barely dinged (0.55² ≈ 0.30). Confidence is only rewarded when it's correct.
- It is **strictly proper**: your _expected_ score is maximized by reporting your honest probability, not by exaggerating or hedging. So scores incentivize truthful reporting — you can't inflate your grade by gaming the metric.

## Procedure

### 1 — Resolve the forecasts

You need, per prediction: the forecast probability `f`, the resolution date, and the binary outcome `o` (1/0, or "ambiguous → exclude"). Ambiguous or never-resolved predictions must be **excluded**, not counted as half-wrong — silently binning them as losses corrupts the average.

### 2 — Compute the mean Brier score

Sum `(fₜ − oₜ)²` across all resolved forecasts, divide by N. This is the headline number. But the headline alone is weak — a low Brier can mean either "well-calibrated but uninformative" or "bold and lucky." Decompose it.

### 3 — Decompose: reliability vs. resolution

Group forecasts into bins by stated probability (e.g. the 60–70% bin, the 70–80% bin). For each bin, compute the **observed frequency** of the event among forecasts in that bin. Murphy's decomposition (1973):

```
BS = RELIABILITY  −  RESOLUTION  +  UNCERTAINTY
```

| Component                                 | What it measures                                                                                                                 | Good direction                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Reliability** (calibration)             | Within each bin, does the observed frequency match the stated probability? "Of all my 70% calls, did ~70% happen?"               | **Lower is better** (0 = perfectly calibrated) |
| **Resolution** (sharpness/discrimination) | Do my conditional frequencies separate from the base rate? i.e., do my bins actually differ, or do I just say 50% on everything? | **Higher is better**                           |
| **Uncertainty**                           | Inherent variance of the outcomes                                                                                                | Fixed by the question set, not by you          |

**The two failure modes this exposes:**

- High reliability, low resolution → **well-calibrated but useless** ("I correctly admit I don't know, on everything"). The forecaster who says 50% on every coin flip is perfectly calibrated and adds nothing.
- Low reliability, high resolution → **bold but miscalibrated** ("I'm decisive and frequently wrong about how sure I am"). Confident and wrong.

A great forecaster has low reliability (well-calibrated) **and** high resolution (informative). Tracking only the mean Brier hides which one you're failing.

### 4 — Compare to a baseline (Brier Skill Score)

A raw Brier score is hard to interpret alone. Compare to the **climatological baseline** — predicting the base rate for every question. The Brier Skill Score:

```
BSS = 1 − (BS / BS_ref)
```

- `BS_ref` = the Brier score of always predicting the base rate (or a naive reference model).
- BSS > 0 means you beat the naive baseline; BSS < 0 means a coin or the base rate would have beaten you. A forecaster with negative skill is worse than not forecasting.

### 5 — Build the calibration curve

Plot, per bin, stated probability (x) vs observed frequency (y). A perfectly calibrated forecaster's points sit on the diagonal. Points above the diagonal = **underconfident** (you said 60%, it happened 80% of the time). Points below = **overconfident** (you said 80%, it happened 60%). The single most common human failure is overconfidence — points sagging below the diagonal on the right side.

### 6 — Emit the result

```
## Calibration & Brier Score — {forecaster / forecast set}

**Forecasts resolved:** N = {n} ({excluded: m, reason})
**Time span:** {range of resolution dates}

**Mean Brier score:** {BS}  (0 = perfect; 0.25 ≈ no-skill on balanced questions)
**Brier Skill Score vs base rate:** {BSS}  (>0 beats naive; <0 worse than guessing)
**Reliability (calibration error):** {REL}  (lower better)
**Resolution (sharpness):** {RES}  (higher better)

**Calibration read:** {overconfident on the high end | well-calibrated | underconfident | too few forecasts to judge}

**Calibration curve (bin → observed frequency):**
| Stated p | 0.1 | 0.3 | 0.5 | 0.7 | 0.9 |
|----------|-----|-----|-----|-----|-----|
| Observed | {..}| {..}| {..}| {..}| {..}|

**Calibration lesson:** {the one bias to correct next cycle, e.g. "pull high-confidence forecasts down — your 90% calls resolve at ~70%"}

**Skill lesson:** {e.g. "positive skill over base rate on tech-adoption questions; negative on regulatory-timing questions — your domain edge is real but narrow"}
```

## Anti-patterns

- Do **not** score a single prediction as if it meant something. Brier is a set property; N=1 tells you nothing about calibration.
- Do **not** silently count unresolved/ambiguous forecasts as losses. Exclude them and say so, or you bias the score toward "wrong."
- Do **not** report the mean Brier without the decomposition. A good mean can hide a useless forecaster (well-calibrated, zero resolution) or a reckless one (lucky this cycle).
- Do **not** skip the baseline. A Brier of 0.20 is meaningless until you compare to the base-rate Brier — on a 90%-base-rate question set, 0.20 may be _worse_ than just predicting "yes" always.
- Do **not** use Brier for rare events without large N. It discriminates poorly between small probability changes for very rare events; you need thousands of forecasts to score a 1%-event forecaster fairly.
- Do **not** grade resolution and calibration as if they're the same. A forecaster can be perfectly calibrated yet add nothing; reward both honesty **and** sharpness.

## Pair with

- `foresight` — produces the dated probabilistic prediction; this skill scores it when it resolves. Together they close the forecasting loop.
- `delphi-method` — a Delphi median is itself a forecast; score panels over time to see which panel compositions actually have skill.
- `test-significance` — distinct: significance asks "is this gap real vs noise"; Brier asks "were these probabilities accurate."
- `quantitative-sanity-check` — recompute anyone else's published Brier / calibration claim before quoting it.

## Reference

- G. W. Brier, "Verification of Forecasts Expressed in Terms of Probability," _Monthly Weather Review_, vol. 78, no. 1, pp. 1–3, 1950 — the original strictly-proper scoring rule.
- A. H. Murphy, "A New Vector Partition of the Probability Score," _Journal of Applied Meteorology_, vol. 12, no. 4, pp. 595–600, 1973 — the reliability/resolution/uncertainty decomposition.
- T. Gneiting and A. E. Raftery, "Strictly Proper Scoring Rules, Prediction, and Estimation," _Journal of the American Statistical Association_, vol. 102, no. 477, pp. 359–378, 2007 — why strict propriety makes Brier the right tool (vs. alternatives you can game).
- P. E. Tetlock and D. Gardner, _Superforecasting_, Crown, 2015 — the empirical case that calibration can be trained and measured with Brier over many forecasts.

## Radarist binding

Predictions only become scoreable if they were persisted with a resolution date:

- `getAgentObservations` — read back the predictions and kill-signals a prior run recorded about an entity. This is the population to score; without it there is nothing to grade.
- `recordAgentObservation` — where `foresight` writes its prediction and kill-signals in the first place.
- `getChangedSince` / `queryActiveEdges` — did the predicted change actually occur by the horizon?
- `getEntityTimeline` — the resolution evidence for a single entity's predicted move.

Score only predictions that carried an explicit probability and a date. Scoring a vague forecast retroactively is not calibration, it is storytelling.

Honest limit: nothing marks a forecast resolved. `getAgentObservations` returns the same observation on every future run, so name in your output exactly which forecasts you scored and their resolution dates — that record is the only thing stopping a later run from scoring them again.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
