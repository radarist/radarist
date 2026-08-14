---
name: score-technology-readiness
description: Use when placing a technology on a capability ring or answering "how ready is X?", "is this production-grade?", "can I deploy this?", "what TRL is it?", "is this proven at scale?". Applies NASA's 9-level TRL scale adapted for software and AI, with the evidence required per level. For strategic-method fit use `evolution-stage` instead.
---

# Score Technology Readiness

TRL scoring with evidence gates. The score is worthless without the evidence that defends it.

## When to invoke

Trigger on phrases like "how mature is {X}?", "is {X} production-ready?", "what TRL is {X}?", "can we deploy {X}?", "is this proven at scale?", "readiness assessment", "maturity stage of {X}", "can I trust {X} for enterprise use?".

Skip for:

- Market-level claims ("is the market ready?" — that's `apply-hype-cycle`, not TRL).
- Pure research concepts with no productization ambition (TRL applies only to technology aimed at deployment).
- Pure hardware — HRL (Hardware Readiness Level) and MRL (Manufacturing Readiness Level) exist for different domains. Flag and defer.

## The 9-level scale (software/AI adaptation)

| TRL   | NASA definition (original)           | Software/AI adaptation                      | Evidence required                                                              |
| ----- | ------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------ |
| **1** | Basic principles observed            | Research paper describing mechanism         | arXiv preprint / peer-reviewed paper                                           |
| **2** | Concept formulated                   | Algorithm + problem statement               | Written spec or working-paper; no code                                         |
| **3** | Proof-of-concept                     | Working code on toy input                   | GitHub repo with runnable example                                              |
| **4** | Component validation in lab          | Component validated on controlled dataset   | Benchmark results; `benchmark-model-claims` score ≥3                           |
| **5** | Validation in relevant environment   | Tested on realistic noisy data              | Third-party eval or replication in adjacent domain                             |
| **6** | Prototype in operational environment | Pilot deployment with real users            | Case study OR customer reference (named) OR closed beta with published results |
| **7** | System prototype demonstrated        | Production-grade deployment at one customer | Production case study; incident reports visible; named reference customer      |
| **8** | System complete and qualified        | Productized offering, multiple customers    | Published customer list; support SLA; operational metrics public               |
| **9** | Actual system proven in operations   | De facto standard in the category           | Industry-wide adoption; downstream ecosystem depends on it                     |

Software/AI rarely reaches pure TRL 9 — "ecosystem dependence" is the best proxy. Large-language-model families, CUDA, Kubernetes are TRL 9; most enterprise SaaS is TRL 7–8.

## Procedure

### 1 — Identify the technology

The subject must be a specific technology with identifiable boundaries — a model, a product, a library, a protocol, a platform. Vague categories ("AI for healthcare") cannot be TRL-scored; break them into specific components first.

### 2 — Find evidence at each level

Go level-by-level from 1 upward. At each level, the technology earns that level if the **evidence requirement** for that level is met.

**Rule**: you cannot skip levels. A technology claiming TRL 7 must have evidence at TRL 6, 5, 4, and below. "Claims of TRL 8" without a named pilot are rejected — request the pilot name.

### 3 — Stop at the highest defensible level

Assign the TRL = highest level with satisfying evidence. If the claim is TRL 7 but only TRL 5 evidence exists, score TRL 5 and note the gap.

### 4 — Emit the "what's needed next" gate

For TRL advancement, specify the **single piece of evidence** that would move the tech one level higher.

Examples:

- Current TRL 5, needs TRL 6: "named pilot deployment with a Fortune 500 customer, with public case study"
- Current TRL 7, needs TRL 8: "second named reference customer in a different vertical, with published operational metrics"

This is the output that Strategist agents can action into a roadmap.

### 5 — Format

```
## Technology Readiness Assessment — {technology name}

**Subject:** {specific technology, with scope boundary}
**Assessed TRL: {N}** (on NASA 9-level scale, software/AI adaptation)

**Evidence by level:**

| TRL | Met? | Evidence |
|---|---|---|
| 1. Basic principles | ✅ | {arXiv paper, DOI} |
| 2. Concept | ✅ | {working-paper URL} |
| 3. PoC | ✅ | {github.com/org/repo} |
| 4. Component validation | ✅ | {benchmark + score} |
| 5. Realistic environment | ✅ | {replication study / third-party test} |
| 6. Pilot | ⚠️ partial | {case study is internal / unnamed customer} |
| 7. Production | ❌ | — |
| 8. Multi-customer | ❌ | — |
| 9. Ecosystem | ❌ | — |

**Verdict: TRL 5** (one level below the vendor claim of TRL 7 — missing named pilot + production deployment).

**To advance TRL 5 → 6:** secure one named pilot deployment with a reference customer willing to publish a case study. A closed beta with >5 external users and reported uptime metrics would also suffice.

**Risks if deployed above stated TRL:** {brief risk summary, e.g. "no incident-reporting track record, so failure modes unknown"}
```

### 6 — Pair with downstream

- Feed the TRL into radar ring placement (Rogers's adoption ring ≈ TRL tier).
- Pair with `benchmark-model-claims` for TRL 4 evidence assessment.
- Pair with `assess-study-bias` when TRL 5 evidence is a single third-party study.
- Trigger `abstain-or-escalate` if the vendor claims a TRL level without the required evidence — this is a surfaceable signal-quality issue.

## Anti-patterns

- Do **not** accept a TRL claim from the vendor without independent evidence. Self-reported TRL is unreliable — check the cited pilot/customer.
- Do **not** score TRL without defining the scope. "OpenAI is TRL 9" is meaningless; "GPT-4 API is TRL 8 for general-purpose chat completion" is actionable.
- Do **not** skip levels. If you can't find evidence for TRL 5, you can't claim TRL 7 — even if the technology is being sold as production-ready.
- Do **not** use this for market-readiness. TRL is about the technology, not the market — they are orthogonal dimensions.
- Do **not** rate hardware on the software TRL. If it's a chip or a sensor, defer to HRL/MRL.

## Reference

- NASA TRL definitions: NASA Procedural Requirement 7123.1C, "NASA Systems Engineering Processes and Requirements," Section 6.5 (2020).
- DoE Technology Readiness Assessment Guide: DOE G 413.3-4A (2011).
- ISO 16290:2013 "Space systems — Definition of the Technology Readiness Levels (TRLs) and their criteria of assessment."
- DARPA Technology Maturation conventions (software adaptation): "Technology Readiness Levels and their Application in a Software-Intensive System," IEEE SystemsConf 2021.
- Pairs with `benchmark-model-claims` (TRL 4 component evidence), `apply-hype-cycle` (market maturity, orthogonal axis), and `position-competitor` (TRL factors into competitive placement).

## Radarist binding

TRL bands map onto evidence classes, and every class is a keyless call:

- **TRL 1–3** (concept, proof) → `searchPapers` → `resolveOpenAccess` for the methods section.
- **TRL 4–6** (validation, prototype) → `searchPatents` (filing activity) + `searchOssHealth` (working implementations).
- **TRL 7–9** (operational, proven at scale) → `searchSecFilings` and `searchHackerNews` for real deployments.
- **Current state** → `getDecoupledTechnologyDetails`.
- **Terminate in a write** → `placeTechnologyOnRadar` → `confirmPlacement`. The TRL gates the Assessment lane, which auto-applies at or above the configured confidence threshold (default 75) — so this number moves a durable placement, not just a paragraph.

If a call returns empty or is missing fields — retry once, then fall back to the alternate named above, then record the gap rather than inventing the value.
