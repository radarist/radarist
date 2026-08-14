import { buildRelationDefaults, defaultRelationConfidence, normalizeConfidence100 } from '../relation-defaults';

describe('buildRelationDefaults', () => {
  it('populates temporal fields with the same ISO timestamp', () => {
    const d = buildRelationDefaults({ source: 'user', assertedBy: 'user:abc' });
    expect(d.t_observed).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(d.t_valid).toBe(d.t_observed);
    expect(d.t_invalidated).toBeNull();
  });

  it('sets aiSuggested=false and confidence=100 for user-asserted relations (0-100 contract)', () => {
    const d = buildRelationDefaults({ source: 'user', assertedBy: 'user:abc' });
    expect(d.aiSuggested).toBe(false);
    expect(d.confidence).toBe(100);
    expect(d.claimStatus).toBe('curated');
    expect(d.assertedBy).toBe('user:abc');
  });

  it('defaults AI-asserted relations with no explicit confidence to 50 (0-100 contract)', () => {
    const d = buildRelationDefaults({ source: 'agent', assertedBy: 'agent:scout' });
    expect(d.aiSuggested).toBe(true);
    expect(d.confidence).toBe(50);
    expect(d.claimStatus).toBe('proposed');
  });

  it('marks AI-asserted relations with aiSuggested=true and proposed status, honoring an explicit confidence', () => {
    const d = buildRelationDefaults({
      source: 'agent',
      assertedBy: 'agent:scout',
      confidence: 75,
    });
    expect(d.aiSuggested).toBe(true);
    expect(d.confidence).toBe(75);
    expect(d.claimStatus).toBe('proposed');
  });

  it('caller properties take precedence over defaults', () => {
    const d = buildRelationDefaults({
      source: 'agent',
      assertedBy: 'agent:x',
      confidence: 60,
      overrides: { notes: 'hand-curated', confidence: 95 },
    });
    expect(d.confidence).toBe(95);
    expect(d.notes).toBe('hand-curated');
  });

  it('includes a relationId UUID', () => {
    const d = buildRelationDefaults({ source: 'user', assertedBy: 'user:a' });
    expect(d.relationId).toMatch(/^rel-/);
  });

  it('mints assertedConfidence and effectiveConfidence equal to resolved confidence (B0 two-field authority)', () => {
    const d = buildRelationDefaults({ source: 'user', assertedBy: 'user:abc' });
    expect(d.assertedConfidence).toBe(100);
    expect(d.effectiveConfidence).toBe(100);
    expect(d.assertedConfidence).toBe(d.confidence);
    expect(d.effectiveConfidence).toBe(d.confidence);
  });

  it('mints assertedConfidence/effectiveConfidence from an explicit confidence value', () => {
    const d = buildRelationDefaults({ source: 'agent', assertedBy: 'agent:scout', confidence: 75 });
    expect(d.assertedConfidence).toBe(75);
    expect(d.effectiveConfidence).toBe(75);
  });

  it('AI-asserted relations with no explicit confidence mint assertedConfidence/effectiveConfidence at 50', () => {
    const d = buildRelationDefaults({ source: 'agent', assertedBy: 'agent:scout' });
    expect(d.assertedConfidence).toBe(50);
    expect(d.effectiveConfidence).toBe(50);
  });
});

describe('defaultRelationConfidence', () => {
  it.each([
    [false, true, 100],
    [true, true, 50],
    [false, false, 1.0],
    [true, false, 0.5],
  ])('aiSuggested=%s, scale100=%s -> %s', (aiSuggested, scale100, expected) => {
    expect(defaultRelationConfidence(aiSuggested, scale100)).toBe(expected);
  });

  it('defaults scale100 from the confidenceScale100Enabled config flag (true by default)', () => {
    expect(defaultRelationConfidence(false)).toBe(100);
    expect(defaultRelationConfidence(true)).toBe(50);
  });
});

describe('normalizeConfidence100', () => {
  it.each([
    [0.85, 85],
    [1, 100],
    [0.005, 1],
    [0, 0],
    [85, 85],
    [100, 100],
  ])('normalizeConfidence100(%s) -> %s', (input, expected) => {
    expect(normalizeConfidence100(input)).toBe(expected);
  });
});
