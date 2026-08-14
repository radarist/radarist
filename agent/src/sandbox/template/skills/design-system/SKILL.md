---
name: design-system
description: Phase 03 of every build mission — establish ONE design brief (theme, exact palette, typography, spacing, components) before any UI exists, and turn it into code tokens. Use even for "plain" tools; the difference between a credible prototype and an AI-generic one is decided here, not in phase 06.
---

# Design system — one brief, exact values, then tokens

Write `docs/03-design-system.md` **and** a token file the app imports
(CSS custom properties or the framework's token mechanism — your choice,
recorded in the doc).

## 1. Theme

One named personality in 2–3 sentences (e.g., "instrument panel: dense,
monochrome surfaces, one signal color"). The name is a decision aid: when a
later styling choice arises, ask "does this fit <theme>?"

**Anti-generic rule (enforced at QA — phase 08 will fail a generic UI):**
the default AI aesthetic is a failure condition, not a fallback. Banned by
default: purple/indigo→blue gradients, everything-rounded-2xl, evenly-spaced
white/near-white cards on a gray page, a centered hero with a gradient
heading, emoji as iconography. Instead commit to ONE deliberate personality
with conviction and carry it everywhere:

- a **distinctive type choice** (a real display face for headings vs a clean
  text face; a deliberate scale with contrast — not all-16px),
- an **opinionated layout** (asymmetry, a real grid, density that fits the
  job — an instrument panel is dense, an editorial piece is airy),
- **one confident accent**, used sparingly, against a considered neutral
  range (not pure #fff / #000),
- **intentional detail** — borders OR shadows (pick one), consistent radius,
  a spacing rhythm a reader can feel.

Boring-but-coherent-and-deliberate beats flashy-but-generic. "Looks like
every other AI-generated app" is a phase-08 QA finding.

## 2. Palette (exact hexes)

- Background, surface, border, text-primary, text-muted: exact hex each.
- One **primary** action color + its hover/active variants.
- Semantic colors only if flows need them (success/error/warn).
- Maximum ~8 named colors total. Every color used anywhere in the app must
  exist in this table — phase 07 screenshots get compared against it.

## 3. Typography

Font family/families (system stacks are fine — name them exactly), a type
scale (size/weight/line-height for h1, h2, body, small, mono), and where
each level is used.

## 4. Spacing & shape

Spacing scale (e.g., 4/8/12/16/24/32), border radius value(s), elevation
approach (borders vs shadows — pick one).

## 5. Component inventory

List every UI component the flows in `docs/02-user-flows.md` require
(table, form field, button, toast, empty-state card…). For each: one line on
its look derived from the sections above. Components not in the inventory
don't get invented during phase 06 — extend the doc first.

## 6. Tokens to code

Emit the values as code (e.g., `src/styles/tokens.css` with CSS custom
properties). The app must consume tokens, not hardcode hexes — hardcoded
colors found in phase 08 are findings.

## Definition of Done

- Every hex exact; every flow-required component in the inventory; token
  file exists and is imported by the app scaffold once it exists.
- Committed as `docs(03): design system`; STATUS phase → `04-user-stories`.
