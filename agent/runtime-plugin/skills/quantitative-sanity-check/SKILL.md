---
name: quantitative-sanity-check
description: Use when a document, signal, or report states numbers that should be internally consistent — CAGR from $A to $B by a year, revenue/users/price triples, "improved 5%" (percent or percentage points?), survivorship framing, Fermi-style headline figures. Recomputes the source's own arithmetic. Internal consistency only — no external sources.
---

# Quantitative Sanity Check

The mathematician's pass: before trusting a number, recompute it from the other numbers the source itself provides. A claim whose own figures contradict each other is wrong before any external fact-check begins.

## When to invoke

Trigger on phrases like "at a CAGR of X%", "expected to grow from $A to $B by {year}", "{N} customers at ${P}/month generating ${R}", "revenue per user", "improved/grew by X%", "X% of successful companies", "10× in 5 years", or any claim that combines two or more numbers that imply a third.

Scope boundary — this skill is **internal arithmetic and consistency only**. It complements (does not duplicate):

- `test-significance` — is a measured gap real or statistical noise? (variance, sample size)
- `estimate-market-size` — building a market size from scratch via top-down + bottom-up triangulation
- `grounded-fact-check` — verifying a claim against **external** sources via live search grounding

Run this skill first: if the claim's own numbers don't reproduce each other, there is nothing to ground or test. Skip when a claim contains a single isolated number with no companion figures to check it against — that is `grounded-fact-check` territory.

## Procedure

### 1 — Inventory the numbers

List every quantitative claim and mark which ones are **linked** — i.e., the source presents them as arithmetically related (start value + end value + growth rate; price + users + revenue; share before + share after + change). Only linked sets are checkable here.

### 2 — Verify CAGR / compounding arithmetic

Any (start, end, years, CAGR) quadruple is over-determined — recompute one from the other three:

```
end = start × (1 + CAGR)^years
implied CAGR = (end / start)^(1/years) − 1
```

Worked example: "the market grows from $6.25B (2024) to $50B by 2032 at a 24.8% CAGR."

- Forward check: 6.25 × 1.248^8 ≈ 6.25 × 5.89 ≈ **$36.8B** — not $50B.
- Implied CAGR: (50 / 6.25)^(1/8) − 1 = 8^(1/8) − 1 ≈ **29.7%** — not 24.8%.
- Verdict: internally inconsistent. One of the three numbers is wrong (or the period is not 8 years). Flag; do not pick a side without re-sourcing.

Common compounding traps: off-by-one on the year count (2024→2032 is 8 compounding periods, not 9); simple-vs-compound confusion ("25%/yr for 8 years" is 5.9×, not 3.0×); "doubling every N years" implies CAGR = 2^(1/N) − 1, not 100/N %.

### 3 — Check unit-economics consistency

Any (price, customers, revenue) triple must multiply through:

```
implied revenue = customers × price per period × periods per year
```

Worked example: "$120M ARR from 40,000 customers at $99/month."

- Implied ARR: 40,000 × $99 × 12 = **$47.5M** — a 2.5× gap to the claimed $120M.
- Possible resolutions: a higher-priced enterprise tier dominates revenue (then "$99/month" is misleading as the representative price), customer count includes free seats, or one figure is simply wrong. The claim as stated is inconsistent — flag it and name the gap.

Accept a triple only when it reproduces within ~±20% (pricing tiers, churn timing, and FX legitimately blur exact multiplication). Beyond that, the burden is on the source.

### 4 — Catch percentage vs percentage-point confusion

"Improved by 5%" from a 10% baseline means either 10.5% (relative, ×1.05) or 15% (percentage points, +5pp) — a 10× difference in implied impact.

- If the source gives before AND after values, compute both readings and state which one the prose matches.
- If only the delta is given, mark the claim **ambiguous** and report both readings. Do not silently choose the more impressive one.
- Watch the reverse trap too: "share fell 50% to 20%" — from 40% (relative) or from 70% (points)?

### 5 — Run survivorship and base-rate checks

For any "X% of {successful group} did Y" claim, ask for the inverted statistic:

- **Survivorship**: "90% of unicorns pivoted early" is uninformative without the denominator — what fraction of _all_ companies that pivoted early became unicorns? If the source only samples winners, tag the claim `survivorship-biased` and treat it as anecdote, not evidence.
- **Base rate**: "the screen detects 99% of cases" at a 1% prevalence still yields mostly false positives unless specificity is also ≈99%. Recompute the positive predictive value when prevalence is available: `PPV = (sens × prev) / (sens × prev + (1 − spec)(1 − prev))`. Worked example: sens 99%, spec 95%, prev 1% → PPV ≈ 0.0099 / (0.0099 + 0.0495) ≈ **17%** — the headline "99% accurate" claim inverts to "5 in 6 positives are false."

### 6 — Fermi decomposition with order-of-magnitude cross-check

For a headline figure with no companion numbers but a decomposable structure, build one independent estimate:

```
quantity ≈ (population) × (participation rate) × (frequency) × (unit value)
```

Round each factor to the nearest order of magnitude or half-magnitude (1, 3, 10, 30, …). If the decomposition lands within ~3× of the claim, the claim is plausible; if it differs by ≥10×, flag it. Worked example: "US developers spend $50B/yr on AI coding tools" — ~4M developers × ~50% adoption × ~$300/yr ≈ **$0.6B**. The claim is ~80× the decomposition: flag as implausible-as-stated (it may be conflating tool spend with total productivity value).

This is the generic single-estimate version of the method — when the number is specifically a _market size_ and the stakes justify two full estimates with cited inputs, hand off to `estimate-market-size`.

### 7 — Render the verdict

```
## Quantitative sanity check — {document / claim set}

| # | Claim | Check | Recomputed | Verdict |
|---|-------|-------|------------|---------|
| 1 | $6.25B → $50B by 2032 at 24.8% CAGR | compounding | implies 29.7% CAGR (or $36.8B end) | inconsistent |
| 2 | 40K customers × $99/mo = $120M ARR | unit economics | implies $47.5M | inconsistent (2.5×) |
| 3 | "conversion improved 5%" | pp vs % | 10.5% or 15% — ambiguous | ambiguous |

**Overall**: {consistent / inconsistent / ambiguous / unverifiable}
**Action**: {pass through / flag in report / re-source via grounded-fact-check / drop claim}
```

Each row's verdict is one of: **consistent** (reproduces within tolerance), **inconsistent** (numbers contradict each other — show the recomputation), **ambiguous** (two readings possible — show both), **unverifiable** (no linked numbers to check against).

## Anti-patterns

- Do **not** "fix" an inconsistent claim by picking the number you find more plausible. Flag the inconsistency; re-sourcing is `grounded-fact-check`'s job.
- Do **not** confuse internal consistency with truth. A claim whose numbers multiply through can still be externally wrong — consistency is necessary, not sufficient.
- Do **not** apply false precision. Recomputed CAGRs to four decimals imply rigor the inputs don't have; one decimal place is enough to show a contradiction.
- Do **not** flag rounding as inconsistency. $47.5M reported as "$48M" is fine; "$120M" is not.
- Do **not** run statistical tests here. If the question is "is this gap noise?", that's `test-significance`.

## Reference

- E. Fermi-style decomposition: see `estimate-market-size` for the two-sided (top-down + bottom-up) variant.
- D. Kahneman, _Thinking, Fast and Slow_, Farrar, Straus and Giroux, 2011 — base-rate neglect (ch. 14–16).
- A. Wald's bomber-armor analysis (1943) — the canonical survivorship-bias case; see M. Mangel and F. J. Samaniego, "Abraham Wald's Work on Aircraft Survivability," _JASA_, vol. 79, no. 386, pp. 259–267, 1984.
- D. Huff, _How to Lie with Statistics_, W. W. Norton, 1954 — percentage vs percentage-point and baseline games.
- Pairs with `claim-provenance` (tag the surviving numbers), `grounded-fact-check` (external verification after internal checks pass), and `abstain-or-escalate` (when an inconsistent number is load-bearing and can't be re-sourced).
