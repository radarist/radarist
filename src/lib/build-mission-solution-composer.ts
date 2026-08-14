import type { DesignBrief } from '@/lib/schemas/design-brief';

export interface SolutionBriefInput {
  title: string;
  objective: string;
  mustHaves: string[];
  outOfScope?: string[];
  subject?: string;
  designBrief: DesignBrief;
}
export interface ComposedSolution {
  brief: string;
  title: string;
}

/**
 * Normalize an assistant-drafted app request into the canonical Limitless
 * MISSION.md. Guarantees a Design Brief (rendered from the resolved palette so
 * the sandbox can consume tokens) and an Acceptance Rubric whose items map 1:1
 * to the machine gates the supervisor verifies (checks.json, qa-report.json,
 * the design token/contrast gate). Mirrors composeTechnologyEvaluationBrief.
 */
export function composeSolutionBrief(input: SolutionBriefInput): ComposedSolution {
  const { title, objective, mustHaves, designBrief } = input;
  const outOfScope = input.outOfScope ?? [];
  const p = designBrief.palette;
  const t = designBrief.typography;
  const features = mustHaves.map((f, i) => `${i + 1}. ${f}`).join('\n');
  const scope = outOfScope.length
    ? outOfScope.map((s) => `- ${s}`).join('\n')
    : '- Anything not listed under Must-have features.';

  const brief = `# Mission: ${title}

## Objective

${objective}

## Must-have features

${features}

## Out of scope

${scope}

## Done means

- Every check in \`.impulse/checks.json\` passes from a clean install.
- \`.impulse/qa-report.json\` records verdict \`PASS\`.
- The running UI conforms to the Design Brief below: it consumes the design
  tokens (no hardcoded hex colors outside the token file) and text meets
  WCAG-AA contrast.
- The app is seeded with **real, on-subject content** — no \`lorem\`, no
  \`foo\`/\`bar\`/\`test123\`; a stranger understands the value in 60 seconds.

## Design Brief

Subject: ${input.subject ?? title}. Build a deliberate, branded product — not a
generic template. Follow the phase-03 \`design-system\` skill and author
\`src/styles/tokens.css\` from this palette.

- Theme: ${designBrief.theme}
- Palette (exact hexes; wire these into tokens, do not hardcode elsewhere):
  bg \`${p.bg}\` · surface \`${p.surface}\` · ink \`${p.ink}\` · accent \`${p.accent}\`
  · sequence ${p.sequence.map((c) => `\`${c}\``).join(', ')}
- Typography: display "${t.display}", body "${t.body}"
- One confident accent; opinionated layout; a strong first-impression/hero
  screen; responsive and accessible.

## Acceptance Rubric

The builder is ready for the independent reviewer ONLY when all of the following
are machine-true:
1. \`.impulse/checks.json\` — every command exits 0.
2. \`.impulse/qa-report.json\` — verdict \`PASS\`, no \`critical\`/unjustified \`major\`.
3. Design gate — token file consumed, no hardcoded hex in \`src/\`, WCAG-AA text contrast.
`;
  return { brief, title };
}
