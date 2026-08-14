/**
 * @file lib/__tests__/mission-outcome.test.ts
 * @description REPORT-002 — the mission terminal-truth decision.
 *
 * `resolveMissionOutcome` is the pure rule Step 4 of run-agent-mission applies
 * so a paid report mission can only end one of three honest ways:
 *   - delivered      — completed, report(s) linked via /reports/{id};
 *   - needs-review   — completed, but the artifact is a retained owner-visible
 *                      draft with the exact failed checks and a repair path;
 *   - no-deliverable — the run "succeeded" but published NOTHING for a mission
 *                      that promised report slots → terminate loudly as failed.
 * It must never produce a green "Mission completed" with zero output, and the
 * SDK-failure path stays exactly as before (handled upstream of this rule).
 */

import { resolveMissionOutcome } from '../mission-quality';
import type { QualityCheck } from '../mission-quality';

function check(name: string, pass: boolean, critical = false): QualityCheck {
  return { name, pass, critical, detail: `${name} detail` };
}

const PASS_REPORT = {
  evaluatedAt: '2026-07-18T00:00:00.000Z',
  overallScore: 1,
  verdict: 'PASS' as const,
  checks: [check('result-exists', true, true), check('citations-present', true)],
};

describe('resolveMissionOutcome', () => {
  it('delivers a clean PASS mission with the private report link appended', () => {
    const outcome = resolveMissionOutcome({
      sdkSuccess: true,
      hadReportSlots: true,
      reports: [{ id: 'report-1', title: 'Landscape' }],
      qualityReport: PASS_REPORT,
    });

    expect(outcome.kind).toBe('delivered');
    expect(outcome.status).toBe('completed');
    expect(outcome.progressMessage).toBe('Mission completed');
    expect(outcome.resultAppendix).toContain('/reports/report-1');
    expect(outcome.reportNeedsReview).toBe(false);
  });

  it('terminates loudly as failed when a slotted mission published nothing', () => {
    const outcome = resolveMissionOutcome({
      sdkSuccess: true,
      hadReportSlots: true,
      reports: [],
      qualityReport: { ...PASS_REPORT, verdict: 'REVISE' },
    });

    expect(outcome.kind).toBe('no-deliverable');
    expect(outcome.status).toBe('failed');
    expect(outcome.progressMessage).toBe('Mission finished without publishing its report deliverable');
    if (outcome.kind !== 'no-deliverable') throw new Error('narrowing failed');
    expect(outcome.error).toMatch(/no report was published/i);
  });

  it('marks a post-revision REVISE with substantive failures as needs-review (never green)', () => {
    const failing = [check('creator-brand-compliance', false), check('citations-present', false)];
    const outcome = resolveMissionOutcome({
      sdkSuccess: true,
      hadReportSlots: true,
      reports: [{ id: 'report-1', title: 'Landscape' }],
      qualityReport: {
        ...PASS_REPORT,
        verdict: 'REVISE',
        checks: [check('result-exists', true, true), ...failing],
      },
    });

    expect(outcome.kind).toBe('needs-review');
    expect(outcome.status).toBe('completed');
    expect(outcome.progressMessage).toBe('Mission completed — report needs review');
    expect(outcome.reportNeedsReview).toBe(true);
    expect(outcome.failingChecks.map((c) => c.name)).toEqual(['creator-brand-compliance', 'citations-present']);
    expect(outcome.resultAppendix).toContain('needs review');
    expect(outcome.resultAppendix).toContain('/reports/report-1');
  });

  it('treats a FAIL verdict with a published report as needs-review too', () => {
    const outcome = resolveMissionOutcome({
      sdkSuccess: true,
      hadReportSlots: true,
      reports: [{ id: 'report-1' }],
      qualityReport: {
        ...PASS_REPORT,
        verdict: 'FAIL',
        checks: [check('creator-citations-resolve', false, true)],
      },
    });

    expect(outcome.kind).toBe('needs-review');
    expect(outcome.failingChecks[0].critical).toBe(true);
  });

  it('ships as delivered when only non-substantive process heuristics fail (MISSION-003)', () => {
    const outcome = resolveMissionOutcome({
      sdkSuccess: true,
      hadReportSlots: true,
      reports: [{ id: 'report-1' }],
      qualityReport: {
        ...PASS_REPORT,
        verdict: 'REVISE',
        checks: [check('result-exists', true, true), check('skill-adherence', false), check('not-partial', false)],
      },
    });

    expect(outcome.kind).toBe('delivered');
    expect(outcome.reportNeedsReview).toBe(false);
  });

  it('keeps an exploratory (slot-less) mission delivered without any report', () => {
    const outcome = resolveMissionOutcome({
      sdkSuccess: true,
      hadReportSlots: false,
      reports: [],
      qualityReport: PASS_REPORT,
    });

    expect(outcome.kind).toBe('delivered');
    expect(outcome.resultAppendix).toBe('');
  });

  it('marks needs-review even when the quality report is missing but reports exist and slots were promised', () => {
    // A missing quality report means the gate could not run — that is not a
    // proven-clean artifact; stay honest and route the owner to review it.
    const outcome = resolveMissionOutcome({
      sdkSuccess: true,
      hadReportSlots: true,
      reports: [{ id: 'report-1' }],
      qualityReport: undefined,
    });

    expect(outcome.kind).toBe('needs-review');
    expect(outcome.failingChecks).toEqual([
      expect.objectContaining({ name: 'quality-evaluation-missing', critical: false }),
    ]);
  });

  it('never runs for SDK failures (caller precondition) — throws to catch misuse', () => {
    expect(() =>
      resolveMissionOutcome({
        sdkSuccess: false,
        hadReportSlots: true,
        reports: [],
        qualityReport: PASS_REPORT,
      })
    ).toThrow(/sdkSuccess/);
  });

  it('lists every published report in the delivered appendix', () => {
    const outcome = resolveMissionOutcome({
      sdkSuccess: true,
      hadReportSlots: true,
      reports: [
        { id: 'report-1', title: 'Main' },
        { id: 'report-2', title: 'Appendix' },
      ],
      qualityReport: PASS_REPORT,
    });

    expect(outcome.resultAppendix).toContain('/reports/report-1');
    expect(outcome.resultAppendix).toContain('/reports/report-2');
  });
});

// ============================================================================
// REPORT-003 — non-regression promotion decision
// ============================================================================

import { evaluateRevisionPromotion } from '../mission-quality';

describe('evaluateRevisionPromotion', () => {
  const report = (verdict: 'PASS' | 'REVISE' | 'FAIL', checks: QualityCheck[]) => ({ verdict, checks });

  it('rejects a verdict-rank drop (REVISE → FAIL)', () => {
    const decision = evaluateRevisionPromotion(
      report('REVISE', [check('citations-present', false)]),
      report('FAIL', [check('result-exists', false, true)])
    );
    expect(decision.promote).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/verdict/i);
  });

  it('rejects an equal-verdict revision that flips a previously-passing load-bearing check to failing', () => {
    // Equal verdicts must not auto-promote a materially worse revision.
    const decision = evaluateRevisionPromotion(
      report('REVISE', [check('creator-brand-compliance', true), check('citations-present', false)]),
      report('REVISE', [check('creator-brand-compliance', false), check('citations-present', false)])
    );
    expect(decision.promote).toBe(false);
    expect(decision.reasons.join(' ')).toContain('creator-brand-compliance');
  });

  it('does NOT reject on a newly-appearing content-gated check (absent in the original run)', () => {
    // A more complete revision surfaces stricter checks — punishing that
    // would reward content-shedding (the original isRevisionRegression note).
    const decision = evaluateRevisionPromotion(
      report('REVISE', [check('citations-present', false)]),
      report('REVISE', [check('citations-present', false), check('creator-jtbd-presence', false)])
    );
    expect(decision.promote).toBe(true);
  });

  it('ignores process-heuristic flips (skill-adherence / not-partial are not load-bearing)', () => {
    const decision = evaluateRevisionPromotion(
      report('REVISE', [check('skill-adherence', true), check('citations-present', false)]),
      report('REVISE', [check('skill-adherence', false), check('citations-present', false)])
    );
    expect(decision.promote).toBe(true);
  });

  it('promotes a tie that addressed feedback without losing ground', () => {
    const decision = evaluateRevisionPromotion(
      report('REVISE', [check('citations-present', false), check('creator-brand-compliance', true)]),
      report('REVISE', [check('citations-present', false), check('creator-brand-compliance', true)])
    );
    expect(decision.promote).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it('promotes an improvement (REVISE → PASS)', () => {
    const decision = evaluateRevisionPromotion(
      report('REVISE', [check('citations-present', false)]),
      report('PASS', [check('citations-present', true)])
    );
    expect(decision.promote).toBe(true);
  });

  it('collects every regression reason (verdict drop + load-bearing flips)', () => {
    const decision = evaluateRevisionPromotion(
      report('REVISE', [check('creator-brand-compliance', true), check('creator-citations-resolve', true, true)]),
      report('FAIL', [check('creator-brand-compliance', false), check('creator-citations-resolve', false, true)])
    );
    expect(decision.promote).toBe(false);
    expect(decision.reasons.length).toBeGreaterThanOrEqual(2);
  });
});
