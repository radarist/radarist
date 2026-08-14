const mockRows = new Map<string, Array<{ id: string; data: Record<string, unknown> }>>();

interface MockQuery {
  where: jest.Mock<MockQuery, unknown[]>;
  select: jest.Mock<MockQuery, unknown[]>;
  get: jest.Mock<
    Promise<{ docs: Array<{ id: string; data: () => Record<string, unknown> }> }>,
    []
  >;
}

function queryFor(collection: string): MockQuery {
  const query = {} as MockQuery;
  query.where = jest.fn(() => query);
  query.select = jest.fn(() => query);
  query.get = jest.fn(async () => ({
    docs: (mockRows.get(collection) ?? []).map((row) => ({ id: row.id, data: () => row.data })),
  }));
  return query;
}

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn((collection: string) => queryFor(collection)),
  },
}));

import {
  loadEligibleSignalProjectionIds,
  loadReferencedSignalIds,
} from '../signal-projection-policy-admin';

describe('Signal projection policy admin loaders', () => {
  beforeEach(() => {
    mockRows.clear();
    mockRows.set('signals', [
      { id: 'approved', data: { status: 'Approved' } },
      { id: 'relation-retained', data: { status: 'Validated' } },
      { id: 'link-retained', data: { status: 'Rejected' } },
      { id: 'inbox-only', data: { status: 'Detected' } },
    ]);
    mockRows.set('relations', [
      {
        id: 'authoritative-relation-id',
        data: {
          id: 'stale-embedded-relation-id',
          sourceSnapshot: { id: 'relation-retained', type: 'signal' },
          targetSnapshot: { id: 'technology-1', type: 'technology' },
        },
      },
    ]);
    mockRows.set('entityDocumentLinks', [
      {
        id: 'authoritative-link-id',
        data: {
          id: 'stale-embedded-link-id',
          entityType: 'signal',
          entityId: 'link-retained',
        },
      },
    ]);
  });

  it('uses authoritative document IDs when stored payload IDs disagree', async () => {
    await expect(loadReferencedSignalIds()).resolves.toEqual(
      new Map([
        ['relation-retained', [{ id: 'authoritative-relation-id', kind: 'relation-endpoint' }]],
        ['link-retained', [{ id: 'authoritative-link-id', kind: 'document-link' }]],
      ])
    );
  });

  it('returns only direct or reference-required Signals for bulk maintenance', async () => {
    await expect(loadEligibleSignalProjectionIds()).resolves.toEqual([
      'approved',
      'link-retained',
      'relation-retained',
    ]);
  });
});
