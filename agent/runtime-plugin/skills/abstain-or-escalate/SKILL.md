---
name: abstain-or-escalate
description: Use when a claim, relation, evidence snippet, or report line has no verifiable source — decide between refusing, escalating, or surfacing the disagreement rather than guessing. Runs after `grounded-answer` step 3 returns no usable source.
---

# Abstain or Escalate

## When to invoke

Invoke this skill at the decision point where a draft claim CANNOT be verified — specifically, when `grounded-answer` step 3 produced "no usable source" for a question, or when:

- No graph-resident entity or edge supports the claim.
- No web source returned by `webSearch`/`webScrape` mentions the fact.
- No document chunk from `searchDocuments` cites the fact.
- Two sources disagree and neither is clearly more authoritative.

Do **not** invoke for conversational turns with no factual claims.

Reachability note: `searchDocuments` mounts on `impulse-reports`, which only the **creator** profile carries — from any other profile it is a handoff, so read that bullet as "no `searchKnowledgeGraph` hit either". Absence of a document search you could not run is not evidence of absence; say which routes you actually tried.

## The four-step decision

### 1 — Check if the claim is load-bearing

A claim is load-bearing if removing it would change a user's decision, a report's recommendation, or a scored relation's outcome. Peripheral color ("Nvidia is a leading chip company") is not load-bearing. A recommendation ("Nvidia has a 40% market-share lead in AI accelerators") is.

- Load-bearing + no source → proceed to step 2.
- Not load-bearing + no source → drop the claim silently. Do not soften-and-keep; softened fluff accumulates.

### 2 — Decide: abstain or escalate

| Situation                                                                                                         | Action                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The user asked a factual question, no source, but the question is one the user can re-ask with more context       | **Abstain.** Tell the user: "I don't have a source for X. Can you point me at one, or should I start from a narrower question?"                                           |
| The answer is needed but requires research the current agent can't do (e.g., specialist knowledge, paid database) | **Escalate.** Record a `KnowledgeGap` node via `recordKnowledgeGap` (if available) with the open question; tell the user the gap exists and suggest the right agent/tool. |
| The claim is consequential and you'd be guessing                                                                  | **Abstain.** Output an explicit refusal. Do not hedge — "I'm not sure, but probably X" is worse than "I don't have evidence for X."                                       |
| Two sources disagree, both plausible                                                                              | **Surface the disagreement** + cite both + state the uncertainty. This is abstention-with-context, not refusal.                                                           |

### 3 — Write the abstention / escalation

**Abstention phrasing** (user-facing):

> I don't have a verifiable source for [claim]. Possible reasons: [graph has no matching entity / web search returned no results / sources disagree]. To proceed, I'd need [specific input the user can provide].

**Escalation phrasing** (with KnowledgeGap):

> This requires research outside my current reach: [specific gap]. I've logged it as a knowledge gap ([gap ID]) so Scout / Curator can pick it up. Shall I dispatch that mission now, or hold off?

**Surface-disagreement phrasing**:

> Two sources disagree on [claim]. [Source A] says X ([citation]). [Source B] says Y ([citation]). [Source A is the primary / is more recent / is editorial-graded A vs D] — I'd weight it higher, but the uncertainty is real.

### 4 — Record the outcome

- Abstention on a chat turn: nothing further needed.
- Abstention while producing a report: leave a `<!-- abstained: [claim] — no source -->` HTML comment at the claim site so the next iteration can backfill.
- Escalation: call `recordKnowledgeGap` tool if available, otherwise emit a structured "gap" event for human review.

## Why this exists

Prompt-only refusal interventions reduce hallucination measurably — per the 2025 I-CALM line of research: "Prompt-only interventions — explicitly announcing reward schemes for answer-versus-abstain decisions plus humility-oriented normative principles — can reduce hallucination risk without modifying the model." Pairing `grounded-answer` (verify) with `abstain-or-escalate` (what to do when verification fails) closes the loop.

## Anti-patterns

- Do **not** soften: "I think ..." / "Probably ..." / "As I understand ..." are hallucinations with disclaimers. Say "I don't have a source" instead.
- Do **not** fabricate a source to justify a guess. That's the worst failure mode.
- Do **not** escalate every trivial gap. Escalation signals real research work — if the answer is "Google it," just tell the user to Google it.
- Do **not** abstain performatively. If you have 3 good sources and 1 claim missing one source, attribute the 3 and drop the 4th — don't refuse the whole answer.

## Reference

- Chain-of-Verification paper: Dhuliawala et al., arXiv:2309.11495, 2023 (prior work on the verify half).
- I-CALM / refusal-aware prompting research, 2025.
