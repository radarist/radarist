/**
 * BUILD-017 C3 capability probe.
 *
 * The rubric-propagation protocol requires the phase-08 reviewer to record a
 * PER-CRITERION pass/finding in `.impulse/qa-report.json`. This test asks a
 * narrower question than the live spike does, and answers it from the schema
 * alone: CAN that report carry such a record at all?
 *
 * The answer matters because it separates two very different BUILD-016 work
 * items. If the reviewer simply chose not to score criteria, the fix is in the
 * qa-gate skill's prompt. If the report has nowhere to PUT a per-criterion
 * score, the fix is a schema change and no amount of prompting will help.
 *
 * These assertions are deliberately written to FAIL if the schema later gains a
 * per-criterion field — at which point this probe should be deleted and C3
 * re-evaluated, because its structural premise will no longer hold.
 */
import { qaReportSchema } from '../src/sandbox/status.js';

const baseReport = {
  verdict: 'PASS' as const,
  checkedAt: '2026-07-30T10:00:00.000Z',
  summary: 'Reviewed against the judged rubric.',
  findings: [],
};

describe('qa-report.json cannot carry a per-criterion rubric record', () => {
  it('silently STRIPS a top-level criteria array a reviewer might write', () => {
    const parsed = qaReportSchema.parse({
      ...baseReport,
      criteria: [
        { id: 'R1', weight: 5, score: 5, passed: true, evidence: 'playwright spec green' },
        { id: 'R3', weight: 4, score: 2, passed: false, evidence: 'screenshot shows gradient hero' },
      ],
    });
    // Not an error — worse: the data is accepted and then discarded, so the
    // supervisor sees a well-formed report with the rubric scores gone.
    expect(parsed).not.toHaveProperty('criteria');
    expect(Object.keys(parsed).sort()).toEqual(['checkedAt', 'findings', 'summary', 'verdict']);
  });

  it('strips per-criterion fields added to an individual finding', () => {
    const parsed = qaReportSchema.parse({
      ...baseReport,
      verdict: 'FAIL',
      findings: [
        {
          severity: 'major',
          title: 'Design reads generic',
          detail: 'Gradient hero present.',
          criterionId: 'R3',
          weight: 4,
          score: 2,
        },
      ],
    });
    expect(parsed.findings[0]).toEqual({
      severity: 'major',
      title: 'Design reads generic',
      detail: 'Gradient hero present.',
    });
  });

  it('offers no field in which a PASSING criterion could be recorded', () => {
    // `findings` is the only per-item collection, and every finding requires a
    // severity from the problem vocabulary. There is no "passed" severity, so a
    // criterion that met its bar cannot be represented as a finding.
    const severities = ['critical', 'major', 'minor'];
    for (const severity of severities) {
      expect(qaReportSchema.parse({ ...baseReport, findings: [{ severity, title: 't' }] }).findings).toHaveLength(1);
    }
    expect(() => qaReportSchema.parse({ ...baseReport, findings: [{ severity: 'pass', title: 'R1 met' }] })).toThrow();
    expect(() => qaReportSchema.parse({ ...baseReport, findings: [{ severity: 'info', title: 'R1 met' }] })).toThrow();
  });

  it('leaves only free-text title/detail/story as a place to name a criterion', () => {
    // This is what the checkpoint evaluator therefore has to search, and why a
    // C3 pass depends on reviewer CONVENTION rather than on structure.
    const parsed = qaReportSchema.parse({
      ...baseReport,
      verdict: 'FAIL',
      findings: [{ severity: 'major', title: 'R3 design distinctiveness', detail: 'weight 4', story: 'S3' }],
    });
    expect(parsed.findings[0].title).toContain('R3');
    expect(parsed.findings[0].story).toBe('S3');
  });
});
