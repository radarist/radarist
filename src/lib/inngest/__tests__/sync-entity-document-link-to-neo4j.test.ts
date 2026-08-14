/**
 * Unit Tests for Entity-Document Link Neo4j Sync Inngest Functions
 *
 * Tests the sync-entity-document-link-to-neo4j functions:
 * - syncEntityDocumentLinkToNeo4jJob - Main sync function
 * - batchSyncEntityDocumentLinksJob - Batch sync function
 * - Helper functions (triggerEntityDocumentLinkSync, triggerBatchEntityDocumentLinkSync)
 *
 * @jest-environment node
 * @phase Knowledge Tab Sprint - Phase 5
 */

import type { EntityDocumentLink } from '@/lib/types';

// ============================================================================
// MOCKS - Must be defined before any imports that use them
// ============================================================================

// Undo the global mock from jest.setup.js so we can test the actual module
jest.unmock('@/lib/inngest/functions/sync-entity-document-link-to-neo4j');

jest.mock('@/lib/graph', () => ({
  __esModule: true,
  checkHealth: jest.fn(),
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));

jest.mock('@/lib/entity-document-link-admin', () => ({
  __esModule: true,
  adminGetEntityDocumentLinkById: jest.fn(),
  adminMarkLinkSynced: jest.fn(),
  adminMarkLinkSyncFailed: jest.fn(),
}));

jest.mock('@/lib/graph/query-cache', () => ({
  invalidateCachesForEntity: jest.fn(),
}));

const mockStepSleep = jest.fn().mockResolvedValue(undefined);

jest.mock('../client', () => ({
  inngest: {
    createFunction: jest.fn(
      (
        config: Record<string, unknown>,
        trigger: Record<string, unknown>,
        handler: (...args: unknown[]) => Promise<unknown>
      ) => {
        // Return a testable function wrapper
        return {
          config,
          trigger,
          handler,
          // Helper for testing
          async execute(eventData: Record<string, unknown>) {
            const steps: Record<string, unknown> = {};
            const step = {
              run: async <T>(name: string, fn: () => Promise<T>) => {
                const result = await fn();
                steps[name] = result;
                return result;
              },
              sleep: (name: string, duration: string) => mockStepSleep(name, duration),
            };
            const result = await handler({ event: { data: eventData }, step });
            return { result, steps };
          },
        };
      }
    ),
    send: jest.fn(),
  },
}));

// Import mocked modules
import { checkHealth, runWriteTransaction, runReadTransaction } from '@/lib/graph';
import {
  adminGetEntityDocumentLinkById,
  adminMarkLinkSynced,
  adminMarkLinkSyncFailed,
} from '@/lib/entity-document-link-admin';
import { inngest } from '../client';
import { invalidateCachesForEntity } from '@/lib/graph/query-cache';
import {
  syncEntityDocumentLinkToNeo4jJob,
  batchSyncEntityDocumentLinksJob,
  triggerEntityDocumentLinkSync,
  triggerBatchEntityDocumentLinkSync,
} from '../functions/sync-entity-document-link-to-neo4j';

// Cast mocks for TypeScript
const mockCheckHealth = checkHealth as jest.MockedFunction<typeof checkHealth>;
const mockRunWriteTransaction = runWriteTransaction as jest.MockedFunction<typeof runWriteTransaction>;
const mockRunReadTransaction = runReadTransaction as jest.MockedFunction<typeof runReadTransaction>;
const mockGetEntityDocumentLinkById = adminGetEntityDocumentLinkById as jest.MockedFunction<
  typeof adminGetEntityDocumentLinkById
>;
const mockMarkLinkSynced = adminMarkLinkSynced as jest.MockedFunction<typeof adminMarkLinkSynced>;
const mockMarkLinkSyncFailed = adminMarkLinkSyncFailed as jest.MockedFunction<typeof adminMarkLinkSyncFailed>;
const mockInngestSend = inngest.send as jest.MockedFunction<typeof inngest.send>;
const mockInvalidateCachesForEntity = invalidateCachesForEntity as jest.MockedFunction<
  typeof invalidateCachesForEntity
>;

// ============================================================================
// HELPERS
// ============================================================================

function createMockLink(overrides?: Partial<EntityDocumentLink>): EntityDocumentLink {
  return {
    id: 'link-123',
    entityType: 'technology',
    entityId: 'tech-456',
    documentId: 'doc-789',
    relationshipType: 'documentation',
    relevance: 'high',
    tags: ['api', 'official'],
    note: 'Official API documentation',
    aiSuggested: false,
    graphSyncStatus: 'pending',
    createdBy: 'user-001',
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
    workspaceId: 'default',
    ...overrides,
  };
}

function createMockQueryResult<T>(records: T[]) {
  return {
    records,
    summary: {
      counters: {
        relationshipsCreated: records.length > 0 ? 1 : 0,
        relationshipsDeleted: 0,
        nodesCreated: 0,
        nodesDeleted: 0,
        propertiesSet: 0,
      },
      queryType: 'rw',
      resultAvailableAfter: 0,
      resultConsumedAfter: 0,
    },
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('Sync Entity-Document Link to Neo4j', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckHealth.mockResolvedValue({ healthy: true, latencyMs: 5 });
    mockRunWriteTransaction.mockResolvedValue(createMockQueryResult([{ r: 'created' }]));
    mockRunReadTransaction.mockResolvedValue(createMockQueryResult([]));
    mockMarkLinkSynced.mockResolvedValue();
    mockMarkLinkSyncFailed.mockResolvedValue();
    mockInngestSend.mockResolvedValue({ ids: ['accepted'] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // CONFIGURATION TESTS
  // ==========================================================================

  describe('syncEntityDocumentLinkToNeo4jJob Configuration', () => {
    it('should be configured with correct ID and retries', () => {
      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        config: {
          id: string;
          retries: number;
          throttle: { limit: number; period: string };
          concurrency: { key: string; limit: number };
        };
        trigger: { event: string };
      };

      expect(job.config.id).toBe('sync-entity-document-link-to-neo4j-v2');
      expect(job.config.retries).toBe(3);
      expect(job.config.throttle.limit).toBe(50);
      expect(job.config.concurrency).toEqual({ key: 'event.data.linkId', limit: 1 });
      expect(job.trigger.event).toBe('app/entity-document-link.sync.requested');
    });
  });

  // ==========================================================================
  // CREATE OPERATION TESTS
  // ==========================================================================

  describe('Create Operation', () => {
    it('should create relationship successfully', async () => {
      const mockLink = createMockLink();
      mockGetEntityDocumentLinkById.mockResolvedValue(mockLink);

      // Mock entity exists
      mockRunReadTransaction
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'tech-456' }])) // Entity exists
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'doc-789' }])); // Document exists

      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{ result: { success: boolean } }>;
      };

      const { result } = await job.execute({
        operation: 'create',
        linkId: 'link-123',
      });

      expect(result.success).toBe(true);
      expect(mockGetEntityDocumentLinkById).toHaveBeenCalledWith('link-123');
      expect(mockRunWriteTransaction).toHaveBeenCalled();
      expect(mockMarkLinkSynced).toHaveBeenCalledWith('link-123');
      expect(mockInvalidateCachesForEntity).toHaveBeenCalledWith('tech-456');
      expect(mockInvalidateCachesForEntity).toHaveBeenCalledWith('doc-789');
    });

    it('should fail if entity not found in Neo4j', async () => {
      const mockLink = createMockLink();
      mockGetEntityDocumentLinkById.mockResolvedValue(mockLink);

      // Mock entity NOT found
      mockRunReadTransaction.mockResolvedValueOnce(createMockQueryResult([]));

      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{ result: { success: boolean } }>;
      };

      await expect(
        job.execute({
          operation: 'create',
          linkId: 'link-123',
        })
      ).rejects.toThrow('Entity Technology:tech-456 not found in Neo4j');
      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/technology.sync.requested',
        data: { operation: 'update', technologyId: 'tech-456' },
      });
    });

    it('queues an inbox Signal before retrying a link that makes it graph-eligible', async () => {
      mockGetEntityDocumentLinkById.mockResolvedValue(
        createMockLink({ entityType: 'signal', entityId: 'signal-inbox' })
      );
      mockRunReadTransaction.mockResolvedValueOnce(createMockQueryResult([]));
      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };

      await expect(job.execute({ operation: 'create', linkId: 'link-123' })).rejects.toThrow(
        'Entity Signal:signal-inbox not found in Neo4j'
      );
      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/unified-entity.sync.requested',
        data: { operation: 'update', entityType: 'signal', entityId: 'signal-inbox' },
      });
    });

    it.each([
      ['org_unit', 'orgUnit'],
      ['pain_point', 'painPoint'],
    ] as const)('normalizes a missing %s endpoint to canonical entity type %s', async (linkType, entityType) => {
      mockGetEntityDocumentLinkById.mockResolvedValue(
        createMockLink({ entityType: linkType, entityId: `${linkType}-1` })
      );
      mockRunReadTransaction.mockResolvedValueOnce(createMockQueryResult([]));
      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };

      await expect(job.execute({ operation: 'create', linkId: 'link-123' })).rejects.toThrow('not found in Neo4j');
      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/unified-entity.sync.requested',
        data: { operation: 'update', entityType, entityId: `${linkType}-1` },
      });
    });

    it('should fail if document not found in Neo4j', async () => {
      const mockLink = createMockLink();
      mockGetEntityDocumentLinkById.mockResolvedValue(mockLink);

      // Mock entity found, document NOT found
      mockRunReadTransaction
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'tech-456' }]))
        .mockResolvedValueOnce(createMockQueryResult([]));

      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{ result: { success: boolean } }>;
      };

      await expect(
        job.execute({
          operation: 'create',
          linkId: 'link-123',
        })
      ).rejects.toThrow('Document doc-789 not found in Neo4j');
      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/document.sync.requested',
        data: { operation: 'update', documentId: 'doc-789' },
      });
    });

    it('skips safely if the link is already missing from Firestore', async () => {
      mockGetEntityDocumentLinkById.mockResolvedValue(null);

      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; skipped: boolean; reason: string };
        }>;
      };

      const { result } = await job.execute({
        operation: 'create',
        linkId: 'link-123',
      });

      expect(result).toMatchObject({
        success: true,
        skipped: true,
        reason: 'Entity-document link not found in Firestore',
      });
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
      expect(mockMarkLinkSynced).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // UPDATE OPERATION TESTS
  // ==========================================================================

  describe('Update Operation', () => {
    it('should update existing relationship', async () => {
      const mockLink = createMockLink({ relevance: 'low', note: 'Updated note' });
      mockGetEntityDocumentLinkById.mockResolvedValue(mockLink);

      mockRunReadTransaction
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'tech-456' }]))
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'doc-789' }]));

      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{ result: { success: boolean; operation: string } }>;
      };

      const { result } = await job.execute({
        operation: 'update',
        linkId: 'link-123',
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('updated');
      expect(mockMarkLinkSynced).toHaveBeenCalledWith('link-123');
    });

    // B1 — relationshipType/endpoint drift. Replacing every same-linkId edge
    // and writing the authoritative projection in one transaction prevents old
    // typed, moved-endpoint, corrupt, and duplicate projections from lingering.
    it('prunes any same-linkId edge of a different type before the MERGE on update', async () => {
      const mockLink = createMockLink({ relationshipType: 'evidence' }); // → HAS_EVIDENCE
      mockGetEntityDocumentLinkById.mockResolvedValue(mockLink);

      mockRunReadTransaction
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'tech-456' }])) // entity exists
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'doc-789' }])); // document exists

      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{ result: { success: boolean } }>;
      };

      await job.execute({ operation: 'update', linkId: 'link-123' });

      const calls = mockRunWriteTransaction.mock.calls as Array<[string, Record<string, unknown>]>;
      const replacement = calls.find(([queryText]) => queryText.includes('staleRelationships'));

      expect(replacement).toBeDefined();
      expect(replacement?.[0]).toContain('FOREACH (relationship IN staleRelationships | DELETE relationship)');
      expect(replacement?.[0]).toContain('MERGE (e)-[r:HAS_EVIDENCE');
      expect(replacement?.[1]).toMatchObject({
        linkId: 'link-123',
        entityId: 'tech-456',
        documentId: 'doc-789',
      });
    });

    it('prunes same-linkId projections before create in case the ID was reused', async () => {
      const mockLink = createMockLink({ relationshipType: 'evidence' });
      mockGetEntityDocumentLinkById.mockResolvedValue(mockLink);

      mockRunReadTransaction
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'tech-456' }]))
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'doc-789' }]));

      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{ result: { success: boolean } }>;
      };

      await job.execute({ operation: 'create', linkId: 'link-123' });

      const calls = mockRunWriteTransaction.mock.calls as Array<[string, Record<string, unknown>]>;
      const replacement = calls.find(([queryText]) => queryText.includes('staleRelationships'));
      expect(replacement?.[0]).toContain('MERGE (e)-[r:HAS_EVIDENCE');
      expect(replacement?.[1]).toMatchObject({
        linkId: 'link-123',
        entityId: 'tech-456',
        documentId: 'doc-789',
      });
    });

    it('skips an old update if deletion happens between its durable load and graph write', async () => {
      mockGetEntityDocumentLinkById.mockResolvedValueOnce(createMockLink()).mockResolvedValueOnce(null);
      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; skipped: boolean; reason: string };
        }>;
      };

      const { result } = await job.execute({ operation: 'update', linkId: 'link-123' });

      expect(result).toMatchObject({
        success: true,
        skipped: true,
        reason: 'Entity-document link not found in Firestore',
      });
      expect(mockGetEntityDocumentLinkById).toHaveBeenCalledTimes(2);
      expect(mockRunReadTransaction).not.toHaveBeenCalled();
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
      expect(mockMarkLinkSynced).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('uses fresh endpoints and prunes the old same-type projection when a linkId is reused', async () => {
      const oldLink = createMockLink({ entityId: 'old-tech', documentId: 'old-doc' });
      const currentLink = createMockLink({
        entityType: 'company',
        entityId: 'current-company',
        documentId: 'current-doc',
        relevance: 'low',
        tags: ['current'],
        note: 'Current source',
      });
      mockGetEntityDocumentLinkById.mockResolvedValueOnce(oldLink).mockResolvedValueOnce(currentLink);
      mockRunReadTransaction
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'current-company' }]))
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'current-doc' }]));
      mockRunWriteTransaction.mockResolvedValueOnce(
        createMockQueryResult([
          {
            r: 'created',
            previousEntityIds: ['old-tech'],
            previousDocumentIds: ['old-doc'],
          },
        ])
      );
      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{ result: { success: boolean } }>;
      };

      await job.execute({ operation: 'create', linkId: 'link-123' });

      const calls = mockRunWriteTransaction.mock.calls as Array<[string, Record<string, unknown>]>;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toContain('OPTIONAL MATCH ()-[stale {linkId: $linkId}]->()');
      expect(calls[0][0]).toContain('FOREACH (relationship IN staleRelationships | DELETE relationship)');
      expect(calls[0][0]).toContain('relationship.createdAt');
      expect(calls[0][0]).toContain('MATCH (e:Company {id: $entityId})');
      expect(calls[0][0]).toContain('MERGE (e)-[r:DOCUMENTED_BY');
      expect(calls[0][1]).toMatchObject({
        linkId: 'link-123',
        entityId: 'current-company',
        documentId: 'current-doc',
        relevance: 'low',
        tags: ['current'],
        note: 'Current source',
      });
      expect(mockInvalidateCachesForEntity.mock.calls.map(([id]) => id)).toEqual(
        expect.arrayContaining(['old-tech', 'old-doc', 'current-company', 'current-doc'])
      );
    });

    it('retries instead of marking synced when graph endpoints disappear during atomic replacement', async () => {
      mockGetEntityDocumentLinkById.mockResolvedValue(createMockLink());
      mockRunReadTransaction
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'tech-456' }]))
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'doc-789' }]));
      mockRunWriteTransaction.mockResolvedValueOnce(createMockQueryResult([]));
      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };

      await expect(job.execute({ operation: 'update', linkId: 'link-123' })).rejects.toThrow(
        'current graph endpoints disappeared'
      );

      expect(mockRunWriteTransaction).toHaveBeenCalledTimes(1);
      expect(mockMarkLinkSynced).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // DELETE OPERATION TESTS
  // ==========================================================================

  describe('Delete Operation', () => {
    it('should delete existing relationship', async () => {
      mockGetEntityDocumentLinkById.mockResolvedValue(null);
      // Mock relationship exists
      mockRunReadTransaction.mockResolvedValueOnce(createMockQueryResult([{ linkId: 'link-123' }]));

      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{ result: { success: boolean; operation: string } }>;
      };

      const { result } = await job.execute({
        operation: 'delete',
        linkId: 'link-123',
        entityType: 'technology',
        entityId: 'tech-456',
        documentId: 'doc-789',
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('deleted');
      expect(mockRunWriteTransaction).toHaveBeenCalled();
      expect(mockInvalidateCachesForEntity).toHaveBeenCalledWith('tech-456');
      expect(mockInvalidateCachesForEntity).toHaveBeenCalledWith('doc-789');
      // Delete doesn't call markLinkSynced
      expect(mockMarkLinkSynced).not.toHaveBeenCalled();
    });

    it('waits for delayed Firestore removal before deleting the graph edge', async () => {
      mockGetEntityDocumentLinkById.mockResolvedValueOnce(createMockLink()).mockResolvedValueOnce(null);
      mockRunReadTransaction.mockResolvedValueOnce(createMockQueryResult([{ linkId: 'link-123' }]));
      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{ result: { success: boolean } }>;
      };

      await job.execute({
        operation: 'delete',
        linkId: 'link-123',
        entityId: 'tech-456',
        documentId: 'doc-789',
      });

      expect(mockStepSleep).toHaveBeenCalledWith('wait-for-link-source-delete-0', '1s');
      expect(mockRunWriteTransaction).toHaveBeenCalled();
    });

    it('keeps the graph edge and fails retryably while the Firestore link remains', async () => {
      mockGetEntityDocumentLinkById.mockResolvedValue(createMockLink());
      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };

      await expect(
        job.execute({
          operation: 'delete',
          linkId: 'link-123',
          entityId: 'tech-456',
          documentId: 'doc-789',
        })
      ).rejects.toThrow('while its Firestore source still exists');

      expect(mockStepSleep).toHaveBeenCalledTimes(4);
      expect(mockRunReadTransaction).not.toHaveBeenCalled();
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });

    it('skips a stale delete event when the same linkId now has different endpoints', async () => {
      mockGetEntityDocumentLinkById.mockResolvedValueOnce(
        createMockLink({ entityId: 'new-entity', documentId: 'new-document' })
      );
      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; skipped: boolean; reason: string };
        }>;
      };

      const { result } = await job.execute({
        operation: 'delete',
        linkId: 'link-123',
        entityId: 'old-entity',
        documentId: 'old-document',
      });

      expect(result).toMatchObject({ success: true, skipped: true, reason: 'stale-delete-event' });
      expect(mockStepSleep).not.toHaveBeenCalled();
      expect(mockRunReadTransaction).not.toHaveBeenCalled();
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });

    it('skips deletion when different endpoints reuse the linkId after the source wait', async () => {
      mockGetEntityDocumentLinkById
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createMockLink({ entityId: 'new-entity', documentId: 'new-document' }));
      mockRunReadTransaction.mockResolvedValueOnce(createMockQueryResult([{ linkId: 'link-123' }]));
      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; skipped: boolean; reason: string };
        }>;
      };

      const { result } = await job.execute({
        operation: 'delete',
        linkId: 'link-123',
        entityId: 'old-entity',
        documentId: 'old-document',
      });

      expect(result).toMatchObject({ success: true, skipped: true, reason: 'stale-delete-event' });
      expect(mockGetEntityDocumentLinkById).toHaveBeenCalledTimes(2);
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });

    it('fails retryably when matching endpoints recreate the link after the source wait', async () => {
      mockGetEntityDocumentLinkById.mockResolvedValueOnce(null).mockResolvedValueOnce(createMockLink());
      mockRunReadTransaction.mockResolvedValueOnce(createMockQueryResult([{ linkId: 'link-123' }]));
      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<unknown>;
      };

      await expect(
        job.execute({
          operation: 'delete',
          linkId: 'link-123',
          entityId: 'tech-456',
          documentId: 'doc-789',
        })
      ).rejects.toThrow('while its Firestore source still exists');

      expect(mockGetEntityDocumentLinkById).toHaveBeenCalledTimes(2);
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });

    it('should handle already deleted relationship gracefully', async () => {
      mockGetEntityDocumentLinkById.mockResolvedValue(null);
      // Mock relationship NOT found (already deleted)
      mockRunReadTransaction.mockResolvedValueOnce(createMockQueryResult([]));

      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{ result: { success: boolean; operation: string } }>;
      };

      const { result } = await job.execute({
        operation: 'delete',
        linkId: 'link-123',
        entityType: 'technology',
        entityId: 'tech-456',
        documentId: 'doc-789',
      });

      expect(result.success).toBe(true);
      expect(result.operation).toBe('deleted');
      // No write transaction needed since already deleted
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // RELATIONSHIP TYPE MAPPING TESTS
  // ==========================================================================

  describe('Relationship Type Mapping', () => {
    const testCases = [
      { relationshipType: 'documentation', expectedNeo4j: 'DOCUMENTED_BY' },
      { relationshipType: 'case_study', expectedNeo4j: 'HAS_CASE_STUDY' },
      { relationshipType: 'technical_spec', expectedNeo4j: 'HAS_TECHNICAL_SPEC' },
      { relationshipType: 'research_paper', expectedNeo4j: 'HAS_RESEARCH' },
      { relationshipType: 'competitive_intel', expectedNeo4j: 'HAS_COMPETITIVE_INTEL' },
      { relationshipType: 'evidence', expectedNeo4j: 'HAS_EVIDENCE' },
      { relationshipType: 'pitch_deck', expectedNeo4j: 'HAS_PITCH_DECK' },
      { relationshipType: 'contract', expectedNeo4j: 'HAS_CONTRACT' },
      { relationshipType: 'other', expectedNeo4j: 'LINKED_TO' },
    ];

    testCases.forEach(({ relationshipType, expectedNeo4j }) => {
      it(`should map ${relationshipType} to ${expectedNeo4j}`, async () => {
        const mockLink = createMockLink({
          relationshipType: relationshipType as EntityDocumentLink['relationshipType'],
        });
        mockGetEntityDocumentLinkById.mockResolvedValue(mockLink);

        mockRunReadTransaction
          .mockResolvedValueOnce(createMockQueryResult([{ id: 'tech-456' }]))
          .mockResolvedValueOnce(createMockQueryResult([{ id: 'doc-789' }]));

        const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
          execute: (data: Record<string, unknown>) => Promise<{
            result: { relationshipType: string };
          }>;
        };

        const { result } = await job.execute({
          operation: 'create',
          linkId: 'link-123',
        });

        expect(result.relationshipType).toBe(expectedNeo4j);
      });
    });
  });

  // ==========================================================================
  // ENTITY TYPE MAPPING TESTS
  // ==========================================================================

  describe('Entity Type Mapping', () => {
    const entityTypes = [
      { entityType: 'technology', label: 'Technology' },
      { entityType: 'company', label: 'Company' },
      { entityType: 'useCase', label: 'UseCase' },
      { entityType: 'strategy', label: 'Strategy' },
      { entityType: 'prototype', label: 'Prototype' },
      { entityType: 'signal', label: 'Signal' },
    ];

    entityTypes.forEach(({ entityType, label }) => {
      it(`should use ${label} label for ${entityType} entity`, async () => {
        const mockLink = createMockLink({
          entityType: entityType as EntityDocumentLink['entityType'],
        });
        mockGetEntityDocumentLinkById.mockResolvedValue(mockLink);

        mockRunReadTransaction
          .mockResolvedValueOnce(createMockQueryResult([{ id: 'entity-123' }]))
          .mockResolvedValueOnce(createMockQueryResult([{ id: 'doc-789' }]));

        const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
          execute: (data: Record<string, unknown>) => Promise<{ result: { success: boolean } }>;
        };

        await job.execute({
          operation: 'create',
          linkId: 'link-123',
        });

        // Verify the read transaction was called to check entity existence
        expect(mockRunReadTransaction).toHaveBeenCalled();
        const firstCall = mockRunReadTransaction.mock.calls[0];
        expect(firstCall[0]).toContain(label);
      });
    });
  });

  // ==========================================================================
  // NEO4J HEALTH CHECK TESTS
  // ==========================================================================

  describe('Neo4j Health Check', () => {
    it('should fail if Neo4j is not healthy', async () => {
      mockCheckHealth.mockResolvedValue({
        healthy: false,
        error: 'Connection refused',
        latencyMs: 0,
      });

      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{ result: { success: boolean } }>;
      };

      await expect(
        job.execute({
          operation: 'create',
          linkId: 'link-123',
        })
      ).rejects.toThrow('Neo4j not healthy: Connection refused');
    });
  });

  // ==========================================================================
  // COMPLETION EVENT TESTS
  // ==========================================================================

  describe('Completion Events', () => {
    it('should send completion event on success', async () => {
      const mockLink = createMockLink();
      mockGetEntityDocumentLinkById.mockResolvedValue(mockLink);

      mockRunReadTransaction
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'tech-456' }]))
        .mockResolvedValueOnce(createMockQueryResult([{ id: 'doc-789' }]));

      const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{ result: { success: boolean } }>;
      };

      await job.execute({
        operation: 'create',
        linkId: 'link-123',
      });

      expect(mockInngestSend).toHaveBeenCalledWith({
        name: 'app/entity-document-link.sync.completed',
        data: expect.objectContaining({
          linkId: 'link-123',
          operation: 'created',
          relationshipType: 'DOCUMENTED_BY',
          syncedAt: expect.any(Number),
        }),
      });
    });
  });

  // ==========================================================================
  // BATCH SYNC TESTS
  // ==========================================================================

  describe('batchSyncEntityDocumentLinksJob', () => {
    it('should be configured correctly', () => {
      const job = batchSyncEntityDocumentLinksJob as unknown as {
        config: { id: string; retries: number };
        trigger: { event: string };
      };

      expect(job.config.id).toBe('batch-sync-entity-document-links-to-neo4j');
      expect(job.config.retries).toBe(2);
    });

    it('should queue sync events for all links', async () => {
      const linkIds = ['link-1', 'link-2', 'link-3'];

      const job = batchSyncEntityDocumentLinksJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; synced: number };
        }>;
      };

      const { result } = await job.execute({
        linkIds,
        options: { batchSize: 10 },
      });

      expect(result.success).toBe(true);
      expect(result.synced).toBe(3);

      // Verify individual sync events were sent
      expect(mockInngestSend).toHaveBeenCalledTimes(3);
      for (const linkId of linkIds) {
        expect(mockInngestSend).toHaveBeenCalledWith({
          name: 'app/entity-document-link.sync.requested',
          data: {
            operation: 'update',
            linkId,
          },
        });
      }
    });

    it('should process links in batches', async () => {
      const linkIds = ['link-1', 'link-2', 'link-3', 'link-4', 'link-5'];

      const job = batchSyncEntityDocumentLinksJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; synced: number };
        }>;
      };

      const { result } = await job.execute({
        linkIds,
        options: { batchSize: 2 },
      });

      expect(result.success).toBe(true);
      expect(result.synced).toBe(5);
    });

    it('should handle errors for individual links', async () => {
      const linkIds = ['link-1', 'link-2', 'link-3'];

      // Make one link fail
      mockInngestSend
        .mockResolvedValueOnce({ ids: [] })
        .mockRejectedValueOnce(new Error('Queue failed'))
        .mockResolvedValueOnce({ ids: [] });

      const job = batchSyncEntityDocumentLinksJob as unknown as {
        execute: (data: Record<string, unknown>) => Promise<{
          result: { success: boolean; synced: number; failed: number; errors: string[] };
        }>;
      };

      const { result } = await job.execute({
        linkIds,
        options: { batchSize: 10 },
      });

      expect(result.success).toBe(false);
      expect(result.synced).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('link-2');
    });
  });

  // ==========================================================================
  // HELPER FUNCTION TESTS
  // ==========================================================================

  describe('Helper Functions', () => {
    describe('triggerEntityDocumentLinkSync', () => {
      it('should send sync event with operation', async () => {
        await triggerEntityDocumentLinkSync('link-123', 'create');

        expect(mockInngestSend).toHaveBeenCalledWith({
          name: 'app/entity-document-link.sync.requested',
          data: {
            operation: 'create',
            linkId: 'link-123',
          },
        });
      });

      it('should include additional data when provided', async () => {
        await triggerEntityDocumentLinkSync('link-123', 'delete', {
          entityId: 'tech-456',
          entityType: 'technology',
          documentId: 'doc-789',
        });

        expect(mockInngestSend).toHaveBeenCalledWith({
          name: 'app/entity-document-link.sync.requested',
          data: {
            operation: 'delete',
            linkId: 'link-123',
            entityId: 'tech-456',
            entityType: 'technology',
            documentId: 'doc-789',
          },
        });
      });
    });

    describe('triggerBatchEntityDocumentLinkSync', () => {
      it('should send batch sync event', async () => {
        await triggerBatchEntityDocumentLinkSync(['link-1', 'link-2', 'link-3']);

        expect(mockInngestSend).toHaveBeenCalledWith({
          name: 'app/entity-document-link.batch-sync.requested',
          data: {
            linkIds: ['link-1', 'link-2', 'link-3'],
            options: undefined,
          },
        });
      });

      it('should include options when provided', async () => {
        await triggerBatchEntityDocumentLinkSync(['link-1', 'link-2'], { batchSize: 5 });

        expect(mockInngestSend).toHaveBeenCalledWith({
          name: 'app/entity-document-link.batch-sync.requested',
          data: {
            linkIds: ['link-1', 'link-2'],
            options: { batchSize: 5 },
          },
        });
      });
    });
  });
});
