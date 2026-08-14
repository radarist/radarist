/**
 * @file lib/__tests__/entity-document-link-admin.test.ts
 * @description Tests for the admin twin of the entity-document link service.
 *
 * Focus (graph-foundation H6): link mutations must fire the DEDICATED
 * `app/entity-document-link.sync.requested` event. The previous route via
 * `triggerEntitySync('document', linkId, …)` sent the unified entity event,
 * which the unified handler explicitly skips for entityType 'document' —
 * every link sync was silently dropped.
 */

jest.mock('server-only', () => ({}));

const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockGet = jest.fn();
const mockTransactionGet = jest.fn();
const mockTransactionDelete = jest.fn();
const mockTransactionUpdate = jest.fn();
const mockRunTransaction = jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
  callback({ get: mockTransactionGet, delete: mockTransactionDelete, update: mockTransactionUpdate })
);
const mockQueryGet = jest.fn();
const mockQuery = {
  orderBy: jest.fn(),
  where: jest.fn(),
  limit: jest.fn(),
  get: mockQueryGet,
};
const mockDoc = jest.fn((collectionName: string, id: string) => ({
  collectionName,
  id,
  update: mockUpdate,
  delete: mockDelete,
  get: mockGet,
}));
const mockCollection = jest.fn((name: string) => ({
  ...mockQuery,
  doc: (id: string) => mockDoc(name, id),
}));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (name: string) => mockCollection(name),
    runTransaction: (callback: (transaction: unknown) => Promise<unknown>) => mockRunTransaction(callback),
  },
}));

jest.mock('firebase-admin/firestore', () => ({
  Timestamp: {
    now: jest.fn(() => ({ toMillis: () => 1700000000000 })),
    fromMillis: jest.fn((ms: number) => ({ toMillis: () => ms })),
  },
}));

jest.mock('@/lib/document-admin', () => ({
  adminGetDocumentById: jest.fn(),
  adminUpdateDocument: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => handler),
    send: jest.fn(),
  },
}));
jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: jest.fn() },
}));

import { inngest } from '@/lib/inngest/client';
import { inngest as sendOnlyInngest } from '@/lib/inngest/send-client';
import { adminGetDocumentById } from '@/lib/document-admin';
import {
  adminGetLinksWithDocuments,
  adminUpdateEntityDocumentLink,
} from '../entity-document-link-admin';
import * as publicEntityDocumentLinkAdmin from '../entity-document-link-admin';
import {
  adminDeleteEntityDocumentLink,
  adminDeleteLinksForDocument,
  adminDeleteLinksForEntity,
} from '../entity-document-link-delete-admin';

const mockAdminGetDocumentById = adminGetDocumentById as jest.Mock;

function linkSnapshot(
  exists = true,
  overrides: Partial<{
    id: string;
    entityType: string;
    entityId: string;
    documentId: string;
  }> = {}
) {
  return {
    exists,
    id: overrides.id ?? 'link-123',
    data: () =>
      exists
        ? {
            workspaceId: 'workspace-001',
            entityType: overrides.entityType ?? 'technology',
            entityId: overrides.entityId ?? 'tech-456',
            documentId: overrides.documentId ?? 'doc-789',
            relationshipType: 'documentation',
            tags: [],
            relevance: 'high',
            aiSuggested: false,
            createdAt: 1700000000000,
            createdBy: 'user-001',
            updatedAt: 1700000000000,
            graphSyncStatus: 'pending',
          }
        : undefined,
  };
}

let transactionLinkSnapshots = new Map<string, ReturnType<typeof linkSnapshot>>();

describe('entity-document-link-admin graph sync lane (H6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.orderBy.mockReturnValue(mockQuery);
    mockQuery.where.mockReturnValue(mockQuery);
    mockQuery.limit.mockReturnValue(mockQuery);
    mockQueryGet.mockResolvedValue({ docs: [] });
    mockAdminGetDocumentById.mockResolvedValue({ id: 'doc-789', linkedEntityCount: 3 });
    mockUpdate.mockResolvedValue(undefined);
    mockDelete.mockResolvedValue(undefined);
    mockGet.mockResolvedValue(linkSnapshot());
    transactionLinkSnapshots = new Map([['link-123', linkSnapshot()]]);
    mockTransactionGet.mockImplementation(async (ref: { collectionName: string; id: string }) =>
      ref.collectionName === 'entityDocumentLinks'
        ? (transactionLinkSnapshots.get(ref.id) ?? linkSnapshot(false, { id: ref.id }))
        : { exists: true, data: () => ({ linkedEntityCount: 3 }) }
    );
    mockTransactionDelete.mockImplementation((ref: { collectionName: string; id: string }) => {
      if (ref.collectionName === 'entityDocumentLinks') transactionLinkSnapshots.delete(ref.id);
    });
    (inngest.send as jest.Mock).mockResolvedValue({ ids: ['event-1'] });
    (sendOnlyInngest.send as jest.Mock).mockResolvedValue({ ids: ['event-1'] });
  });

  it('preserves the public deletion exports while implementation lives in the leaf', () => {
    expect(publicEntityDocumentLinkAdmin.adminDeleteEntityDocumentLink).toBe(adminDeleteEntityDocumentLink);
    expect(publicEntityDocumentLinkAdmin.adminDeleteLinksForDocument).toBe(adminDeleteLinksForDocument);
    expect(publicEntityDocumentLinkAdmin.adminDeleteLinksForEntity).toBe(adminDeleteLinksForEntity);
  });

  it('update fires the dedicated sync event under a stable replay identity', async () => {
    // GRAPH-069: dispatch moved onto the shared server primitive, which uses
    // the middleware-free send client and supplies a content-derived event id
    // so an exact retry deduplicates instead of re-running the worker.
    await adminUpdateEntityDocumentLink('link-123', { relevance: 'low' });

    expect(sendOnlyInngest.send).toHaveBeenCalledWith({
      id: expect.stringMatching(/^edlh1_[0-9a-f]{64}$/),
      name: 'app/entity-document-link.sync.requested',
      data: { operation: 'update', linkId: 'link-123', entityId: 'tech-456', documentId: 'doc-789' },
    });
  });

  it('delete fires the dedicated sync event carrying the old endpoints', async () => {
    await adminDeleteEntityDocumentLink('link-123');

    expect(sendOnlyInngest.send).toHaveBeenCalledWith({
      name: 'app/entity-document-link.sync.requested',
      data: {
        operation: 'delete',
        linkId: 'link-123',
        entityId: 'tech-456',
        documentId: 'doc-789',
      },
    });
    expect(mockTransactionDelete).toHaveBeenCalled();
    expect(mockTransactionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ collectionName: 'documents', id: 'doc-789' }),
      expect.objectContaining({ linkedEntityCount: 2 })
    );
  });

  it('retains the link when the required graph handoff fails', async () => {
    (sendOnlyInngest.send as jest.Mock).mockResolvedValueOnce({ ids: [] });

    await expect(adminDeleteEntityDocumentLink('link-123')).rejects.toThrow('handoff failed');

    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockTransactionDelete).not.toHaveBeenCalled();
  });

  it('retains the link when its atomic counter transaction fails', async () => {
    mockRunTransaction.mockRejectedValueOnce(new Error('counter failed'));

    await expect(adminDeleteEntityDocumentLink('link-123')).rejects.toThrow('counter failed');

    expect(sendOnlyInngest.send).toHaveBeenCalledTimes(1);
    expect(mockTransactionDelete).not.toHaveBeenCalled();
  });

  it('never routes link syncs through the unified entity event (dead lane)', async () => {
    await adminUpdateEntityDocumentLink('link-123', { relevance: 'low' });

    const eventNames = [
      ...(inngest.send as jest.Mock).mock.calls,
      ...(sendOnlyInngest.send as jest.Mock).mock.calls,
    ].map(([evt]: [{ name: string }]) => evt.name);
    expect(eventNames).not.toContain('app/unified-entity.sync.requested');
    expect(eventNames).toContain('app/entity-document-link.sync.requested');
  });

  it('does not fire a sync event when the link to delete is missing', async () => {
    mockGet.mockResolvedValue(linkSnapshot(false));

    await adminDeleteEntityDocumentLink('missing-link');

    expect(sendOnlyInngest.send).not.toHaveBeenCalled();
  });

  it('enriches worker-side links with the exact original source URL', async () => {
    const originalUrl = 'https://example.com/research/article?id=42#results';
    mockQueryGet.mockResolvedValue({ docs: [linkSnapshot()] });
    mockAdminGetDocumentById.mockResolvedValue({
      id: 'doc-789',
      title: 'Exact source',
      type: 'url',
      status: 'processed',
      originalUrl,
      domain: 'example.com',
    });

    const result = await adminGetLinksWithDocuments('technology', 'tech-456');

    expect(result).toHaveLength(1);
    expect(result[0].document.originalUrl).toBe(originalUrl);
    expect(mockQuery.where).toHaveBeenCalledWith('entityId', '==', 'tech-456');
  });

  it('normalizes painPoint while preserving a same-ID org-unit link', async () => {
    const painLink = linkSnapshot(true, {
      id: 'link-pain',
      entityType: 'pain_point',
      entityId: 'shared-id',
      documentId: 'doc-pain',
    });
    const orgLink = linkSnapshot(true, {
      id: 'link-org',
      entityType: 'org_unit',
      entityId: 'shared-id',
      documentId: 'doc-org',
    });
    mockQueryGet.mockResolvedValue({ docs: [painLink, orgLink] });
    transactionLinkSnapshots = new Map([
      ['link-pain', painLink],
      ['link-org', orgLink],
    ]);

    await expect(adminDeleteLinksForEntity('painPoint', 'shared-id')).resolves.toBe(1);

    expect(transactionLinkSnapshots.has('link-pain')).toBe(false);
    expect(transactionLinkSnapshots.has('link-org')).toBe(true);
  });

  it('deletes document links from both endpoints without deleting same-ID non-document entities', async () => {
    const targetLink = linkSnapshot(true, {
      id: 'link-target',
      entityType: 'technology',
      entityId: 'tech-1',
      documentId: 'doc-a',
    });
    const entityLink = linkSnapshot(true, {
      id: 'link-entity',
      entityType: 'document',
      entityId: 'doc-a',
      documentId: 'doc-b',
    });
    const unrelatedLink = linkSnapshot(true, {
      id: 'link-unrelated',
      entityType: 'company',
      entityId: 'doc-a',
      documentId: 'doc-c',
    });
    const selfLink = linkSnapshot(true, {
      id: 'link-self',
      entityType: 'document',
      entityId: 'doc-a',
      documentId: 'doc-a',
    });
    mockQueryGet
      .mockResolvedValueOnce({ docs: [targetLink, selfLink] })
      .mockResolvedValueOnce({ docs: [entityLink, unrelatedLink, selfLink] });
    transactionLinkSnapshots = new Map(
      [targetLink, entityLink, unrelatedLink, selfLink].map((snapshot) => [snapshot.id, snapshot])
    );

    await expect(adminDeleteLinksForDocument('doc-a')).resolves.toBe(3);

    expect(transactionLinkSnapshots.has('link-target')).toBe(false);
    expect(transactionLinkSnapshots.has('link-entity')).toBe(false);
    expect(transactionLinkSnapshots.has('link-self')).toBe(false);
    expect(transactionLinkSnapshots.has('link-unrelated')).toBe(true);
    expect(mockTransactionDelete).toHaveBeenCalledTimes(3);
  });

  it('uses bounded Admin transactions for more than 500 link deletes', async () => {
    const links = Array.from({ length: 501 }, (_, index) =>
      linkSnapshot(true, {
        id: `link-${index}`,
        entityType: 'technology',
        entityId: 'tech-many',
        documentId: `doc-${index}`,
      })
    );
    mockQueryGet.mockResolvedValue({ docs: links });
    transactionLinkSnapshots = new Map(links.map((snapshot) => [snapshot.id, snapshot]));

    await expect(adminDeleteLinksForEntity('technology', 'tech-many')).resolves.toBe(501);

    expect(mockRunTransaction).toHaveBeenCalledTimes(3);
    expect(mockTransactionDelete).toHaveBeenCalledTimes(501);
  });
});
