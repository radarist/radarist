---
name: bayesian-update
description: Use to revise a belief in light of new evidence rather than treating new data as decisive — "does this change my mind?", "how much should this move my estimate?", "update my prior", "posterior probability", "is this signal strong enough to act on?". A transparent Bayes-factor update — state the prior, assess evidence likelihood under each hypothesis, combine into a posterior. Guards against base-rate neglect.
---

# Bayesian Update

Don't ask "does this evidence prove it?" Ask "how much should this evidence move me?" A Bayes update forces you to name your starting belief (the prior), name how surprising the evidence is under each story (the likelihood), and let the math combine them — instead of letting a vivid new data point overwrite everything.

## When to invoke

Trigger on phrases like "does this change anything?", "how strong is this signal?", "update my probability", "Bayesian update", "given this evidence, how likely is {X}?", "prior vs posterior", "is this enough to act on?".

Skip for:

- Factual lookups with one right answer — use `grounded-answer`. Bayesian reasoning is for *probabilistic* beliefs under uncertainty.
- Questions better answered by enumerating evidence against all hypotheses — `analysis-of-competing-hypotheses` already does that qualitatively. Reach for Bayes when you want a *number* and the prior really matters (low base rates, surprising evidence).
- Deterministic / mechanistic questions where the answer follows from rules, not probability.

## Why it works (and the two biases it fixes)

1. **Base-rate neglect.** A dramatic positive test on a rare disease is usually a false positive, because the disease is rare. Bayes bakes the base rate in as the prior, so rare things stay hard to confirm.
2. **Overreaction to the latest datum.** A single strong signal shouldn't flip a well-grounded belief. The update size is bounded by how *discriminative* the evidence actually is — often much less than it feels.

## The pieces

To update, you need three things, stated explicitly:

- **Prior** `P(H)` — how likely the hypothesis was *before* this evidence. This is the base rate. Naming it is the whole point; it's where most reasoning errors live.
- **Likelihood** `P(E | H)` — if the hypothesis were true, how expected is this evidence? And `P(E | ¬H)` — if it were false, how expected? The ratio `P(E|H) / P(E|¬H)` is the **Bayes factor**: how much the evidence shifts the odds. A Bayes factor of 1 means the evidence is useless (equally likely under both stories); 10 means it favors H tenfold.
- **Posterior** `P(H | E)` — what you should believe after combining them.

Odds form (the clean way to think and compute):

```
Posterior odds = Prior odds × Bayes factor
 P(H|E)/P(¬H|E) = [P(H)/P(¬H)] × [P(E|H)/P(E|¬H)]
```

Multiply odds, don't add beliefs. A prior of 1:99 and a Bayes factor of 10 becomes 10:99 — the hypothesis moved up a lot *relatively* but is still unlikely *absolutely*. Both readings matter; people quote the former and hide the latter.

## Procedure

### 1 — Define the binary hypothesis (or use the dominant pair)

Bayes is cleanest with two hypotheses (H vs ¬H). For multi-hypothesis questions, either pick the leading pair and update that, or run `analysis-of-competing-hypotheses` instead — don't fake a single posterior across a messy hypothesis space.

### 2 — Set the prior from a base rate, not a feeling

`P(H)` comes from a **reference class** — how often has this kind of thing been true before? "A startup with these signals reaches Series B" → look at the base rate for comparable startups, not how excited you are about this one. If you can't find a reference class, say so and use a wide, honest prior — never a precise one invented to look rigorous.

### 3 — Estimate the likelihoods — and rate the evidence's diagnosticity

For the new evidence, ask both: "if H, how expected?" and "if ¬H, how expected?" The evidence is only strong if these **differ**. A datum that's expected under both stories carries little Bayes factor no matter how vivid.

| Bayes factor | Strength of evidence (per convention) |
| --- | --- |
| 1–3 | Barely worth mentioning |
| 3–10 | Moderate |
| 10–30 | Strong |
| 30–100 | Very strong |
| >100 | Decisive |

Be honest about weak evidence. Most single signals are in the 1–10 range; treating them as "decisive" is the classic error.

### 4 — Compute the posterior

Multiply prior odds by the Bayes factor. Convert back to a probability if useful: `P = odds/(1+odds)`. Always report **both** the relative shift ("odds rose 10×") and the absolute posterior ("still only 9% likely"). One without the other misleads.

### 5 — Sensitivity: would a different prior or likelihood flip it?

Bayes outputs are only as good as the inputs. Vary the prior across a plausible range and vary the Bayes factor; see whether the *decision* changes. If a small change in the prior flips the call, you don't have a conclusion — you have a need for more diagnostic evidence. Name the single most load-bearing input.

### 6 — Emit the update

```
## Bayesian Update — {question}

**Hypothesis (H):** {specific, testable}
**Prior P(H):** {value} — base-rate rationale: {reference class}
**Prior odds:** {H:¬H}

**New evidence:** {the specific datum}
**Likelihood if H true, P(E|H):** {value}
**Likelihood if H false, P(E|¬H):** {value}
**Bayes factor:** {P(E|H)/P(E|¬H)} — {barely/moderate/strong}

**Posterior odds:** {value}   →   **Posterior P(H|E):** {value}

**Two reads:**
- Relative: odds moved {Nx}.
- Absolute: hypothesis is now {still unlikely | roughly coin-flip | likely}.

**Sensitivity:** decision is {robust | fragile} — it flips if prior is {<X} or Bayes factor is {<Y}.
**Most load-bearing input:** {the prior base rate | the P(E|¬H) estimate} — that's what to re-source.

**Confidence in this update:** {0.0–1.0}
```

## Anti-patterns

- Do **not** skip the prior. "Looking only at the evidence" is base-rate neglect dressed up as objectivity — the prior is the base rate and it usually dominates.
- Do **not** invent a precise prior you can't justify. A wide honest prior beats a precise fake one; say "I don't have a reference class" if you don't.
- Do **not** treat vivid evidence as strong. Diagnosticity is `P(E|H) vs P(E|¬H)`, not how surprising `E` feels. A shocking fact expected under both stories moves you almost nothing.
- Do **not** report the relative shift without the absolute posterior. "Odds doubled!" on a 1-in-1000 hypothesis leaves it at 1-in-500.
- Do **not** chain updates on dependent evidence as if independent. Two reports citing the same primary source are one observation, not two — multiplying their Bayes factors double-counts.
- Do **not** use Bayes to dress a foregone conclusion. If your prior is 0.99, almost no evidence moves it, and you didn't need an update — you needed `key-assumptions-check` on why the prior is 0.99.

## Pair with

- `analysis-of-competing-hypotheses` — ACH is the qualitative, all-hypotheses version; Bayes is the two-hypothesis quantitative version. Use ACH to enumerate, Bayes to put a number on the leading pair.
- `key-assumptions-check` — the prior is an assumption; surface and challenge it explicitly.
- `foresight` / `delphi-method` — both produce priors (a prediction, a panel median); a Bayes update is how you revise one when new evidence lands before resolution.
- `brier-score-calibration` — over many updates, score whether your priors and likelihoods were accurate.

## Reference

- T. Bayes (posthumous, ed. R. Price), "An Essay towards solving a Problem in the Doctrine of Chances," _Philosophical Transactions of the Royal Society_, vol. 53, pp. 370–418, 1763 — the origin.
- P.-S. Laplace, _Théorie analytique des probabilités_, 1812 — the independent, general development that made Bayes practical.
- J. Zlotnick, "A Theoretical Basis for the Use of Bayesian Analysis in Intelligence," _Studies in Intelligence_ (CIA), 1972 — the foundational case for Bayes in intelligence analysis, where base-rate neglect and overreaction are endemic.
- R. J. Heuer Jr., _Psychology of Intelligence Analysis_, CIA Center for the Study of Intelligence, 1999, ch. 12–13 — the analyst-facing treatment of Bayesian reasoning and the biases it corrects.
- E.-J. Wagenmakers et al., "Bayesian Benefit for the Pragmatic Researcher," _Psychonomic Bulletin & Review_, 2018 — a usable, modern statement of the Bayes factor and its interpretation thresholds (the 1–3–10–30 convention).
