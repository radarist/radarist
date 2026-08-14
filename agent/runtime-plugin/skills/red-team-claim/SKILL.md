---
name: red-team-claim
description: Use before a report's headline claim reaches a user — "our conclusion is {X}", "the key takeaway is {Y}". Adversarial review — what a skeptical reviewer, a competitor's analyst, or a regulator would say against it. Names attack vectors and forces a fix, a hedge, or a retraction. For whole-report structure use `critique-report` instead.
---

# Red Team Claim

Adversarial review. Imagine the smartest critic of this claim has to tear it apart — what do they say?

## When to invoke

Trigger before emitting:

- A report's executive summary / key takeaway / headline conclusion
- Any claim that will propagate (e.g. "Anthropic will dominate AI infrastructure in 2026")
- A recommendation the user will act on

Particular candidates:

- After `write-imrad-report` produces its Discussion section
- After `analysis-of-competing-hypotheses` picks a winning hypothesis
- After a Strategist emits a headline insight

Skip for:

- Procedural outputs (a patent claim extraction, a FundingEvent record — they are descriptive, not assertive)
- Reports still in draft that need verification first (run `grounded-answer` + `triangulate-sources` first, then red-team)
- Chat-level conversational claims

## The seven attack vectors

A red-team pass checks the claim against each of these. Name the vectors that apply — don't just pick the easy ones.

### 1. **Definition attack**

What does the claim _actually mean_? Are the terms defined unambiguously? "Anthropic will dominate" — dominate what? Dominate how? Revenue share? API volume? Enterprise mindshare? A vague claim fails on definition alone.

### 2. **Baseline attack**

Compared to what? "30% faster" → faster than what baseline? Same model family? Last year? The competitor's best configuration? An undefined baseline means the claim is unfalsifiable.

### 3. **Selection bias attack**

What cases did the claim-author choose to look at? Are there cases they left out that would weaken the claim? "Our model beats GPT-5 on HumanEval" — what about the 12 other benchmarks where it didn't? Cherry-picked evidence.

### 4. **Counter-example attack**

One specific, credible counter-example that breaks the claim. "Anthropic will dominate" → counter: "But Meta Llama has 10× the deployment count and zero Anthropic revenue share in the open-source segment." A single strong counter forces the claim to hedge.

### 5. **Mechanism attack**

Does the claim specify _why_ it's true? A claim without a causal mechanism can't be defended when the mechanism fails. "LLMs will replace traditional search" — through what mechanism? If the mechanism is "RAG integration," what about cases where RAG is a cost center, not a win?

### 6. **Base-rate attack**

What's the historical base rate of this type of claim being true? "X will dominate the market" — historically, how often do such predictions pan out? If the answer is 20%, the claim should carry that prior.

### 7. **Incentive attack**

Who benefits if the reader believes this claim? Is the author's incentive aligned with truth or with persuasion? A Gartner report predicting "$50B market by 2027" might be accurate — or might be Gartner's sales incentive to sell consulting on that market. Name the incentive, then discount accordingly.

## Procedure

### 1 — State the claim in one sentence

Lift it verbatim from the report. The red-team reviews the _claim as stated_, not a charitable interpretation.

### 2 — Walk the seven vectors

For each vector: does it apply? If yes, what's the specific attack?

Format:

| Vector          | Applies?   | Attack                                                                                                     |
| --------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| Definition      | ✅         | "Dominate" is undefined — revenue share? mindshare? benchmark-share?                                       |
| Baseline        | ✅         | "In 2026" — vs 2025 or vs 2024? The 2025 baseline would weaken the trajectory claim                        |
| Selection       | ❌         | —                                                                                                          |
| Counter-example | ✅         | Llama has 10× deployment count in open-source segment (Hugging Face Hub data)                              |
| Mechanism       | ⚠️ partial | Claim mentions "superior models" but not how this translates to dominance (distribution? ecosystem?)       |
| Base-rate       | ✅         | "X will dominate" type claims are historically 20–30% accurate in tech-sector predictions (5-year horizon) |
| Incentive       | ❌         | Author is a neutral analyst with no commercial tie                                                         |

### 3 — Compute a claim-survival score

Count the ❌ (no attack applies) vectors. Each ❌ is +1. Maximum 7.

- **7** — claim survives all attacks. Ship as stated.
- **5–6** — claim survives most. Hedge the weak vectors in the published version.
- **3–4** — claim is weak. Either substantially revise or downgrade to "some evidence suggests" language.
- **0–2** — claim is broken. Retract or rewrite from scratch.

### 4 — Output structured decision

```
## Red-Team Review — {claim}

**Original claim:** {claim verbatim}

**Attack vectors:**

| Vector | Applies? | Specific attack | Severity |
|---|---|---|---|
| Definition | ✅/❌/⚠️ | {attack} | L/M/H |
| Baseline | ✅/❌/⚠️ | {attack} | L/M/H |
| Selection | ✅/❌/⚠️ | {attack} | L/M/H |
| Counter-example | ✅/❌/⚠️ | {attack} | L/M/H |
| Mechanism | ✅/❌/⚠️ | {attack} | L/M/H |
| Base-rate | ✅/❌/⚠️ | {attack} | L/M/H |
| Incentive | ✅/❌/⚠️ | {attack} | L/M/H |

**Survival score:** {N}/7

**Verdict:** {ship / hedge / rewrite / retract}

**If ship-with-hedge, suggested rewrite:**
> {Original claim, with hedges added to address the weak vectors}

**Attack vectors that must be pre-empted in the published text:** {list}
```

### 5 — Propose the hedged rewrite

If the verdict is "hedge" (score 5–6), write the claim as it should appear in the final report. Show both versions:

- **Original:** "Anthropic will dominate AI infrastructure in 2026."
- **Hedged:** "Anthropic is positioned to lead the enterprise AI API segment in 2026 on current trajectory, though open-source Llama deployment and shifts in enterprise-procurement preferences could materially change this within 12 months."

The hedged version adds: segment narrowing (enterprise API vs "AI infrastructure"), conditional language ("on current trajectory"), and a named counter-scenario.

### 6 — Pair downstream

- If the verdict is "retract or rewrite," call `abstain-or-escalate`.
- If the verdict is "hedge," the hedged version replaces the headline.
- Feed the named attack vectors into `premortem-analysis` as failure modes.

## Anti-patterns

- Do **not** skip the counter-example vector. "No counter-example exists" is itself a strong finding — make it explicit rather than implicit.
- Do **not** red-team your own conclusions charitably. The whole point is adversarial rigor.
- Do **not** treat the report's own evidence as adversarial. Red-teaming means _looking for evidence the report doesn't cite_.
- Do **not** apply this to every sentence. Apply to headline claims and recommendations — the things that propagate.
- Do **not** let incentive attacks substitute for evidence attacks. "The author works for a firm that sells X" is an incentive note, not a claim-invalidator by itself.

## Reference

- R. J. Heuer, _Psychology of Intelligence Analysis_, CIA Center for Study of Intelligence, 1999 — chapter on "structured analytic techniques" and the devil's advocate role.
- P. Schoemaker, "The Use of Scenarios in Strategic Decision Making," _Sloan Management Review_, 1993 — on explicit counter-scenario construction.
- M. Tetlock, _Superforecasting: The Art and Science of Prediction_, Crown, 2015 — on base-rate reasoning and inside/outside view distinction.
- Anthropic's "constitutional AI" adversarial prompting pattern (arXiv:2212.08073, 2022) — methodological inspiration for structured adversarial review.
- Pairs with `abstain-or-escalate` (structural flaw found → abstain), `premortem-analysis` (ex-ante failure analysis; red-team is claim-level, premortem is decision-level), and `analysis-of-competing-hypotheses` (ACH picks winner → red-team stress-tests the winning conclusion).

## Radarist binding

The strongest attack on a claim is that its own support has since been contradicted:

- `getClaimHealth` — support level and corroboration for the claim's entities.
- `queryActiveEdges` — is the supporting edge still current, or carrying `t_invalidated`?
- `getRelationEvidence` — read the actual sources rather than the summary of them.
- `findDataGaps` — what is missing that would change the conclusion.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
