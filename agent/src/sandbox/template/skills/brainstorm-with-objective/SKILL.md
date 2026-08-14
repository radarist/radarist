---
name: brainstorm-with-objective
description: Phase 01 of every build mission — forced divergence then convergence on the implementation approach. Use even when one approach seems obviously correct; the obvious approach surviving a real comparison is the cheapest insurance a mission can buy.
---

# Brainstorm with objective — diverge, score, attack, converge

Write `docs/01-brainstorm.md`:

## 1. Diverge (≥3 genuinely different approaches)

Three or more approaches to satisfying the inception objective. "Different"
means a stranger could tell them apart by architecture or interaction model,
not by adjectives. For each: 2–4 lines — core idea, primary risk.

A library/component choice is not an approach; an approach is a shape of the
whole solution (e.g., "single-page list with inline editing" vs "wizard flow
with review step" vs "canvas-first with detail drawer").

## 2. Score

| Approach | Fit to job (1–5) | Effort (1–5, lower=less) | Risk (1–5, lower=safer) |
| -------- | ---------------- | ------------------------ | ----------------------- |

Score against the **job statement** from `docs/00-inception.md`, not against
what is fun to build. One line of justification per cell that isn't obvious.

## 3. Attack your favorite

Before choosing, write 3–5 sentences arguing **against** the highest-scoring
approach, as a skeptical reviewer would. If the attack lands (you cannot
answer it in one sentence), adjust the scores and say so.

## 4. Converge

Name the chosen approach and the single strongest reason. Note what would
make you revisit (a kill-signal, e.g., "if the dataset exceeds X rows the
inline-editing approach dies").

## Definition of Done

- ≥3 distinct approaches, scored table, an attack section that names a real
  weakness (an attack that finds nothing is a defect — look again).
- Chosen approach consistent with inception constraints.
- Committed as `docs(01): options analysis`; STATUS phase → `02-user-flows`.
