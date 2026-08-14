import { proposedAssessmentSchema, generateAssessmentKey, RING_BY_RECOMMENDATION } from '../proposed-assessment';

describe('proposed-assessment schema', () => {
  const base = {
    id: 'abc',
    technologyId: 'tech-1',
    recommendation: 'trial' as const,
    confidence: 75,
    proposedRing: 'Trial',
    sourceRunId: 'mission-1',
    createdAt: 1,
    updatedAt: 1,
  };

  it('parses a minimal proposal and defaults evidence + status', () => {
    const parsed = proposedAssessmentSchema.parse(base);
    expect(parsed.status).toBe('pending');
    expect(parsed.evidence).toEqual({ metrics: [], findings: [] });
  });

  it('rejects confidence out of 0–100 and an unknown recommendation', () => {
    expect(() => proposedAssessmentSchema.parse({ ...base, confidence: 120 })).toThrow();
    expect(() => proposedAssessmentSchema.parse({ ...base, recommendation: 'maybe' })).toThrow();
  });

  it('generateAssessmentKey is deterministic per (technology, run) and differs across inputs', () => {
    const a = generateAssessmentKey('tech-1', 'mission-1');
    expect(generateAssessmentKey('tech-1', 'mission-1')).toBe(a);
    expect(generateAssessmentKey('tech-2', 'mission-1')).not.toBe(a);
    expect(generateAssessmentKey('tech-1', 'mission-2')).not.toBe(a);
    expect(a).toHaveLength(32);
  });

  it('RING_BY_RECOMMENDATION maps every recommendation to a canonical ring', () => {
    expect(RING_BY_RECOMMENDATION).toEqual({ adopt: 'Adopt', trial: 'Trial', assess: 'Assess', hold: 'Hold' });
  });
});
