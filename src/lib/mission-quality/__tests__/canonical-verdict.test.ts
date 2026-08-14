/**
 * @file mission-quality/__tests__/canonical-verdict.test.ts
 * @description REPORT-018 — one canonical quality verdict, with the model judge
 * subordinate to deterministic truth.
 *
 * The regression fixture models an evaluator disagreement: deterministic L1
 * refuses a structurally unsafe report while the advisory judge returns PASS.
 * The canonical rule must keep the artifact in review and preserve both inputs.
 */
import { composeCanonicalQualityVerdict, type CanonicalQualityVerdict } from '@/lib/mission-quality/canonical-verdict';

/** Synthetic deterministic refusal fixture. */
const RETAINED_L1 = {
  evaluatedAt: '2026-08-01T13:16:11.553Z',
  overallScore: 0.4615,
  verdict: 'FAIL' as const,
  checks: [
    { name: 'result-exists', pass: true, critical: true, detail: 'result is 252905 chars' },
    {
      name: 'creator-citations-resolve',
      pass: false,
      critical: true,
      detail: 'citation [11] does not map to any source in the research bundle',
    },
    {
      name: 'creator-multi-source-quantitative',
      pass: false,
      critical: false,
      detail: '26 single-source quantitative violations',
    },
    { name: 'creator-brand-compliance', pass: false, critical: false, detail: 'brand analyzer failed' },
  ],
};

/** L2 as it actually judged the same artifact. */
const RETAINED_L2 = {
  evaluatedAt: '2026-08-01T13:18:02.001Z',
  judgeModel: 'gemini-2.5-flash',
  overallScore: 1,
  verdict: 'PASS' as const,
  dimensions: [
    { name: 'evidenceSourced' as const, score: 1, rationale: 'anchored IEEE citations throughout' },
    { name: 'numbersDefensible' as const, score: 1, rationale: 'every figure is sourced' },
  ],
};

/** Composition must yield a verdict whenever at least one evaluator ran. */
function composed(...args: Parameters<typeof composeCanonicalQualityVerdict>): CanonicalQualityVerdict {
  const result = composeCanonicalQualityVerdict(...args);
  if (!result) throw new Error('expected a canonical verdict when an evaluator ran');
  return result;
}

describe('REPORT-018 — the retained disagreement', () => {
  let verdict: CanonicalQualityVerdict;
  beforeAll(() => {
    verdict = composed(RETAINED_L1, RETAINED_L2);
  });

  it('composes FAIL — a perfect model score cannot upgrade a deterministic refusal', () => {
    expect(verdict.verdict).toBe('FAIL');
  });

  it('names the deterministic ceiling and what set it', () => {
    expect(verdict.ceiling).toBe('FAIL');
    expect(verdict.criticalFailures).toEqual(['creator-citations-resolve']);
  });

  it('attributes the canonical verdict to the deterministic evaluator', () => {
    expect(verdict.decidedBy).toBe('deterministic');
  });

  it('preserves the disagreement for audit and UI explanation', () => {
    expect(verdict.disagreement).toBeDefined();
    expect(verdict.disagreement?.kind).toBe('judge-more-favourable');
    expect(verdict.disagreement?.detail).toContain('PASS');
    expect(verdict.disagreement?.detail).toContain('FAIL');
  });

  it('keeps both raw receipts immutable and unmodified', () => {
    expect(verdict.deterministic).toEqual({
      verdict: 'FAIL',
      overallScore: 0.4615,
      evaluatedAt: RETAINED_L1.evaluatedAt,
    });
    expect(verdict.judge).toEqual({
      verdict: 'PASS',
      overallScore: 1,
      judgeModel: 'gemini-2.5-flash',
      evaluatedAt: RETAINED_L2.evaluatedAt,
    });
    // The composer must never rewrite the sources it reads.
    expect(RETAINED_L1.verdict).toBe('FAIL');
    expect(RETAINED_L2.verdict).toBe('PASS');
  });
});

describe('REPORT-018 — composition rules', () => {
  const clean = { evaluatedAt: 't', overallScore: 1, verdict: 'PASS' as const, checks: [] };

  it('a clean deterministic result CAN still be lowered by the judge', () => {
    const v = composed(clean, { ...RETAINED_L2, verdict: 'REVISE', overallScore: 0.5 });
    expect(v.verdict).toBe('REVISE');
    expect(v.decidedBy).toBe('judge');
    expect(v.disagreement?.kind).toBe('judge-more-critical');
  });

  it('a soft-only deterministic REVISE is not upgraded to PASS by a perfect judge', () => {
    const soft = {
      evaluatedAt: 't',
      overallScore: 0.8,
      verdict: 'REVISE' as const,
      checks: [{ name: 'citations-present', pass: false, critical: false, detail: 'only 1 marker' }],
    };
    const v = composed(soft, RETAINED_L2);
    expect(v.verdict).toBe('REVISE');
    expect(v.ceiling).toBe('REVISE');
    expect(v.criticalFailures).toEqual([]);
  });

  it('falls back to the deterministic verdict when the judge is absent', () => {
    const v = composed(RETAINED_L1, undefined);
    expect(v.verdict).toBe('FAIL');
    expect(v.decidedBy).toBe('deterministic');
    expect(v.judge).toBeUndefined();
    expect(v.disagreement).toBeUndefined();
  });

  it('records no disagreement when both evaluators agree', () => {
    const v = composed(clean, { ...RETAINED_L2, verdict: 'PASS', overallScore: 0.9 });
    expect(v.verdict).toBe('PASS');
    expect(v.disagreement).toBeUndefined();
  });

  it('returns undefined when neither evaluator ran, rather than inventing a PASS', () => {
    expect(composeCanonicalQualityVerdict(undefined, undefined)).toBeUndefined();
  });

  it('a judge with no deterministic report cannot mint a canonical PASS on its own', () => {
    const v = composed(undefined, RETAINED_L2);
    expect(v).toBeDefined();
    expect(v.verdict).toBe('REVISE');
    // Not attributed to either evaluator: the bound is the composition policy,
    // because an unevaluated report is not evidence of a clean one.
    expect(v.decidedBy).toBe('ceiling');
    expect(v.ceiling).toBe('REVISE');
  });

  it('lists every critical failure, not just the first', () => {
    const twoCriticals = {
      evaluatedAt: 't',
      overallScore: 0.2,
      verdict: 'FAIL' as const,
      checks: [
        { name: 'scout-bundle-parseable', pass: false, critical: true, detail: 'x' },
        { name: 'scout-no-citation-padding', pass: false, critical: true, detail: 'y' },
        { name: 'citations-present', pass: false, critical: false, detail: 'z' },
      ],
    };
    const v = composed(twoCriticals, undefined);
    expect(v.criticalFailures).toEqual(['scout-bundle-parseable', 'scout-no-citation-padding']);
  });
});
