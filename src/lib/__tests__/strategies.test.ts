/**
 * Unit Tests for Strategies Module
 *
 * Tests all strategy management functions including:
 * - CRUD operations (Create, Read, Update, Delete, Bulk Delete)
 * - Directive management (add, remove, update)
 * - Document management (add, remove, AI extraction)
 * - AI summary generation
 * - Migration utilities
 * - Error handling across all operations
 *
 * @jest-environment node
 */

import type { Strategy, StrategyDirective, StrategyDocument } from '../types';

// Mock firebase with jest.fn() in factory (proper hoisting pattern)
jest.mock('../firebase', () => ({
  db: {},
  removeUndefinedFields: jest.fn((obj: Record<string, unknown>) => {
    const result: Record<string, unknown> = {};
    for (const key in obj) {
      if (obj[key] !== undefined) {
        result[key] = obj[key];
      }
    }
    return result;
  }),
}));

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  arrayUnion: jest.fn((val: unknown) => ({ __arrayUnion: val })),
  arrayRemove: jest.fn((val: unknown) => ({ __arrayRemove: val })),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  runTransaction: jest.fn(),
  writeBatch: jest.fn(() => ({
    delete: jest.fn(),
    commit: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock entity-factory to break runTransaction dependency
let entityCounter = 0;
jest.mock('../entity-factory', () => ({
  createEntity: jest.fn().mockImplementation(async (_type: string, data: Record<string, unknown>) => {
    entityCounter++;
    return {
      entity: { ...data, id: `strategy-${entityCounter}`, slug: `test-strategy-${entityCounter}`, createdAt: Date.now(), updatedAt: Date.now() },
      isNew: true,
    };
  }),
  DuplicateEntityError: class DuplicateEntityError extends Error {
    public readonly entityType: string;
    public readonly field: string;
    public readonly value: string;
    public readonly existingId: string;
    constructor(entityType: string, field: string, value: string, existingId: string) {
      super(`${entityType} with ${field} "${value}" already exists (ID: ${existingId})`);
      this.name = 'DuplicateEntityError';
      this.entityType = entityType;
      this.field = field;
      this.value = value;
      this.existingId = existingId;
    }
  },
}));

// Mock inngest client
jest.mock('../inngest/client', () => ({
  inngest: {
    send: jest.fn().mockResolvedValue(undefined),
    createFunction: jest.fn().mockReturnValue(jest.fn()),
  },
}));

// Mock entity sync helper
jest.mock('../entity-sync', () => ({
  EntitySyncDispatchError: class EntitySyncDispatchError extends Error {
    constructor(_entityType: string, _entityId: string, _operation: string, cause: unknown) {
      super(cause instanceof Error ? cause.message : String(cause));
      this.name = 'EntitySyncDispatchError';
    }
  },
  requestEntityGraphSync: jest.fn().mockResolvedValue(undefined),
  triggerEntitySync: jest.fn().mockResolvedValue(undefined),
  requestEntityGraphDeletion: jest.fn().mockResolvedValue(undefined),
  requestEntityGraphDeletions: jest.fn(async (_type: string, ids: string[]) => ({
    acknowledged: [...ids],
    failed: [],
  })),
}));

// Mock data-refresh events
jest.mock('../events/data-refresh', () => ({
  emitDataRefresh: jest.fn(),
}));

// Mock relations (used by deleteStrategy via dynamic import)
jest.mock('../relations', () => ({
  deleteRelationsForEntity: jest.fn().mockResolvedValue(0),
}));

const mockDeleteLinksForEntity = jest.fn().mockResolvedValue(0);
jest.mock('../entity-document-link-service', () => ({
  deleteLinksForEntity: mockDeleteLinksForEntity,
}));

const mockDeleteAllEntityNotes = jest.fn().mockResolvedValue(0);
jest.mock('../entity-notes-cleanup', () => ({
  deleteAllEntityNotes: mockDeleteAllEntityNotes,
}));

jest.mock('../entity-reference-cleanup', () => ({
  ENTITY_REFERENCE_CLEANUP_BATCH_SIZE: 450,
  preflightEntityReferenceCleanup: jest.fn(async (entityType: string, entityId: string) => ({
    entityType,
    entityId,
    ownedReferences: [],
    liveArrayReferences: [],
  })),
  preflightEntityReferenceCleanups: jest.fn(async (entityType: string, entityIds: string[]) => ({
    prepared: entityIds.map((id) => ({
      id,
      plan: { entityType, entityId: id, ownedReferences: [], liveArrayReferences: [] },
    })),
    failed: [],
  })),
  applyEntityReferenceCleanup: jest.fn().mockResolvedValue({
    ownedReferencesDeleted: 0,
    liveReferencesRemoved: 0,
    delegatedReferences: 0,
    batchesCommitted: 0,
  }),
}));

// Mock AI client (used by generateStrategyAISummary via dynamic import)
jest.mock('../ai', () => ({
  generateContent: jest.fn().mockResolvedValue('AI-generated summary of the strategy.'),
}));

// Import mocked modules to get references
import { getDocs, getDoc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { createEntity, DuplicateEntityError } from '../entity-factory';
import {
  EntitySyncDispatchError,
  requestEntityGraphDeletion,
  requestEntityGraphDeletions,
  triggerEntitySync,
  requestEntityGraphSync,
} from '../entity-sync';
import { emitDataRefresh } from '../events/data-refresh';
import { deleteRelationsForEntity } from '../relations';

// Cast to jest.Mock for type safety
const mockGetDocs = getDocs as jest.Mock;
const mockGetDoc = getDoc as jest.Mock;
const mockUpdateDoc = updateDoc as jest.Mock;
const mockDeleteDoc = deleteDoc as jest.Mock;
const mockWriteBatch = writeBatch as jest.Mock;
const {
  preflightEntityReferenceCleanup: mockPreflightEntityReferenceCleanup,
  preflightEntityReferenceCleanups: mockPreflightEntityReferenceCleanups,
  applyEntityReferenceCleanup: mockApplyEntityReferenceCleanup,
} = jest.requireMock('../entity-reference-cleanup') as {
  preflightEntityReferenceCleanup: jest.Mock;
  preflightEntityReferenceCleanups: jest.Mock;
  applyEntityReferenceCleanup: jest.Mock;
};
const mockCreateEntity = createEntity as jest.Mock;
const mockTriggerSync = triggerEntitySync as jest.Mock;
const mockRequestGraphSync = requestEntityGraphSync as jest.Mock;
const mockRequestEntityGraphDeletion = requestEntityGraphDeletion as jest.Mock;
const mockRequestEntityGraphDeletions = requestEntityGraphDeletions as jest.Mock;
const mockEmitDataRefresh = emitDataRefresh as jest.Mock;
const mockDeleteRelations = deleteRelationsForEntity as jest.Mock;

// Import functions after mocking
import {
  getStrategies,
  getStrategyById,
  createStrategy,
  updateStrategy,
  deleteStrategy,
  deleteStrategies,
  addDirectiveToStrategy,
  removeDirectiveFromStrategy,
  updateDirective,
  addDocumentToStrategy,
  removeDocumentFromStrategy,
  updateDocumentAIExtraction,
  generateStrategyAISummary,
  regenerateAllStrategySummaries,
  migrateStrategy,
  migrateAllStrategies,
} from '../strategies';

/**
 * Helper to create a mock Strategy for testing
 */
function createMockStrategy(overrides?: Partial<Strategy>): Strategy {
  return {
    id: 'strategy-1',
    name: 'Digital Transformation 2025',
    slug: 'digital-transformation-2025',
    description: 'Drive digital innovation across business units',
    mainDirectives: [
      {
        id: 'dir-1',
        directive: 'Adopt cloud-native architecture',
        category: 'Innovation',
        priority: 8,
        metrics: {
          target: '100% cloud migration',
          timeline: 'by 2026',
          baseline: 'Current: 30%',
        },
      },
      {
        id: 'dir-2',
        directive: 'Reduce operational costs by 20%',
        category: 'Efficiency',
        priority: 7,
      },
    ],
    content: '# Digital Transformation Strategy\n\nThis strategy outlines our path to digital excellence.',
    documents: [
      {
        id: 'doc-1',
        name: 'Strategic Plan Q1.pdf',
        type: 'upload',
        url: 'https://storage.example.com/plan-q1.pdf',
        uploadedAt: 1700000000000,
      },
    ],
    links: [{ title: 'Industry Report', url: 'https://example.com/report' }],
    aiGeneratedSummary: 'Focus on cloud-native and cost reduction.',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

/**
 * Helper to create a mock Firestore document snapshot
 */
function createMockDocSnap(data: Strategy | null) {
  return {
    exists: () => data !== null,
    data: () => data,
  };
}

describe('Strategies Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    entityCounter = 0;
  });

  // =========================================================================
  // CRUD Operations
  // =========================================================================

  describe('getStrategies()', () => {
    it('should fetch all strategies from Firestore', async () => {
      // Arrange
      const mockStrategies = [
        createMockStrategy({ id: 'strategy-1', name: 'Strategy A' }),
        createMockStrategy({ id: 'strategy-2', name: 'Strategy B' }),
      ];
      mockGetDocs.mockResolvedValueOnce({
        docs: mockStrategies.map(s => ({ data: () => s })),
      });

      // Act
      const result = await getStrategies();

      // Assert
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Strategy A');
      expect(result[1].name).toBe('Strategy B');
      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no strategies exist', async () => {
      // Arrange
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      // Act
      const result = await getStrategies();

      // Assert
      expect(result).toEqual([]);
    });

    it('should throw descriptive error on Firestore failure', async () => {
      // Arrange
      mockGetDocs.mockRejectedValueOnce(new Error('Firestore unavailable'));

      // Act & Assert
      await expect(getStrategies()).rejects.toThrow('Failed to fetch strategies');
    });
  });

  describe('getStrategyById()', () => {
    it('should return strategy when found', async () => {
      // Arrange
      const mockStrategy = createMockStrategy();
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));

      // Act
      const result = await getStrategyById('strategy-1');

      // Assert
      expect(result).toEqual(mockStrategy);
      expect(result?.name).toBe('Digital Transformation 2025');
      expect(mockGetDoc).toHaveBeenCalledTimes(1);
    });

    it('should return null when strategy does not exist', async () => {
      // Arrange
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(null));

      // Act
      const result = await getStrategyById('nonexistent');

      // Assert
      expect(result).toBeNull();
    });

    it('should throw descriptive error on Firestore failure', async () => {
      // Arrange
      mockGetDoc.mockRejectedValueOnce(new Error('Permission denied'));

      // Act & Assert
      await expect(getStrategyById('strategy-1')).rejects.toThrow('Failed to fetch strategy strategy-1');
    });
  });

  describe('createStrategy()', () => {
    it('should create a strategy with all required fields', async () => {
      // Arrange
      const input = {
        name: 'Sustainability Plan',
        description: 'Green initiatives strategy',
        mainDirectives: [] as StrategyDirective[],
        content: '# Sustainability\n\nGo green.',
        documents: [] as StrategyDocument[],
        links: [] as { title: string; url: string }[],
      };

      // Act
      const result = await createStrategy(input);

      // Assert
      expect(result.id).toBe('strategy-1');
      expect(result.name).toBe('Sustainability Plan');
      expect(mockCreateEntity).toHaveBeenCalledTimes(1);
      // GRAPH-058: creates must ask for a REQUIRED graph handoff so a lost
      // dispatch is surfaceable as saved-locally instead of vanishing.
      expect(mockCreateEntity).toHaveBeenCalledWith(
        'strategy',
        expect.objectContaining({
          name: 'Sustainability Plan',
          mainDirectives: [],
          documents: [],
          links: [],
        }),
        { graphSync: 'required' }
      );
    });

    it('should default mainDirectives and documents to empty arrays when not provided', async () => {
      // Arrange
      const input = {
        name: 'Minimal Strategy',
        description: 'Bare minimum',
        content: 'Content here',
      } as Omit<Strategy, 'id' | 'slug' | 'createdAt' | 'updatedAt'>;

      // Act
      await createStrategy(input);

      // Assert
      expect(mockCreateEntity).toHaveBeenCalledWith(
        'strategy',
        expect.objectContaining({
          mainDirectives: [],
          documents: [],
          links: [],
        }),
        { graphSync: 'required' }
      );
    });

    it('should leave create graph sync ownership to entity-factory', async () => {
      // Arrange
      const input = {
        name: 'Sync Test',
        description: 'Testing sync',
        content: 'Content',
        mainDirectives: [] as StrategyDirective[],
        documents: [] as StrategyDocument[],
        links: [] as { title: string; url: string }[],
      };

      // Act
      await createStrategy(input);

      // Assert
      expect(mockTriggerSync).not.toHaveBeenCalled();
    });

    it('should throw validation error when name is missing', async () => {
      // Arrange
      const input = {
        name: '',
        description: 'No name',
        content: 'Content',
      } as Omit<Strategy, 'id' | 'slug' | 'createdAt' | 'updatedAt'>;

      // Act & Assert
      await expect(createStrategy(input)).rejects.toThrow('Strategy name and description are required');
    });

    it('should throw validation error when description is missing', async () => {
      // Arrange
      const input = {
        name: 'Name Only',
        description: '',
        content: 'Content',
      } as Omit<Strategy, 'id' | 'slug' | 'createdAt' | 'updatedAt'>;

      // Act & Assert
      await expect(createStrategy(input)).rejects.toThrow('Strategy name and description are required');
    });

    it('should re-throw DuplicateEntityError from entity-factory', async () => {
      // Arrange
      mockCreateEntity.mockRejectedValueOnce(new DuplicateEntityError('Strategy', 'slug', 'duplicate-strategy', 'existing-id'));

      const input = {
        name: 'Duplicate Strategy',
        description: 'Already exists',
        content: 'Content',
        mainDirectives: [] as StrategyDirective[],
        documents: [] as StrategyDocument[],
        links: [] as { title: string; url: string }[],
      };

      // Act & Assert
      await expect(createStrategy(input)).rejects.toThrow('already exists');
    });
  });

  describe('updateStrategy()', () => {
    it('should update existing strategy fields', async () => {
      // Arrange
      const mockStrategy = createMockStrategy();
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      // Act
      await updateStrategy('strategy-1', { description: 'Updated description' });

      // Assert
      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updatePayload = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updatePayload.description).toBe('Updated description');
    });

    it('should add updatedAt timestamp to updates', async () => {
      // Arrange
      const mockStrategy = createMockStrategy();
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      // Act
      await updateStrategy('strategy-1', { name: 'New Name' });

      // Assert
      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.updatedAt).toBeDefined();
      expect(typeof updateCall.updatedAt).toBe('number');
    });

    it('requires an acknowledged Neo4j handoff after update', async () => {
      // Arrange
      const mockStrategy = createMockStrategy();
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      // Act
      await updateStrategy('strategy-1', { name: 'Updated' });

      // Assert — GRAPH-058: awaited and required, not fire-and-forget. The
      // event carries identifiers only; the worker re-reads Firestore.
      expect(mockRequestGraphSync).toHaveBeenCalledWith('strategy', 'strategy-1', 'update');
      expect(mockTriggerSync).not.toHaveBeenCalled();
    });

    it('surfaces an unacknowledged handoff instead of wrapping it as a failed update', async () => {
      const mockStrategy = createMockStrategy();
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      mockUpdateDoc.mockResolvedValueOnce(undefined);
      const dispatchError = new EntitySyncDispatchError('strategy', 'strategy-1', 'update', new Error('queue down'));
      mockRequestGraphSync.mockRejectedValueOnce(dispatchError);

      // The generic wrapper would have hidden the identity the saved-locally
      // resolver keys on, and the Firestore write is already committed.
      await expect(updateStrategy('strategy-1', { name: 'Updated' })).rejects.toBe(dispatchError);
    });

    it('should throw when strategy does not exist', async () => {
      // Arrange
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(null));

      // Act & Assert
      await expect(
        updateStrategy('nonexistent', { name: 'Fail' }),
      ).rejects.toThrow('Failed to update strategy nonexistent');
    });

    it('should throw on Firestore update failure', async () => {
      // Arrange
      const mockStrategy = createMockStrategy();
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      mockUpdateDoc.mockRejectedValueOnce(new Error('Write failed'));

      // Act & Assert
      await expect(
        updateStrategy('strategy-1', { name: 'Fail' }),
      ).rejects.toThrow('Failed to update strategy strategy-1');
    });
  });

  describe('deleteStrategy()', () => {
    it('should delete strategy and clean up relations', async () => {
      // Arrange
      mockDeleteRelations.mockResolvedValueOnce(3);
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      // Act
      await deleteStrategy('strategy-1');

      // Assert
      expect(mockPreflightEntityReferenceCleanup).toHaveBeenCalledWith(
        'strategy',
        'strategy-1',
        expect.anything()
      );
      expect(mockApplyEntityReferenceCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'strategy', entityId: 'strategy-1' }),
        expect.anything()
      );
      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('strategy', 'strategy-1');
      expect(mockDeleteRelations).toHaveBeenCalledWith('strategy-1');
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
      expect(mockRequestEntityGraphDeletion.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteLinksForEntity.mock.invocationCallOrder[0]
      );
      expect(mockDeleteLinksForEntity.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteRelations.mock.invocationCallOrder[0]
      );
      expect(mockDeleteRelations.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteAllEntityNotes.mock.invocationCallOrder[0]
      );
      expect(mockDeleteAllEntityNotes.mock.invocationCallOrder[0]).toBeLessThan(
        mockApplyEntityReferenceCleanup.mock.invocationCallOrder[0]
      );
      expect(mockApplyEntityReferenceCleanup.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteDoc.mock.invocationCallOrder[0]
      );
    });

    it('should require Neo4j deletion delivery before deleting Firestore', async () => {
      // Arrange
      mockDeleteRelations.mockResolvedValueOnce(0);
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      // Act
      await deleteStrategy('strategy-1');

      // Assert
      expect(mockRequestEntityGraphDeletion).toHaveBeenCalledWith('strategy', 'strategy-1');
      expect(mockRequestEntityGraphDeletion.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteDoc.mock.invocationCallOrder[0]
      );
    });

    it('should retain the Firestore document when graph deletion is not acknowledged', async () => {
      mockRequestEntityGraphDeletion.mockRejectedValueOnce(
        new EntitySyncDispatchError('strategy', 'strategy-1', 'delete', new Error('handoff failed'))
      );

      await expect(deleteStrategy('strategy-1')).rejects.toThrow('handoff failed');

      expect(mockDeleteRelations).not.toHaveBeenCalled();
      expect(mockDeleteAllEntityNotes).not.toHaveBeenCalled();
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('should throw on Firestore deletion failure', async () => {
      // Arrange
      mockDeleteRelations.mockResolvedValueOnce(0);
      mockDeleteDoc.mockRejectedValueOnce(new Error('Permission denied'));

      // Act & Assert
      await expect(deleteStrategy('strategy-1')).rejects.toThrow('Failed to delete strategy strategy-1');
    });

    it('retains the parent when note cleanup fails', async () => {
      mockDeleteAllEntityNotes.mockRejectedValueOnce(new Error('note cleanup failed'));

      await expect(deleteStrategy('strategy-1')).rejects.toThrow('Failed to delete strategy strategy-1');
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when live-reference cleanup fails', async () => {
      const cause = new Error('reference cleanup failed');
      mockApplyEntityReferenceCleanup.mockRejectedValueOnce(cause);

      await expect(deleteStrategy('strategy-1')).rejects.toMatchObject({
        message: 'Failed to delete strategy strategy-1',
        cause,
      });
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });
  });

  describe('deleteStrategies() - bulk delete', () => {
    it('preflights every ID before graph handoff and isolates a failed preflight', async () => {
      const cleanupPlan = {
        entityType: 'strategy',
        entityId: 's-1',
        ownedReferences: [],
        liveArrayReferences: [],
      };
      mockPreflightEntityReferenceCleanups.mockResolvedValueOnce({
        prepared: [{ id: 's-1', plan: cleanupPlan }],
        failed: [{ id: 's-2', error: new Error('blocked') }],
      });
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteRelations.mockResolvedValue(0);

      const result = await deleteStrategies(['s-1', 's-2']);

      expect(result).toEqual({ deleted: 1, failed: ['s-2'], relationsDeleted: 0 });
      expect(mockPreflightEntityReferenceCleanups).toHaveBeenCalledWith(
        'strategy',
        ['s-1', 's-2'],
        expect.anything()
      );
      expect(mockPreflightEntityReferenceCleanups.mock.invocationCallOrder[0]).toBeLessThan(
        mockRequestEntityGraphDeletions.mock.invocationCallOrder[0]
      );
      expect(mockRequestEntityGraphDeletions).toHaveBeenCalledWith('strategy', ['s-1']);
      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('strategy', 's-1');
      expect(mockDeleteLinksForEntity).not.toHaveBeenCalledWith('strategy', 's-2');
      expect(mockApplyEntityReferenceCleanup).toHaveBeenCalledWith(cleanupPlan, expect.anything());
      expect(mockBatch.delete).toHaveBeenCalledTimes(1);
    });

    it('should delete multiple strategies in a batch', async () => {
      // Arrange
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteRelations.mockResolvedValue(1);

      // Act
      const result = await deleteStrategies(['s-1', 's-2', 's-3']);

      // Assert
      expect(result.deleted).toBe(3);
      expect(result.failed).toEqual([]);
      expect(result.relationsDeleted).toBe(3); // 1 per entity
      expect(mockBatch.delete).toHaveBeenCalledTimes(3);
      expect(mockBatch.commit).toHaveBeenCalledTimes(1);
    });

    it('should emit data refresh after successful bulk delete', async () => {
      // Arrange
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteRelations.mockResolvedValue(0);

      // Act
      await deleteStrategies(['s-1']);

      // Assert
      expect(mockEmitDataRefresh).toHaveBeenCalledWith('strategies', 'bulk-delete');
    });

    it('should report failures when batch commit fails', async () => {
      // Arrange
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockRejectedValue(new Error('Batch failed')) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteRelations.mockResolvedValue(0);

      // Act
      const result = await deleteStrategies(['s-1', 's-2']);

      // Assert
      expect(result.deleted).toBe(0);
      expect(result.failed).toEqual(['s-1', 's-2']);
    });

    it('retains only the strategy whose document-link cleanup fails', async () => {
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteLinksForEntity
        .mockResolvedValueOnce(0)
        .mockRejectedValueOnce(new Error('link cleanup failed'));
      mockDeleteRelations.mockResolvedValue(1);

      const result = await deleteStrategies(['s-1', 's-2']);

      expect(result).toEqual({ deleted: 1, failed: ['s-2'], relationsDeleted: 1 });
      expect(mockBatch.delete).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Directive Management
  // =========================================================================

  describe('addDirectiveToStrategy()', () => {
    it('should add a directive using arrayUnion', async () => {
      // Arrange
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const directive: Omit<StrategyDirective, 'id'> = {
        directive: 'Expand to 3 new markets',
        category: 'Growth',
        priority: 9,
      };

      // Act
      const directiveId = await addDirectiveToStrategy('strategy-1', directive);

      // Assert
      expect(directiveId).toMatch(/^dir-\d+$/);
      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updatePayload = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(typeof updatePayload.updatedAt).toBe('number');
    });

    it('should throw on Firestore failure', async () => {
      // Arrange
      mockUpdateDoc.mockRejectedValueOnce(new Error('Write failed'));

      // Act & Assert
      await expect(
        addDirectiveToStrategy('strategy-1', { directive: 'Test', category: 'Growth', priority: 5 }),
      ).rejects.toThrow('Failed to add directive to strategy strategy-1');
    });
  });

  describe('removeDirectiveFromStrategy()', () => {
    it('should remove directive by filtering out matching ID', async () => {
      // Arrange
      const mockStrategy = createMockStrategy();
      // First getDoc call for getStrategyById
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      // Second getDoc call for updateStrategy -> getDoc check
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      // Act
      await removeDirectiveFromStrategy('strategy-1', 'dir-1');

      // Assert
      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      const directives = updateCall.mainDirectives as StrategyDirective[];
      expect(directives).toHaveLength(1);
      expect(directives[0].id).toBe('dir-2');
    });

    it('should throw when strategy not found', async () => {
      // Arrange
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(null));

      // Act & Assert
      await expect(
        removeDirectiveFromStrategy('nonexistent', 'dir-1'),
      ).rejects.toThrow('Failed to remove directive');
    });

    it('should throw when directive not found in strategy', async () => {
      // Arrange
      const mockStrategy = createMockStrategy();
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));

      // Act & Assert
      await expect(
        removeDirectiveFromStrategy('strategy-1', 'dir-nonexistent'),
      ).rejects.toThrow('Failed to remove directive');
    });
  });

  describe('updateDirective()', () => {
    it('should update a specific directive within the strategy', async () => {
      // Arrange
      const mockStrategy = createMockStrategy();
      // First getDoc call for getStrategyById in updateDirective
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      // Second getDoc call for updateStrategy -> getDoc check
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      // Act
      await updateDirective('strategy-1', 'dir-1', { priority: 10 });

      // Assert
      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      const directives = updateCall.mainDirectives as StrategyDirective[];
      expect(directives[0].priority).toBe(10);
      expect(directives[0].id).toBe('dir-1');
    });

    it('should throw when directive not found', async () => {
      // Arrange
      const mockStrategy = createMockStrategy();
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));

      // Act & Assert
      await expect(
        updateDirective('strategy-1', 'dir-nonexistent', { priority: 5 }),
      ).rejects.toThrow('Failed to update directive');
    });

    it('should throw when strategy not found', async () => {
      // Arrange
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(null));

      // Act & Assert
      await expect(
        updateDirective('nonexistent', 'dir-1', { priority: 5 }),
      ).rejects.toThrow('Failed to update directive');
    });
  });

  // =========================================================================
  // Document Management
  // =========================================================================

  describe('addDocumentToStrategy()', () => {
    it('should add a document using arrayUnion', async () => {
      // Arrange
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const document: Omit<StrategyDocument, 'id'> = {
        name: 'Annual Report.pdf',
        type: 'upload',
        url: 'https://storage.example.com/annual-report.pdf',
        uploadedAt: Date.now(),
      };

      // Act
      const documentId = await addDocumentToStrategy('strategy-1', document);

      // Assert
      expect(documentId).toMatch(/^doc-\d+$/);
      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
    });

    it('should throw on Firestore failure', async () => {
      // Arrange
      mockUpdateDoc.mockRejectedValueOnce(new Error('Write failed'));

      // Act & Assert
      await expect(
        addDocumentToStrategy('strategy-1', { name: 'Test', type: 'link', url: 'https://example.com', uploadedAt: Date.now() }),
      ).rejects.toThrow('Failed to add document to strategy strategy-1');
    });
  });

  describe('removeDocumentFromStrategy()', () => {
    it('should remove document by filtering out matching ID', async () => {
      // Arrange
      const mockStrategy = createMockStrategy();
      // First getDoc for getStrategyById
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      // Second getDoc for updateStrategy
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      // Act
      await removeDocumentFromStrategy('strategy-1', 'doc-1');

      // Assert
      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      const documents = updateCall.documents as StrategyDocument[];
      expect(documents).toHaveLength(0);
    });

    it('should throw when document not found in strategy', async () => {
      // Arrange
      const mockStrategy = createMockStrategy();
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));

      // Act & Assert
      await expect(
        removeDocumentFromStrategy('strategy-1', 'doc-nonexistent'),
      ).rejects.toThrow('Failed to remove document');
    });
  });

  describe('updateDocumentAIExtraction()', () => {
    it('should update AI extraction for a specific document', async () => {
      // Arrange
      const mockStrategy = createMockStrategy();
      // First getDoc for getStrategyById
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      // Second getDoc for updateStrategy
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const aiExtraction = {
        summary: 'Document covers sustainability initiatives.',
        keyPoints: ['Renewable energy', 'Carbon reduction'],
        extractedDirectives: ['Transition to 100% renewable by 2026'],
        processedAt: Date.now(),
      };

      // Act
      await updateDocumentAIExtraction('strategy-1', 'doc-1', aiExtraction);

      // Assert
      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      const documents = updateCall.documents as StrategyDocument[];
      expect(documents[0].aiExtraction).toEqual(aiExtraction);
    });

    it('should throw when document not found', async () => {
      // Arrange
      const mockStrategy = createMockStrategy();
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));

      // Act & Assert
      await expect(
        updateDocumentAIExtraction('strategy-1', 'doc-nonexistent', {
          summary: 'Test',
          keyPoints: [],
          extractedDirectives: [],
          processedAt: Date.now(),
        }),
      ).rejects.toThrow('Failed to update document AI extraction');
    });

    it('should throw when strategy not found', async () => {
      // Arrange
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(null));

      // Act & Assert
      await expect(
        updateDocumentAIExtraction('nonexistent', 'doc-1', {
          summary: 'Test',
          keyPoints: [],
          extractedDirectives: [],
          processedAt: Date.now(),
        }),
      ).rejects.toThrow('Failed to update document AI extraction');
    });
  });

  // =========================================================================
  // AI Summary Generation
  // =========================================================================

  describe('generateStrategyAISummary()', () => {
    it('should generate and save AI summary for a strategy', async () => {
      // Arrange
      const mockStrategy = createMockStrategy();
      // First getDoc for getStrategyById in generateStrategyAISummary
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      // Second getDoc for updateStrategy call
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(mockStrategy));
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      // Act
      const summary = await generateStrategyAISummary('strategy-1');

      // Assert
      expect(summary).toBe('AI-generated summary of the strategy.');
      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
    });

    it('should throw when strategy not found', async () => {
      // Arrange
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(null));

      // Act & Assert
      await expect(generateStrategyAISummary('nonexistent')).rejects.toThrow('Failed to generate AI summary');
    });
  });

  describe('regenerateAllStrategySummaries()', () => {
    it('should regenerate summaries for all strategies', async () => {
      // Arrange
      const strategies = [
        createMockStrategy({ id: 'strategy-1' }),
        createMockStrategy({ id: 'strategy-2' }),
      ];
      // getStrategies call
      mockGetDocs.mockResolvedValueOnce({
        docs: strategies.map(s => ({ data: () => s })),
      });
      // Two rounds of getStrategyById + updateStrategy per strategy
      for (let i = 0; i < 2; i++) {
        mockGetDoc.mockResolvedValueOnce(createMockDocSnap(strategies[i]));
        mockGetDoc.mockResolvedValueOnce(createMockDocSnap(strategies[i]));
        mockUpdateDoc.mockResolvedValueOnce(undefined);
      }

      // Act
      const count = await regenerateAllStrategySummaries();

      // Assert
      expect(count).toBe(2);
    });

    it('should continue when individual summary generation fails', async () => {
      // Arrange
      const strategies = [
        createMockStrategy({ id: 'strategy-1' }),
        createMockStrategy({ id: 'strategy-2' }),
      ];
      // getStrategies call
      mockGetDocs.mockResolvedValueOnce({
        docs: strategies.map(s => ({ data: () => s })),
      });
      // First strategy fails (not found)
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(null));
      // Second strategy succeeds
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(strategies[1]));
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(strategies[1]));
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      // Act
      const count = await regenerateAllStrategySummaries();

      // Assert
      expect(count).toBe(1);
    });
  });

  // =========================================================================
  // Migration Utilities
  // =========================================================================

  describe('migrateStrategy()', () => {
    it('should add default fields to unmigrated strategy', async () => {
      // Arrange
      const unmigratedStrategy = createMockStrategy({
        mainDirectives: undefined as unknown as StrategyDirective[],
        documents: undefined as unknown as StrategyDocument[],
      });
      // First getDoc for getStrategyById in migrateStrategy
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(unmigratedStrategy));
      // Second getDoc for updateStrategy
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(unmigratedStrategy));
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      // Act
      await migrateStrategy('strategy-1');

      // Assert
      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.mainDirectives).toEqual([]);
      expect(updateCall.documents).toEqual([]);
    });

    it('should skip already-migrated strategy', async () => {
      // Arrange
      const migratedStrategy = createMockStrategy(); // already has mainDirectives and documents
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(migratedStrategy));

      // Act
      await migrateStrategy('strategy-1');

      // Assert
      expect(mockUpdateDoc).not.toHaveBeenCalled();
    });

    it('should throw when strategy not found', async () => {
      // Arrange
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(null));

      // Act & Assert
      await expect(migrateStrategy('nonexistent')).rejects.toThrow('Failed to migrate strategy nonexistent');
    });
  });

  describe('migrateAllStrategies()', () => {
    it('should migrate only unmigrated strategies', async () => {
      // Arrange
      const strategies = [
        createMockStrategy({ id: 'migrated', mainDirectives: [], documents: [] }),
        createMockStrategy({
          id: 'unmigrated',
          mainDirectives: undefined as unknown as StrategyDirective[],
          documents: undefined as unknown as StrategyDocument[],
        }),
      ];
      // getStrategies
      mockGetDocs.mockResolvedValueOnce({
        docs: strategies.map(s => ({ data: () => s })),
      });
      // migrateStrategy for 'unmigrated': getStrategyById + updateStrategy(getDoc + updateDoc)
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(strategies[1]));
      mockGetDoc.mockResolvedValueOnce(createMockDocSnap(strategies[1]));
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      // Act
      const count = await migrateAllStrategies();

      // Assert
      expect(count).toBe(1);
    });

    it('should return 0 when all strategies already migrated', async () => {
      // Arrange
      const strategies = [
        createMockStrategy({ id: 'migrated-1' }),
        createMockStrategy({ id: 'migrated-2' }),
      ];
      mockGetDocs.mockResolvedValueOnce({
        docs: strategies.map(s => ({ data: () => s })),
      });

      // Act
      const count = await migrateAllStrategies();

      // Assert
      expect(count).toBe(0);
      expect(mockUpdateDoc).not.toHaveBeenCalled();
    });
  });
});
