/**
 * @file mission-quality/__tests__/scout-bundle-repair.test.ts
 * @description REPORT-017 — one bounded repair for a correctable Scout bundle,
 * before the Creator chain halts.
 *
 * The regression fixture is a parseable bundle that fails only bounded numeric
 * citation-padding checks. It must not advance to Creator unchanged, but it can
 * earn one deterministic correction without weakening the evidence gate.
 *
 * The gate is not weakened. What changes is that ONE specific, evidenced,
 * repairable failure earns the single revision turn that already exists.
 */
import {
  CORRECTABLE_SCOUT_CHECKS,
  isCorrectableScoutBundleFailure,
  recoverScoutBundleEvidence,
} from '@/lib/mission-quality/scout-bundle-repair';
import { analyzeCitationPadding } from '@/lib/mission-quality/analyzers/scout-bundle-analyzer';
import { analyzeSingleSourceQuantitative } from '@/lib/mission-quality/analyzers/scout-single-source-analyzer';
import type { ScoutBundle } from '@/lib/schemas/scout-bundle';

const check = (name: string, pass: boolean, critical = true, detail = 'x') => ({ name, pass, critical, detail });

/** Synthetic correctable failure: bundle parsed, two padding violations. */
const RETAINED_FAILURE = {
  verdict: 'FAIL' as const,
  checks: [
    check('result-exists', true),
    check('scout-bundle-parseable', true, true, 'bundle parsed — 9 source(s), 10 finding(s)'),
    check(
      'scout-no-citation-padding',
      false,
      true,
      "2 padding violations (first: finding 3 — source 7 snippet does not contain any of the finding's numeric tokens (18%))"
    ),
    check('scout-multi-source-quantitative', false, false),
  ],
};

describe('REPORT-017 — what earns the single repair turn', () => {
  it('accepts a parseable synthetic bundle with named padding violations', () => {
    const decision = isCorrectableScoutBundleFailure('scout', RETAINED_FAILURE);
    expect(decision.correctable).toBe(true);
    expect(decision.correctableChecks).toEqual(['scout-no-citation-padding']);
  });

  it('refuses a malformed bundle — nothing to repair, so it stays fail-closed', () => {
    const decision = isCorrectableScoutBundleFailure('scout', {
      verdict: 'FAIL',
      checks: [check('scout-bundle-parseable', false, true, 'no fenced json block found')],
    });
    expect(decision.correctable).toBe(false);
    expect(decision.reason).toContain('scout-bundle-parseable');
  });

  it('refuses fabricated evidence — an unreachable URL is not a formatting slip', () => {
    const decision = isCorrectableScoutBundleFailure('scout', {
      verdict: 'FAIL',
      checks: [check('scout-bundle-parseable', true), check('scout-no-fake-urls', false, true, '2 URL(s) unreachable')],
    });
    expect(decision.correctable).toBe(false);
    expect(decision.reason).toContain('scout-no-fake-urls');
  });

  it('refuses when ANY critical failure is outside the correctable set', () => {
    const decision = isCorrectableScoutBundleFailure('scout', {
      verdict: 'FAIL',
      checks: [
        check('scout-bundle-parseable', true),
        check('scout-no-citation-padding', false, true),
        check('result-exists', false, true, 'result is only 12 chars'),
      ],
    });
    expect(decision.correctable).toBe(false);
    expect(decision.reason).toContain('result-exists');
  });

  it('refuses a non-scout agent — this path repairs a research bundle, nothing else', () => {
    expect(isCorrectableScoutBundleFailure('creator', RETAINED_FAILURE).correctable).toBe(false);
    expect(isCorrectableScoutBundleFailure(undefined, RETAINED_FAILURE).correctable).toBe(false);
  });

  it('refuses a verdict that is not FAIL — REVISE already has its own path', () => {
    expect(isCorrectableScoutBundleFailure('scout', { ...RETAINED_FAILURE, verdict: 'REVISE' }).correctable).toBe(
      false
    );
  });

  it('refuses when no critical check failed at all, so a FAIL with no cause never repairs', () => {
    const decision = isCorrectableScoutBundleFailure('scout', {
      verdict: 'FAIL',
      checks: [check('scout-bundle-parseable', true), check('citations-present', false, false)],
    });
    expect(decision.correctable).toBe(false);
  });

  it('refuses when the failing check carries no detail the agent could act on', () => {
    const decision = isCorrectableScoutBundleFailure('scout', {
      verdict: 'FAIL',
      checks: [check('scout-bundle-parseable', true), check('scout-no-citation-padding', false, true, '   ')],
    });
    expect(decision.correctable).toBe(false);
    expect(decision.reason).toContain('no actionable detail');
  });

  it('keeps the correctable set deliberately narrow', () => {
    // Widening this set is a decision about what evidence the platform will let
    // an agent rewrite, so it is pinned rather than left to drift.
    expect([...CORRECTABLE_SCOUT_CHECKS]).toEqual(['scout-no-citation-padding']);
  });
});

function source(id: number, snippet: string) {
  return {
    id,
    title: `Retained source ${id}`,
    url: `https://example.com/evidence/${id}`,
    fetched_via: 'gemini-grounding' as const,
    tool_call_id: `toolu_retained_${id}`,
    admiralty: 'B2',
    date_accessed: '2026-08-01',
    snippet,
  };
}

function renderBundle(bundle: ScoutBundle): string {
  return ['Synthetic Scout result.', '```json', JSON.stringify(bundle), '```'].join('\n');
}

/**
 * Synthetic mixed-support bundle. Findings 0 and 1 are supported; findings
 * 2–9 each pair one numeric source with
 * one topical source whose snippet does not carry the number.
 */
const SYNTHETIC_MIXED_SUPPORT_BUNDLE: ScoutBundle = {
  queries: ['market adoption evidence', 'cost benchmark evidence', 'implementation risk evidence'],
  sources: [
    source(1, 'Independent evidence says adoption reached 30% in the measured cohort.'),
    source(2, 'A second measurement also reports adoption reached 30% in the cohort.'),
    source(3, 'The market is changing quickly, with several vendors competing.'),
    source(4, 'Surveyed teams reported a 40% reduction in cycle time.'),
    source(5, 'Teams are applying the technology to delivery workflows.'),
    source(6, 'The benchmark measured $0.28 per million tokens.'),
    source(7, 'Pricing varies by vendor and deployment model.'),
    source(8, 'Median response latency was 180ms.'),
    source(9, 'The study compares several runtime architectures.'),
    source(10, 'The pilot served 5,000 users.'),
    source(11, 'Adoption depends on workflow fit and change management.'),
    source(12, 'Storage consumption measured 110GB.'),
    source(13, 'Storage architecture affects operating cost.'),
    source(14, 'The measured throughput improvement was 2.5x.'),
    source(15, 'Throughput depends on batching and hardware.'),
  ],
  findings: [
    'Enterprise adoption is accelerating in regulated teams [1, 2].',
    'Implementation risk concentrates in workflow integration [3, 5].',
    'Adoption reached 30% in the measured cohort [1, 3].',
    'Cycle time fell 40% in surveyed teams [4, 5].',
    'Inference cost reached $0.28 per million tokens [6, 7].',
    'Median response latency reached 180ms [8, 9].',
    'The pilot served 5,000 users [10, 11].',
    'Storage consumption measured 110GB [12, 13].',
    'Measured throughput improved 2.5x [14, 15].',
    'Adoption reached 30% in another segment [2, 11].',
  ],
  unresolved: ['Long-term retention effects remain unknown.'],
};

describe('REPORT-019 — evidence-preserving record recovery', () => {
  it('replays the retained 15-source/10-finding/8-violation shape and preserves the two valid findings byte-for-byte', () => {
    const originalAnalysis = analyzeCitationPadding(SYNTHETIC_MIXED_SUPPORT_BUNDLE);
    expect(originalAnalysis.ok).toBe(false);
    if (originalAnalysis.ok) throw new Error('fixture must carry the retained padding failure');
    expect(originalAnalysis.violations).toHaveLength(8);

    const recovered = recoverScoutBundleEvidence(renderBundle(SYNTHETIC_MIXED_SUPPORT_BUNDLE));
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.reason);

    expect(recovered.receipt).toEqual({
      sourceCount: 15,
      originalFindingCount: 10,
      recoveredFindingCount: 2,
      preservedFindingIndexes: [0, 1],
      correctedFindingIndexes: [],
      downgradedFindingIndexes: [2, 3, 4, 5, 6, 7, 8, 9],
    });
    expect(recovered.bundle.findings).toEqual(SYNTHETIC_MIXED_SUPPORT_BUNDLE.findings.slice(0, 2));
    expect(recovered.bundle.sources).toEqual(SYNTHETIC_MIXED_SUPPORT_BUNDLE.sources);
    expect(recovered.bundle.queries).toEqual(SYNTHETIC_MIXED_SUPPORT_BUNDLE.queries);
    expect(recovered.bundle.unresolved[0]).toBe(SYNTHETIC_MIXED_SUPPORT_BUNDLE.unresolved[0]);
    expect(recovered.bundle.unresolved.slice(1)).toHaveLength(8);
    expect(recovered.bundle.unresolved.slice(1).every((claim) => claim.includes('not supported evidence'))).toBe(true);
    expect(recovered.bundle.unresolved.slice(1).every((claim) => !/\[[\d\s,]+\]/.test(claim))).toBe(true);
    expect(analyzeCitationPadding(recovered.bundle)).toEqual({ ok: true });
    expect(analyzeSingleSourceQuantitative(recovered.bundle)).toEqual({ ok: true, quantitativeFindingCount: 0 });
  });

  it('corrects only the affected record when two independently supporting citations remain', () => {
    const bundle: ScoutBundle = {
      ...SYNTHETIC_MIXED_SUPPORT_BUNDLE,
      findings: [
        SYNTHETIC_MIXED_SUPPORT_BUNDLE.findings[0],
        'Adoption reached 30% in the measured cohort [1, 2, 3].',
      ],
    };

    const recovered = recoverScoutBundleEvidence(renderBundle(bundle));
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.reason);

    expect(recovered.bundle.findings).toEqual([
      bundle.findings[0],
      'Adoption reached 30% in the measured cohort [1, 2].',
    ]);
    expect(recovered.receipt.preservedFindingIndexes).toEqual([0]);
    expect(recovered.receipt.correctedFindingIndexes).toEqual([1]);
    expect(recovered.receipt.downgradedFindingIndexes).toEqual([]);
    expect(recovered.bundle.sources).toEqual(bundle.sources);
  });

  it('downgrades an independently detected single-source quantitative record even when padding affected another record', () => {
    const bundle: ScoutBundle = {
      ...SYNTHETIC_MIXED_SUPPORT_BUNDLE,
      findings: [
        SYNTHETIC_MIXED_SUPPORT_BUNDLE.findings[0],
        'Adoption reached 30% in the measured cohort [1, 3].',
        'Median response latency reached 180ms [8].',
      ],
    };

    const recovered = recoverScoutBundleEvidence(renderBundle(bundle));
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.reason);

    expect(recovered.bundle.findings).toEqual([bundle.findings[0]]);
    expect(recovered.receipt.downgradedFindingIndexes).toEqual([1, 2]);
    expect(recovered.bundle.unresolved.at(-1)).toContain('Median response latency reached 180ms.');
    expect(recovered.bundle.unresolved.at(-1)).not.toContain('[8]');
  });

  it('does not retain a padding-affected numeric claim with one source when the soft analyzer misses its token class', () => {
    const bundle: ScoutBundle = {
      ...SYNTHETIC_MIXED_SUPPORT_BUNDLE,
      findings: [
        SYNTHETIC_MIXED_SUPPORT_BUNDLE.findings[0],
        'The milestone is forecast for 2026 [1, 3].',
      ],
      sources: [
        ...SYNTHETIC_MIXED_SUPPORT_BUNDLE.sources.slice(0, 1).map((item) => ({
          ...item,
          snippet: 'The milestone is forecast for 2026.',
        })),
        ...SYNTHETIC_MIXED_SUPPORT_BUNDLE.sources.slice(1),
      ],
    };

    // A bare year is caught by padding analysis but is deliberately outside
    // the softer single-source quantitative token taxonomy.
    expect(analyzeSingleSourceQuantitative(bundle)).toEqual({ ok: true, quantitativeFindingCount: 0 });
    const recovered = recoverScoutBundleEvidence(renderBundle(bundle));
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.reason);
    expect(recovered.bundle.findings).toEqual([bundle.findings[0]]);
    expect(recovered.receipt.downgradedFindingIndexes).toEqual([1]);
    expect(recovered.bundle.unresolved.at(-1)).toContain('The milestone is forecast for 2026.');
    expect(recovered.bundle.unresolved.at(-1)).not.toContain('[1]');
  });

  it('fails closed when every finding is affected instead of fabricating a supported placeholder', () => {
    const bundle: ScoutBundle = {
      ...SYNTHETIC_MIXED_SUPPORT_BUNDLE,
      findings: ['Adoption reached 30% in the measured cohort [1, 3].'],
    };

    expect(recoverScoutBundleEvidence(renderBundle(bundle))).toEqual({
      ok: false,
      reason: 'every finding was affected; no supported finding remains for Creator',
    });
  });

  it('refuses a mismatched quality trigger when the parsed bundle has no padding violation', () => {
    const bundle: ScoutBundle = {
      ...SYNTHETIC_MIXED_SUPPORT_BUNDLE,
      findings: SYNTHETIC_MIXED_SUPPORT_BUNDLE.findings.slice(0, 2),
    };

    expect(recoverScoutBundleEvidence(renderBundle(bundle))).toEqual({
      ok: false,
      reason: 'parsed bundle has no citation-padding violation to recover',
    });
  });
});
