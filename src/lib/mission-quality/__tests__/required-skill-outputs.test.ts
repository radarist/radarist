/**
 * @file mission-quality/__tests__/required-skill-outputs.test.ts
 * @description SKILL-050 — a required output-time skill is accountable on its
 * own, not through an aggregate that any unrelated marker can satisfy.
 *
 * A mission can require IEEE citation discipline and a design review while an
 * aggregate marker check passes on unrelated procedures. These tests prove
 * each requested output-time skill remains independently accountable.
 */
import {
  evaluateRequiredSkillOutputs,
  resolveRequiredOutputSkills,
  REQUIRED_OUTPUT_CONTRACTS,
} from '@/lib/mission-quality/required-skill-outputs';
import { evaluateMissionQuality, substantiveFailingChecks } from '@/lib/mission-quality';
import { buildRevisionFeedbackWithManifest } from '@/lib/skill-prelude/build-feedback';

const DIMENSIONS = (lines: string[]): string =>
  ['MISSION', '', 'CRITICAL DIMENSIONS:', ...lines.map((l) => `- ${l}`), ''].join('\n');

/** A Creator brief that requires both report output contracts. */
const CREATOR_BRIEF = DIMENSIONS(['IEEE citation discipline: required', 'Design review before publication: required']);

/** Synthetic artifact shape: a plain reference list with no anchors. */
const REPORT_WITHOUT_CITATIONS = `<html><body>
  <p>Compliance spend rises 18% [1].</p>
  <ol class="ref-list"><li>EU Commission, "CSRD Omnibus I"</li></ol>
</body></html>`;

/** The `cite-ieee` HTML output contract, satisfied. */
const REPORT_WITH_CITATIONS = `<html><body>
  <p>Compliance spend rises 18% <a class="cite-link" href="#ref-1"><sup class="cite">[1]</sup></a>.</p>
  <ol class="ref-list"><li id="ref-1">EU Commission, "CSRD Omnibus I"</li></ol>
</body></html>`;

const EXPORT_SHA = 'a'.repeat(64);
const BOTH_INVOCATIONS = [
  { skill: 'cite-ieee' },
  { skill: 'design-pass', args: `review exact final report export ${EXPORT_SHA}` },
];
const ARTIFACT_EVIDENCE = {
  reportId: 'report-skill-050',
  sha256: EXPORT_SHA,
  revisionNumber: 1,
  reviewedBy: ['design-pass', 'critique-report'] as const,
  designPassVerdict: 'PASS' as const,
};
const ARTIFACT_IDENTITY = { reportId: 'report-skill-050', sha256: EXPORT_SHA, revisionNumber: 1 };

/** Synthetic request with explicit report-output requirements. */
const SYNTHETIC_RAW_REQUEST = `Create and publish a board-ready HTML strategic decision report.
Required publication quality:
- use the Radarist design system and accessible responsive HTML;
- include at least one decision-useful diagram or chart and one compact executive infographic or visual summary;
- use IEEE-style numbered citations whose in-text links resolve to anchored reference entries.`;

describe('SKILL-050 — resolving what a mission actually required', () => {
  it('resolves the report output contracts from the brief', () => {
    const required = resolveRequiredOutputSkills(CREATOR_BRIEF);
    expect(required.sort()).toEqual(['cite-ieee', 'design-pass']);
  });

  it('leaves an explicitly non-applicable skill out of the denominator', () => {
    const brief = DIMENSIONS([
      'IEEE citation discipline: required',
      'Design review before publication: N/A — no visuals',
    ]);
    expect(resolveRequiredOutputSkills(brief)).toEqual(['cite-ieee']);
  });

  it('resolves registered output-time directives through the shared registry', () => {
    const brief = DIMENSIONS(['Red-team the headline claim: required', 'JTBD framing per technology: required']);
    // `jtbd-framing` is precomputed by the prelude, not an output-time contract,
    // so it must not become an output check.
    expect(resolveRequiredOutputSkills(brief)).toEqual(['red-team-claim']);
  });

  it('requires nothing when the brief carries no dimensions block', () => {
    expect(resolveRequiredOutputSkills('Write me a report about batteries.')).toEqual([]);
  });

  it('prefers the persisted requirement over re-parsing the prompt', () => {
    // The prelude already resolved and persisted the directives; re-deriving
    // from a prompt that a revision turn has since appended to would drift.
    expect(resolveRequiredOutputSkills('no block here', ['cite-ieee'])).toEqual(['cite-ieee']);
  });

  it('merges a legacy partial persisted ledger with cite-ieee/design-pass from the brief', () => {
    expect(resolveRequiredOutputSkills(CREATOR_BRIEF, ['red-team-claim'])).toEqual([
      'cite-ieee',
      'design-pass',
      'red-team-claim',
    ]);
  });

  it('resolves cite-ieee and design-pass from the synthetic request', () => {
    expect(resolveRequiredOutputSkills(SYNTHETIC_RAW_REQUEST)).toEqual(['cite-ieee', 'design-pass']);
  });

  it('does not impose report-output skills on Scout or Linker missions', () => {
    expect(resolveRequiredOutputSkills(SYNTHETIC_RAW_REQUEST, undefined, 'scout')).toEqual([]);
    expect(resolveRequiredOutputSkills(SYNTHETIC_RAW_REQUEST, undefined, 'linker')).toEqual([]);
  });

  it('does not infer an output contract from generic report prose', () => {
    expect(resolveRequiredOutputSkills('Create a concise report with the available evidence.')).toEqual([]);
  });

  it('ignores a persisted entry that is not a known output contract', () => {
    expect(resolveRequiredOutputSkills('no block', ['cite-ieee', 'not-a-skill'])).toEqual(['cite-ieee']);
  });
});

describe('SKILL-050 — each required skill is evaluated on its own', () => {
  it('fails cite-ieee when the anchored output shape is absent', () => {
    const checks = evaluateRequiredSkillOutputs(['cite-ieee', 'design-pass'], REPORT_WITHOUT_CITATIONS);
    const cite = checks.find((c) => c.name === 'skill-output:cite-ieee');
    expect(cite?.pass).toBe(false);
    expect(cite?.detail).toContain('cite-ieee');
  });

  it('fails design-pass independently of cite-ieee', () => {
    const checks = evaluateRequiredSkillOutputs(['cite-ieee', 'design-pass'], REPORT_WITH_CITATIONS, BOTH_INVOCATIONS);
    expect(checks.find((c) => c.name === 'skill-output:cite-ieee')?.pass).toBe(true);
    expect(checks.find((c) => c.name === 'skill-output:design-pass')?.pass).toBe(false);
  });

  it('passes only when BOTH output contracts are present', () => {
    const checks = evaluateRequiredSkillOutputs(
      ['cite-ieee', 'design-pass'],
      REPORT_WITH_CITATIONS,
      BOTH_INVOCATIONS,
      ARTIFACT_EVIDENCE,
      ARTIFACT_IDENTITY
    );
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  it('fails both when marker-shaped output exists without formal Skill() receipts', () => {
    const checks = evaluateRequiredSkillOutputs(
      ['cite-ieee', 'design-pass'],
      REPORT_WITH_CITATIONS,
      [],
      ARTIFACT_EVIDENCE,
      ARTIFACT_IDENTITY
    );
    expect(checks.every((check) => !check.pass)).toBe(true);
    expect(checks.every((check) => check.detail.includes('no formal Skill() receipt'))).toBe(true);
  });

  it('fails when formal calls exist but neither procedure changed the output', () => {
    const checks = evaluateRequiredSkillOutputs(
      ['cite-ieee', 'design-pass'],
      REPORT_WITHOUT_CITATIONS,
      BOTH_INVOCATIONS
    );
    expect(checks.every((check) => !check.pass)).toBe(true);
    expect(checks.find((check) => check.name.endsWith('cite-ieee'))?.detail).toContain(
      'was invoked but its output is absent'
    );
    expect(checks.find((check) => check.name.endsWith('design-pass'))?.detail).toContain(
      'no publication-owned artifact review evidence'
    );
  });

  it('rejects a design receipt bound to different export bytes', () => {
    const checks = evaluateRequiredSkillOutputs(
      ['design-pass'],
      REPORT_WITH_CITATIONS,
      [{ skill: 'design-pass', args: `review exact final report export ${'b'.repeat(64)}` }],
      ARTIFACT_EVIDENCE,
      ARTIFACT_IDENTITY
    );
    expect(checks[0]).toMatchObject({ pass: false });
  });

  it('rejects publication evidence whose identity differs from the canonical bytes', () => {
    const checks = evaluateRequiredSkillOutputs(
      ['design-pass'],
      REPORT_WITH_CITATIONS,
      BOTH_INVOCATIONS,
      ARTIFACT_EVIDENCE,
      { ...ARTIFACT_IDENTITY, sha256: 'c'.repeat(64) }
    );
    expect(checks[0].pass).toBe(false);
    expect(checks[0].detail).toContain('does not match the canonical report artifact identity');
  });

  it('is not satisfied by unrelated procedure markers', () => {
    // Four unrelated markers, which is what made the aggregate check pass.
    const unrelated = [
      'Decision domain: Complex',
      'Horizon: H2',
      'Evolution stage: Product',
      'Smallest test: a two-week pilot',
    ].join('\n');
    const checks = evaluateRequiredSkillOutputs(
      ['cite-ieee', 'design-pass'],
      `${REPORT_WITHOUT_CITATIONS}\n${unrelated}`
    );
    expect(checks.every((c) => !c.pass)).toBe(true);
  });

  it('cite-ieee requested ALONE is scored alone, with no design-pass denominator', () => {
    const checks = evaluateRequiredSkillOutputs(['cite-ieee'], REPORT_WITH_CITATIONS, [{ skill: 'cite-ieee' }]);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: 'skill-output:cite-ieee', pass: true });
  });

  it('design-pass requested ALONE is scored alone, with no cite-ieee denominator', () => {
    const checks = evaluateRequiredSkillOutputs(
      ['design-pass'],
      REPORT_WITH_CITATIONS,
      BOTH_INVOCATIONS,
      ARTIFACT_EVIDENCE,
      ARTIFACT_IDENTITY
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: 'skill-output:design-pass', pass: true });
  });

  it('a receipt for the OTHER skill does not satisfy the one that was required', () => {
    // The receipt check is per-skill: invoking design-pass cannot vouch for
    // cite-ieee, exactly as an unrelated marker cannot.
    const checks = evaluateRequiredSkillOutputs(['cite-ieee'], REPORT_WITH_CITATIONS, [{ skill: 'design-pass' }]);
    expect(checks[0].pass).toBe(false);
    expect(checks[0].detail).toContain('no formal Skill() receipt');
  });

  it('emits nothing when nothing was required, so the denominator stays honest', () => {
    expect(evaluateRequiredSkillOutputs([], REPORT_WITHOUT_CITATIONS)).toEqual([]);
  });

  it('records an unmeasurable requirement as not-evaluated rather than a silent pass', () => {
    // A skill with no detectable output shape cannot be scored; counting it as a
    // pass would be the same false-green this row exists to close.
    const contract = REQUIRED_OUTPUT_CONTRACTS.find((c) => c.skill === 'cite-ieee');
    expect(contract).toBeDefined();
    const checks = evaluateRequiredSkillOutputs(['triangulate-sources'], 'nothing measurable here');
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('skill-output:triangulate-sources');
  });

  it('marks the checks non-critical, so a missing skill asks for a revision rather than voiding the run', () => {
    const checks = evaluateRequiredSkillOutputs(['cite-ieee'], REPORT_WITHOUT_CITATIONS);
    expect(checks[0].critical).toBe(false);
  });
});

/**
 * The acceptance the row names: a FIXED Creator fixture requesting `cite-ieee`
 * plus `design-pass`, scored through the real `evaluateMissionQuality` — not the
 * helper in isolation — so the wiring is proven, not just the predicate.
 */
describe('SKILL-050 — fixed Creator fixture, through the real evaluator', () => {
  const evaluate = (
    result: string,
    requiredOutputSkills?: string[],
    skillInvocations: Array<{ skill: string; args?: string }> = BOTH_INVOCATIONS,
    includeArtifactEvidence = true
  ) =>
    evaluateMissionQuality({
      prompt: CREATOR_BRIEF,
      result,
      agent: 'creator',
      skillInvocations,
      ...(requiredOutputSkills ? { requiredOutputSkills } : {}),
      ...(includeArtifactEvidence
        ? { artifactEvidence: ARTIFACT_EVIDENCE, artifactIdentity: ARTIFACT_IDENTITY }
        : {}),
    });

  it('fails when the citation output contract is absent', () => {
    const report = evaluate(REPORT_WITHOUT_CITATIONS);
    const cite = report.checks.find((c) => c.name === 'skill-output:cite-ieee');
    expect(cite?.pass).toBe(false);
    expect(report.verdict).not.toBe('PASS');
  });

  it('fails when exact-artifact design-review evidence is absent', () => {
    const report = evaluate(REPORT_WITH_CITATIONS, undefined, BOTH_INVOCATIONS, false);
    expect(report.checks.find((c) => c.name === 'skill-output:design-pass')?.pass).toBe(false);
    expect(report.verdict).not.toBe('PASS');
  });

  it('passes both only with cited output and exact-artifact review evidence', () => {
    const report = evaluate(REPORT_WITH_CITATIONS);
    const required = report.checks.filter((c) => c.name.startsWith('skill-output:'));
    expect(required).toHaveLength(2);
    expect(required.every((c) => c.pass)).toBe(true);
  });

  it('the aggregate skill-adherence check no longer covers for a missing requested skill', () => {
    // Four unrelated procedure markers must not satisfy the
    // aggregate, and before this row that WAS the whole skill verdict.
    const unrelated = [
      'Decision domain: Complex',
      'Horizon: H2',
      'Evolution stage: Product',
      'Smallest test: pilot',
    ].join('\n');
    const report = evaluate(`${REPORT_WITHOUT_CITATIONS}\n${unrelated}`, undefined, []);
    expect(report.checks.find((c) => c.name === 'skill-adherence')?.pass).toBe(true);
    expect(report.checks.filter((c) => c.name.startsWith('skill-output:')).every((c) => !c.pass)).toBe(true);
    expect(report.verdict).not.toBe('PASS');
  });

  it('the synthetic request cannot pass from citation/design markers without receipts', () => {
    const report = evaluateMissionQuality({
      prompt: SYNTHETIC_RAW_REQUEST,
      result: REPORT_WITH_CITATIONS,
      agent: 'creator',
      skillInvocations: [],
      artifactEvidence: ARTIFACT_EVIDENCE,
      artifactIdentity: ARTIFACT_IDENTITY,
    });
    const required = report.checks.filter((check) => check.name.startsWith('skill-output:'));
    expect(required.map((check) => check.name)).toEqual(['skill-output:cite-ieee', 'skill-output:design-pass']);
    expect(required.every((check) => !check.pass)).toBe(true);
    expect(report.verdict).toBe('REVISE');
  });

  it('the synthetic request passes both skill checks only with receipts and exact artifact evidence', () => {
    const report = evaluateMissionQuality({
      prompt: SYNTHETIC_RAW_REQUEST,
      result: REPORT_WITH_CITATIONS,
      agent: 'creator',
      skillInvocations: BOTH_INVOCATIONS,
      artifactEvidence: ARTIFACT_EVIDENCE,
      artifactIdentity: ARTIFACT_IDENTITY,
    });
    const required = report.checks.filter((check) => check.name.startsWith('skill-output:'));
    expect(required).toHaveLength(2);
    expect(required.every((check) => check.pass)).toBe(true);
  });

  it('adds no checks — and no denominator — when the brief requires nothing', () => {
    const report = evaluateMissionQuality({
      prompt: 'Write a short note.',
      result: REPORT_WITHOUT_CITATIONS,
      agent: 'creator',
    });
    expect(report.checks.filter((c) => c.name.startsWith('skill-output:'))).toEqual([]);
  });

  it('the correction brief names the missing skills', () => {
    const report = evaluate(REPORT_WITHOUT_CITATIONS, undefined, BOTH_INVOCATIONS, false);
    const failing = substantiveFailingChecks(report.checks);
    const manifest = buildRevisionFeedbackWithManifest({ failingChecks: failing, deliverableKind: 'report' });
    expect(manifest.requestedSkills).toEqual(expect.arrayContaining(['cite-ieee', 'design-pass']));
    expect(manifest.feedback).toContain('cite-ieee');
    expect(manifest.feedback).toContain('design-pass');
  });

  it('the persisted requirement wins over the prompt', () => {
    // A revision turn appends to `prompt`; the dispatched requirement does not
    // change, so the two evaluations stay comparable.
    const report = evaluateMissionQuality({
      prompt: 'no dimensions block at all',
      result: REPORT_WITHOUT_CITATIONS,
      agent: 'creator',
      requiredOutputSkills: ['cite-ieee'],
    });
    const required = report.checks.filter((c) => c.name.startsWith('skill-output:'));
    expect(required).toHaveLength(1);
    expect(required[0].pass).toBe(false);
  });
});
