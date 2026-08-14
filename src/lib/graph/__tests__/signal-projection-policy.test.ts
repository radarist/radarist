import {
  collectSignalProjectionReferences,
  decideSignalProjection,
  DIRECT_SIGNAL_GRAPH_STATUSES,
} from '../signal-projection-policy';

describe('Signal graph projection policy', () => {
  it.each(DIRECT_SIGNAL_GRAPH_STATUSES)('projects %s Signals directly', (status) => {
    expect(decideSignalProjection(status)).toEqual({
      eligible: true,
      reason: 'approved-or-imported',
      references: [],
    });
  });

  it.each(['Detected', 'Validated', 'Rejected', 'Archived', undefined])(
    'keeps an unreferenced %s Signal in the Firestore inbox only',
    (status) => {
      expect(decideSignalProjection(status)).toEqual({ eligible: false, reason: 'inbox-only', references: [] });
    }
  );

  it('retains a downgraded Signal when an authoritative graph record references it', () => {
    expect(
      decideSignalProjection('Rejected', [
        { id: 'rel-2', kind: 'relation-endpoint' },
        { id: 'link-1', kind: 'document-link' },
        { id: 'rel-2', kind: 'relation-endpoint' },
      ])
    ).toEqual({
      eligible: true,
      reason: 'reference-required',
      references: [
        { id: 'link-1', kind: 'document-link' },
        { id: 'rel-2', kind: 'relation-endpoint' },
      ],
    });
  });

  it('does not count blank reference IDs as retention anchors', () => {
    expect(decideSignalProjection('Detected', [{ id: ' ', kind: 'document-link' }]).eligible).toBe(false);
  });

  it('collects only typed Signal endpoints and Signal document links', () => {
    expect(
      collectSignalProjectionReferences({
        relations: [
          {
            id: 'relation-1',
            sourceSnapshot: { id: 'signal-a', type: 'signal' },
            targetSnapshot: { id: 'technology-a', type: 'technology' },
          },
          {
            id: 'relation-2',
            sourceSnapshot: { id: 'signal-a', type: 'company' },
            targetSnapshot: { id: 'signal-b', type: 'signal' },
          },
        ],
        documentLinks: [
          { id: 'link-1', entityType: 'signal', entityId: 'signal-a' },
          { id: 'link-2', entityType: 'company', entityId: 'signal-b' },
          { id: 'link-3', entityType: 'signal', entityId: '' },
        ],
      })
    ).toEqual(
      new Map([
        [
          'signal-a',
          [
            { id: 'relation-1', kind: 'relation-endpoint' },
            { id: 'link-1', kind: 'document-link' },
          ],
        ],
        ['signal-b', [{ id: 'relation-2', kind: 'relation-endpoint' }]],
      ])
    );
  });
});
