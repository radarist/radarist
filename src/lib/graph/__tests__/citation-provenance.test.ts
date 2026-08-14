import {
  filterBundleByWithheldSourceIds,
  parseGraphCitation,
  resolveGraphCitations,
} from '@/lib/graph/citation-provenance';

describe('citation provenance', () => {
  it.each([
    ['internal://radarist-kg/document/doc-1', { collection: 'documents', id: 'doc-1' }],
    ['internal://impulse-signals/signal-1', { collection: 'signals', id: 'signal-1' }],
    ['internal://impulse-graph/legacy-1', { collection: 'impulse-graph', id: 'legacy-1' }],
    ['internal://', { collection: 'internal-unresolved', id: '(missing-reference)' }],
  ])('fails closed when parsing %s', (url, expected) => {
    expect(parseGraphCitation(url)).toEqual(expected);
  });

  it('never lets stale graph presence authorize missing Firestore truth', async () => {
    const report = await resolveGraphCitations(
      [
        { id: 1, url: 'internal://radarist-kg/signal/stale', title: 'stale projection' },
        { id: 2, url: 'https://example.com/current', title: 'web' },
      ],
      async () => ({ state: 'absent' })
    );
    expect(report.eligible.map((source) => source.id)).toEqual([2]);
    expect(report.absent.map((entry) => entry.source.id)).toEqual([1]);
  });

  it('classifies a read failure as unavailable and removes dependent findings', async () => {
    const sources = [
      { id: 1, url: 'internal://radarist-kg/document/unreadable' },
      { id: 2, url: 'https://example.com/current' },
    ];
    const report = await resolveGraphCitations(sources, async () => {
      throw new Error('Firestore unavailable');
    });
    expect(report.unavailable).toHaveLength(1);
    const filtered = filterBundleByWithheldSourceIds(
      { sources, findings: ['Mixed claim [1, 2].', 'Current claim [2].'], unresolved: [] },
      new Set([1])
    );
    expect(filtered.bundle.findings).toEqual(['Current claim [2].']);
    expect(filtered.bundle.sources.map((source) => source.id)).toEqual([2]);
  });
});
