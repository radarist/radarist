---
name: key-assumptions-check
description: Use before relying on a conclusion that rests on unexamined premises — "what are we assuming here?", "what would have to be true for X to hold?", "stress-test our reasoning". Heuer's Key Assumptions Check — enumerate the premises a conclusion depends on, rate each for sensitivity and grounding, then re-source or kill the ones that are both sensitive and ungrounded. For comparing whole rival hypotheses use `analysis-of-competing-hypotheses` instead.
---

# Key Assumptions Check

Most bad conclusions aren't wrong about the evidence — they're wrong about the things they assumed without noticing. Heuer's check makes every load-bearing assumption visible, then asks the one question that matters: would the conclusion survive if this assumption were false?

## When to invoke

Trigger on phrases like "what are we assuming?", "is this actually load-bearing?", "what would have to be true for {X} to hold?", "key assumptions check", "audit our reasoning", "before we commit to {conclusion}", "are we taking {Y} for granted?". Invoke before any consequential conclusion ships, and whenever reasoning has gotten fast enough that no one has listed what it leans on.

Skip for:

- Enumerating explanations for a question — that's `analysis-of-competing-hypotheses`. This skill assumes you already have a leading conclusion and audits its foundations.
- Imagining how a plan fails — that's `premortem-analysis`. Premortem invents future failure modes; this check excavates present assumptions.
- Pure fact-checking of a stated claim — `grounded-fact-check`. Here the targets are *unstated* premises.

## The premise

Assumptions are dangerous precisely because they're invisible. Reasoning that rests on "everyone knows X" is reasoning that never tested X — and X is usually the thing that, when wrong, takes the whole conclusion down. The check forces three uncomfortable moves:

1. **Surface** the assumptions that the reasoner didn't realize they were making.
2. **Rate** each by *sensitivity* (does the conclusion need it?) and *grounding* (is there evidence, or is it just habit/consensus?).
3. **Resolve** the dangerous ones: those that are both highly sensitive and weakly grounded. A low-sensitivity assumption barely matters; a high-grounding one is fine as-is. The intersection is the risk.

## Procedure

### 1 — State the conclusion in one sentence

Fix the claim under audit. "We conclude that {X} because {Y}." If the conclusion is fuzzy, the assumptions can't be pinned — sharpen it first (`decompose-research-question` if needed). You can't check assumptions behind a conclusion you can't state.

### 2 — Excavate every assumption the reasoning leans on

Walk the argument and list each premise it requires — the things that must be true for the conclusion to follow. Include the **implicit** ones, which are the dangerous majority:

- **Implicit premises** — "we assumed past patterns continue," "we assumed the source is independent," "we assumed the metric means the same thing here as there." These are the silent killers; name them explicitly.
- **Boundary assumptions** — "we assumed this holds within {scope} and not outside it."
- **Absence-of-evidence assumptions** — "we assumed no news to the contrary means nothing changed." (Silence isn't evidence of stability.)

Aim to over-list. The assumptions you're tempted to skip as "too obvious" are usually the load-bearing ones.

### 3 — Rate each on two axes

| Axis | Question | Rating |
| --- | --- | --- |
| **Sensitivity** | If this assumption were false, would the conclusion fall or barely wobble? | High / Med / Low |
| **Grounding** | Is it backed by evidence, or taken on faith/consensus/it-feels-right? | Strong / Moderate / Weak |

The cells that matter:

- **High sensitivity × Weak grounding → ACT.** This is the assumption that can sink the conclusion and has no evidence holding it up. Re-source it, test it, or mark the conclusion as fragile.
- **High sensitivity × Strong grounding → note but don't re-litigate.** It's load-bearing but supported; record it so a reader can see what the conclusion rests on.
- **Low sensitivity × anything → deprioritize.** Even if wrong, it won't change the answer.

### 4 — Resolve the dangerous assumptions

For each High-sensitivity × Weak-grounding item, choose one:

- **Re-source** — go find evidence (`sift-source-check`, `triangulate-sources`). If you can ground it, it moves to safe.
- **Test** — if there's a cheap way to check, run it (`cheapest-experiment`).
- **Bound** — narrow the conclusion to the scope where the assumption holds; don't assert the broad version.
- **Flag** — if it can't be resolved in time, state it as an explicit caveat and drop the conclusion's confidence. Do **not** ship the strong conclusion silently resting on an unresolved weak assumption.

### 5 — Sensitivity sweep

For the conclusion as a whole: if the top 2–3 assumptions were each retracted, does the conclusion still hold? If it collapses on any single one, the conclusion isn't a conclusion — it's that assumption wearing a costume. Say so, and either ground the assumption or `abstain-or-escalate`.

### 6 — Emit the result

```
## Key Assumptions Check — {conclusion}

**Conclusion under audit:** {one sentence}

**Assumptions (sorted: sensitive-first):**

| # | Assumption | Sensitivity | Grounding | Disposition |
|---|-----------|-------------|-----------|-------------|
| 1 | {load-bearing implicit premise} | High | Weak | Re-source / flag |
| 2 | {boundary assumption} | High | Strong | Note (load-bearing) |
| 3 | {absence-of-evidence assumption} | Med | Weak | Bound the conclusion |
| 4 | {routine premise} | Low | Strong | Deprioritize |

**Dangerous assumptions (High sensitivity × Weak grounding):** {count}
- {each, with disposition chosen}

**Sensitivity sweep:** {conclusion survives losing any single top-3 assumption | collapses on assumption #N — treat as fragile}

**Revised confidence:** {0.0–1.0} — {downgraded because {assumption} is unresolved}

**One assumption to re-source before trusting this conclusion:** {…}
```

## Anti-patterns

- Do **not** skip the implicit assumptions. The explicit ones are already defended; the implicit ones are where conclusions actually die.
- Do **not** rate everything "medium" to avoid the hard call. If sensitivity and grounding were obvious, you wouldn't need the check — force a High/Weak somewhere or you've done theatre.
- Do **not** "resolve" a weak assumption by reasserting it. "We re-confirmed we believe X" is not grounding; evidence or a test is.
- Do **not** leave dangerous assumptions unflagged to preserve a clean conclusion. A conclusion that silently rests on an unresolved weak premise is the exact failure this skill exists to catch.
- Do **not** treat consensus as grounding. "Everyone assumes X" is weak grounding with extra confidence, not strong grounding — consensus is often the shared blind spot.
- Do **not** run this only on conclusions you distrust. The check is most valuable on the conclusions you're sure of, because those are where the assumptions have gone fully invisible.

## Pair with

- `analysis-of-competing-hypotheses` — ACH audits *which hypothesis* the evidence favors; this audits *what each hypothesis secretly assumes*. Run ACH first, then check assumptions behind the winner.
- `premortem-analysis` — premortem invents future failure modes; this excavates present assumptions. Together they bracket a decision from both directions.
- `abstain-or-escalate` — when a High-sensitivity assumption can't be grounded in time, refuse the strong conclusion rather than ship it on a hidden premise.
- `red-team-claim` — a red-team pass is stronger when it opens with the key-assumptions list; the dangerous assumptions are where a red team should aim first.

## Reference

- R. J. Heuer Jr. and R. H. Pherson, _Structured Analytic Techniques for Intelligence Analysis_, 2nd ed., CQ Press, 2014 — the Key Assumptions Check is one of the core Diagnostic Structured Analytic Techniques; the library already cites this volume for ACH.
- R. J. Heuer Jr., _Psychology of Intelligence Analysis_, CIA Center for the Study of Intelligence, 1999 — the central thesis that analysts fail on unexamined assumptions far more often than on bad logic (the chapters on assumptions and on "Do You Really Need More Information?").
- R. M. Clark, _Intelligence Analysis: A Target-Centric Approach_, CQ Press — practitioner treatment of assumption surfacing as the hinge of sound analysis.

## Radarist binding

The graph can tell you which assumptions are ungrounded rather than merely unstated:

- `findDataGaps` / `findConceptGaps` — an assumption whose supporting data is absent is ungrounded by definition.
- `getClaimHealth` — support level for the entities the assumption rests on.
- `getRelationEvidence` — whether the premise traces to real evidence or to another assumption.

An assumption that is both sensitive (the conclusion dies without it) and ungrounded (no evidence behind it) is the finding — surface it first.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
