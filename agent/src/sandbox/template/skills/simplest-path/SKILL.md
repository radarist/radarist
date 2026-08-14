---
name: simplest-path
description: Phase 05 of every build mission — choose the thinnest end-to-end architecture that proves the riskiest assumption, write a one-page ADR, and only then unlock application code. Use ESPECIALLY when you feel confident; confidence is when architecture astronautics sneaks in.
---

# Simplest path — thinnest slice, boring technology, one-page ADR

Write `docs/05-adr.md` (one page hard cap). **No application code exists
before this is committed** — only `/workspace/spikes/` experiments.

## 1. Riskiest assumption

Name the single assumption most likely to sink the mission (a rendering
approach, a data volume, a library capability). The walking skeleton (S1)
must prove or kill it.

## 2. The slice

Describe the thinnest end-to-end slice touching every layer: what renders,
where state lives, how persistence works. Per component, answer the deletion
question: **"what breaks if we delete this?"** If the answer is "nothing
yet," delete it from the design.

## 3. Stack decision

You scaffold freely — so the ADR must carry the justification:

- Chosen stack (framework, build tool, test runners, persistence) with one
  line of _why_ each — and the why must reference the job/flows, not
  fashion. **Prefer boring technology**: the newest thing in the stack
  should be the thing the mission is actually about.
- Licensing: everything you install must be permissive OSS (MIT/Apache/BSD/
  ISC). No paid or source-unavailable dependencies, ever.
- The dev server must bind `0.0.0.0:3000` (the sandbox maps that port).
- **Preview contract**: the published preview launches from a reviewed copy
  of the workspace in exactly one of two trusted shapes, selected by an
  optional `radarist-preview.json` at the workspace root. The manifest never
  carries a command — only a mode:
  - `{"mode": "framework-dev"}` (or no manifest): the platform runs
    `npm --ignore-scripts run dev`, so `package.json` must define a
    `scripts.dev` that binds `0.0.0.0:3000`.
  - `{"mode": "static", "root": "site", "entry": "index.html"}`: the
    platform serves the `root` directory with its own fixed static file
    server. Use this when the simplest artifact is plain HTML/CSS/JS with no
    build step. `root`/`entry` are optional (default `.` / `index.html`),
    must be relative, and may not use dotfile segments, `node_modules`, or
    derived-output roots (`dist`, `.next`, …). Committed source only —
    derived outputs are deleted before the preview starts. Request-reachable
    symlinks under `root` fail the launch; dotfile and `node_modules` subtrees
    are not request-reachable.

## 4. Alternatives rejected

2–3 rejected options, one line each on why (cost, risk, overkill).

## 5. Reversibility

Rate each major decision: `cheap-to-reverse` / `expensive-to-reverse`.
Expensive-to-reverse decisions get one extra sentence of justification.

## Definition of Done

- ≤1 page; riskiest assumption named; deletion question answered for every
  component; stack justified incl. licensing; dev-server port noted.
- Committed as `docs(05): ADR`; STATUS phase → `06-build`. Application
  scaffolding may now begin.
