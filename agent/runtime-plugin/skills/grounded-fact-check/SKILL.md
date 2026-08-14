---
name: grounded-fact-check
description: Use before publishing a report that states load-bearing specifics — vendor and product numbers, benchmark scores, market figures, dates, named standards, "X overtook Y in YYYY", percentages a reader would act on. Verifies each value against a grounded search and reconciles the draft. For identifier format validation use `verify-citations` instead.
---

# Grounded Fact-Check

A citation proves a number was _written down somewhere_. It does **not** prove the number is _correct_. The most dangerous report defect is a fabricated-but-plausible specific — e.g. "Microsoft Majorana-1 = 32 logical qubits" (real chip: 8 physical topological qubits) — presented behind a `[3]` citation and a self-assigned reliability grade, so every reviewer assumes it was validated. This skill closes that gap: it verifies the _value_, not the _formatting_.

`grounded-answer` runs general Chain-of-Verification against graph/web/firecrawl. This skill is the **specific-number tripwire** that must fire before any report ships — it always uses live Google Search grounding and is scoped to the handful of load-bearing specifics a decision rests on.

## When to run

Run before publishing a report/brief/document that contains one or more **load-bearing specific claims**:

- **Vendor/product specs** — qubit counts, parameter counts, context windows, throughput, "X% on \<benchmark\>", model/chip generations.
- **Market figures** — TAM/SAM/SOM, CAGR, revenue, headcount, "$X billion".
- **Dates & precedence** — "released in YYYY", "X overtook Y in YYYY", "first to \<milestone\>".
- **Named standards / entities** — "NIST FIPS 203 = ML-KEM", spec numbers, org names attached to a specific fact.

Skip only for pure conversational turns that contain no factual specifics.

Do **not** spend grounding calls on: the report's own _forecasts_ (a dated prediction with kill-signals is an honest hedge, not a checkable fact), subjective judgments, claims already tagged `[assumption]`/`[estimate]`, or round framing numbers with no decision weight.

## The loop

### 1 — Extract the load-bearing claims

List the specific, **present-or-past-tense, externally-checkable** claims a reader would act on. Aim for the top 5–12 by decision weight. For each, note the exact value as written and whether it already carries a citation. A citation does not exempt a claim — that is precisely the case this skill exists for.

### 2 — Verify each via grounding (do NOT echo the draft)

For each claim, call **`search_with_grounding`** with a _neutral_ question that does not state your draft value — anchoring on your own number defeats the check:

- Draft: "Majorana-1 has 32 logical qubits [3]" → Ask: **"How many qubits does Microsoft's Majorana-1 chip have, and are they physical or logical?"**
- Draft: "Quantinuum H2 reaches 96 qubits" → Ask: **"How many qubits does Quantinuum's H2 system have? How many does Helios have?"**
- Draft: "China overtook the US in quantum in 2023" → Ask: **"When did China surpass the US in quantum computing, by what measure?"**

Read the grounded answer and its sources. Do not answer from memory — if you did not call the tool, you did not verify.

### 3 — Classify each claim

| Grounded result vs. draft                                  | Verdict          | Action                                                                                                |
| ---------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| Grounded sources state the **same** specific value         | **confirmed**    | Keep. Ensure the citation points at a source that actually states it.                                 |
| Grounded sources state a **different, specific** value     | **contradicted** | **Correct the draft to the grounded value + cite that source.** Never ship the original.              |
| Grounding is ambiguous / no source states a specific value | **unverifiable** | Do not assert it as fact. Soften ("reportedly", "as of YYYY") **or** tag `[estimate]` **or** drop it. |

Bias toward **unverifiable over contradicted** when the grounded result is fuzzy — only mark _contradicted_ when a source states a clearly different specific value. (This mirrors `abstain-or-escalate`: when verification fails, refuse-or-hedge, don't guess a "corrected" number.)

### 4 — Reconcile and record

Apply every correction before publishing. The published report must contain **zero** specific claims that this loop classified `contradicted`. For `unverifiable` claims that you chose to keep, they must be visibly hedged or `[estimate]`-tagged — not presented as confirmed fact behind a citation or grade.

End your work (not the report body) with a one-line ledger so the correction is auditable, e.g.:
`Fact-check: 9 load-bearing claims · 7 confirmed · 1 corrected (Majorana-1 32→8 physical) · 1 hedged ([estimate])`

## Anti-patterns (do not do)

- **Do not** treat a citation, an Admiralty grade, or a confident tone as verification. Those are the camouflage this skill removes.
- **Do not** phrase the grounding question so it echoes your draft number ("Is it true Majorana-1 has 32 logical qubits?") — it biases the search toward confirming you.
- **Do not** "verify" a forecast/opinion — scope to checkable specifics, or you burn calls and invent false contradictions.
- **Do not** invent a "corrected" value when grounding is fuzzy — that is a new fabrication. Hedge or drop instead.
- **Do not** skip a claim because it "is obviously right." The Majorana number looked obviously right; that is why it shipped.

## Enforcement note (for report producers)

This skill is the during-draft discipline. It is **also enforced after the draft**: the mission quality loop runs an independent grounded check on the published report's load-bearing claims (`report-claims-verified`); a contradiction there flips the verdict to REVISE and sends you a "correct X → Y [grounded source]" instruction. Running this skill _while_ drafting means the report passes that gate on the first try instead of costing a revision turn.

## Reference

- Dhuliawala et al., "Chain-of-Verification Reduces Hallucination in LLMs," arXiv:2309.11495, 2023.
- Companion skills: `grounded-answer` (general CoVe), `abstain-or-escalate` (what to do when verification fails), `triangulate-sources` (multi-source corroboration), `claim-provenance` (validated-vs-assumption inline tagging).
