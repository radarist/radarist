---
name: write-srl-brief
description: Use for a short decision-oriented briefing of one page or less — "give me a 1-pager on X", "brief me on Y", "SBAR", "executive summary of Z", "crisp summary". Structures it as Situation, Background, Assessment, Recommendation with strict length caps and a mandatory confidence tag. For an academic-shaped report use `write-imrad-report` instead; for the argument structure inside either use `pyramid-principle` instead.
---

# Write SRL Brief

**S**ituation — **R**elevance — **L**et me recommend. Actually: SBAR — Situation, Background, Assessment, Recommendation. Navy-aviation-born protocol, now standard in healthcare emergency communications, and ideal for high-density executive briefings.

Complements `write-imrad-report` — that's for academic long-form; this is for decision-oriented short-form.

## When to invoke

Trigger on phrases like "give me a 1-pager on {X}", "briefing on {Y}", "SBAR on {Z}", "brief me for Thursday's meeting", "crisp summary of {topic}", "what do I need to know about {X}?", "executive brief", "decision memo on {X}".

Skip for:

- Conversational chat replies (not briefings).
- Research-heavy documents (>1 page) — use `write-imrad-report`.
- Marketing / narrative content (different voice).
- Purely factual answers with no recommendation — a brief needs a "what to do."

## The SBAR structure

**Length cap: 1 page (≈400–500 words total). Hard cap on each section.**

### S — Situation (≤3 sentences, ≤80 words)

_What is the current state right now?_ One plain-language paragraph. No jargon unless unavoidable. No history — just the present moment.

> Example: "Anthropic announced a $30B Series G at a $380B post-money valuation on 2026-02-12. The round was led by GIC and Coatue, with participation from Microsoft and NVIDIA among 30+ investors. The company is now the second-highest-valued private AI lab and continues to compete with OpenAI on enterprise API share."

### B — Background (≤4 sentences, ≤120 words)

_Why are we talking about this now? What's the relevant history?_ The context that makes the Situation make sense. Prior events, trajectory, related moves.

> Example: "Anthropic's prior Series F in September 2025 valued the company at $183B — a 2.1× markup in 5 months signals intense competitive pressure for AI compute. The raise comes amid a broader AI capex surge: OpenAI reportedly drew interest at $500B+ earlier in 2026, and Mistral, xAI, and Cohere have all raised at elevated multiples in the past 6 months. Regulatory scrutiny of AI foundation-model concentration is increasing in both the EU and US."

### A — Assessment (≤5 sentences, ≤150 words)

_What's really going on? What's the synthesis?_ This is the author's analytical value-add — what the Situation + Background means together. Name the trend, name the pivotal factor, name the uncertainty.

> Example: "This raise completes Anthropic's transition from research lab to compute-hyperscaler in all but name — $380B post-money puts it among the 30 most valuable private companies globally. The Microsoft + NVIDIA participation signals strategic compute-access agreements that may outweigh the $30B in primary capital. Three risks dominate: (1) capex deployment discipline given the round size, (2) regulatory pushback on foundation-model concentration (EU AI Act enforcement begins Aug 2026), (3) product-market fit for enterprise agents given LangChain/LlamaIndex continued growth. Competitive dynamic: this is a barbell market, with Anthropic and OpenAI at one pole, and a long-tail of specialized providers at the other."

### R — Recommendation (≤3 sentences + mandatory confidence tag)

_What should we do about this?_ Concrete, actionable, with owner and deadline where relevant.

> Example:
>
> - **Action:** Reprioritize Anthropic tracking in the radar (promote from Tier-2 to Tier-1 strategic entity) and initiate deeper enterprise-agent-framework coverage.
> - **Owner:** Curator agent (data) + Strategist agent (narrative).
> - **Deadline:** Next quarterly review (2026-07-15).
> - **Confidence: 0.85** (high — public filings + named investors; residual risk is post-money valuation for a subsequent round since Bloomberg reports $800B+ interest).

## Procedure

### 1 — Identify the decision

Every brief is for a decision. If you can't name the decision in one sentence, the user doesn't need a brief — they need `grounded-answer` or `write-imrad-report`.

### 2 — Write the Situation — tight, neutral, no editorializing

Use present-tense facts. No adjectives that express judgment ("troubling", "impressive", "shocking"). Those belong in Assessment.

### 3 — Write the Background — only the minimum context

Prune ruthlessly. Anything older than 2 years is usually too old. Anything not directly relevant to the decision is out.

### 4 — Write the Assessment — bring the analytical value

This is where the skill earns its keep vs a plain summary. Name a trend, name a risk, name a structural dynamic. If the Assessment reads like "just the facts," you didn't assess — rewrite.

### 5 — Write the Recommendation — with confidence

Every recommendation has a confidence score (0.0–1.0, typically 0.5–0.95 for briefs). Below 0.5 → the recommendation is guessing; return to data collection.

If you can't assign confidence > 0.5, **trigger `abstain-or-escalate`** instead of producing a low-confidence recommendation.

### 6 — Hard-cap the length

If the brief exceeds 1 page / 500 words, you are (a) over-writing or (b) the problem needs `write-imrad-report`. Cut.

### 7 — Final checks

- [ ] The first sentence of Situation is understandable to someone with zero context
- [ ] Background contains no new claims — everything should be derivable from the Situation + cited sources
- [ ] Assessment explicitly names the risks, not just "risks exist"
- [ ] Recommendation has a confidence score
- [ ] Total ≤ 1 page (≈500 words)

## Output format

```
# Briefing: {topic} — {date}

## Situation
{≤3 sentences}

## Background
{≤4 sentences}

## Assessment
{≤5 sentences — this is the analytical value-add}

## Recommendation
- **Action:** {what to do}
- **Owner:** {who does it}
- **Deadline:** {when}
- **Confidence:** {0.0–1.0} ({optional one-sentence justification})
```

## Anti-patterns

- Do **not** exceed 1 page. A 2-page "brief" is not a brief — it's `write-imrad-report` in disguise.
- Do **not** omit the confidence score. An un-scored recommendation is untrustable.
- Do **not** bury the recommendation. It's the last section _after_ Assessment for a reason — the reader has scanned S/B/A by the time they reach R, and R is the action.
- Do **not** editorialize in Situation. Neutrality there lets the Assessment land.
- Do **not** write five recommendations. One primary, with at most one backup. Decisions have singular actions.

## Reference

- L. Leonard et al., "Situation-Background-Assessment-Recommendation (SBAR)," _Joint Commission Journal on Quality and Safety_, vol. 32, no. 3, pp. 167–175, 2006 (healthcare handoff standard).
- US Navy aviation "Aviator's Model Code of Conduct" (original SBAR practice).
- K. Haig, S. Sutton, and J. Whittington, "SBAR: a shared mental model for improving communication between clinicians," _Joint Commission Journal on Quality and Safety_, 2006.
- Pairs with `write-imrad-report` (explicit long-form ↔ short-form counterpart), `abstain-or-escalate` (when confidence <0.5), `rate-source-admiralty` (every factual claim in Situation/Background should be source-graded), and `grounded-answer` (Situation facts should be CoVe-verified).
