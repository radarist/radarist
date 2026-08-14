/**
 * @jest-environment node
 *
 * Focused tests for document-admin (the high-blast, previously-untested admin
 * twin of document-service): field mapping + timestamp coercion, the in-memory
 * filter logic (tags + type-then-status re-filter), and the create/update CRUD.
 */
export {};

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('firebase-admin/firestore', () => ({
  Timestamp: { now: () => ({ toMillis: () => 1_700_000_000_000 }) },
}));

const mockQueryGet = jest.fn();
const mockDocGet = jest.fn();
const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockAdd = jest.fn();
const mockTransactionGet = jest.fn();
const mockTransactionDelete = jest.fn();
const mockTransactionSet = jest.fn();
const mockTransactionUpdate = jest.fn();
let mockStoredLease: Record<string, unknown> | null = null;
const mockRunTransaction = jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
  callback({
    get: mockTransactionGet,
    delete: mockTransactionDelete,
    set: mockTransactionSet,
    update: mockTransactionUpdate,
  })
);
const mockAdminDeleteRelationsForEntity = jest.fn().mockResolvedValue(0);
const mockAdminDeleteLinksForDocument = jest.fn().mockResolvedValue(0);
const mockAdminDeleteChunksForDocument = jest.fn().mockResolvedValue(0);
const mockAdminDeleteStoredDocument = jest.fn().mockResolvedValue({
  storage: 'deleted',
  firestoreFallback: 'absent',
});
const mockInngestSend = jest.fn().mockResolvedValue({ ids: ['event-1'] });

jest.mock('@/lib/relations-cascade-admin', () => ({
  adminDeleteRelationsForEntity: (...args: unknown[]) => mockAdminDeleteRelationsForEntity(...args),
}));
jest.mock('@/lib/entity-document-link-delete-admin', () => ({
  adminDeleteLinksForDocument: (...args: unknown[]) => mockAdminDeleteLinksForDocument(...args),
}));
jest.mock('@/lib/document-chunk-admin', () => ({
  adminDeleteChunksForDocument: (...args: unknown[]) => mockAdminDeleteChunksForDocument(...args),
}));
jest.mock('@/lib/document-storage-admin', () => ({
  adminDeleteStoredDocument: (...args: unknown[]) => mockAdminDeleteStoredDocument(...args),
}));
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));

jest.mock('@/lib/firebase-admin', () => {
  const collection = jest.fn((collectionName: string) => {
    const ref: Record<string, unknown> = {
      get: mockQueryGet,
      add: mockAdd,
      doc: jest.fn((id: string) => ({ collectionName, id, get: mockDocGet, update: mockUpdate })),
    };
    ref.orderBy = jest.fn(() => ref);
    ref.where = jest.fn(() => ref);
    ref.limit = jest.fn(() => ref);
    return ref;
  });
  return { db: { collection, runTransaction: mockRunTransaction } };
});

const {
  adminGetDocumentById,
  adminGetDocumentForDownload,
  adminGetDocuments,
  adminCreateDocument,
  adminUpdateDocument,
  adminDeleteDocument,
  adminDeleteDocuments,
  SYSTEM_DOCUMENT_DELETE_PRINCIPAL,
} = require('../document-admin');

const ts = (ms: number) => ({ toMillis: () => ms });
const docSnap = (data: unknown, id = 'doc-1') => ({ exists: data !== null, id, data: () => data });
const querySnap = (docs: Array<Record<string, unknown>>) => ({
  empty: docs.length === 0,
  size: docs.length,
  docs: docs.map((d, i) => ({ id: (d.id as string) ?? `doc-${i}`, data: () => d, exists: true })),
});

describe('document-admin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStoredLease = null;
    mockAdminDeleteRelationsForEntity.mockResolvedValue(0);
    mockAdminDeleteLinksForDocument.mockResolvedValue(0);
    mockAdminDeleteChunksForDocument.mockResolvedValue(0);
    mockAdminDeleteStoredDocument.mockResolvedValue({ storage: 'deleted', firestoreFallback: 'absent' });
    mockInngestSend.mockResolvedValue({ ids: ['event-1'] });
    mockTransactionGet.mockImplementation(async (ref: { collectionName?: string; id?: string }) => {
      if (ref.collectionName === 'documentDeletionLeases') return docSnap(mockStoredLease, ref.id);
      return mockDocGet();
    });
    mockTransactionSet.mockImplementation((ref: { collectionName?: string }, data: Record<string, unknown>) => {
      if (ref.collectionName === 'documentDeletionLeases') mockStoredLease = data;
    });
    mockTransactionDelete.mockImplementation((ref: { collectionName?: string }) => {
      if (ref.collectionName === 'documentDeletionLeases') mockStoredLease = null;
    });
  });

  describe('adminGetDocumentById', () => {
    it('maps the snapshot to a Document, coercing timestamps and defaulting tags', async () => {
      mockDocGet.mockResolvedValue(
        docSnap(
          { title: 'Doc A', type: 'pdf', status: 'processed', processedAt: ts(1_700_000_500_000) /* no tags */ },
          'd1'
        )
      );
      const doc = await adminGetDocumentById('d1');
      expect(doc).toMatchObject({
        id: 'd1',
        title: 'Doc A',
        type: 'pdf',
        status: 'processed',
        processedAt: 1_700_000_500_000,
        tags: [],
      });
    });

    it('returns null when the document does not exist', async () => {
      mockDocGet.mockResolvedValue(docSnap(null));
      await expect(adminGetDocumentById('missing')).resolves.toBeNull();
    });
  });

  describe('adminGetDocuments (in-memory filters)', () => {
    it('filters by tag in memory', async () => {
      mockQueryGet.mockResolvedValue(
        querySnap([
          { id: 'a', title: 'A', type: 'pdf', status: 'processed', tags: ['x'] },
          { id: 'b', title: 'B', type: 'pdf', status: 'uploaded', tags: ['y'] },
          { id: 'c', title: 'C', type: 'pdf', status: 'processed', tags: ['x', 'z'] },
        ])
      );
      const res = await adminGetDocuments({ tags: ['z'] });
      expect(res.map((d: { id: string }) => d.id)).toEqual(['c']);
    });

    it('re-applies the status filter in memory when type is the primary predicate', async () => {
      mockQueryGet.mockResolvedValue(
        querySnap([
          { id: 'a', type: 'pdf', status: 'processed', tags: [] },
          { id: 'b', type: 'pdf', status: 'uploaded', tags: [] },
        ])
      );
      const res = await adminGetDocuments({ type: 'pdf', status: 'processed' });
      expect(res.map((d: { id: string }) => d.id)).toEqual(['a']);
    });
  });

  describe('write ops', () => {
    it('adminCreateDocument stamps status=uploaded + timestamps and re-reads', async () => {
      mockAdd.mockResolvedValue({ id: 'new-1' });
      mockDocGet.mockResolvedValue(docSnap({ title: 'New', type: 'url', status: 'uploaded', tags: [] }, 'new-1'));
      const created = await adminCreateDocument({ title: 'New', type: 'url', originalUrl: 'http://x' } as never);
      expect(mockAdd).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'uploaded', createdAt: expect.anything(), updatedAt: expect.anything() })
      );
      expect(created).toMatchObject({ id: 'new-1', title: 'New' });
    });

    it('adminUpdateDocument bumps updatedAt and writes via update()', async () => {
      await adminUpdateDocument('d1', { status: 'processed' });
      expect(mockTransactionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ collectionName: 'documents', id: 'd1' }),
        expect.objectContaining({ updatedAt: expect.anything() })
      );
    });

    it('adminDeleteDocument completes every prerequisite before deleting its parent', async () => {
      mockDocGet.mockResolvedValue(
        docSnap(
          {
            title: 'Delete me',
            type: 'pdf',
            status: 'processed',
            storageUrl: 'documents/u/d1.pdf',
            uploadedBy: 'u',
          },
          'd1'
        )
      );
      mockAdminDeleteLinksForDocument.mockResolvedValueOnce(2);

      await expect(adminDeleteDocument('d1', { kind: 'system', expectedOwnerUid: 'u' })).resolves.toBe(true);

      expect(mockAdminDeleteLinksForDocument).toHaveBeenCalledWith('d1');
      expect(mockAdminDeleteChunksForDocument).toHaveBeenCalledWith('d1');
      expect(mockAdminDeleteStoredDocument).toHaveBeenCalledWith('documents/u/d1.pdf', 'u');
      expect(mockTransactionDelete).toHaveBeenCalledTimes(2);
      expect(mockTransactionDelete).toHaveBeenCalledWith(
        expect.objectContaining({ collectionName: 'documents', id: 'd1' })
      );
      expect(mockInngestSend.mock.invocationCallOrder[0]).toBeLessThan(
        mockTransactionDelete.mock.invocationCallOrder[0]
      );
      expect(mockAdminDeleteChunksForDocument.mock.invocationCallOrder[0]).toBeLessThan(
        mockTransactionDelete.mock.invocationCallOrder[0]
      );
    });

    it('retains the Admin document when its link cascade fails', async () => {
      mockDocGet.mockResolvedValue(docSnap({ title: 'Keep me', type: 'pdf', status: 'processed' }, 'd2'));
      mockAdminDeleteLinksForDocument.mockRejectedValueOnce(new Error('link dispatch failed'));

      await expect(adminDeleteDocument('d2', SYSTEM_DOCUMENT_DELETE_PRINCIPAL)).rejects.toThrow('link dispatch failed');

      expect(mockTransactionDelete).not.toHaveBeenCalled();
      expect(mockStoredLease).toMatchObject({ documentId: 'd2', storagePath: '' });
      expect(mockTransactionSet).toHaveBeenCalledTimes(1);
    });

    it('retains the Admin document when chunk cleanup fails', async () => {
      mockDocGet.mockResolvedValue(docSnap({ title: 'Keep me', type: 'pdf', status: 'processed' }, 'd3'));
      mockAdminDeleteChunksForDocument.mockRejectedValueOnce(new Error('chunk cleanup failed'));

      await expect(adminDeleteDocument('d3', SYSTEM_DOCUMENT_DELETE_PRINCIPAL)).rejects.toThrow('chunk cleanup failed');

      expect(mockTransactionDelete).not.toHaveBeenCalled();
    });

    it('retains the parent when required storage cleanup fails', async () => {
      mockDocGet.mockResolvedValue(docSnap({ type: 'pdf', storageUrl: 'documents/u/d4.pdf', uploadedBy: 'u' }, 'd4'));
      mockAdminDeleteStoredDocument.mockRejectedValueOnce(new Error('storage unavailable'));

      await expect(adminDeleteDocument('d4', { kind: 'system', expectedOwnerUid: 'u' })).rejects.toThrow(
        'storage unavailable'
      );

      expect(mockInngestSend).not.toHaveBeenCalled();
      expect(mockTransactionDelete).not.toHaveBeenCalled();
    });

    it('never derives authority for stored content from mutable document fields alone', async () => {
      mockDocGet.mockResolvedValue(
        docSnap({ type: 'pdf', storageUrl: 'documents/victim/d4.pdf', uploadedBy: 'victim' }, 'd4')
      );

      await expect(adminDeleteDocument('d4', SYSTEM_DOCUMENT_DELETE_PRINCIPAL)).rejects.toThrow(
        'authoritative expected owner'
      );

      expect(mockAdminDeleteStoredDocument).not.toHaveBeenCalled();
      expect(mockTransactionDelete).not.toHaveBeenCalled();
    });

    it('refuses a stored document whose owner conflicts with the system caller context', async () => {
      mockDocGet.mockResolvedValue(
        docSnap({ type: 'pdf', storageUrl: 'documents/victim/d4.pdf', uploadedBy: 'victim' }, 'd4')
      );

      await expect(adminDeleteDocument('d4', { kind: 'system', expectedOwnerUid: 'operator' })).rejects.toThrow(
        'Document owner does not match the system deletion context'
      );

      expect(mockAdminDeleteRelationsForEntity).not.toHaveBeenCalled();
      expect(mockAdminDeleteStoredDocument).not.toHaveBeenCalled();
    });

    it('retains the parent unless Inngest durably accepts graph cleanup', async () => {
      mockDocGet.mockResolvedValue(docSnap({ type: 'url', uploadedBy: 'u' }, 'd5'));
      mockInngestSend.mockResolvedValueOnce({ ids: [] });

      await expect(adminDeleteDocument('d5', SYSTEM_DOCUMENT_DELETE_PRINCIPAL)).rejects.toThrow(
        'Inngest accepted no document-delete event'
      );

      expect(mockTransactionDelete).not.toHaveBeenCalled();
    });

    it.each([
      ['absent', null],
      ['foreign', { type: 'url', uploadedBy: 'other-user' }],
      ['ownerless', { type: 'url' }],
    ])('gives a user the same false outcome for an %s record', async (_label: string, data: unknown) => {
      mockDocGet.mockResolvedValue(docSnap(data));

      await expect(adminDeleteDocument('d6', { kind: 'user', uid: 'u' })).resolves.toBe(false);

      expect(mockAdminDeleteRelationsForEntity).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
      expect(mockTransactionDelete).not.toHaveBeenCalled();
    });

    it('leases identity before cleanup so a concurrent canonical mutation cannot cause a foreign cascade', async () => {
      mockDocGet.mockResolvedValue(docSnap({ type: 'pdf', storageUrl: 'documents/u/d7.pdf', uploadedBy: 'u' }, 'd7'));
      mockAdminDeleteRelationsForEntity.mockImplementationOnce(async () => {
        await expect(
          adminUpdateDocument('d7', {
            uploadedBy: 'other',
            storageUrl: 'documents/other/replaced.pdf',
          })
        ).rejects.toThrow('Document deletion is already in progress');
        return 0;
      });

      await expect(adminDeleteDocument('d7', { kind: 'user', uid: 'u' })).resolves.toBe(true);

      expect(mockTransactionUpdate).not.toHaveBeenCalled();
      expect(mockAdminDeleteStoredDocument).toHaveBeenCalledWith('documents/u/d7.pdf', 'u');
      expect(mockTransactionDelete).toHaveBeenCalledWith(
        expect.objectContaining({ collectionName: 'documents', id: 'd7' })
      );
    });

    it('starts no parent transaction when every bulk cascade fails', async () => {
      mockDocGet.mockResolvedValue(docSnap({ title: 'Keep me', type: 'url', uploadedBy: 'u' }, 'd8'));
      mockAdminDeleteLinksForDocument.mockRejectedValue(new Error('link query failed'));

      await expect(adminDeleteDocuments(['d1', 'd2', 'd3'], SYSTEM_DOCUMENT_DELETE_PRINCIPAL)).rejects.toThrow(
        'link query failed'
      );

      expect(mockTransactionDelete).not.toHaveBeenCalled();
    });
  });

  // SEC-015 — the owner-bound content read. The repository, not the route, is
  // where the ownership comparison has to live, so these assert it directly.
  describe('adminGetDocumentForDownload', () => {
    it('authorizes the owner and returns the document plus its authoritative owner', async () => {
      mockDocGet.mockResolvedValue(
        docSnap({ title: 'Owned', type: 'pdf', storageUrl: 'documents/u1/f.pdf', uploadedBy: 'u1' }, 'd1')
      );

      await expect(adminGetDocumentForDownload('d1', 'u1')).resolves.toEqual({
        authorized: true,
        ownerId: 'u1',
        document: expect.objectContaining({ id: 'd1', uploadedBy: 'u1', storageUrl: 'documents/u1/f.pdf' }),
      });
    });

    it('tolerates stored whitespace around the owner uid', async () => {
      mockDocGet.mockResolvedValue(docSnap({ title: 'Owned', type: 'pdf', uploadedBy: '  u1  ' }, 'd1'));

      await expect(adminGetDocumentForDownload('d1', 'u1')).resolves.toMatchObject({
        authorized: true,
        ownerId: 'u1',
      });
    });

    it('refuses a foreign document and returns nothing about it', async () => {
      mockDocGet.mockResolvedValue(
        docSnap({ title: 'Victim file', type: 'pdf', storageUrl: 'documents/u1/f.pdf', uploadedBy: 'u1' }, 'd1')
      );

      const result = await adminGetDocumentForDownload('d1', 'attacker');

      expect(result).toEqual({ authorized: false, reason: 'not-owner' });
      expect(JSON.stringify(result)).not.toContain('Victim file');
      expect(JSON.stringify(result)).not.toContain('documents/u1/f.pdf');
    });

    it('refuses a machine-owned document through the same exact-match rule', async () => {
      mockDocGet.mockResolvedValue(
        docSnap({ title: 'Verdict', type: 'markdown', storageUrl: '', uploadedBy: 'build-mission' }, 'd1')
      );

      await expect(adminGetDocumentForDownload('d1', 'u1')).resolves.toEqual({
        authorized: false,
        reason: 'not-owner',
      });
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['whitespace-only', '   '],
    ])('fails closed on a legacy record whose owner is %s', async (_label, uploadedBy) => {
      mockDocGet.mockResolvedValue(
        docSnap({ title: 'Legacy', type: 'pdf', storageUrl: 'documents/u1/f.pdf', uploadedBy }, 'd1')
      );

      await expect(adminGetDocumentForDownload('d1', 'u1')).resolves.toEqual({
        authorized: false,
        reason: 'ownerless',
      });
    });

    it('reports an absent document as not-found', async () => {
      mockDocGet.mockResolvedValue(docSnap(null, 'missing'));

      await expect(adminGetDocumentForDownload('missing', 'u1')).resolves.toEqual({
        authorized: false,
        reason: 'not-found',
      });
    });

    it('cannot be satisfied by a blank caller uid matching a blank owner', async () => {
      mockDocGet.mockResolvedValue(docSnap({ title: 'Legacy', type: 'pdf', uploadedBy: '' }, 'd1'));

      await expect(adminGetDocumentForDownload('d1', '')).resolves.toEqual({
        authorized: false,
        reason: 'ownerless',
      });
    });
  });
});
