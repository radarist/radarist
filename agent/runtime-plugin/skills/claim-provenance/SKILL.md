---
name: claim-provenance
description: Use when a brief or report contains fact-claims — numbers ("$6.25B market", "24.8% CAGR", "60% YoY"), forward-looking projections, or any sentence a reader might act on. Tags each with `[validated, <source>]` or `[assumption, retire-by <milestone>]` per Discovery-Driven Planning.
---

# Claim Provenance

One bracket per fact-claim. `[validated, <source>]` if cited. `[assumption, retire-by <milestone>]` if reasoned. Default is bracket-less prose for non-fact sentences (transitions, framing, qualitative narrative).

## When to invoke

Trigger on any output that contains fact-claims a reader might act on:

- Quantitative claims ("$6.25B market", "24.8% CAGR", "60% YoY funding surge", "60% of HR leaders cite skills as top priority")
- Forward-looking projections ("market reaches $15B by 2030", "Workday acquires Eightfold within 18 months")
- Categorical assertions ("Eightfold is the leader in skills intelligence", "EU AI Act prohibits autonomous offer extension")
- Comparative claims ("Workday is more expensive than Eightfold", "Eightfold has the largest installed base")

Particularly valuable when:

- The brief makes recommendations that depend on the claim's truth
- The claim shapes the executive summary or headline conclusion
- The reader is a decision-maker who will act before re-validating
- The brief is timestamped and the data may decay (current-state claims especially)

Skip for:

- Headers, section titles, transition phrases ("In this brief, we examine…")
- Methodology descriptions of what the analysis did, not what's true ("We surveyed 12 vendors")
- Pure qualitative narrative ("the regulatory environment is heating up") — soften the claim instead, don't tag a vibe
- Trivial observations the reader doesn't act on ("AI is a category that includes many subdisciplines")

## The method in four steps

### 1 — Identify the fact-claim

A fact-claim is a sentence whose truth-value matters to the reader's decision. Test it: if this sentence were wrong, would the reader's next action change?

- Pass: `The AI in HR market reached $6.25B in 2026.` — wrong by $2B and the investment thesis shifts.
- Pass: `Workday acquired HiredScore for $530M in March 2026.` — wrong on the price and the M&A premium thesis collapses.
- Fail: `AI is reshaping HR.` — vibe, not fact-claim. Either sharpen ("AI assistants now appear in 42% of Fortune 500 HR stacks") or leave un-tagged.
- Fail: `This brief is a Q1 2026 snapshot.` — methodology, not claim about the world.

### 2 — Decide validated vs assumption

A claim is **validated** when:

- A citation in the brief supports it directly (a numbered IEEE ref, a DOI, a named report)
- The cited source is reasonably authoritative for this claim type (analyst report for market sizing; SEC filing for financials; vendor press release for funding rounds)
- The cited claim matches your sentence — not "we cited a number from this category" but "we cited _this specific_ number"

A claim is an **assumption** when:

- It's reasoned from priors ("typical pilot in this category runs $80-120k")
- It's a forward-looking projection without a forecasting model behind it
- The cited source is a vendor self-report on its own product
- You can't point to a specific sentence in a specific source that says exactly this

If you're unsure, mark it `[assumption, retire-by <milestone>]` — that's honest and it forces a future check. False-validated tags are the failure mode that DDP exists to prevent.

### 3 — Format the bracket

**Validated form:**

```
<claim>. [validated, <source identifier>; <optional verification action>]
```

- `<source identifier>` should be the same identifier used in the References section if the brief has one ("MarketsAndMarkets 2026", "[12]", "SEC 10-K Workday FY2026 Q3")
- `<optional verification action>` is for claims that _should_ be re-checked even though they're cited — mostly for analyst-research single-sourced numbers that benefit from cross-verification

**Assumption form:**

```
<claim>. [assumption, retire-by <milestone>]
```

- `<milestone>` must be a specific event or date that, if it happens, converts the assumption to validated knowledge — or kills it
- Good milestones: `retire-by Q4 2026 with Workday Skills Cloud installed-base count`, `retire-by next earnings call disclosure`, `retire-by 8-week pilot completion`
- Bad milestones: `retire-by later`, `retire-by more research` — same as un-tagged. Be specific.

### 4 — Place the bracket inline at the end of the claim

The bracket goes inside the paragraph, immediately after the sentence-terminating punctuation. Do not relegate provenance to footnotes — the reader needs to see validation status while reading the claim, not after.

- Good: `The AI in HR market reached $6.25B in 2026 [validated, MarketsAndMarkets 2026 [12]].`
- Good: `Skills graphs will be the dominant talent-mobility primitive by Q2 2027 [assumption, retire-by Q4 2026 with Workday Skills Cloud installed-base count].`
- Bad: `The AI in HR market reached $6.25B in 2026.\n\n[Provenance footnote — validated against MarketsAndMarkets]` — the reader has already moved on.

## Output format (mandatory)

When invoked across a report or analysis, every fact-claim sentence ends with one of:

```
[validated, <source identifier>[; <optional verification action>]]
[assumption, retire-by <specific milestone>]
```

This format is machine-parseable. The L1 quality gate (`mission-quality.ts:SKILL_PROCEDURE_MARKERS`) detects two markers — opening `[validated,` bracket and `[assumption, ... retire-by ...]` block — and counts the sentence-level discipline as the `claim-provenance` skill-procedure marker.

## Coverage targets

This is a discipline applied across the whole document, not a single block. Aim for:

- ≥80% of quantitative sentences tagged (validated or assumption)
- 100% of headline / executive-summary fact-claims tagged
- 100% of forward-looking projections tagged as assumptions with retire-by milestones

Below these thresholds, the brief reads to a sceptical reader as "I can't tell which numbers are real" — and the reader either over-trusts (escalation risk) or discards the brief entirely (lost work).

## Anti-patterns to refuse

- **Validated tag on a vendor self-report** — vendor "we have 1.6B career profiles" is not validated by a vendor press release; mark it `[assumption, retire-by independent third-party verification]` or downgrade to a qualitative narrative.
- **Assumption tag without retire-by** — `[assumption]` alone is half-honest. The retire-by is the discipline; without it, the tag is decorative.
- **Vague retire-by milestones** — `retire-by later this year` is the same as un-tagged. Be specific (date, event, threshold).
- **Tag-spam on non-fact sentences** — methodology, transitions, and qualitative framing don't get tags. Tagging everything devalues the tagging.
- **Citation laundering** — wrapping a vendor-self-reported number in `[validated, vendor press release 2025 [4]]` is technically a citation but doesn't change that the source is conflicted. Use `[assumption, retire-by independent verification]` instead.
- **Single-source `[validated]` tags on decision-grade numbers** — for executive-summary or recommendation-driving claims, single-source is a soft fail; pair with `triangulate-sources` to get a second source before tagging validated.

## Working with other skills

- After every quantitative-claim sentence → tag it.
- Before `critique-report` runs its 10-point review → run claim-provenance to surface tag coverage. The L1 gate catches uncovered claims that `critique-report` alone might miss.
- Use with `triangulate-sources` — when a claim is validated by only one source, the `[validated]` tag should include the verification action ("cross-check against IDC by Q3").
- Use with `grounded-answer` — chain-of-verification surfaces whether a draft claim has a verifiable source; the result decides validated vs assumption.
- Use with `cheapest-experiment` — recommendations that depend on `[assumption, …]` claims should design the experiment that retires the assumption.
- Pair with `red-team-claim` on any `[validated, …]` claim in the executive summary — would a hostile reviewer accept the source as authoritative for this specific number?

## Confidence notes

Provenance and confidence are different axes — a `[validated]` claim can still have low confidence if the cited source is one of several with disagreement (analyst reports diverge widely on market sizing, for example). The bracket records the _type_ of evidence; confidence records _how much_ the type backs the claim. Both should be present in any decision-grade brief.

## Radarist binding

The validated-vs-assumption split is already stored — read it:

- `getEntityAssertions` / `getRelationEvidence` — which claims have evidence and which do not.
- `explainRelation` — the asserter and the basis, which decides `[validated]` vs `[assumption]`.
- `getClaimHealth` — a fast per-entity view when the report cites many.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
