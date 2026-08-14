---
name: evolution-stage
description: Use when a brief names technologies, capabilities, or vendor categories — tech comparisons, ecosystem maps, buy-vs-build matrices, radar landscape reports. Tags each with a Wardley evolution stage (Genesis / Custom-built / Product / Commodity) plus an evidence-anchored rationale. For empirical readiness use `score-technology-readiness` instead.
---

# Evolution Stage (Wardley)

One stage per technology. One-line rationale. One method-fit implication.

## When to invoke

Trigger on phrases like "compare {vendors}", "current state of {category}", "buy vs build", "what tools should we use?", "ecosystem of {space}", "radar update", "where are these technologies in their lifecycle?".

Particularly valuable when:

- The brief makes recommendations about _which method_ to use (custom-build vs adopt-product vs commodify) for a given capability
- A prior recommendation was wrong because the team treated a Custom-built capability as a Product (or vice versa)
- The brief decides between buying a vendor product, building in-house, or accepting a commodity dependency
- A pattern of "this vendor's product feels half-built" suggests a Custom-built component sold as Product

Skip for:

- Pure foresight / prediction briefs (use `apply-hype-cycle` for the maturity arc instead)
- Single-technology deep dives where the stage is unambiguous
- Decisions where method-fit is already settled (we have a contract; no scope to revisit)

## The four stages (Wardley evolution axis)

| Stage            | Definition                                                       | Right method                                 | Brief signals                                                                           |
| ---------------- | ---------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Genesis**      | Novel, no comparable thing exists; cause-effect uncertain        | Agile / experimental / time-bounded research | "First of its kind", "in-house only", "no published patterns"                           |
| **Custom-built** | Bespoke implementations; emerging patterns but no shared product | Lean / Adapted from {comparable}             | "We tuned the X for our environment", "consultant-implemented", multi-month integration |
| **Product**      | Stable category; documented patterns, vendor competition         | Six-Sigma / scale / playbook                 | "Documented integration", "≥5 named reference customers", "vendor-roadmap-driven"       |
| **Commodity**    | Indistinguishable utility; price + reliability are the only axes | Outsource / commodify / utility purchase     | "SaaS subscription", "low integration variance", "treated as background infrastructure" |

The progression is **right-to-left through stages over time**: most genesis tech becomes commodity if it works. The strategic question is "where is this NOW and what method matches?"

## The method in three steps

### 1 — Place the technology on the evolution axis

Ask four diagnostic questions:

- Is this the first/only example of its category? → Genesis
- Are there 2-5 comparable implementations, all bespoke? → Custom-built
- Is this a documented vendor category with named playbook patterns and ≥5 reference customers per leading vendor? → Product
- Is this a low-differentiation utility purchased on price/SLA? → Commodity

Write the placement in one labelled line:

```
Evolution stage: Product
```

Don't hedge "between Custom and Product" — the act of picking is the work. If you genuinely can't pick, write "Custom-to-Product transitional" with both rationales (the lower-stage method-fit usually still applies during transition).

### 2 — Anchor in observable evidence

Every stage placement needs a one-line rationale citing observable evidence — not opinion.

- Good (Product): `Workday Skills Cloud — Product. Rationale: Workday's published integration patterns, ≥10 large-enterprise references, 12-month update cadence with documented breaking-changes log.`
- Good (Custom-built): `Eightfold AI — Custom-built. Rationale: each enterprise tunes the talent graph, average 6-month integration, no commoditised API yet.`
- Good (Genesis): `Multi-agent orchestration on internal HRIS data — Genesis. Rationale: zero published reference architectures, all known deployments are in-house experiments at frontier-AI labs.`
- Bad: `Eightfold — Product (it has customers).` — every product has customers. The rationale must reflect the _category_ signature.

If you can't anchor the rationale in evidence, downgrade to the lower stage — when in doubt, the customer is doing more custom work than the brief assumes.

### 3 — Translate to method-fit

Each stage has implications for the reader's choice of method. Surface this as a sentence per stage occurrence:

- Genesis → "Apply Agile / experimental discipline. Time-bound. Expect to scrap or rebuild."
- Custom-built → "Apply Lean / pattern-led approaches. Borrow from comparable {X} implementations. Expect 6-12mo integration."
- Product → "Apply playbook-driven adoption. Vendor-roadmap-anchored. Expect <3mo integration if buyer follows reference architecture."
- Commodity → "Treat as utility. Optimise on price and SLA. Don't custom-integrate."

The brief's recommendations should match the method-fit of the technologies they involve. A recommendation to "build a custom orchestration layer on Workday Skills Cloud" treats a Product as Custom-built — possible but expensive, and the brief should name that.

## Output format (mandatory)

When evaluating a technology, emit one fenced block labelled `evolution-stage`:

```evolution-stage
Technology: <name>

Evolution stage: <Genesis|Custom-built|Product|Commodity>
Rationale: <one line citing observable evidence — references count, integration profile, vendor roadmap, etc.>
Method fit: <one line on the right approach: Agile / Lean / Playbook / Utility>
```

This block is machine-parseable. The L1 quality gate (`mission-quality.ts:SKILL_PROCEDURE_MARKERS`) detects two markers — the `Evolution stage:` line and any `Wardley {map|stage|evolution|doctrine|landscape}` reference — and counts the placement as the `evolution-stage` skill-procedure marker.

## Anti-patterns to refuse

- **Stage-without-rationale** — `Stage: Product` with no evidence makes the placement decorative.
- **Misclassifying Custom-built as Product** — vendors love to be called Products; if integration is multi-month and tuning is per-customer, it's Custom-built regardless of the marketing.
- **Genesis label as a hedge** — labelling everything Genesis treats every emerging-tech mention as un-actionable. Most "Genesis" categories actually have ≥2 comparable implementations and are Custom-built.
- **Method-fit mismatch** — naming a Product but recommending Genesis-style methods (or vice versa). The whole skill exists to expose this.
- **Comparing across stages without naming it** — comparing a Product to a Custom-built tool feature-by-feature is a category error; the Product will look "feature-rich and rigid" while the Custom-built will look "flexible but half-built." Both are method-of-evolution effects, not flaws.

## Working with other skills

- Pair with `score-technology-readiness` (NASA TRL) — TRL is empirical readiness; Wardley stage is strategic-method-fit. They're orthogonal axes; both should appear on a tech profile.
- Pair with the Tech Radar `Adopt / Trial / Assess / Hold` ring — ring is _should-we-adopt-it_, stage is _what-method-fits-its-current-state_. A technology can be Trial-ring and Genesis-stage (try carefully because the practice isn't established) or Adopt-ring and Commodity-stage (use, don't customise).
- Run **before** `jtbd-framing` — the JTBD's competing-solutions list often spans evolution stages (a Genesis-stage probe + a Product incumbent + a Commodity utility), and naming the stages clarifies the comparison.
- Use with `apply-hype-cycle` — hype cycle is an arc through time; Wardley evolution is the present strategic position. Both inform "where is this now?" but the question they answer is different.

## Confidence notes

Stage placement is more confident when anchored in observable counts (number of references, integration time, breaking-changes log). It's less confident when based on vendor positioning or market category. Mark stages anchored only in vendor self-positioning as `(stage estimate)` and lower the brief's confidence on any recommendation that depends on the placement.

## Radarist binding

Wardley stage is defined by observable evidence, and the graph holds most of it:

- `findVendors` — vendor count separates Custom-built from Product.
- `searchOssHealth` — many interchangeable implementations means Commodity.
- `getRelatedEntities` / `getGraphNeighbors` — integration patterns and customer references.
- `listCommunityClusters` — whether the category has consolidated into a stable cluster.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
