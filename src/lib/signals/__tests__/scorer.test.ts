import { scoreSignal } from '../scorer';
import type { Signal } from '@/lib/types';

const baseSignal = (overrides: Partial<Signal> = {}): Signal =>
  ({
    id: 's-1',
    slug: 's-1',
    type: 'news',
    title: '',
    description: '',
    status: 'Detected',
    detectedAt: Date.now(),
    ...overrides,
  }) as Signal;

describe('scoreSignal', () => {
  it('returns overall=0 when signal has neither title nor description', () => {
    const result = scoreSignal(baseSignal({ title: '', description: '' }));
    expect(result.overall).toBe(0);
    expect(result.factors).toContain('no-content');
  });

  it('rewards strong source reliability (patent > news)', () => {
    const patentSig = baseSignal({
      title: 'Method for distributed ledger consensus',
      description:
        'A patent describing a novel consensus protocol with full technical claims covering the approach in enough detail to be a verifiable signal for tracking.',
      type: 'patent',
    });
    const newsSig = { ...patentSig, type: 'news' as const };
    const p = scoreSignal(patentSig);
    const n = scoreSignal(newsSig);
    expect(p.breakdown.sourceReliability).toBeGreaterThan(n.breakdown.sourceReliability);
    expect(p.overall).toBeGreaterThan(n.overall);
  });

  it('caps overall score at 100 and floors at 0', () => {
    const mega = scoreSignal(
      baseSignal({
        title: 'X'.repeat(500),
        description: 'Y'.repeat(5000),
        type: 'paper',
        url: 'https://arxiv.org/abs/1234',
      })
    );
    expect(mega.overall).toBeLessThanOrEqual(100);
    expect(mega.overall).toBeGreaterThan(0);
    const empty = scoreSignal(baseSignal({ title: '', description: '' }));
    expect(empty.overall).toBe(0);
  });

  it('provides a TrustScore object with all required breakdown fields', () => {
    const r = scoreSignal(
      baseSignal({
        title: 'Something',
        description:
          'A moderately long description that should put this in the medium band for data completeness scoring.',
        type: 'news',
      })
    );
    expect(r).toHaveProperty('overall');
    expect(r).toHaveProperty('breakdown.sourceReliability');
    expect(r).toHaveProperty('breakdown.dataCompleteness');
    expect(r).toHaveProperty('breakdown.corroboration');
    expect(r).toHaveProperty('breakdown.aiConfidence');
    expect(Array.isArray(r.factors)).toBe(true);
  });

  it('elevates breakdown.aiConfidence when description crosses length thresholds', () => {
    // short description → low-tier aiConfidence
    const short = scoreSignal(
      baseSignal({
        title: 'Short',
        description: 'Under eighty chars.',
        type: 'news',
      })
    );
    // medium description (title >= 20 chars + description >= 80 chars) → mid-tier
    const medium = scoreSignal(
      baseSignal({
        title: 'Medium title long enough',
        description: 'X'.repeat(100),
        type: 'news',
      })
    );
    // long description (>= 300 chars) → top-tier
    const long = scoreSignal(
      baseSignal({
        title: 'Long title long enough',
        description: 'X'.repeat(400),
        type: 'news',
      })
    );
    expect(short.breakdown.aiConfidence).toBeLessThan(medium.breakdown.aiConfidence);
    expect(medium.breakdown.aiConfidence).toBeLessThan(long.breakdown.aiConfidence);
  });

  it('does not treat linked entities as evidence sources', () => {
    const noLinks = scoreSignal(
      baseSignal({
        title: 'Isolated signal',
        description: 'A description that lives alone without known connections.',
        type: 'news',
      })
    );
    const withLinkedEntities = scoreSignal(
      baseSignal({
        title: 'Well-corroborated signal',
        description: 'A description that lives alone without known connections.',
        type: 'news',
        linkedEntities: { technologies: ['tech-1'], companies: ['co-1', 'co-2'], useCases: [] },
      })
    );
    const withLinkedEntityIds = scoreSignal(
      baseSignal({
        title: 'Well-corroborated signal',
        description: 'A description that lives alone without known connections.',
        type: 'news',
        linkedEntityIds: ['ent-1', 'ent-2', 'ent-3'],
      } as never)
    );
    expect(withLinkedEntities.breakdown.corroboration).toBe(noLinks.breakdown.corroboration);
    expect(withLinkedEntityIds.breakdown.corroboration).toBe(noLinks.breakdown.corroboration);
  });

  it('counts only distinct confirming URLs as corroboration', () => {
    const common = {
      title: 'A corroborated signal',
      description: 'A sufficiently detailed signal description.',
      type: 'news' as const,
      url: 'https://original.example/claim',
      source: 'Original',
    };
    const single = scoreSignal(baseSignal(common));
    const duplicateAndCounterEvidence = scoreSignal(
      baseSignal({
        ...common,
        expandedContent: {
          sources: [
            {
              title: 'Duplicate',
              url: 'https://original.example/claim?utm_source=search',
              verdict: 'confirming',
            },
            { title: 'Counter', url: 'https://counter.example/claim', verdict: 'contradicting' },
            { title: 'Unclear', url: 'https://unclear.example/claim', verdict: 'inconclusive' },
          ],
          expandedAt: 1,
          expansionModel: 'test',
          expansionDuration: 1,
        },
      })
    );
    const twoConfirming = scoreSignal(
      baseSignal({
        ...common,
        expandedContent: {
          sources: [{ title: 'Independent', url: 'https://second.example/claim', verdict: 'confirming' }],
          expandedAt: 1,
          expansionModel: 'test',
          expansionDuration: 1,
        },
      })
    );

    expect(single.breakdown.corroboration).toBe(40);
    expect(duplicateAndCounterEvidence.breakdown.corroboration).toBe(40);
    expect(twoConfirming.breakdown.corroboration).toBe(70);
  });
});
