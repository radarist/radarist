/**
 * @file lib/skill-prelude/registry.ts
 * @description Static mapping from CRITICAL DIMENSIONS directive prefixes to
 * skill names, plus each skill's activation mode.
 *
 * `parseCriticalDimensions` matches a brief's directive lines against these
 * prefixes with `startsWith`, so every prefix must be unique and no prefix may
 * be a prefix of another — `registry.test.ts` asserts both. A directive may not
 * contain a `:` before its `required | N/A` verdict (the line regex stops at the
 * first colon).
 */

/**
 * How a required skill is satisfied.
 *
 * - `per-entity`   — precomputed once per named technology in the brief's SCOPE.
 * - `brief-level`  — precomputed once from the brief itself.
 * - `output-time`  — NOT precomputed. The skill operates on material that does
 *   not exist yet when the prelude runs: the sources the run actually found, the
 *   numbers it actually produced, the headline claim it actually wrote. Firing
 *   it against a 500-character brief excerpt would spend a real helper session
 *   to produce a block about nothing. It stays a deterministic *directive* the
 *   mission agent honours with its own `Skill` tool, and `SKILL_PROCEDURE_MARKERS`
 *   in `mission-quality.ts` measures whether it actually fired.
 */
export type SkillActivation = 'per-entity' | 'brief-level' | 'output-time';

/**
 * Report procedures that operate on the finished draft rather than the brief.
 *
 * These belong in the shared registry even though the prelude deliberately
 * does not run them: registering them is what lets the mission persist the
 * exact `output-time-directive` requirement for later receipt/output checks.
 */
export const OUTPUT_CONTRACT_DIRECTIVES = {
  'IEEE citation discipline': 'cite-ieee',
  'Design review before publication': 'design-pass',
} as const;

export const DIRECTIVE_TO_SKILL: Record<string, string> = {
  'JTBD framing per technology': 'jtbd-framing',
  'Wardley evolution-stage per technology': 'evolution-stage',
  'NASA TRL per technology': 'score-technology-readiness',
  'Three Horizons tag per recommendation': 'three-horizons',
  'Cynefin domain classification': 'cynefin-classification',
  'Cheapest experiment per recommendation': 'cheapest-experiment',
  'Claim provenance brackets': 'claim-provenance',
  // SKILL-010 — seven more skills routed deterministically. Only the first is
  // precomputed; the rest operate on the run's own output (see `output-time`).
  'Competing hypotheses for the central question': 'analysis-of-competing-hypotheses',
  'Source reliability grade per cited source': 'rate-source-admiralty',
  'Independent corroboration for load-bearing claims': 'triangulate-sources',
  'Arithmetic consistency of stated figures': 'quantitative-sanity-check',
  'Red-team the headline claim': 'red-team-claim',
  'Premortem on the recommendation': 'premortem-analysis',
  'Citation identifier validation': 'verify-citations',
  ...OUTPUT_CONTRACT_DIRECTIVES,
};

export const KNOWN_SKILLS: Set<string> = new Set(Object.values(DIRECTIVE_TO_SKILL));

const SKILL_ACTIVATION: Record<string, SkillActivation> = {
  // Per-entity skills fan out one sub-mission per named technology in the brief.
  'jtbd-framing': 'per-entity',
  'evolution-stage': 'per-entity',
  'score-technology-readiness': 'per-entity',
  // Brief-level skills fire once, from the brief text.
  'cynefin-classification': 'brief-level',
  'three-horizons': 'brief-level',
  'cheapest-experiment': 'brief-level',
  'claim-provenance': 'brief-level',
  'analysis-of-competing-hypotheses': 'brief-level',
  // Output-time skills are never precomputed — see SkillActivation.
  'rate-source-admiralty': 'output-time',
  'triangulate-sources': 'output-time',
  'quantitative-sanity-check': 'output-time',
  'red-team-claim': 'output-time',
  'premortem-analysis': 'output-time',
  'verify-citations': 'output-time',
  'cite-ieee': 'output-time',
  'design-pass': 'output-time',
};

/**
 * Activation mode for a skill. Unknown skills default to `brief-level`, which is
 * the pre-SKILL-010 behaviour for anything that was not per-entity.
 */
export function skillActivation(skill: string): SkillActivation {
  return SKILL_ACTIVATION[skill] ?? 'brief-level';
}

export function isPerEntitySkill(skill: string): boolean {
  return skillActivation(skill) === 'per-entity';
}

/** Whether the prelude should spend a helper session precomputing this skill. */
export function isPrecomputedSkill(skill: string): boolean {
  return skillActivation(skill) !== 'output-time';
}
