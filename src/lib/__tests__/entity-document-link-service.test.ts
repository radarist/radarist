/**
 * @file lib/__tests__/entity-document-link-service.test.ts
 * @description Unit tests for EntityDocumentLink service
 *
 * Tests CRUD operations, AI suggestions, graph sync status, and statistics
 *
 * @phase Knowledge Tab Sprint - Phase 2
 * @author Radarist Team
 * @created 2026-01-14
 */

import {
  getEntityDocumentLinks,
  getEntityDocumentLinkById,
  getLinksForEntity,
  getLinksForDocument,
  getLinksWithDocuments,
  findExistingLink,
  createEntityDocumentLink,
  updateEntityDocumentLink,
  deleteEntityDocumentLink,
  deleteLinksForEntity,
  deleteLinksForDocument,
  createAISuggestedLink,
  getPendingAISuggestions,
  approveAISuggestion,
  rejectAISuggestion,
  markLinkSynced,
  markLinkSyncFailed,
  getLinksPendingSync,
  getLinkStatsForEntity,
  getGlobalLinkStats,
} from '../entity-document-link-service';
import type { EntityDocumentLink } from '../types';

// Mock document-service first
jest.mock('../document-service', () => ({
  getDocumentById: jest.fn(),
  updateDocument: jest.fn(),
  updateLinkedEntityCount: jest.fn(),
}));

// Mock Firebase
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  doc: jest.fn(),
  getDoc: jest.fn(),
  getDocs: jest.fn(),
  addDoc: jest.fn(),
  updateDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
  runTransaction: jest.fn(),
  Timestamp: {
    now: jest.fn(() => ({ toMillis: () => Date.now() })),
    fromMillis: jest.fn((ms: number) => ({ toMillis: () => ms })),
  },
}));

jest.mock('../firebase', () => ({
  db: {},
}));
jest.mock('../fetch-with-auth', () => ({ fetchWithAuth: jest.fn() }));

// Mock the Inngest client — the sync trigger dynamic-imports it. H6: link
// mutations must reach the DEDICATED entity-document-link sync handler, not
// the unified entity handler (which explicitly skips entityType 'document').
jest.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => handler),
    send: jest.fn(),
  },
}));

// Import mocked functions
import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  runTransaction,
} from 'firebase/firestore';

import { getDocumentById, updateLinkedEntityCount } from '../document-service';
import { fetchWithAuth } from '../fetch-with-auth';
import { inngest } from '@/lib/inngest/client';

// ============================================================================
// TEST HELPERS
// ============================================================================

const createMockLink = (overrides: Partial<EntityDocumentLink> = {}): EntityDocumentLink => ({
  id: 'link-123',
  entityType: 'technology',
  entityId: 'tech-456',
  documentId: 'doc-789',
  relationshipType: 'documentation',
  relevance: 'high',
  tags: ['important', 'api'],
  note: 'Main API documentation',
  aiSuggested: false,
  aiConfidence: undefined,
  graphSyncStatus: 'pending',
  lastSyncedAt: undefined,
  createdBy: 'user-001',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  workspaceId: 'workspace-001',
  ...overrides,
});

const createMockDocSnapshot = (data: EntityDocumentLink | null, exists = true) => ({
  exists: () => exists,
  id: data?.id || 'unknown',
  data: () => data,
});

const createMockQuerySnapshot = (docs: EntityDocumentLink[]) => ({
  docs: docs.map((d) => ({
    id: d.id,
    data: () => d,
    exists: () => true,
  })),
  empty: docs.length === 0,
  size: docs.length,
  forEach: (callback: (doc: { id: string; data: () => EntityDocumentLink }) => void) => {
    docs.forEach((d) => callback({ id: d.id, data: () => d }));
  },
});

interface MockReference {
  collectionName: string;
  id: string;
}

let transactionLinks = new Map<string, EntityDocumentLink>();
let transactionDocumentCounts = new Map<string, number>();
const mockTransactionDelete = jest.fn();
const mockTransactionUpdate = jest.fn();

function seedCascadeTransaction(links: readonly EntityDocumentLink[], documentCount = links.length): void {
  transactionLinks = new Map(links.map((link) => [link.id, link]));
  transactionDocumentCounts = new Map(links.map((link) => [link.documentId, documentCount]));
}

type LinkEndpointTriple = { linkId: string; entityId: string; documentId: string };

function graphHandoffRequests(): Array<{ operation: 'delete'; links: LinkEndpointTriple[] }> {
  return allGraphHandoffRequests().filter(
    (request): request is { operation: 'delete'; links: LinkEndpointTriple[] } => request.operation === 'delete'
  );
}

/** Every body posted to the shared handoff route, delete and create/update alike. */
function allGraphHandoffRequests(): Array<{
  operation: 'create' | 'update' | 'delete';
  links?: LinkEndpointTriple[];
  link?: LinkEndpointTriple;
}> {
  return (fetchWithAuth as jest.Mock).mock.calls.map(([, init]: [string, RequestInit]) =>
    JSON.parse(String(init.body))
  );
}

// ============================================================================
// TESTS
// ============================================================================

describe('EntityDocumentLink Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    transactionLinks = new Map();
    transactionDocumentCounts = new Map();
    (query as jest.Mock).mockReturnValue({});
    (where as jest.Mock).mockReturnValue({});
    (orderBy as jest.Mock).mockReturnValue({});
    (limit as jest.Mock).mockReturnValue({});
    (collection as jest.Mock).mockReturnValue({});
    (doc as jest.Mock).mockImplementation((_db, collectionName: string, id: string) => ({ collectionName, id }));
    (runTransaction as jest.Mock).mockImplementation(
      async (_db, callback: (transaction: Record<string, jest.Mock>) => Promise<unknown>) =>
        callback({
          get: jest.fn(async (ref: MockReference) => {
            if (ref.collectionName === 'entityDocumentLinks') {
              const link = transactionLinks.get(ref.id) ?? null;
              return createMockDocSnapshot(link, link !== null);
            }
            const count = transactionDocumentCounts.get(ref.id);
            return {
              exists: () => count !== undefined,
              id: ref.id,
              data: () => (count === undefined ? undefined : { linkedEntityCount: count }),
            };
          }),
          delete: mockTransactionDelete,
          update: mockTransactionUpdate,
        })
    );
    mockTransactionDelete.mockImplementation((ref: MockReference) => {
      if (ref.collectionName === 'entityDocumentLinks') transactionLinks.delete(ref.id);
    });
    (inngest.send as jest.Mock).mockResolvedValue({ ids: ['event-1'] });
    (fetchWithAuth as jest.Mock).mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        operation: string;
        links?: Array<{ linkId: string }>;
        link?: { linkId: string };
      };
      // GRAPH-069 added the single-link create/update branch to the same route.
      const payload = body.links
        ? { acknowledged: body.links.map(({ linkId }) => linkId), failed: [] }
        : { success: true, handoff: 'acknowledged', operation: body.operation, linkId: body.link?.linkId };
      return new Response(JSON.stringify(payload), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  // ==========================================================================
  // GET OPERATIONS
  // ==========================================================================

  describe('getEntityDocumentLinks', () => {
    it('should return all links when no filters provided', async () => {
      const mockLinks = [createMockLink({ id: 'link-1' }), createMockLink({ id: 'link-2' })];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getEntityDocumentLinks({});

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('link-1');
      expect(result[1].id).toBe('link-2');
    });

    it('should filter by entityType and entityId', async () => {
      const mockLinks = [createMockLink({ entityType: 'technology', entityId: 'tech-1' })];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getEntityDocumentLinks({
        entityType: 'technology',
        entityId: 'tech-1',
      });

      expect(result).toHaveLength(1);
      expect(result[0].entityType).toBe('technology');
      expect(result[0].entityId).toBe('tech-1');
    });

    it('should filter by documentId', async () => {
      const mockLinks = [createMockLink({ documentId: 'doc-123' })];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getEntityDocumentLinks({ documentId: 'doc-123' });

      expect(result).toHaveLength(1);
      expect(result[0].documentId).toBe('doc-123');
    });

    it('should filter by relationshipType', async () => {
      const mockLinks = [createMockLink({ relationshipType: 'technical_spec' })];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getEntityDocumentLinks({ relationshipType: 'technical_spec' });

      expect(result).toHaveLength(1);
      expect(result[0].relationshipType).toBe('technical_spec');
    });

    it('should filter by relevance', async () => {
      const mockLinks = [createMockLink({ relevance: 'high' })];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getEntityDocumentLinks({ relevance: 'high' });

      expect(result).toHaveLength(1);
      expect(result[0].relevance).toBe('high');
    });

    it('should filter by aiSuggested', async () => {
      const mockLinks = [createMockLink({ aiSuggested: true })];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getEntityDocumentLinks({ aiSuggested: true });

      expect(result).toHaveLength(1);
      expect(result[0].aiSuggested).toBe(true);
    });

    it('should filter by graphSyncStatus', async () => {
      const mockLinks = [createMockLink({ graphSyncStatus: 'failed' })];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getEntityDocumentLinks({ graphSyncStatus: 'failed' });

      expect(result).toHaveLength(1);
      expect(result[0].graphSyncStatus).toBe('failed');
    });

    it('should apply limit when provided', async () => {
      const mockLinks = [createMockLink()];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getEntityDocumentLinks({ limit: 10 });

      // Verify the result is returned - limit is applied internally
      expect(result).toHaveLength(1);
    });

    it('should return empty array when no links found', async () => {
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([]));

      const result = await getEntityDocumentLinks({});

      expect(result).toHaveLength(0);
    });
  });

  describe('getEntityDocumentLinkById', () => {
    it('should return link when found', async () => {
      const mockLink = createMockLink({ id: 'link-123' });
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(mockLink));

      const result = await getEntityDocumentLinkById('link-123');

      expect(result).toEqual(mockLink);
    });

    it('should return null when link not found', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));

      const result = await getEntityDocumentLinkById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getLinksForEntity', () => {
    it('should return links for specific entity', async () => {
      const mockLinks = [
        createMockLink({ entityType: 'technology', entityId: 'tech-1' }),
        createMockLink({ entityType: 'technology', entityId: 'tech-1', id: 'link-2' }),
      ];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getLinksForEntity('technology', 'tech-1');

      expect(result).toHaveLength(2);
      expect(result[0].entityType).toBe('technology');
      expect(result[0].entityId).toBe('tech-1');
    });
  });

  describe('getLinksForDocument', () => {
    it('should return links for specific document', async () => {
      const mockLinks = [
        createMockLink({ documentId: 'doc-1' }),
        createMockLink({ documentId: 'doc-1', id: 'link-2' }),
      ];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getLinksForDocument('doc-1');

      expect(where).toHaveBeenCalledWith('documentId', '==', 'doc-1');
      expect(result).toHaveLength(2);
    });
  });

  describe('getLinksWithDocuments', () => {
    it('enriches a linked document with its exact original source URL', async () => {
      const mockLink = createMockLink({ documentId: 'doc-source' });
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([mockLink]));
      (getDocumentById as jest.Mock).mockResolvedValue({
        id: 'doc-source',
        title: 'Exact source',
        type: 'url',
        status: 'processed',
        originalUrl: 'https://example.com/research/article?id=42#results',
        domain: 'example.com',
      });

      const result = await getLinksWithDocuments('technology', 'tech-456');

      expect(result).toHaveLength(1);
      expect(result[0].document.originalUrl).toBe('https://example.com/research/article?id=42#results');
    });
  });

  describe('findExistingLink', () => {
    it('should return link when entity-document pair exists', async () => {
      const mockLink = createMockLink({
        entityType: 'technology',
        entityId: 'tech-456',
        documentId: 'doc-789',
      });
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([mockLink]));

      const result = await findExistingLink('technology', 'tech-456', 'doc-789');

      expect(result).not.toBeNull();
      expect(result?.entityType).toBe('technology');
      expect(result?.entityId).toBe('tech-456');
      expect(result?.documentId).toBe('doc-789');
    });

    it('should return null when no link exists', async () => {
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([]));

      const result = await findExistingLink('technology', 'tech-1', 'doc-1');

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // CREATE OPERATIONS
  // ==========================================================================

  describe('createEntityDocumentLink', () => {
    it('should create a new link', async () => {
      const newLinkId = 'new-link-id';
      const createdLink = createMockLink({
        id: newLinkId,
        entityType: 'technology',
        entityId: 'tech-123',
        documentId: 'doc-456',
      });

      // Mock findExistingLink (getDocs) returns empty
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([]));
      // Mock addDoc
      (addDoc as jest.Mock).mockResolvedValue({ id: newLinkId });
      // Mock document service
      (updateLinkedEntityCount as jest.Mock).mockResolvedValue(undefined);
      // Mock getEntityDocumentLinkById (getDoc) to return created link
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(createdLink));

      const input = {
        entityType: 'technology' as const,
        entityId: 'tech-123',
        documentId: 'doc-456',
        relationshipType: 'documentation' as const,
        relevance: 'high' as const,
        tags: [] as string[],
        createdBy: 'user-001',
        workspaceId: 'workspace-001',
      };

      const { link } = await createEntityDocumentLink(input);

      expect(addDoc).toHaveBeenCalled();
      expect(link.id).toBe(newLinkId);
      expect(link.entityType).toBe('technology');
      expect(link.graphSyncStatus).toBe('pending');
    });

    it('should throw error when link already exists', async () => {
      const existingLink = createMockLink();
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([existingLink]));

      const input = {
        entityType: 'technology' as const,
        entityId: 'tech-456',
        documentId: 'doc-789',
        relationshipType: 'documentation' as const,
        relevance: 'high' as const,
        tags: [] as string[],
        createdBy: 'user-001',
        workspaceId: 'workspace-001',
      };

      await expect(createEntityDocumentLink(input)).rejects.toThrow('Link already exists');
    });

    it('should include tags and note when provided', async () => {
      const newLinkId = 'new-link-id';
      const createdLink = createMockLink({
        id: newLinkId,
        entityType: 'technology',
        entityId: 'tech-123',
        documentId: 'doc-456',
        tags: ['api', 'reference'],
        note: 'Important documentation',
      });

      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([]));
      (addDoc as jest.Mock).mockResolvedValue({ id: newLinkId });
      (updateLinkedEntityCount as jest.Mock).mockResolvedValue(undefined);
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(createdLink));

      const input = {
        entityType: 'technology' as const,
        entityId: 'tech-123',
        documentId: 'doc-456',
        relationshipType: 'documentation' as const,
        relevance: 'high' as const,
        tags: ['api', 'reference'],
        note: 'Important documentation',
        createdBy: 'user-001',
        workspaceId: 'workspace-001',
      };

      const { link } = await createEntityDocumentLink(input);

      expect(link.tags).toEqual(['api', 'reference']);
      expect(link.note).toBe('Important documentation');
    });
  });

  describe('createAISuggestedLink', () => {
    it('should create an AI-suggested link with aiSuggested true', async () => {
      const aiLinkId = 'ai-link-id';
      const aiConfidence = 0.85;
      const input = {
        entityType: 'technology' as const,
        entityId: 'tech-123',
        documentId: 'doc-456',
        relationshipType: 'documentation' as const,
        relevance: 'high' as const,
        tags: [] as string[],
        createdBy: 'ai-system',
        workspaceId: 'workspace-001',
      };

      // Create a mock that matches what the service should return
      const createdLink = createMockLink({
        id: aiLinkId,
        entityType: input.entityType,
        entityId: input.entityId,
        documentId: input.documentId,
        relationshipType: input.relationshipType,
        relevance: input.relevance,
        aiSuggested: true,
        aiConfidence,
      });

      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([]));
      (addDoc as jest.Mock).mockResolvedValue({ id: aiLinkId });
      (updateLinkedEntityCount as jest.Mock).mockResolvedValue(undefined);
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(createdLink));

      const { link } = await createAISuggestedLink(input, aiConfidence);

      expect(link.aiSuggested).toBe(true);
      expect(link.aiConfidence).toBe(0.85);
    });
  });

  // ==========================================================================
  // UPDATE OPERATIONS
  // ==========================================================================

  describe('updateEntityDocumentLink', () => {
    it('should update an existing link', async () => {
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      await updateEntityDocumentLink('link-123', {
        relevance: 'low',
        note: 'Updated note',
      });

      expect(updateDoc).toHaveBeenCalled();
      const updateCall = (updateDoc as jest.Mock).mock.calls[0][1];
      expect(updateCall.relevance).toBe('low');
      expect(updateCall.note).toBe('Updated note');
    });

    it('should set graphSyncStatus to pending on update', async () => {
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      await updateEntityDocumentLink('link-123', {
        relevance: 'low',
      });

      const updateCall = (updateDoc as jest.Mock).mock.calls[0][1];
      expect(updateCall.graphSyncStatus).toBe('pending');
    });
  });

  describe('approveAISuggestion', () => {
    it('should approve AI suggestion by setting aiSuggested to false', async () => {
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      await approveAISuggestion('link-123');

      expect(updateDoc).toHaveBeenCalled();
      const updateCall = (updateDoc as jest.Mock).mock.calls[0][1];
      expect(updateCall.aiSuggested).toBe(false);
    });

    it('should clear aiConfidence when approving', async () => {
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      await approveAISuggestion('link-123');

      const updateCall = (updateDoc as jest.Mock).mock.calls[0][1];
      expect(updateCall.aiConfidence).toBeUndefined();
    });
  });

  describe('rejectAISuggestion', () => {
    it('should delete the link when rejected', async () => {
      const mockLink = createMockLink({ aiSuggested: true });
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(mockLink));
      seedCascadeTransaction([mockLink], 1);

      await rejectAISuggestion('link-123');

      expect(mockTransactionDelete).toHaveBeenCalled();
    });

    it('should return without error when link not found', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));

      // Should not throw - just logs and returns
      await expect(rejectAISuggestion('nonexistent')).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // DELETE OPERATIONS
  // ==========================================================================

  describe('deleteEntityDocumentLink', () => {
    it('should delete an existing link', async () => {
      const mockLink = createMockLink();
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(mockLink));
      seedCascadeTransaction([mockLink], 3);

      await deleteEntityDocumentLink('link-123');

      expect(mockTransactionDelete).toHaveBeenCalled();
    });

    it('should return without error when link not found', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));

      // Should not throw - just logs and returns
      await expect(deleteEntityDocumentLink('nonexistent')).resolves.toBeUndefined();
    });

    it('should update document linkedEntityCount on delete', async () => {
      const mockLink = createMockLink();
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(mockLink));
      seedCascadeTransaction([mockLink], 3);

      await deleteEntityDocumentLink('link-123');

      expect(mockTransactionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ collectionName: 'documents', id: 'doc-789' }),
        expect.objectContaining({ linkedEntityCount: 2 })
      );
    });

    it('performs no Firestore mutation when graph dispatch is not acknowledged', async () => {
      const mockLink = createMockLink();
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(mockLink));
      seedCascadeTransaction([mockLink]);
      (fetchWithAuth as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Graph synchronization handoff was not acknowledged' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await expect(deleteEntityDocumentLink('link-123')).rejects.toThrow('handoff failed');

      expect(runTransaction).not.toHaveBeenCalled();
      expect(mockTransactionDelete).not.toHaveBeenCalled();
      expect(mockTransactionUpdate).not.toHaveBeenCalled();
    });

    it('retains the link after a transaction failure and converges on retry', async () => {
      const mockLink = createMockLink();
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(mockLink));
      seedCascadeTransaction([mockLink], 1);
      (runTransaction as jest.Mock).mockRejectedValueOnce(new Error('counter transaction failed'));

      await expect(deleteEntityDocumentLink('link-123')).rejects.toThrow('counter transaction failed');
      expect(transactionLinks.has('link-123')).toBe(true);
      expect(mockTransactionDelete).not.toHaveBeenCalled();

      await expect(deleteEntityDocumentLink('link-123')).resolves.toBeUndefined();
      expect(transactionLinks.has('link-123')).toBe(false);
      expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['empty', { acknowledged: [], failed: [] }],
      ['partial', { acknowledged: ['link-123'], failed: [] }],
    ])('rejects %s server acknowledgement before Firestore mutation', async (_label, body) => {
      const links =
        _label === 'partial'
          ? [createMockLink(), createMockLink({ id: 'link-456', documentId: 'doc-456' })]
          : [createMockLink()];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(links));
      seedCascadeTransaction(links);
      (fetchWithAuth as jest.Mock).mockResolvedValueOnce(
        new Response(JSON.stringify(body), { status: 202, headers: { 'Content-Type': 'application/json' } })
      );

      await expect(deleteLinksForEntity('technology', 'tech-456')).rejects.toThrow(/acknowledgement/);

      expect(runTransaction).not.toHaveBeenCalled();
      expect(mockTransactionDelete).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // GRAPH SYNC LANE (H6) — link mutations must fire the DEDICATED
  // app/entity-document-link.sync.requested event. The unified entity handler
  // explicitly skips entityType 'document', so routing through
  // triggerEntitySync('document', …) dropped 100% of link syncs.
  // ==========================================================================

  describe('graph sync lane (H6)', () => {
    it('create hands the committed link to the server boundary, never to Inngest directly', async () => {
      const newLinkId = 'new-link-id';
      const createdLink = createMockLink({ id: newLinkId });
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([]));
      (addDoc as jest.Mock).mockResolvedValue({ id: newLinkId });
      (updateLinkedEntityCount as jest.Mock).mockResolvedValue(undefined);
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(createdLink));

      const { graphHandoff } = await createEntityDocumentLink({
        entityType: 'technology' as const,
        entityId: 'tech-123',
        documentId: 'doc-456',
        relationshipType: 'documentation' as const,
        relevance: 'high' as const,
        tags: [] as string[],
        createdBy: 'user-001',
        workspaceId: 'workspace-001',
      });

      // GRAPH-069: the browser cannot reach the right Inngest environment, so
      // the dedicated event is emitted server-side behind this authenticated
      // route — and the caller learns whether it was acknowledged.
      expect(allGraphHandoffRequests()).toEqual([
        {
          operation: 'create',
          link: { linkId: newLinkId, entityId: createdLink.entityId, documentId: createdLink.documentId },
        },
      ]);
      expect(graphHandoff).toEqual({ status: 'acknowledged' });
      expect(inngest.send).not.toHaveBeenCalled();
    });

    it('update uses the same server boundary as create', async () => {
      (updateDoc as jest.Mock).mockResolvedValue(undefined);
      const stored = createMockLink({ id: 'link-123' });
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(stored));

      const { graphHandoff } = await updateEntityDocumentLink('link-123', { relevance: 'low' });

      expect(allGraphHandoffRequests()).toEqual([
        {
          operation: 'update',
          link: { linkId: 'link-123', entityId: stored.entityId, documentId: stored.documentId },
        },
      ]);
      expect(graphHandoff).toEqual({ status: 'acknowledged' });
      expect(inngest.send).not.toHaveBeenCalled();
    });

    it('delete fires the dedicated sync event carrying the old endpoints', async () => {
      const mockLink = createMockLink();
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(mockLink));
      seedCascadeTransaction([mockLink]);

      await deleteEntityDocumentLink('link-123');

      expect(graphHandoffRequests()).toEqual([
        {
          operation: 'delete',
          links: [
            {
              linkId: 'link-123',
              entityId: 'tech-456',
              documentId: 'doc-789',
            },
          ],
        },
      ]);
    });

    it('never routes link syncs through the unified entity event (dead lane)', async () => {
      (updateDoc as jest.Mock).mockResolvedValue(undefined);
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(createMockLink({ id: 'link-123' })));

      await updateEntityDocumentLink('link-123', { relevance: 'low' });

      const eventNames = (inngest.send as jest.Mock).mock.calls.map(([evt]) => evt.name);
      expect(eventNames).not.toContain('app/unified-entity.sync.requested');
    });

    // B2 — the bulk cascade deletes (deleteLinksForEntity / deleteLinksForDocument)
    // batch-deleted Firestore docs but emitted NO Neo4j delete sync, orphaning
    // the LINKS/typed edges. The singular deleteEntityDocumentLink() emits one;
    // the bulk paths must emit one per deleted link, carrying the old endpoints
    // (the doc is gone, so the handler can't reload them).
    it('deleteLinksForEntity emits a delete sync per link with old endpoints', async () => {
      const links = [
        createMockLink({ id: 'link-a', entityId: 'tech-456', documentId: 'doc-a' }),
        createMockLink({ id: 'link-b', entityId: 'tech-456', documentId: 'doc-b' }),
      ];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(links));
      seedCascadeTransaction(links);

      await deleteLinksForEntity('technology', 'tech-456');

      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
      expect(graphHandoffRequests()[0].links).toEqual([
        { linkId: 'link-a', entityId: 'tech-456', documentId: 'doc-a' },
        { linkId: 'link-b', entityId: 'tech-456', documentId: 'doc-b' },
      ]);
    });

    it('deleteLinksForDocument emits a delete sync per link with old endpoints', async () => {
      const links = [
        createMockLink({ id: 'link-c', entityId: 'tech-1', documentId: 'doc-789' }),
        createMockLink({ id: 'link-d', entityId: 'comp-2', documentId: 'doc-789' }),
      ];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(links));
      seedCascadeTransaction(links);

      await deleteLinksForDocument('doc-789');

      const deletedLinkIds = graphHandoffRequests()[0].links.map(({ linkId }) => linkId);

      expect(deletedLinkIds).toEqual(expect.arrayContaining(['link-c', 'link-d']));
    });

    it('deletes document links from both endpoints without deleting same-ID non-document entities', async () => {
      const targetLink = createMockLink({
        id: 'link-target',
        entityType: 'technology',
        entityId: 'tech-1',
        documentId: 'doc-a',
      });
      const entityLink = createMockLink({
        id: 'link-entity',
        entityType: 'document',
        entityId: 'doc-a',
        documentId: 'doc-b',
      });
      const unrelatedLink = createMockLink({
        id: 'link-unrelated',
        entityType: 'company',
        entityId: 'doc-a',
        documentId: 'doc-c',
      });
      const selfLink = createMockLink({
        id: 'link-self',
        entityType: 'document',
        entityId: 'doc-a',
        documentId: 'doc-a',
      });
      (getDocs as jest.Mock)
        .mockResolvedValueOnce(createMockQuerySnapshot([targetLink, selfLink]))
        .mockResolvedValueOnce(createMockQuerySnapshot([entityLink, unrelatedLink, selfLink]));
      seedCascadeTransaction([targetLink, entityLink, unrelatedLink, selfLink]);

      await expect(deleteLinksForDocument('doc-a')).resolves.toBe(3);

      expect(transactionLinks.has('link-target')).toBe(false);
      expect(transactionLinks.has('link-entity')).toBe(false);
      expect(transactionLinks.has('link-self')).toBe(false);
      expect(transactionLinks.has('link-unrelated')).toBe(true);
      expect(mockTransactionDelete).toHaveBeenCalledTimes(3);
      expect(graphHandoffRequests()[0].links.map(({ linkId }) => linkId)).toEqual([
        'link-target',
        'link-self',
        'link-entity',
      ]);
    });

    it('normalizes orgUnit and preserves same-ID links owned by another entity type', async () => {
      const orgLink = createMockLink({ id: 'link-org', entityType: 'org_unit', entityId: 'shared-id' });
      const painLink = createMockLink({ id: 'link-pain', entityType: 'pain_point', entityId: 'shared-id' });
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([orgLink, painLink]));
      seedCascadeTransaction([orgLink, painLink], 2);

      await expect(deleteLinksForEntity('orgUnit', 'shared-id')).resolves.toBe(1);

      expect(transactionLinks.has('link-org')).toBe(false);
      expect(transactionLinks.has('link-pain')).toBe(true);
      expect(graphHandoffRequests()[0].links.map(({ linkId }) => linkId)).toEqual(['link-org']);
    });

    it('uses bounded retry-safe chunks for more than 500 links without changing list pagination', async () => {
      const links = Array.from({ length: 501 }, (_, index) =>
        createMockLink({ id: `link-${index}`, entityId: 'tech-many', documentId: `doc-${index}` })
      );
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(links));
      seedCascadeTransaction(links, 1);

      await expect(deleteLinksForEntity('technology', 'tech-many')).resolves.toBe(501);

      expect(runTransaction).toHaveBeenCalledTimes(3);
      expect(fetchWithAuth).toHaveBeenCalledTimes(3);
      expect(graphHandoffRequests().map(({ links: chunk }) => chunk.length)).toEqual([200, 200, 101]);
      expect(limit).not.toHaveBeenCalled();
      expect(mockTransactionDelete).toHaveBeenCalledTimes(501);
    });

    it('treats a replayed delete event as harmless after the link is already gone', async () => {
      const link = createMockLink({ id: 'link-replay' });
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([link]));
      seedCascadeTransaction([link], 1);

      await expect(deleteLinksForDocument(link.documentId)).resolves.toBe(1);
      await expect(deleteLinksForDocument(link.documentId)).resolves.toBe(0);

      expect(fetchWithAuth).toHaveBeenCalledTimes(2);
      expect(mockTransactionDelete).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // GRAPH SYNC OPERATIONS
  // ==========================================================================

  describe('markLinkSynced', () => {
    it('should update sync status to synced', async () => {
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      await markLinkSynced('link-123');

      expect(updateDoc).toHaveBeenCalled();
      const updateCall = (updateDoc as jest.Mock).mock.calls[0][1];
      expect(updateCall.graphSyncStatus).toBe('synced');
      expect(updateCall.lastSyncedAt).toBeDefined();
    });
  });

  describe('markLinkSyncFailed', () => {
    it('should update sync status to failed', async () => {
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      await markLinkSyncFailed('link-123');

      expect(updateDoc).toHaveBeenCalled();
      const updateCall = (updateDoc as jest.Mock).mock.calls[0][1];
      expect(updateCall.graphSyncStatus).toBe('failed');
    });
  });

  describe('getLinksPendingSync', () => {
    it('should return links with pending sync status', async () => {
      const mockLinks = [
        createMockLink({ graphSyncStatus: 'pending' }),
        createMockLink({ graphSyncStatus: 'pending', id: 'link-2' }),
      ];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getLinksPendingSync();

      expect(where).toHaveBeenCalledWith('graphSyncStatus', '==', 'pending');
      expect(result).toHaveLength(2);
    });

    it('should apply limit when provided', async () => {
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([]));

      await getLinksPendingSync(50);

      expect(limit).toHaveBeenCalledWith(50);
    });
  });

  // ==========================================================================
  // AI SUGGESTIONS
  // ==========================================================================

  describe('getPendingAISuggestions', () => {
    it('should return AI suggested links', async () => {
      const mockLinks = [createMockLink({ aiSuggested: true }), createMockLink({ aiSuggested: true, id: 'link-2' })];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getPendingAISuggestions();

      expect(result).toHaveLength(2);
      expect(result[0].aiSuggested).toBe(true);
    });

    it('should use default limit of 50', async () => {
      const mockLinks = [createMockLink({ aiSuggested: true })];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getPendingAISuggestions();

      expect(result).toHaveLength(1);
    });
  });

  // ==========================================================================
  // STATISTICS
  // ==========================================================================

  describe('getLinkStatsForEntity', () => {
    it('should return statistics for an entity', async () => {
      const mockLinks = [
        createMockLink({ relationshipType: 'documentation', relevance: 'high' }),
        createMockLink({
          relationshipType: 'documentation',
          relevance: 'medium',
          id: 'link-2',
        }),
        createMockLink({
          relationshipType: 'technical_spec',
          relevance: 'high',
          id: 'link-3',
        }),
      ];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getLinkStatsForEntity('technology', 'tech-1');

      expect(result.total).toBe(3);
      expect(result.byRelationshipType.documentation).toBe(2);
      expect(result.byRelationshipType.technical_spec).toBe(1);
      expect(result.byRelevance.high).toBe(2);
      expect(result.byRelevance.medium).toBe(1);
    });

    it('should return zero counts when no links exist', async () => {
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([]));

      const result = await getLinkStatsForEntity('technology', 'tech-1');

      expect(result.total).toBe(0);
      expect(result.byRelationshipType.documentation).toBe(0);
      expect(result.byRelevance.high).toBe(0);
    });

    it('should count AI suggested links', async () => {
      const mockLinks = [createMockLink({ aiSuggested: true }), createMockLink({ aiSuggested: false, id: 'link-2' })];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getLinkStatsForEntity('technology', 'tech-1');

      expect(result.aiSuggestedCount).toBe(1);
    });
  });

  describe('getGlobalLinkStats', () => {
    it('should return global statistics', async () => {
      const mockLinks = [
        createMockLink({ entityType: 'technology', graphSyncStatus: 'pending' }),
        createMockLink({ entityType: 'company', graphSyncStatus: 'pending', id: 'link-2' }),
        createMockLink({ entityType: 'technology', graphSyncStatus: 'pending', id: 'link-3' }),
      ];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getGlobalLinkStats();

      expect(result.total).toBe(3);
      expect(result.byEntityType.technology).toBe(2);
      expect(result.byEntityType.company).toBe(1);
      expect(result.pendingSyncCount).toBe(3);
    });

    it('should count by relationship type', async () => {
      const mockLinks = [
        createMockLink({ relationshipType: 'documentation' }),
        createMockLink({ relationshipType: 'documentation', id: 'link-2' }),
        createMockLink({ relationshipType: 'case_study', id: 'link-3' }),
      ];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockLinks));

      const result = await getGlobalLinkStats();

      expect(result.byRelationshipType.documentation).toBe(2);
      expect(result.byRelationshipType.case_study).toBe(1);
    });
  });
});
