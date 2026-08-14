/**
 * Unit Tests for Initiatives Module
 *
 * Tests all initiative management functions including:
 * - CRUD operations (Create, Read, Update, Delete)
 * - Filtering by status, priority, type, org unit
 * - Statistics and metrics calculation
 *
 * @jest-environment node
 */

import type { Initiative, InitiativeStatus, InitiativePriority } from '../types';

// Mock firebase with jest.fn() in factory (proper hoisting pattern)
jest.mock('../firebase', () => ({
  db: {},
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
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  runTransaction: jest.fn(),
  limit: jest.fn(),
}));

// Mock entity-factory: createEntity returns a fake entity with id/slug/timestamps
jest.mock('../entity-factory', () => ({
  __esModule: true,
  createEntity: jest.fn((_type: string, data: Record<string, unknown>) => {
    const id = `initiative-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const now = Date.now();
    return Promise.resolve({
      entity: { ...data, id, slug: 'mock-slug', createdAt: now, updatedAt: now },
      created: true,
    });
  }),
  DuplicateEntityError: class DuplicateEntityError extends Error {
    entityType: string;
    field: string;
    value: string;
    existingId: string;
    constructor(entityType: string, field: string, value: string, existingId: string) {
      super(`${entityType} with ${field} "${value}" already exists (ID: ${existingId})`);
      this.name = 'DuplicateEntityError';
      this.entityType = entityType;
      this.field = field;
      this.value = value;
      this.existingId = existingId;
    }
  },
  generateSlug: jest.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
}));

// Mock Neo4j sync
jest.mock('../inngest/functions/sync-entity-to-neo4j', () => ({
  triggerUnifiedEntitySync: jest.fn().mockResolvedValue(undefined),
}));

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
}));

// Mock relations for cascade delete
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
  preflightEntityReferenceCleanup: jest.fn(async (entityType: string, entityId: string) => ({
    entityType,
    entityId,
    ownedReferences: [],
    liveArrayReferences: [],
  })),
  applyEntityReferenceCleanup: jest.fn().mockResolvedValue(undefined),
}));

// Import mocked modules to get references
import { getDocs, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { createEntity } from '../entity-factory';

// Cast to jest.Mock for type safety
const mockGetDocs = getDocs as jest.Mock;
const mockGetDoc = getDoc as jest.Mock;
const _mockSetDoc = setDoc as jest.Mock;
const mockUpdateDoc = updateDoc as jest.Mock;
const mockDeleteDoc = deleteDoc as jest.Mock;
const mockCreateEntity = createEntity as jest.Mock;
const {
  preflightEntityReferenceCleanup: mockPreflightEntityReferenceCleanup,
  applyEntityReferenceCleanup: mockApplyEntityReferenceCleanup,
} = jest.requireMock('../entity-reference-cleanup') as {
  preflightEntityReferenceCleanup: jest.Mock;
  applyEntityReferenceCleanup: jest.Mock;
};
const {
  triggerEntitySync: mockTriggerSync,
  requestEntityGraphSync: mockRequestGraphSync,
  requestEntityGraphDeletion: mockRequestEntityGraphDeletion,
} = jest.requireMock('../entity-sync') as {
  triggerEntitySync: jest.Mock;
  requestEntityGraphSync: jest.Mock;
  requestEntityGraphDeletion: jest.Mock;
};

// Import functions after mocking
import {
  getInitiatives,
  getInitiativeById,
  createInitiative,
  updateInitiative,
  deleteInitiative,
  getInitiativesWithFilters,
  getInitiativesByOrgUnit,
  getInitiativeStats,
} from '../initiatives';

/**
 * Helper to create a mock initiative for testing
 */
function createMockInitiative(overrides?: Partial<Initiative>): Initiative {
  return {
    id: 'init-123',
    slug: 'ai-transformation',
    name: 'AI Transformation',
    description: 'Enterprise-wide AI adoption initiative',
    status: 'active',  // Valid status per InitiativeStatus type
    priority: 'high',
    ownerOrgUnitId: 'org-123',
    ownerOrgUnitName: 'Innovation Department',
    sponsorUserId: 'user-123',
    sponsorName: 'John Smith',
    startDate: Date.now() - 90 * 24 * 60 * 60 * 1000,
    targetEndDate: Date.now() + 180 * 24 * 60 * 60 * 1000,
    budget: 1000000,
    linkedStrategyIds: ['strategy-123'],
    linkedPrototypeIds: ['proto-456'],
    linkedPainPointIds: ['pain-789'],
    milestones: [
      {
        id: 'milestone-1',
        title: 'Phase 1 Complete',
        targetDate: Date.now() - 30 * 24 * 60 * 60 * 1000,
        status: 'completed',
        completedDate: Date.now() - 35 * 24 * 60 * 60 * 1000,
      },
    ],
    tags: ['ai', 'digital', 'transformation'],
    createdAt: Date.now() - 90 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('Initiatives Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getInitiatives()', () => {
    it('should fetch all initiatives ordered by priority', async () => {
      const mockInitiatives = [
        createMockInitiative({ id: 'init-1', name: 'Initiative 1', priority: 'critical' }),
        createMockInitiative({ id: 'init-2', name: 'Initiative 2', priority: 'high' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockInitiatives.map((i) => ({ data: () => i })),
      });

      const result = await getInitiatives();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Initiative 1');
      expect(result[1].name).toBe('Initiative 2');
      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no initiatives exist', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getInitiatives();

      expect(result).toEqual([]);
      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should handle errors gracefully', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getInitiatives()).rejects.toThrow('Firestore error');
    });
  });

  describe('getInitiativeById()', () => {
    it('should fetch an initiative by ID', async () => {
      const mockInitiative = createMockInitiative();
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => mockInitiative,
      });

      const result = await getInitiativeById('init-123');

      expect(result).toEqual(mockInitiative);
      expect(mockGetDoc).toHaveBeenCalledTimes(1);
    });

    it('should return null when initiative does not exist', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => false,
      });

      const result = await getInitiativeById('nonexistent');

      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getInitiativeById('init-123')).rejects.toThrow('Firestore error');
    });
  });

  describe('createInitiative()', () => {
    it('should create a new initiative with generated ID', async () => {
      const newInitiative = {
        name: 'New Initiative',
        description: 'Test initiative',
        status: 'proposed' as InitiativeStatus,
        priority: 'medium' as InitiativePriority,
        ownerOrgUnitId: 'org-123',
        sponsorName: 'Jane Doe',
        linkedStrategyIds: [],
        linkedPrototypeIds: [],
        linkedPainPointIds: [],
        tags: ['new'],
      };

      const result = await createInitiative(newInitiative);

      expect(result.id).toBeDefined();
      expect(result.name).toBe('New Initiative');
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(mockCreateEntity).toHaveBeenCalledTimes(1);
      // GRAPH-058: the factory is asked for a REQUIRED handoff, so a lost
      // dispatch can be surfaced as saved-locally rather than swallowed.
      expect(mockCreateEntity).toHaveBeenCalledWith('initiative', expect.anything(), { graphSync: 'required' });
      expect(mockTriggerSync).not.toHaveBeenCalled();
    });

    it('should generate unique IDs for different initiatives', async () => {
      const createInput1 = {
        name: 'Init 1',
        description: 'First initiative',
        status: 'proposed' as InitiativeStatus,
        priority: 'medium' as InitiativePriority,
        ownerOrgUnitId: 'org-123',
        linkedStrategyIds: [] as string[],
        linkedPrototypeIds: [] as string[],
        linkedPainPointIds: [] as string[],
        tags: [] as string[],
      };
      const createInput2 = {
        name: 'Init 2',
        description: 'Second initiative',
        status: 'proposed' as InitiativeStatus,
        priority: 'medium' as InitiativePriority,
        ownerOrgUnitId: 'org-123',
        linkedStrategyIds: [] as string[],
        linkedPrototypeIds: [] as string[],
        linkedPainPointIds: [] as string[],
        tags: [] as string[],
      };

      const init1 = await createInitiative(createInput1);
      const init2 = await createInitiative(createInput2);

      expect(init1.id).not.toBe(init2.id);
    });

    it('should handle creation errors', async () => {
      mockCreateEntity.mockRejectedValueOnce(new Error('Firestore error'));

      const createInput = {
        name: 'Error Initiative',
        description: 'Error initiative description',
        status: 'proposed' as InitiativeStatus,
        priority: 'medium' as InitiativePriority,
        ownerOrgUnitId: 'org-123',
        linkedStrategyIds: [] as string[],
        linkedPrototypeIds: [] as string[],
        linkedPainPointIds: [] as string[],
        tags: [] as string[],
      };

      await expect(createInitiative(createInput)).rejects.toThrow('Firestore error');
    });
  });

  describe('updateInitiative()', () => {
    it('should update an existing initiative', async () => {
      const updates = {
        name: 'Updated Name',
        status: 'completed' as InitiativeStatus,
      };

      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateInitiative('init-123', updates);

      // GRAPH-058: the update awaits a REQUIRED handoff, so a lost dispatch
      // is surfaceable as saved-locally instead of being swallowed.
      expect(mockRequestGraphSync).toHaveBeenCalledWith('initiative', 'init-123', 'update');
      expect(mockTriggerSync).not.toHaveBeenCalled();

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      // Verify the second argument (the updates) contains expected fields
      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall).toMatchObject({
        name: 'Updated Name',
        status: 'completed',
      });
      expect(typeof updateCall.updatedAt).toBe('number');
    });

    it('should update timestamp on every update', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const beforeTime = Date.now();
      await updateInitiative('init-123', { name: 'Test' });
      const afterTime = Date.now();

      const updateCall = mockUpdateDoc.mock.calls[0][1] as any;
      expect(updateCall.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(updateCall.updatedAt).toBeLessThanOrEqual(afterTime);
    });

    it('should handle update errors', async () => {
      mockUpdateDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(
        updateInitiative('init-123', { name: 'Test' })
      ).rejects.toThrow('Firestore error');
    });
  });

  describe('deleteInitiative()', () => {
    it('should delete an initiative by ID', async () => {
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deleteInitiative('init-123');

      expect(mockPreflightEntityReferenceCleanup).toHaveBeenCalledWith(
        'initiative',
        'init-123',
        expect.anything()
      );
      expect(mockApplyEntityReferenceCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'initiative', entityId: 'init-123' }),
        expect.anything()
      );
      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('initiative', 'init-123');
      expect(mockDeleteAllEntityNotes).toHaveBeenCalledWith({}, 'initiatives', 'init-123');
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
      expect(mockRequestEntityGraphDeletion).toHaveBeenCalledWith('initiative', 'init-123');
      expect(mockRequestEntityGraphDeletion.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteLinksForEntity.mock.invocationCallOrder[0]
      );
      expect(mockDeleteLinksForEntity.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteAllEntityNotes.mock.invocationCallOrder[0]
      );
      expect(mockDeleteAllEntityNotes.mock.invocationCallOrder[0]).toBeLessThan(
        mockApplyEntityReferenceCleanup.mock.invocationCallOrder[0]
      );
      expect(mockApplyEntityReferenceCleanup.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteDoc.mock.invocationCallOrder[0]
      );
    });

    it('should clean up relations before deleting', async () => {
      const { deleteRelationsForEntity } = require('../relations');
      (deleteRelationsForEntity as jest.Mock).mockResolvedValueOnce(4);
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deleteInitiative('init-123');

      expect(deleteRelationsForEntity).toHaveBeenCalledWith('init-123');
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    });

    it('should handle deletion errors', async () => {
      mockDeleteDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(deleteInitiative('init-123')).rejects.toThrow('Firestore error');
    });

    it('should retain the Firestore document when graph deletion is not acknowledged', async () => {
      mockRequestEntityGraphDeletion.mockRejectedValueOnce(new Error('handoff failed'));

      await expect(deleteInitiative('init-123')).rejects.toThrow('handoff failed');

      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when document-link cleanup fails', async () => {
      mockDeleteLinksForEntity.mockRejectedValueOnce(new Error('link cleanup failed'));

      await expect(deleteInitiative('init-123')).rejects.toThrow('link cleanup failed');
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when live-reference cleanup fails', async () => {
      mockApplyEntityReferenceCleanup.mockRejectedValueOnce(new Error('reference cleanup failed'));

      await expect(deleteInitiative('init-123')).rejects.toThrow('reference cleanup failed');
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });
  });

  describe('getInitiativesWithFilters()', () => {
    it('should filter initiatives by status', async () => {
      const mockInitiatives = [
        createMockInitiative({ id: 'init-1', status: 'active' }),
        createMockInitiative({ id: 'init-2', status: 'active' }),
        createMockInitiative({ id: 'init-3', status: 'completed' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockInitiatives.map((i) => ({ data: () => i })),
      });

      const result = await getInitiativesWithFilters({ status: ['active'] });

      expect(result).toHaveLength(2);
      expect(result.every((i) => i.status === 'active')).toBe(true);
    });

    it('should filter initiatives by priority', async () => {
      const mockInitiatives = [
        createMockInitiative({ id: 'init-1', priority: 'critical' }),
        createMockInitiative({ id: 'init-2', priority: 'critical' }),
        createMockInitiative({ id: 'init-3', priority: 'low' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockInitiatives.map((i) => ({ data: () => i })),
      });

      const result = await getInitiativesWithFilters({ priority: ['critical'] });

      expect(result).toHaveLength(2);
      expect(result.every((i) => i.priority === 'critical')).toBe(true);
    });

    it('should return empty array when no matching initiatives', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getInitiativesWithFilters({ status: ['cancelled'] });

      expect(result).toEqual([]);
    });
  });

  describe('getInitiativesByOrgUnit()', () => {
    it('should fetch initiatives filtered by org unit', async () => {
      const mockInitiatives = [
        createMockInitiative({ ownerOrgUnitId: 'org-456' }),
        createMockInitiative({ ownerOrgUnitId: 'org-456' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockInitiatives.map((i) => ({ data: () => i })),
      });

      const result = await getInitiativesByOrgUnit('org-456');

      expect(result).toHaveLength(2);
      expect(result.every((i) => i.ownerOrgUnitId === 'org-456')).toBe(true);
    });
  });

  describe('getInitiativeStats()', () => {
    it('should calculate correct statistics', async () => {
      const mockInitiatives = [
        createMockInitiative({ status: 'proposed', priority: 'critical' }),
        createMockInitiative({ status: 'active', priority: 'high' }),
        createMockInitiative({ status: 'completed', priority: 'medium' }),
        createMockInitiative({ status: 'on_hold', priority: 'low' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockInitiatives.map((i) => ({ data: () => i })),
      });

      const stats = await getInitiativeStats();

      expect(stats.total).toBe(4);
      expect(stats.byStatus.proposed).toBe(1);
      expect(stats.byStatus.active).toBe(1);
      expect(stats.byStatus.completed).toBe(1);
      expect(stats.byStatus.on_hold).toBe(1);
      expect(stats.byPriority.critical).toBe(1);
      expect(stats.byPriority.high).toBe(1);
    });

    it('should handle empty initiative list', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const stats = await getInitiativeStats();

      expect(stats.total).toBe(0);
      expect(stats.byStatus.proposed).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle concurrent updates correctly', async () => {
      mockUpdateDoc.mockResolvedValue(undefined);

      await Promise.all([
        updateInitiative('init-123', { name: 'Update 1' }),
        updateInitiative('init-123', { name: 'Update 2' }),
      ]);

      expect(mockUpdateDoc).toHaveBeenCalledTimes(2);
    });

    it('should handle initiatives with minimal data', async () => {
      const minimalInitiative = createMockInitiative({
        milestones: [],
        linkedStrategyIds: [],
        linkedPrototypeIds: [],
        linkedPainPointIds: [],
        budget: undefined,
      });

      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => minimalInitiative,
      });

      const result = await getInitiativeById('init-123');

      expect(result).toEqual(minimalInitiative);
      expect(result?.milestones).toEqual([]);
    });

    it('should preserve array fields during updates', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateInitiative('init-123', {
        tags: ['tag1', 'tag2', 'tag3'],
      });

      const updateCall = mockUpdateDoc.mock.calls[0][1] as any;
      expect(Array.isArray(updateCall.tags)).toBe(true);
      expect(updateCall.tags[0]).toBe('tag1');
    });

    it('should handle complex nested updates', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const newMilestone = {
        id: 'milestone-new',
        title: 'New Milestone',
        targetDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
        status: 'pending' as const,
      };

      await updateInitiative('init-123', {
        milestones: [newMilestone],
      });

      const updateCall = mockUpdateDoc.mock.calls[0][1] as any;
      expect(updateCall.milestones[0].title).toBe('New Milestone');
    });
  });
});
