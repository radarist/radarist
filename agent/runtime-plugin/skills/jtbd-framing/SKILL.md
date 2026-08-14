---
name: jtbd-framing
description: Use when a brief compares technologies, vendors, or products — "which of these should we adopt?", "how do these vendors compare?", "buy vs build", "ecosystem of {category}". Produces a verb-led outcome-driven job statement per technology, the competing solutions including non-consumption, and the struggling moment.
---

# JTBD Framing

One verb-led job statement per technology, three-to-four competing solutions including non-consumption, one struggling moment in the customer's voice.

## When to invoke

Trigger on phrases like "compare {vendors}", "which {tool} should we use?", "landscape of {category}", "ecosystem of {tech area}", "buy vs build", "are these tools competing?", "what's the difference between X and Y?".

Particularly valuable when:

- A creator is writing a tech-comparison brief, ecosystem report, or buy-vs-build matrix
- A strategist needs to decide which capability to invest in given two or three vendors
- A scout has surfaced ≥3 vendors in the same space and the radar needs to place them
- A user asks "what's the right tool for {our context}" — the right tool depends on the job

Skip for:

- Single-technology deep dives — the JTBD is implicit; use `research-technology` instead
- Forecast / timing questions — use `foresight`
- Risk-on-a-chosen-plan questions — use `premortem-analysis`
- Pure feature comparisons where customer demand is already settled — feature matrices are fine

## The method in four steps

### 1 — State the job (verb + metric + object + context)

Tony Ulwick's outcome-driven format: every job has the same grammar.

```
Job: <verb> the <metric> it takes to <object of action> [in/for/with <context>]
```

The verb must be one of: **minimize, maximize, reduce, identify, accelerate, automate, eliminate, increase, decrease, streamline**. These verbs share a property — they describe _what the customer wants moved_ without naming a solution.

- Good: `Job: minimize the time it takes to identify high-fit internal candidates for an open requisition.`
- Good: `Job: reduce the cost-per-hire of engineering reqs while maintaining hire-quality scores.`
- Bad: `Job: improve hiring.` — no verb-led action, no metric, no object.
- Bad: `Job: deploy AI for HR.` — describes a solution, not a job. Solutions go in step 2.

If you can't write the sentence using one of those verbs, the brief isn't ready for JTBD framing — you're still describing solutions, not jobs.

### 2 — List 3-4 competing solutions (including non-consumption)

For the same job, what else does the customer hire to get it done? List 3-4 competing solutions. **At least one must be non-consumption** — what the customer does when they don't hire any tool at all.

- Good (for "minimize the time it takes to identify high-fit internal candidates"):
  - Static job-description matching tools (incumbent SaaS)
  - External recruiting agencies (manual, expensive)
  - LinkedIn Talent Insights (adjacent, generic)
  - **Non-consumption:** leaving reqs open for 90+ days while managers ask their network
- Bad: only listing direct-named-competitor SaaS products. The most powerful competitor is almost always non-consumption.

The non-consumption case is the one that pays for itself in the brief: it tells the reader what the customer's _current pain_ looks like, which is often more vivid than what the chosen tool offers.

### 3 — Quote the struggling moment

In ≤30 words, surface the moment a customer hits the wall on this job — in the customer's voice if you have it, paraphrased if not. Christensen called this the "hire" moment: the specific pain that triggers a search for a solution.

- Good: `Struggling moment: "We have 8,000 engineers but our hiring manager can only search the 200 they've worked with."`
- Good: `Struggling moment: HR team manually exports a CSV of every internal candidate matching a req — average 4 hours per role for a Director-level opening.`
- Bad: `Struggling moment: HR is hard.` — no specific situation, no observable evidence.

If you can't write the struggling moment, the JTBD is speculative. Either find a real customer story (search the scout bundle for case-study language) or label this section "speculative" and lower the brief's overall confidence.

### 4 — Place each technology against the job

Once steps 1-3 are done for the job, write one short paragraph per technology in the brief:

- Which job (from step 1) does this tech most directly serve?
- Which competing solutions (from step 2) is it built to displace?
- How does it address the struggling moment (from step 3)?

The same job can have multiple technologies serving it — that's the whole point. The reader can then ask: "given my struggling moment, which of these tools should I hire first?"

## Output format (mandatory)

When invoked in a report or analysis, emit one fenced block per technology, labelled `jtbd`:

```jtbd
Technology: <name>

Job: <verb> the <metric> it takes to <object> [in/for/with <context>]
Context: <who has this job — segment, size, industry>

Competing solutions:
- <named solution 1>
- <named solution 2>
- <named solution 3>
- Non-consumption: <what the customer does without any tool>

Struggling moment: <≤30 words, customer voice or paraphrase, with specific evidence>

How {Technology} addresses the job: <one short paragraph — which competing solution it displaces, how it changes the struggling moment>
```

This block is machine-parseable. The L1 quality gate (`mission-quality.ts:SKILL_PROCEDURE_MARKERS`) detects two markers — verb-led `Job:` line and `Struggling moment:` block — and counts JTBD framing as one of the skill-procedure markers required by `skill-adherence`.

## Anti-patterns to refuse

- **Solution language in the Job: line** — `Job: deploy an AI agent` is not a job, it's a solution. Push back.
- **Tech-vs-tech comparison without a Job: line** — the comparison is tautological without anchoring in customer demand.
- **No non-consumption competitor** — you have not done the JTBD work if you can't name what the customer does without any tool.
- **Vague struggling moment** — "HR is hard" or "talent is competitive" are not struggling moments. They're complaints. Demand specificity (named segment, named pain, named evidence).
- **Same job copy-pasted across all technologies** — if all 5 vendors serve the same job in the same context with the same competitors, you have a feature matrix, not a JTBD comparison. Either find the segment-level differentiation or admit the category is commoditizing.

## Working with other skills

- After `research-technology` returns a per-tech profile → run `jtbd-framing` to anchor the brief in customer demand before writing the comparison.
- Before `position-competitor` runs its 2×2 → use the JTBD's competing-solutions list to choose the axes.
- Use with `red-team-claim` on the struggling moment — if the moment is paraphrased, ask whether a real customer would actually say it that way. If not, soften the claim.
- Use with `apply-hype-cycle` after the JTBD work — different jobs sit on different points of the curve, even within the same tech category.
- The output's `Job:` line, `Competing solutions` list, and `Struggling moment` block all serve as parseable markers for downstream tooling and L1 quality detection.

## Confidence notes

The JTBD section itself doesn't carry an explicit confidence score — the confidence belongs to the _struggling moment_. If the struggling moment is sourced (from a customer interview, case study, vendor reference call), confidence is high. If it's paraphrased from a scout finding, confidence is medium. If it's reasoned-from-first-principles ("plausibly, an HR team in this situation would experience…"), confidence is low and the brief should say so.

## Radarist binding

The struggling moment is a first-class entity here — do not invent one.

**Route** (minimum viable = the 2 marked ★):

1. ★ `searchPainPoints` / `getPainPointDetails` — the recorded organisational pain this technology would be hired to relieve.
2. `listPainPointsByOrgUnit` — whose pain, which unit; grounds the job statement in a real consumer.
3. ★ `findSolutions` — what already addresses that pain, i.e. the competing solutions the job statement must beat.
4. `findAlignedTechnologies` / `searchInitiatives` — is a bet already running against this job?

Anchor every job statement to a PainPoint id where one exists. Where none exists, say so explicitly — an unanchored job statement is a hypothesis, not a finding.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named below, then record the gap with `recordKnowledgeGap` rather than inventing the value.
