---
name: steelman-argument
description: Use before refuting an opposing view, to be sure you are attacking its strongest form — "steelman the opposing case", "strongest argument for X", "am I strawmanning?", "the best case against my position". Builds the most charitable version of the opposing argument to the standard its actual proponents would endorse. For attacking your own headline claim use `red-team-claim` instead.
---

# Steelman the Argument

You haven't understood an opposing view until you can state its strongest case better than its advocates do — well enough that they would sign off on your summary. The steelman is the opposite of the strawman: instead of the weakest version you can knock down, you build the version that's hardest to knock down, then engage *that*.

## When to invoke

Trigger on phrases like "steelman {X}", "what's the strongest argument for {opposing view}?", "am I strawmanning {Y}?", "the best case against my recommendation", "ideological Turing test", "charitable reading of {Z}", "before I rebut {W}".

Skip for:

- Factual checks of a specific claim — use `grounded-fact-check`. Steelmanning is about *positions and arguments*, not single facts.
- Adversarial stress-testing of your own conclusion — that's `red-team-claim`. Steelman first (understand the opposition at full strength), red-team second (attack your own case).
- Questions with a single correct answer and no genuine opposing school — there's nothing to steelman.

## Why it earns its place

Two failure modes it blocks:

1. **Strawmanning.** Beating a caricature feels like winning and teaches nothing. If your rebuttal only works against the weak version, you haven't addressed the real disagreement.
2. **The double standard of rigor.** We demand airtight evidence for views we dislike and accept loose arguments for our own. Steelmanning flips the bias: apply the most charitable reconstruction to the opposing view — the same generosity you'd want for yours.

The payoff isn't politeness. A position that survives its strongest opposing case is actually held; one that only survives weak opposition is fragile and you'll discover that at the worst moment.

## The standard: the Ideological Turing Test

The test (Caplan): can you pass as a genuine advocate of the opposing view? Specifically, could you write the opposing argument so faithfully that its actual proponents can't easily tell you're not one of them — or would even endorse what you wrote? If a real advocate reads your steelman and says "no, that's not what we mean," you haven't steelmanned; you've built a better-dressed strawman. **The advocate's endorsement is the bar.**

## Procedure

### 1 — Name the opposing position precisely

State the view in one sentence, using its proponents' own terms — not your re-labeled version. "The opposing view is that {X}, because {Y}." If you can only describe it in dismissive language ("they just think…"), you haven't understood it yet — go read what its advocates actually say (this is where `sift-source-check` lateral reading matters: find the genuine proponents, not a hostile summary).

### 2 — Reconstruct the strongest case, in their frame

Build the argument as its best advocates would, using their premises and their evidence. Do **not** insert your own premises to "help" — that's smuggling your conclusion. The steelman is strong *on its own terms*. Cover:

- Their **core claim** and the values/priorities it rests on.
- Their **strongest evidence** (cite the best version, not a weak instance).
- Their **best responses** to the obvious objections.
- The **genuine insight** at the center — even views you reject usually contain one true observation.

### 3 — Pressure-test the steelman against its own weakest links

A real steelman isn't blind admiration — it builds the strong version *and* notes where that strong version is still vulnerable. Identify:

- The load-bearing assumption that, if false, weakens the case most.
- The evidence that, if overturned, collapses the argument.

This is what makes it a steelman and not propaganda: you know where even the best version is exposed.

### 4 — Run the endorsement check

Would a genuine advocate recognize this as their position, fairly stated? If you have access to one (or to a representative text), verify. If your steelman makes the opponent say "yes, exactly," it passes. If they say "you're still missing the point," iterate — that feedback *is* the signal you're after, not an annoyance.

### 5 — Only now engage

Once the steelman passes, you've earned the right to disagree. State where and why the strong version still fails — which of its load-bearing assumptions you contest, which evidence you think doesn't hold. A rebuttal aimed at the steelman is the only kind worth making.

### 6 — Emit the result

```
## Steelman — {opposing position}

**Position (their terms):** {one sentence, using their language}

**Strongest case (their frame):**
- Core claim: {…}
- Values/premises it rests on: {…}
- Strongest evidence: {…}
- Their best answer to the obvious objection: {…}
- Genuine insight at the center: {…}

**Where this strong version is still exposed:**
- Load-bearing assumption: {…} — if false, weakens the case most.
- Evidence most pivotal: {…} — if overturned, collapses it.

**Endorsement check:** {passes — representative advocate would sign it | fails — still caricaturing on {point}}

**Engagement (post-steelman):** where I part with the strong version, and why — {which assumption/evidence I contest}

**Confidence I've actually understood them:** {0.0–1.0}
```

## Anti-patterns

- Do **not** build a weak version you can beat. If your "steelman" reads like something the opponent would disown, it's a strawman in costume.
- Do **not** smuggle your own premises into the reconstruction. The steelman must be strong *on the opponent's terms*; inserting your values to make it "work" is just agreeing with yourself.
- Do **not** skip the genuine insight. A steelman that finds nothing true in the opposing view is almost always a sign you haven't understood it, not that the view is pure error.
- Do **not** confuse steelmanning with conceding. Building the strong version doesn't mean adopting it — you're allowed to then disagree, more precisely than before.
- Do **not** stop at "I could see how someone might think that." That's empathy, not a steelman. The bar is the specific, evidenced, endorsement-passing reconstruction.
- Do **not** steelman a hostile summary of the view. Lateral-read to the actual proponents (`sift-source-check`); reconstructing a parody is wasted effort.

## Pair with

- `red-team-claim` — steelman the opposing case (understand), then red-team your own (attack). Doing only the second is where shallow rebuttals come from.
- `analysis-of-competing-hypotheses` — ACH treats all hypotheses fairly; steelmanning is the same charity applied to one opposing argument.
- `sift-source-check` — find the genuine proponents before reconstructing; never steelman a second-hand caricature.
- `critique-report` — a self-review that hasn't steelmanned the alternative position hasn't earned its confidence.

## Reference

- The **principle of charity** (W. V. O. Quine; Donald Davidson) in the philosophy of language — reconstruct an opponent's position in its strongest, most rational form before evaluating it. This is the intellectual root of steelmanning.
- B. Caplan, "The Ideological Turing Test," EconLog (Library of Economics and Liberty), 2011 — the operational test: you understand an ideology only if you can impersonate it undetectably.
- D. Walton, _Fundamentals of Critical Argumentation_, Cambridge University Press, 2006 — the strawman fallacy and the argumentation-scheme tradition that distinguishes fair reconstruction from caricature.
- A. Rapoport's restate-first rule, as presented by D. Dennett in _Intuition Pumps and Other Tools for Thinking_, Norton, 2013 — restate your opponent's position so clearly that they could not agree more, before you critique it. The operational ancestor of the steelman.
