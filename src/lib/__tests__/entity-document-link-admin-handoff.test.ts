/**
 * @file lib/__tests__/entity-document-link-admin-handoff.test.ts
 * @description GRAPH-069 — the admin repository must route create AND update
 * through the same server-owned handoff primitive and report the honest result.
 *
 * The regression these lock down: `adminCreateEntityDocumentLink` returned the
 * link unchanged when `syncQueued` was false, so an Assistant tool answered
 * "Linked X to Y" for a link the graph never heard about.
 */

jest.mock('server-only', () => ({}));

const mockUpdate = jest.fn();
const mockGet = jest.fn();
const mockTransactionGet = jest.fn();
const mockTransactionSet = jest.fn();
const mockTransactionUpdate = jest.fn();
const mockRunTransaction = jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
  callback({
    get: mockTransactionGet,
    getAll: (...refs: unknown[]) => Promise.all(refs.map((ref) => mockTransactionGet(ref))),
    set: mockTransactionSet,
    update: mockTransactionUpdate,
  })
);
const mockQueryGet = jest.fn();
const mockQuery = { orderBy: jest.fn(), where: jest.fn(), limit: jest.fn(), get: mockQueryGet };
const mockDoc = jest.fn((collectionName: string, id: string) => ({
  collectionName,
  id,
  update: mockUpdate,
  get: mockGet,
}));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (name: string) => ({ ...mockQuery, doc: (id: string) => mockDoc(name, id) }),
    runTransaction: (callback: (transaction: unknown) => Promise<unknown>) => mockRunTransaction(callback),
  },
}));
jest.mock('firebase-admin/firestore', () => ({
  Timestamp: {
    now: jest.fn(() => ({ toMillis: () => 1_700_000_000_000 })),
    fromMillis: jest.fn((ms: number) => ({ toMillis: () => ms })),
  },
}));
jest.mock('@/lib/document-admin', () => ({
  adminGetDocumentById: jest.fn(async () => ({ id: 'doc-789', linkedEntityCount: 1 })),
  adminUpdateDocument: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const deliverEntityDocumentLinkGraphHandoffServer = jest.fn();
jest.mock('@/lib/entity-document-link-sync-server', () => ({
  deliverEntityDocumentLinkGraphHandoffServer: (...args: unknown[]) =>
    deliverEntityDocumentLinkGraphHandoffServer(...args),
  requestEntityDocumentLinkGraphDeletionServer: jest.fn(),
  requestEntityDocumentLinkGraphDeletionsServer: jest.fn(),
}));

// The old lane. If anything reintroduces a direct, unacknowledged send from an
// admin write path, these blow up rather than silently regressing.
const directClientSend = jest.fn(() => {
  throw new Error('admin link writes must dispatch through the shared handoff primitive');
});
jest.mock('@/lib/inngest/client', () => ({
  inngest: { createFunction: jest.fn(), send: directClientSend },
}));
jest.mock('@/lib/inngest/send-client', () => ({ inngest: { send: directClientSend } }));

import { adminCreateEntityDocumentLink, adminUpdateEntityDocumentLink } from '../entity-document-link-admin';

const STORED = {
  workspaceId: 'default',
  entityType: 'technology',
  entityId: 'tech-456',
  documentId: 'doc-789',
  relationshipType: 'documentation',
  tags: [],
  relevance: 'high',
  aiSuggested: false,
  createdBy: 'user-001',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  graphSyncStatus: 'pending',
};

const CREATE_INPUT = {
  workspaceId: 'default',
  entityType: 'technology' as const,
  entityId: 'tech-456',
  documentId: 'doc-789',
  relationshipType: 'documentation' as const,
  tags: [],
  relevance: 'high' as const,
  aiSuggested: false,
  createdBy: 'user-001',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.orderBy.mockReturnValue(mockQuery);
  mockQuery.where.mockReturnValue(mockQuery);
  mockQuery.limit.mockReturnValue(mockQuery);
  mockQueryGet.mockResolvedValue({ empty: true, docs: [] });
  mockGet.mockResolvedValue({ exists: true, id: 'link-123', data: () => STORED });
  mockUpdate.mockResolvedValue(undefined);
  mockTransactionGet.mockImplementation(async (ref: { collectionName: string }) =>
    ref.collectionName === 'entityDocumentLinks'
      ? { exists: false, data: () => undefined }
      : { exists: true, data: () => ({ linkedEntityCount: 1 }) }
  );
  deliverEntityDocumentLinkGraphHandoffServer.mockResolvedValue({ status: 'acknowledged' });
});

describe('adminCreateEntityDocumentLink graph handoff', () => {
  it('hands the committed link to the shared server primitive', async () => {
    const result = await adminCreateEntityDocumentLink(CREATE_INPUT);

    expect(result.link.entityId).toBe('tech-456');
    expect(result.graphHandoff).toEqual({ status: 'acknowledged' });
    expect(deliverEntityDocumentLinkGraphHandoffServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: result.link.id, entityId: 'tech-456', documentId: 'doc-789' }),
      'create'
    );
    expect(directClientSend).not.toHaveBeenCalled();
  });

  it('reports pending-reconciliation rather than a bare committed link', async () => {
    deliverEntityDocumentLinkGraphHandoffServer.mockResolvedValue({
      status: 'pending-reconciliation',
      reason: 'queue unavailable',
      anchorRecorded: true,
    });

    const result = await adminCreateEntityDocumentLink(CREATE_INPUT);

    expect(result.link.entityId).toBe('tech-456');
    expect(result.graphHandoff).toMatchObject({ status: 'pending-reconciliation', anchorRecorded: true });
  });
});

describe('adminUpdateEntityDocumentLink graph handoff', () => {
  it('uses the same primitive with the update operation and the re-read row', async () => {
    const result = await adminUpdateEntityDocumentLink('link-123', { relevance: 'low' });

    expect(mockUpdate).toHaveBeenCalled();
    expect(deliverEntityDocumentLinkGraphHandoffServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'link-123', entityId: 'tech-456', documentId: 'doc-789' }),
      'update'
    );
    expect(result.graphHandoff).toEqual({ status: 'acknowledged' });
    expect(directClientSend).not.toHaveBeenCalled();
  });

  it('refuses the handoff when the row vanished between commit and read-back', async () => {
    mockGet.mockResolvedValue({ exists: false, id: 'link-123', data: () => undefined });

    const result = await adminUpdateEntityDocumentLink('link-123', { relevance: 'low' });

    expect(result.graphHandoff.status).toBe('refused');
    expect(deliverEntityDocumentLinkGraphHandoffServer).not.toHaveBeenCalled();
  });
});
