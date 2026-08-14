/**
 * @file lib/mission-quality/skill-markers.ts
 * @description The output-shape markers that prove a skill's procedure actually
 * ran, and the helpers that read them.
 *
 * Extracted from `mission-quality.ts` by SKILL-050. Two consumers now need this
 * table — the aggregate `skill-adherence` check and the per-skill output
 * accountability the row adds — and leaving it in the evaluator would have made
 * `mission-quality.ts` and `mission-quality/required-skill-outputs.ts` import
 * each other. The registration invariant (`scripts/check-skill-registration.ts`)
 * reads this file.
 */

/**
 * Patterns that indicate the agent internalized a skill's procedure even
 * without formally invoking Skill(). Each one is a strong signal that the
 * output follows a specific skill's method. See skill-adherence check.
 */
export const SKILL_PROCEDURE_MARKERS: Array<{ pattern: RegExp; skill: string }> = [
  { pattern: /\b[A-F][1-6]\b.{0,10}(source|grade|admiralty|reliability)/i, skill: 'rate-source-admiralty' },
  {
    pattern: /\b(C|I|N|NA)\b.{0,40}(hypothesis|evidence|consistent|inconsistent)/i,
    skill: 'analysis-of-competing-hypotheses',
  },
  {
    pattern: /\bH[1-9]\b.{0,80}(hypothesis|consistent|inconsistent|contradict|support)/i,
    skill: 'analysis-of-competing-hypotheses',
  },
  { pattern: /🟢|🟡|🔴/, skill: 'assess-study-bias' },
  { pattern: /\b(RoB-2|risk of bias|cochrane)\b/i, skill: 'assess-study-bias' },
  { pattern: /\bCohen'?s [hd]\b/i, skill: 'test-significance' },
  {
    pattern:
      /\b(Peak of Inflated Expectations|Trough of Disillusionment|Slope of Enlightenment|Plateau of Productivity)\b/i,
    skill: 'apply-hype-cycle',
  },
  { pattern: /\bTRL\s?[1-9]\b/i, skill: 'score-technology-readiness' },
  {
    pattern:
      /\b(Situation|Background|Assessment|Recommendation)\b.{0,200}\b(Situation|Background|Assessment|Recommendation)\b/i,
    skill: 'write-srl-brief',
  },
  {
    pattern: /\b(five forces|threat of new entrants|supplier power|buyer power|threat of substitutes|rivalry among)\b/i,
    skill: 'five-forces-analysis',
  },
  {
    pattern: /\b(scenario planning|2×2 scenario|cambrian|wild west|walled garden|frozen winter)\b/i,
    skill: 'scenario-planning',
  },
  { pattern: /\b(top-down|bottom-up)\b.{0,100}\b(TAM|SAM|SOM|market siz)/i, skill: 'estimate-market-size' },
  { pattern: /\b(premortem|pre-mortem|failure mode|kill threshold)\b/i, skill: 'premortem-analysis' },
  { pattern: /\b(red[-\s]team|attack vector|counter[-\s]example)\b/i, skill: 'red-team-claim' },
  { pattern: /\b(FundingEvent|post-money valuation|lead investor)\b/i, skill: 'detect-funding-round' },
  { pattern: /\b(MAEvent|acquirer|target|consideration|regulatory jurisdictions)\b/i, skill: 'detect-ma-event' },
  { pattern: /\b(ReleaseEvent|semver|breaking changes|deprecations)\b/i, skill: 'analyze-release-notes' },
  {
    pattern: /\b(ReliabilityScore|data contamination|baseline freshness|seed variance)\b/i,
    skill: 'benchmark-model-claims',
  },
  { pattern: /\bWeak signals? to watch NOW\b/i, skill: 'foresight' },
  { pattern: /\bKill signals?\b[\s\S]{0,80}\bretract\b/i, skill: 'foresight' },
  {
    pattern:
      /^[\s\-*]*Job:\s*(minimize|maximize|reduce|identify|accelerate|automate|eliminate|increase|decrease|streamline)\b/im,
    skill: 'jtbd-framing',
  },
  { pattern: /\bStruggling moment\s*:/i, skill: 'jtbd-framing' },
  { pattern: /^[\s\-*]*Smallest test\s*:/im, skill: 'cheapest-experiment' },
  {
    pattern: /\bDecision rule\s*:[\s\S]{0,160}\b(pass if|fail if)\b/i,
    skill: 'cheapest-experiment',
  },
  { pattern: /\[validated\s*,/i, skill: 'claim-provenance' },
  {
    pattern: /\[assumption\s*,[\s\S]{0,200}\bretire[-\s]?by\b/i,
    skill: 'claim-provenance',
  },
  {
    pattern: /^[\s\-*]*\**Decision domain\**\s*:\s*\**\s*(Clear|Simple|Complicated|Complex|Chaotic)\b/im,
    skill: 'cynefin-classification',
  },
  {
    pattern:
      /\b(probe[-\s]?sense[-\s]?respond|sense[-\s]?categori[sz]e[-\s]?respond|sense[-\s]?analy[sz]e[-\s]?respond|act[-\s]?sense[-\s]?respond)\b/i,
    skill: 'cynefin-classification',
  },
  {
    pattern: /^[\s\-*]*\**Evolution stage\**\s*:\s*\**\s*(Genesis|Custom[-\s]built|Custom|Product|Commodity)\b/im,
    skill: 'evolution-stage',
  },
  { pattern: /\bWardley\s+(map|mapping|stage|evolution|doctrine|landscape)/i, skill: 'evolution-stage' },
  {
    pattern: /^[\s\-*]*\**Horizon\**\s*:\s*\**\s*H[1-3]\b/im,
    skill: 'three-horizons',
  },
  { pattern: /\bThree[-\s]+Horizons?\b/i, skill: 'three-horizons' },
  // SKILL-048 — the eight skills added by SKILL-033. Each pattern is lifted
  // from that skill's own "Emit the result" / "Output shape" template, so a
  // match means the agent actually produced the skill's output, not that it
  // used a word the skill happens to mention.
  { pattern: /\bBayes factor\b/i, skill: 'bayesian-update' },
  { pattern: /^[\s\-*]*\**Posterior (odds|P\(H\|E\))\**\s*:/im, skill: 'bayesian-update' },
  { pattern: /\bBrier (skill )?score\b/i, skill: 'brier-score-calibration' },
  { pattern: /\bcalibration curve\b/i, skill: 'brier-score-calibration' },
  {
    // The output is a fixed five-key column block; two consecutive keys in
    // order is the shape, and a single word in prose is not.
    pattern: /^[\s>*-]*(?:STRUCTURE|GAPS|TIME|TRUST)\b[^\n]*\n[\s>*-]*(?:GAPS|TIME|TRUST|SO WHAT)\b/m,
    skill: 'graph-as-instrument',
  },
  { pattern: /^[\s#*]*\**Key Assumptions Check\b/im, skill: 'key-assumptions-check' },
  { pattern: /^[\s\-*]*\**Sensitivity sweep\**\s*:/im, skill: 'key-assumptions-check' },
  { pattern: /^[\s\-*]*\**Governing thought\b/im, skill: 'pyramid-principle' },
  { pattern: /^[\s\-*]*\**MECE check\**\s*:/im, skill: 'pyramid-principle' },
  { pattern: /^[\s#*]*\**SIFT Check\b/im, skill: 'sift-source-check' },
  { pattern: /^[\s\-*]*\**Find better coverage\**\s*:/im, skill: 'sift-source-check' },
  { pattern: /\bsteelman(?:ned|ning)?\b/i, skill: 'steelman-argument' },
  { pattern: /^[\s\-*]*\**Endorsement check\**\s*:/im, skill: 'steelman-argument' },
  {
    pattern: /^[\s>*-]*\**DISPOSITION\**\s*:?\s*\**\s*(monitor|probe|promote|discard)\b/im,
    skill: 'weak-signal-triage',
  },
  { pattern: /^[\s>*-]*\**AMPLITUDE\**\s*:?\s*\**\s*(low|medium|high)\b/im, skill: 'weak-signal-triage' },
  // SKILL-048 — the remaining skills that publish a literal output template.
  // `scripts/check-skill-registration.ts` fails if a skill ships such a
  // template with no marker here, so this list and the templates stay paired.
  { pattern: /"event_type"\s*:\s*"patent_event"/i, skill: 'analyze-patent-claims' },
  { pattern: /\b(claim_transition_language|independent_claim_count)\b/i, skill: 'analyze-patent-claims' },
  { pattern: /^[\s\-*]*\**Compound claim\**\s*:/im, skill: 'chemistry-claim-check' },
  { pattern: /\bname vs\.? formula\b/i, skill: 'chemistry-claim-check' },
  { pattern: /^[\s\-*]*\**Orthogonality check\**\s*:/im, skill: 'position-competitor' },
  { pattern: /^[\s\-*]*\**Axes chosen\**\s*:/im, skill: 'position-competitor' },
  { pattern: /^[\s\-*]*\**SMILES\**\s*:\s*\S/im, skill: 'smiles-sanity-check' },
  { pattern: /\bring closures?\b.{0,20}\b(matched|open-close|never closed)\b/i, skill: 'smiles-sanity-check' },
  { pattern: /\bPRISMA flow\b/i, skill: 'systematic-review' },
  { pattern: /^[\s\-*]*\**Protocol \(pre-registered\b/im, skill: 'systematic-review' },
  { pattern: /"independence_check"/i, skill: 'triangulate-sources' },
  { pattern: /\b(distinct_first_hand_chains|triangulated_across)\b/i, skill: 'triangulate-sources' },
];

/**
 * Skills whose procedure marker appears in a run's output.
 *
 * SKILL-050: per-skill accountability reads the SAME table the aggregate
 * `skill-adherence` check uses. Before this the only consumer was an any-marker
 * aggregate, which reported the skill programme as successful when four
 * unrelated markers were present and a specifically requested output-time skill
 * had never fired.
 */
export function detectSkillProcedureMarkers(result: string): Set<string> {
  const detected = new Set<string>();
  if (!result) return detected;
  for (const { pattern, skill } of SKILL_PROCEDURE_MARKERS) {
    if (pattern.test(result)) detected.add(skill);
  }
  return detected;
}

/** Skills this table can measure from output alone. */
export const MARKER_DETECTABLE_SKILLS: ReadonlySet<string> = new Set(SKILL_PROCEDURE_MARKERS.map((m) => m.skill));
