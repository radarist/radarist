/**
 * @jest-environment node
 *
 * Atomic create contract for the server-side entity-document-link service.
 * The in-memory Firestore double serializes transactions and commits their
 * writes atomically so these tests exercise the concurrency boundary rather
 * than merely asserting individual SDK calls.
 */

jest.mock('server-only', () => ({}));

type StoredData = Record<string, unknown>;
type StoredCollections = Map<string, Map<string, StoredData>>;

const mockCollections: StoredCollections = new Map();
const mockInngestSend = jest.fn();
const mockRecordAnchor = jest.fn();
const mockRunTransaction = jest.fn();
let mockFailDocumentCounterCommit = false;
let mockTransactionTail: Promise<void> = Promise.resolve();

function collectionStore(name: string): Map<string, StoredData> {
  let collection = mockCollections.get(name);
  if (!collection) {
    collection = new Map();
    mockCollections.set(name, collection);
  }
  return collection;
}

function snapshot(collectionName: string, id: string) {
  const data = collectionStore(collectionName).get(id);
  return {
    exists: data !== undefined,
    id,
    data: () => data,
  };
}

interface MockDocumentReference {
  collectionName: string;
  id: string;
  get: () => Promise<ReturnType<typeof snapshot>>;
}

function documentReference(collectionName: string, id: string): MockDocumentReference {
  return {
    collectionName,
    id,
    get: async () => snapshot(collectionName, id),
  };
}

function queryFor(
  collectionName: string,
  filters: readonly { field: string; value: unknown }[] = [],
  resultLimit?: number
) {
  const query = {
    where: (field: string, _operator: string, value: unknown) =>
      queryFor(collectionName, [...filters, { field, value }], resultLimit),
    limit: (limit: number) => queryFor(collectionName, filters, limit),
    orderBy: () => query,
    get: async () => {
      const docs = [...collectionStore(collectionName).entries()]
        .filter(([, data]) => filters.every(({ field, value }) => data[field] === value))
        .slice(0, resultLimit)
        .map(([id]) => snapshot(collectionName, id));
      return { empty: docs.length === 0, docs };
    },
  };
  return query;
}

function collectionReference(name: string) {
  const query = queryFor(name);
  return {
    ...query,
    doc: (id: string) => documentReference(name, id),
  };
}

function cloneCollections(): StoredCollections {
  return new Map(
    [...mockCollections.entries()].map(([collectionName, documents]) => [
      collectionName,
      new Map([...documents.entries()].map(([id, data]) => [id, { ...data }])),
    ])
  );
}

async function runSerializedTransaction<T>(
  callback: (transaction: {
    get: (ref: MockDocumentReference) => Promise<ReturnType<typeof snapshot>>;
    getAll: (...refs: MockDocumentReference[]) => Promise<Array<ReturnType<typeof snapshot>>>;
    set: (ref: MockDocumentReference, data: StoredData) => void;
    update: (ref: MockDocumentReference, data: StoredData) => void;
  }) => Promise<T>
): Promise<T> {
  const predecessor = mockTransactionTail;
  let release!: () => void;
  mockTransactionTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;

  try {
    const writes: Array<{
      kind: 'set' | 'update';
      ref: MockDocumentReference;
      data: StoredData;
    }> = [];
    const result = await callback({
      get: async (ref) => snapshot(ref.collectionName, ref.id),
      getAll: async (...refs) => refs.map((ref) => snapshot(ref.collectionName, ref.id)),
      set: (ref, data) => writes.push({ kind: 'set', ref, data }),
      update: (ref, data) => writes.push({ kind: 'update', ref, data }),
    });

    if (
      mockFailDocumentCounterCommit &&
      writes.some(({ kind, ref }) => kind === 'update' && ref.collectionName === 'documents')
    ) {
      throw new Error('counter update failed');
    }

    const committed = cloneCollections();
    for (const { kind, ref, data } of writes) {
      const documents = committed.get(ref.collectionName) ?? new Map<string, StoredData>();
      committed.set(ref.collectionName, documents);
      if (kind === 'update' && !documents.has(ref.id)) {
        throw new Error(`No document to update: ${ref.collectionName}/${ref.id}`);
      }
      documents.set(ref.id, kind === 'update' ? { ...documents.get(ref.id), ...data } : { ...data });
    }
    mockCollections.clear();
    for (const [name, documents] of committed) mockCollections.set(name, documents);
    return result;
  } finally {
    release();
  }
}

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (name: string) => collectionReference(name),
    runTransaction: (...args: unknown[]) => mockRunTransaction(...args),
  },
}));

jest.mock('firebase-admin/firestore', () => ({
  Timestamp: {
    now: jest.fn(() => ({ toMillis: () => 1_700_000_000_000 })),
    fromMillis: jest.fn((millis: number) => ({ toMillis: () => millis })),
  },
}));

jest.mock('@/lib/document-admin', () => ({
  adminGetDocumentById: jest.fn(),
  adminUpdateDocument: jest.fn(),
}));

jest.mock('@/lib/entity-document-link-delete-admin', () => ({
  adminDeleteEntityDocumentLink: jest.fn(),
  adminDeleteLinksForDocument: jest.fn(),
  adminDeleteLinksForEntity: jest.fn(),
  adminFirestoreToEntityDocumentLink: (doc: ReturnType<typeof snapshot>) => {
    if (!doc.exists) return null;
    const data = doc.data()!;
    return {
      id: doc.id,
      ...data,
      createdAt:
        typeof (data.createdAt as { toMillis?: () => number } | undefined)?.toMillis === 'function'
          ? (data.createdAt as { toMillis: () => number }).toMillis()
          : data.createdAt,
      updatedAt:
        typeof (data.updatedAt as { toMillis?: () => number } | undefined)?.toMillis === 'function'
          ? (data.updatedAt as { toMillis: () => number }).toMillis()
          : data.updatedAt,
    };
  },
}));

// GRAPH-069 moved link dispatch onto the shared server primitive, which uses
// the middleware-free send client. Both are stubbed so a regression back to the
// old lane shows up as an unexpected call rather than a silent pass.
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));
jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));
jest.mock('@/lib/entity-graph-sync-outbox-admin', () => ({
  recordEntityGraphSyncAnchor: (...args: unknown[]) => mockRecordAnchor(...args),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import type { CreateEntityDocumentLinkInput } from '@/lib/types';
import { adminCreateEntityDocumentLink } from '../entity-document-link-admin';

const baseInput: CreateEntityDocumentLinkInput = {
  workspaceId: 'default',
  entityType: 'technology',
  entityId: 'tech-a',
  documentId: 'doc-shared',
  relationshipType: 'documentation',
  tags: [],
  relevance: 'high',
  aiSuggested: false,
  createdBy: 'user-1',
};

function seedDocument(id = baseInput.documentId, linkedEntityCount = 0): void {
  collectionStore('documents').set(id, {
    id,
    title: 'Atomic link contract',
    linkedEntityCount,
  });
}

function links(): Array<[string, StoredData]> {
  return [...collectionStore('entityDocumentLinks').entries()];
}

describe('adminCreateEntityDocumentLink atomic create contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCollections.clear();
    mockFailDocumentCounterCommit = false;
    mockTransactionTail = Promise.resolve();
    mockRunTransaction.mockImplementation(runSerializedTransaction);
    mockInngestSend.mockResolvedValue({ ids: ['sync-1'] });
    mockRecordAnchor.mockResolvedValue({ generation: 'c'.repeat(32) });
    seedDocument();
  });

  it('lets exactly one of two concurrent identical creates win', async () => {
    const outcomes = await Promise.allSettled([
      adminCreateEntityDocumentLink(baseInput),
      adminCreateEntityDocumentLink(baseInput),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejection = outcomes.find(({ status }) => status === 'rejected') as PromiseRejectedResult;
    expect(rejection.reason).toEqual(expect.objectContaining({ message: expect.stringContaining('Link already exists') }));
    expect(links()).toHaveLength(1);
    expect(collectionStore('documents').get(baseInput.documentId)?.linkedEntityCount).toBe(1);
    expect(mockInngestSend).toHaveBeenCalledTimes(1);
    expect(mockInngestSend).toHaveBeenCalledWith({
      id: expect.stringMatching(/^edlh1_[0-9a-f]{64}$/),
      name: 'app/entity-document-link.sync.requested',
      data: {
        operation: 'create',
        linkId: expect.stringMatching(/^edl1_/),
        entityId: baseInput.entityId,
        documentId: baseInput.documentId,
      },
    });
  });

  it('increments without a lost update for concurrent distinct links to one document', async () => {
    await Promise.all([
      adminCreateEntityDocumentLink({ ...baseInput, entityId: 'tech-a' }),
      adminCreateEntityDocumentLink({ ...baseInput, entityId: 'tech-b' }),
    ]);

    expect(links()).toHaveLength(2);
    expect(collectionStore('documents').get(baseInput.documentId)?.linkedEntityCount).toBe(2);
    expect(mockInngestSend).toHaveBeenCalledTimes(2);
  });

  it('rolls back the link when the document counter update cannot commit', async () => {
    mockFailDocumentCounterCommit = true;

    await expect(adminCreateEntityDocumentLink(baseInput)).rejects.toThrow('counter update failed');

    expect(links()).toHaveLength(0);
    expect(collectionStore('documents').get(baseInput.documentId)?.linkedEntityCount).toBe(0);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('fails atomically when the linked document does not exist', async () => {
    collectionStore('documents').delete(baseInput.documentId);

    await expect(adminCreateEntityDocumentLink(baseInput)).rejects.toThrow('Cannot link missing document');

    expect(links()).toHaveLength(0);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('fails closed on an oversized deterministic identity before any transaction or event', async () => {
    await expect(
      adminCreateEntityDocumentLink({ ...baseInput, entityId: `tech-${'x'.repeat(2_000)}` })
    ).rejects.toThrow('Firestore document IDs allow at most 1500');

    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(links()).toHaveLength(0);
    expect(collectionStore('documents').get(baseInput.documentId)?.linkedEntityCount).toBe(0);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('returns the committed record and an honest pending handoff when dispatch is unavailable', async () => {
    mockInngestSend.mockRejectedValueOnce(new Error('inngest unavailable'));

    // GRAPH-069: the link IS committed, so the create must not throw — but it
    // must also not claim the projection happened, and it must leave a durable
    // recovery anchor behind.
    await expect(adminCreateEntityDocumentLink(baseInput)).resolves.toMatchObject({
      link: {
        id: expect.stringMatching(/^edl1_/),
        entityId: baseInput.entityId,
        documentId: baseInput.documentId,
        graphSyncStatus: 'pending',
      },
      graphHandoff: { status: 'pending-reconciliation', anchorRecorded: true },
    });
    expect(mockRecordAnchor).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'entityDocumentLink', operation: 'create' })
    );
    expect(links()).toHaveLength(1);
    expect(collectionStore('documents').get(baseInput.documentId)?.linkedEntityCount).toBe(1);
  });

  it('preserves recognizable duplicate errors for legacy random-ID links', async () => {
    collectionStore('entityDocumentLinks').set('legacy-other-type', {
      ...baseInput,
      entityType: 'company',
      graphSyncStatus: 'pending',
      createdAt: { toMillis: () => 1_700_000_000_000 },
      updatedAt: { toMillis: () => 1_700_000_000_000 },
    });
    collectionStore('entityDocumentLinks').set('legacy-random-link-id', {
      ...baseInput,
      graphSyncStatus: 'pending',
      createdAt: { toMillis: () => 1_700_000_000_000 },
      updatedAt: { toMillis: () => 1_700_000_000_000 },
    });

    await expect(adminCreateEntityDocumentLink(baseInput)).rejects.toThrow(
      'Link already exists between technology:tech-a and document:doc-shared (ID: legacy-random-link-id)'
    );
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(collectionStore('documents').get(baseInput.documentId)?.linkedEntityCount).toBe(0);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('makes a later retry converge through the existing-link query', async () => {
    const { link: created } = await adminCreateEntityDocumentLink(baseInput);

    await expect(adminCreateEntityDocumentLink(baseInput)).rejects.toThrow(`Link already exists`);

    expect(created.id).toMatch(/^edl1_/);
    expect(links().map(([id]) => id)).toEqual([created.id]);
    expect(collectionStore('documents').get(baseInput.documentId)?.linkedEntityCount).toBe(1);
    expect(mockInngestSend).toHaveBeenCalledTimes(1);
  });
});
