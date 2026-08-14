---
name: pyramid-principle
description: Use to structure a persuasive analytical argument or document — "structure this report", "make this argument land", "governing thought", "Minto pyramid", "execs keep asking what the point is". Minto's Pyramid — lead with one governing thought, support it with a MECE group of arguments, each backed by evidence, so the document reads top-down in 30 seconds or 30 minutes. For a one-page decision brief use `write-srl-brief` instead.
---

# Pyramid Principle

Start with the answer. Then give exactly the reasons a skeptic would demand, grouped so they don't overlap and don't leave a gap. A reader should get the point from the first sentence, the support from the next tier, and the evidence only if they keep reading.

## When to invoke

Trigger on phrases like "structure this argument", "what's the governing thought?", "make this land", "execs say it rambles", "pyramid structure", "give me a top-down version", "what's my one sentence?", "Minto pyramid". Invoke when an analytical document needs to persuade — memos, board decks, recommendation write-ups.

Skip for:

- A ≤1-page decision brief — that's `write-srl-brief` (SBAR). The Pyramid is the underlying *argument geometry*; SBAR is one short container for it.
- Academic long-form — `write-imrad-report` (IMRAD). The Pyramid can still govern the Discussion, but IMRAD imposes its own Methods/Results order.
- Exploratory or narrative writing with no single point to land — there's nothing to put at the apex.

## The structure

A pyramid: one block on top, a row beneath it, more beneath that.

- **Apex — the governing thought.** The single sentence that answers the reader's question: the recommendation, conclusion, or key message. Not a topic ("the market") — a point ("enter the market now, before competitor X closes it").
- **Second tier — the supporting arguments.** The 3 (±1) reasons that, together, prove the apex. These must be **MECE**: mutually exclusive (no overlap) and collectively exhaustive (no gap — together they fully support the apex).
- **Lower tiers — evidence.** Each second-tier argument is backed by data, examples, or sub-arguments. Recursion stops when a tier is self-evidently supported.

The reader reads **top-down**: claim → why → prove it. They can stop at any depth and still have the message. That is the whole point — a busy reader gets the answer immediately; a skeptical reader can drill as deep as they need.

## Procedure

### 1 — Find the governing thought (the apex)

Force the entire document into one sentence that answers the reader's question. Test it:

- Is it a **point** or just a **topic**? "Our cloud strategy" = topic. "Migrate to managed cloud in Q3 to cut infra cost 30% before the renewal cliff" = point.
- Does it pass the **"so what?"** test? If a reader can reply "so what?", you've stated a category, not a conclusion.
- Does it answer the question the reader actually has? A governing thought that answers a question nobody asked is well-structured and useless.

If you can't write the apex in one sentence, you don't yet have a point — go back to the analysis. Don't paper over a missing conclusion with structure.

### 2 — Build the second tier as a MECE set of "whys"

Ask: "Why is the apex true?" List the reasons. Then enforce MECE:

- **Mutually exclusive** — no two reasons should overlap. If reason 2 restates part of reason 1, merge or re-cut. Overlapping supports look comprehensive but actually double-count, and a sharp reader will catch it.
- **Collectively exhaustive** — do the reasons *together* fully prove the apex, or is there a gap? A missing reason is the hole a skeptic walks through.

Aim for roughly **three** second-tier arguments. Two is often thin (forces an artificial binary); five-plus usually means you haven't grouped — combine into 3 higher-level reasons with sub-points beneath.

Classic MECE cuts that often fit: *three reasons* (why now / why us / why this way), *three horizons* (short / medium / long), *three lenses* (financial / strategic / risk). The cut must fit *this* argument, not be borrowed.

### 3 — Support each second-tier argument

For each reason, ask "why is *this* true?" and supply evidence — data, examples, a sub-argument. This is the recursive heart of the method: every tier is the "why" of the tier above. Stop when a claim is self-evidently backed.

### 4 — Check the vertical logic (governs top-down)

Read any vertical path: apex → reason → evidence. Each step down must answer "why?" of the step above. If a path breaks — an evidence point that doesn't actually support its reason, or a reason that doesn't support the apex — the pyramid has a crack. Fix the logic, not the wording.

### 5 — Check the horizontal logic (governs peer groups)

Within any tier, the items should be **parallel** (same level of abstraction, same grammatical form) and ordered by a logic the reader can predict (priority, time, cause→effect). A tier that mixes a $ reason, a process reason, and a one-off anecdote isn't parallel — re-cut it. Readers predict the order; honoring that prediction is what makes the structure feel inevitable rather than arbitrary.

### 6 — Write the SCQA opening (only if a cold reader needs orienting)

For documents where the reader lacks context, open with Minto's **SCQA** before the pyramid lands:

- **Situation** — what the reader already accepts (the common ground).
- **Complication** — what changed / the problem / the tension.
- **Question** — the question the complication raises in the reader's mind.
- **Answer** — the apex of the pyramid (your governing thought).

The SCQA primes the reader to *want* the apex, so the top-down structure lands as a satisfying answer rather than an abrupt claim. In short memos you can often skip straight to the apex; in cold-read documents, the SCQA earns the right to it.

### 7 — Emit the structure

```
## Pyramid — {document/argument}

**Governing thought (apex):** {one-sentence point that passes "so what?"}

**Second tier (the 3 whys — MECE):**
1. {reason A}
2. {reason B}
3. {reason C}

**Evidence per reason:**
- Under A: {data / sub-arguments}
- Under B: {…}
- Under C: {…}

**MECE check:** {no overlap; no gap — how each gap/overlap was resolved}
**Vertical check:** {each down-step answers "why?" of the step above}
**Horizontal check:** {tiers parallel and predictably ordered by {logic}}

**SCQA (if used):** S: {…} | C: {…} | Q: {…} | A: {apex}
```

## Anti-patterns

- Do **not** put a topic where the apex belongs. "An analysis of our options" is not a governing thought — the reader can't act on a topic.
- Do **not** build the pyramid bottom-up into a "surprise ending." Analytical writing leads with the answer; hiding the conclusion for a reveal wastes the reader's time and reads as evasive.
- Do **not** let the second tier overlap or leave a gap. Non-MECE supports look thorough and collapse under questioning — that's where weak arguments are exposed.
- Do **not** write five or seven second-tier arguments. If you have that many, you haven't grouped; find the 3 higher-level reasons and demote the rest to sub-points.
- Do **not** use a borrowed MECE cut ("three lenses: people/process/technology") when it doesn't fit the argument. The cut must be driven by the substance, or the structure is decoration.
- Do **not** substitute structure for a point. A flawless pyramid with no real apex is polished emptiness — fix the analysis first.

## Pair with

- `write-srl-brief` — SBAR is the short container; the Pyramid is the argument geometry inside it. A 1-pager whose Recommendation is the apex and whose Assessment is the second tier is a Pyramid in SBAR clothing.
- `write-imrad-report` — use the Pyramid to structure the Discussion's governing thought; IMRAD governs section order, not argument logic.
- `red-team-claim` — red-team the apex directly and each second-tier reason; a pyramid fails at the apex or at a weak support, rarely in between.
- `key-assumptions-check` — audit the assumptions behind each second-tier reason; the pyramid exposes them, the assumptions check tests them.

## Reference

- B. Minto, _The Pyramid Principle: Logic in Writing and Thinking_ (later editions: _The Minto Pyramid Principle_), developed at McKinsey & Company from 1973 and published by Minto International / Financial Times/Prentice Hall — the canonical source for the governing-thought, MECE-support, SCQA method.
- B. Minto, "The Pyramid Principle" (McKinsey internal training, widely disseminated) — the origin of the method as a consulting communication standard.
- G. Polya, _How to Solve It_, and the broader tradition of top-down analytical structuring — the "start from the answer and justify downward" logic predates Minto but she systematized it for written argument.
