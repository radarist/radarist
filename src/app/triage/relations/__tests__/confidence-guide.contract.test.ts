/** @jest-environment node */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

jest.mock('@/lib/graph/neo4j-client', () => ({
  runReadTransaction: jest.fn(),
  runWriteTransaction: jest.fn(),
}));
jest.mock('@/lib/graph/assertions', () => ({
  getAssertionWithEvidenceByRelationId: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { computeCorroboration } from '@/lib/claim-chips';
import { corroborationNudge, effectiveConfidenceSet } from '@/lib/graph/confidence-calibration';
import { MACHINE_RELATION_MATERIALIZATION_THRESHOLD } from '@/lib/graph/materialization-policy';
import { calculateCorroborationScore } from '@/lib/signals/trust-score';
import { normalizeVerifiedEvidence } from '@/lib/signals/verified-evidence';
import { CONFIDENCE_EVIDENCE_GUIDE_URL } from '@/lib/public-documentation';

const guide = readFileSync(resolve(process.cwd(), 'docs/guides/confidence-evidence-and-feedback.md'), 'utf8');

describe('confidence, evidence, and feedback guide contract', () => {
  it('pins the current score formulas and worked relation example', () => {
    expect([0, 1, 2, 3, 4, 10].map(corroborationNudge)).toEqual([0, 0, 5, 10, 15, 15]);
    expect(effectiveConfidenceSet('r')).toContain('coalesce(r.assertedConfidence, r.confidence, 100)');
    expect(effectiveConfidenceSet('r')).toContain('THEN 100');
    expect(effectiveConfidenceSet('r')).toContain('THEN 5');
    expect(MACHINE_RELATION_MATERIALIZATION_THRESHOLD).toBe(75);
    expect(calculateCorroborationScore(true, 0)).toBe(40);
    expect(calculateCorroborationScore(false, 100)).toBe(40);
    expect(calculateCorroborationScore(true, 2)).toBe(70);
    expect(calculateCorroborationScore(true, 3)).toBe(85);
    expect(calculateCorroborationScore(true, 4)).toBe(95);

    expect(guide).toContain('assertedConfidence + corroborationNudge + feedbackDelta');
    expect(guide).toContain('80 + 10 - 5 = 85');
    expect(guide).toContain('sourceReliability * 30%');
    expect(guide).toContain('dataCompleteness * 25%');
    expect(guide).toContain('corroboration * 25%');
    expect(guide).toContain('aiConfidence * 20%');
    expect(guide).toMatch(/A successful\s+recalculation clamps the result to 5-100\./);
    expect(guide).toContain('failed best-effort recalculation');
  });

  it('documents that verified signals and graph assertions use different source contracts', () => {
    const evidence = [
      { url: 'https://news.example.com/first', snippet: 'First report' },
      { url: 'https://news.example.com/second', snippet: 'Second report' },
    ];

    const verifiedSignalCount = normalizeVerifiedEvidence(evidence, 'https://vendor.test/announcement')
      .independentPublisherCount;
    const graphSourceCount = computeCorroboration(evidence.map(({ url }) => ({ sourceUrl: url })))
      .independentSourceCount;

    expect(verifiedSignalCount).toBe(1);
    expect(graphSourceCount).toBe(2);
    expect(guide).toContain('There is no universal, system-wide definition of an "independent source."');
    expect(guide).toContain('Different URLs from one publisher count separately.');
    expect(guide).toContain('Contradiction handling is not universal.');
  });

  it('publishes one canonical guide URL and documents the actual rejection window', () => {
    expect(CONFIDENCE_EVIDENCE_GUIDE_URL).toBe(
      'https://github.com/radarist/radarist/blob/main/docs/guides/confidence-evidence-and-feedback.md'
    );
    expect(guide).toMatch(/suppressed for 30 days,\s+regardless of whether new evidence arrives/);
    expect(guide).toMatch(/proposed again even from unchanged evidence/);
  });
});
