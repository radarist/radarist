---
name: sift-source-check
description: Use before trusting, citing, or acting on a web source you do not already know — "is this source legit?", "can I trust this article?", "verify this link", "is this real?". Runs SIFT (Caulfield) — Stop, Investigate the source, Find better coverage, Trace claims to the original — by lateral search rather than by reading the suspicious page. For grading a source you have already accepted use `rate-source-admiralty` instead.
---

# SIFT Source Check

Four quick moves, done by leaving the page and searching elsewhere — not by reading the suspicious page harder. You can't fact-check a source using only the source's own words about itself.

## When to invoke

Trigger on phrases like "is {source} credible?", "can I trust this?", "verify this article/link", "is this real?", "check this source", "should I cite this?", "is {site} reliable?". Also invoke whenever a report or answer is about to cite a source the author did not already know and trust.

Skip for:

- A source already graded and trusted (Admiralty A/B with rationale) — it's earned its place; don't re-check on every use.
- A peer-reviewed paper or primary filing whose provenance you're verifying at a different level — use `verify-citations` (DOIs/arXiv IDs) instead.
- Rating a source you've decided to use — after SIFT passes, hand to `rate-source-admiralty` for the persistent two-axis grade.

## The premise

People get duped by reading a convincing page *on its own terms*. Professional fact-checkers don't — they practice **lateral reading**: open a new tab, see what *other* reliable sources say about this source and this claim, then decide. Novices read vertically (down the page); experts read laterally (across the web).

## The four moves (SIFT)

### S — Stop

Before you read further, share, or get outraged: stop. Ask two things:

1. Do I know this website / this author / this organization? If not, that's the trigger for the next moves.
2. What is my emotional reaction? Strong emotion (outrage, vindication, fear) is the single best predictor that you're about to share something false. The feeling is the alarm, not the evidence.

Stopping is not a step you skip because it's "obvious." It is the move that buys time for the other three.

### I — Investigate the source

Leave the page. Search for **the source itself** ("what is {site}? who runs it? what is its reputation?") using a search you trust. Use Wikipedia, media-bias trackers, and what established outlets say *about* this outlet — not what the outlet says about itself.

Find out, in under a minute:

- Who is behind it (organization, owner, funding).
- Its general reputation and any known bias or history of error.
- Its editorial process, if any.

You're not trying to decide if the source is perfect. You're building a quick prior: is this a place that could plausibly carry this kind of claim?

### F — Find better coverage

Don't ask "is this exact article true?" Ask "is this *claim* reported by sources I already trust?" Search the **claim**, not the page. Look for:

- Established outlets or fact-checkers (Snopes, PolitiFact, Reuters Fact Check, AP) covering the same claim.
- Agreement or disagreement across independent reporting.
- Whether trusted coverage contradicts, confirms, or is silent.

Silence from trusted sources is itself information: a sensational claim that no established outlet has touched is a flag, not a scoop.

### T — Trace claims to the original context

Quotes, screenshots, statistics, and video clips circulate **stripped of context**. Trace the specific load-bearing claim back to where it originated:

- A quote → the full transcript/speech, not the excerpt.
- A stat → the original study or dataset, not the secondary write-up.
- A video/image → the original source and date; check for cropping or re-dating.

Recontextualize: does the claim mean the same thing in its original setting? Many viral "gotchas" are real quotes in false context, or real numbers stripped of their denominator.

## Procedure (running all four)

### 1 — Note the source and the load-bearing claim

Before searching, write down (a) the source URL/outlet and (b) the specific claim that matters — the one your work depends on. Vague claims can't be checked.

### 2 — Run S, then I, F, T in order

Each move can resolve the question. If Investigate reveals the source is a known misinformation vector, you may not need F and T. If the source is fine but the claim is what's suspect, F and T do the work.

### 3 — Converge on one verdict

| Verdict | Meaning |
| --- | --- |
| **Trusted** | Known reliable source carrying a claim corroborated by independent coverage. |
| **Usable with caveat** | Source or claim has a known slant/limitation; cite with the caveat attached. |
| **Unconfirmed** | No trusted coverage either way; treat as a lead, not evidence. |
| **Refuted / unreliable** | Source is a known bad actor, or the claim is contradicted/debunked by trusted coverage, or the context was stripped. Do not cite. |

### 4 — Emit the result

```
## SIFT Check — {claim} @ {source}

**Claim:** {the load-bearing specific claim}
**Source:** {outlet / URL}, {author if known}

**Stop:** {known source | unknown — emotional hook: {outrage/surprise/etc.}}
**Investigate:** {who runs it; reputation; bias} → {prior}
**Find better coverage:** {trusted outlets covering it: agree / contradict / silent}
**Trace to original:** {original context found: same meaning / recontextualized / fabricated}

**Verdict: {Trusted | Usable with caveat | Unconfirmed | Refuted}** — {one-sentence why}

**Hand-off:** {grade via `rate-source-admiralty` → A/B/C… 1/2/3…} | {abstain — no reliable basis}
```

## Anti-patterns

- Do **not** try to verify a source by reading the source's own "About" page. That's vertical reading; con artists write great About pages. Investigate *laterally*.
- Do **not** skip Stop. The emotional-hook check catches the majority of what you'd later regret sharing.
- Do **not** conflate "I couldn't find debunking" with "it's true." Absence of trusted coverage is **Unconfirmed**, not Trusted.
- Do **not** confirm a claim using sources that all trace back to one origin. Three articles copying one press release is one source, not three — check independence (this is also the rule in `triangulate-sources`).
- Do **not** rely on a single fact-checker's verdict as final if it is itself contested; read the *reasoning*, not just the rating.
- Do **not** strip context yourself when re-reporting. The Trace move exists because recontextualization is how true things become false in transit.

## Pair with

- `rate-source-admiralty` — SIFT is the entrance exam; Admiralty is the persistent grade you record after SIFT passes.
- `triangulate-sources` — SIFT often ends at "find better coverage"; triangulation is the stricter bar for treating a claim as *established*.
- `verify-citations` — for academic sources, trace the reference to the actual DOI/arXiv artifact, not just the landing page.
- `abstain-or-escalate` — when SIFT returns Unconfirmed or Refuted and there's no better source, refuse the claim rather than cite the unreliable one.

## Reference

- M. Caulfield and S. Wineburg, _Verified: How to Think Straight, Get Duped Less, and Make Better Decisions About What to Believe Online_, University of Chicago Press, 2023 (esp. ch. 4, "Lateral Reading") — the canonical statement of SIFT.
- M. Caulfield, _Web Literacy for Student Fact-Checkers_, Pressbooks, 2017 — the earlier "Four Moves and a Habit" formulation that SIFT refined.
- S. Wineburg and S. McGrew, "Lateral Reading: Reading Less and Learning More When Evaluating Digital Information," _Teachers College Record_, 2017 — the empirical finding that professional fact-checkers read laterally while students and historians read vertically.

## Radarist binding

The four SIFT moves map onto keyless calls — investigate laterally, never by reading the suspicious page:

- `webSearch` — lateral search on the *publisher*, not the claim.
- `searchPapers` / `resolveOpenAccess` — trace a science claim to the actual paper.
- `searchSecFilings` — trace a corporate or financial claim to the filing.
- `searchKnowledgeGraph` — do we already know this publisher, and how did it grade before?

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
