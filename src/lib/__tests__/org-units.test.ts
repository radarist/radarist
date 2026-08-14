/**
 * Unit Tests for Org Units Module
 *
 * Tests all org unit management functions including:
 * - CRUD operations (Create, Read, Update, Delete)
 * - Filtering by type, level, parent
 * - Hierarchical relationships
 *
 * @jest-environment node
 */

import type { OrgUnit, OrgUnitType, OrgUnitLevel } from '../types';

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
    const id = `orgunit-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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
  getOrgUnits,
  getOrgUnitById,
  createOrgUnit,
  updateOrgUnit,
  deleteOrgUnit,
  getOrgUnitsWithFilters,
  getOrgUnitChildren,
  getRootOrgUnits,
  getOrgUnitAncestry,
} from '../org-units';

/**
 * Helper to create a mock org unit for testing
 */
function createMockOrgUnit(overrides?: Partial<OrgUnit>): OrgUnit {
  return {
    id: 'org-123',
    slug: 'innovation-lab',
    name: 'Innovation Lab',
    description: 'Central innovation team',
    type: 'department',
    level: 2,
    parentId: 'org-parent',
    employeeCount: 25,
    annualBudget: 500000,
    location: 'Geneva',
    tags: ['innovation', 'digital'],
    createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('Org Units Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getOrgUnits()', () => {
    it('should fetch all org units ordered by name', async () => {
      const mockOrgUnits = [
        createMockOrgUnit({ id: 'org-1', name: 'Alpha Division' }),
        createMockOrgUnit({ id: 'org-2', name: 'Beta Division' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockOrgUnits.map((o) => ({ data: () => o })),
      });

      const result = await getOrgUnits();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Alpha Division');
      expect(result[1].name).toBe('Beta Division');
      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no org units exist', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getOrgUnits();

      expect(result).toEqual([]);
      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should handle errors gracefully', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getOrgUnits()).rejects.toThrow('Firestore error');
    });
  });

  describe('getOrgUnitById()', () => {
    it('should fetch an org unit by ID', async () => {
      const mockOrgUnit = createMockOrgUnit();
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => mockOrgUnit,
      });

      const result = await getOrgUnitById('org-123');

      expect(result).toEqual(mockOrgUnit);
      expect(mockGetDoc).toHaveBeenCalledTimes(1);
    });

    it('should return null when org unit does not exist', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => false,
      });

      const result = await getOrgUnitById('nonexistent');

      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getOrgUnitById('org-123')).rejects.toThrow('Firestore error');
    });
  });

  describe('createOrgUnit()', () => {
    it('should create a new org unit with generated ID', async () => {
      const newOrgUnit = {
        name: 'New Division',
        description: 'Test division',
        type: 'department' as OrgUnitType,
        level: 2 as OrgUnitLevel,
        parentId: 'org-parent',
        employeeCount: 10,
        annualBudget: 100000,
        location: 'Paris',
        tags: ['new'],
      };

      const result = await createOrgUnit(newOrgUnit);

      expect(result.id).toBeDefined();
      expect(result.name).toBe('New Division');
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(mockCreateEntity).toHaveBeenCalledTimes(1);
      // GRAPH-058: the factory is asked for a REQUIRED handoff, so a lost
      // dispatch can be surfaced as saved-locally rather than swallowed.
      expect(mockCreateEntity).toHaveBeenCalledWith('orgUnit', expect.anything(), { graphSync: 'required' });
      expect(mockTriggerSync).not.toHaveBeenCalled();
    });

    it('should generate unique IDs for different org units', async () => {
      const createInput1 = {
        name: 'Unit 1',
        type: 'department' as OrgUnitType,
        level: 2 as OrgUnitLevel,
        tags: [] as string[],
      };
      const createInput2 = {
        name: 'Unit 2',
        type: 'department' as OrgUnitType,
        level: 2 as OrgUnitLevel,
        tags: [] as string[],
      };

      const unit1 = await createOrgUnit(createInput1);
      const unit2 = await createOrgUnit(createInput2);

      expect(unit1.id).not.toBe(unit2.id);
    });

    it('should handle creation errors', async () => {
      mockCreateEntity.mockRejectedValueOnce(new Error('Firestore error'));

      const createInput = {
        name: 'Error Unit',
        type: 'department' as OrgUnitType,
        level: 2 as OrgUnitLevel,
        tags: [] as string[],
      };

      await expect(createOrgUnit(createInput)).rejects.toThrow('Firestore error');
    });
  });

  describe('updateOrgUnit()', () => {
    it('should update an existing org unit', async () => {
      const updates = {
        name: 'Updated Name',
        employeeCount: 50,
      };

      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateOrgUnit('org-123', updates);

      // GRAPH-058: the update awaits a REQUIRED handoff, so a lost dispatch
      // is surfaceable as saved-locally instead of being swallowed.
      expect(mockRequestGraphSync).toHaveBeenCalledWith('orgUnit', 'org-123', 'update');
      expect(mockTriggerSync).not.toHaveBeenCalled();

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      // Verify the second argument (the updates) contains expected fields
      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall).toMatchObject({
        name: 'Updated Name',
        employeeCount: 50,
      });
      expect(typeof updateCall.updatedAt).toBe('number');
    });

    it('should update timestamp on every update', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const beforeTime = Date.now();
      await updateOrgUnit('org-123', { name: 'Test' });
      const afterTime = Date.now();

      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(updateCall.updatedAt).toBeLessThanOrEqual(afterTime);
    });

    it('should handle update errors', async () => {
      mockUpdateDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(
        updateOrgUnit('org-123', { name: 'Test' })
      ).rejects.toThrow('Firestore error');
    });
  });

  describe('deleteOrgUnit()', () => {
    it('should delete an org unit by ID', async () => {
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deleteOrgUnit('org-123');

      expect(mockPreflightEntityReferenceCleanup).toHaveBeenCalledWith(
        'orgUnit',
        'org-123',
        expect.anything()
      );
      expect(mockApplyEntityReferenceCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'orgUnit', entityId: 'org-123' }),
        expect.anything()
      );
      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('orgUnit', 'org-123');
      expect(mockDeleteAllEntityNotes).toHaveBeenCalledWith({}, 'org-units', 'org-123');
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
      expect(mockRequestEntityGraphDeletion).toHaveBeenCalledWith('orgUnit', 'org-123');
      expect(mockPreflightEntityReferenceCleanup.mock.invocationCallOrder[0]).toBeLessThan(
        mockRequestEntityGraphDeletion.mock.invocationCallOrder[0]
      );
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
      (deleteRelationsForEntity as jest.Mock).mockResolvedValueOnce(5);
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deleteOrgUnit('org-123');

      expect(deleteRelationsForEntity).toHaveBeenCalledWith('org-123');
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    });

    it('should handle deletion errors', async () => {
      mockDeleteDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(deleteOrgUnit('org-123')).rejects.toThrow('Firestore error');
    });

    it('should retain the Firestore document when graph deletion is not acknowledged', async () => {
      mockRequestEntityGraphDeletion.mockRejectedValueOnce(new Error('handoff failed'));

      await expect(deleteOrgUnit('org-123')).rejects.toThrow('handoff failed');

      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when note cleanup fails', async () => {
      mockDeleteAllEntityNotes.mockRejectedValueOnce(new Error('note cleanup failed'));

      await expect(deleteOrgUnit('org-123')).rejects.toThrow('note cleanup failed');
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('fails closed before graph handoff when ownership blockers remain', async () => {
      mockPreflightEntityReferenceCleanup.mockRejectedValueOnce(new Error('ownership blocked'));

      await expect(deleteOrgUnit('org-123')).rejects.toThrow('ownership blocked');

      expect(mockRequestEntityGraphDeletion).not.toHaveBeenCalled();
      expect(mockDeleteLinksForEntity).not.toHaveBeenCalled();
      expect(mockDeleteAllEntityNotes).not.toHaveBeenCalled();
      expect(mockApplyEntityReferenceCleanup).not.toHaveBeenCalled();
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when live-reference cleanup fails', async () => {
      mockApplyEntityReferenceCleanup.mockRejectedValueOnce(new Error('reference cleanup failed'));

      await expect(deleteOrgUnit('org-123')).rejects.toThrow('reference cleanup failed');
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });
  });

  describe('getOrgUnitsWithFilters()', () => {
    it('should filter org units by type', async () => {
      const mockOrgUnits = [
        createMockOrgUnit({ type: 'business_unit', level: 1 }),
        createMockOrgUnit({ type: 'business_unit', level: 1 }),
        createMockOrgUnit({ type: 'department', level: 2 }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockOrgUnits.map((o) => ({ data: () => o })),
      });

      const result = await getOrgUnitsWithFilters({ type: ['business_unit'] });

      expect(result).toHaveLength(2);
      expect(result.every((o) => o.type === 'business_unit')).toBe(true);
    });

    it('should return empty array when no matching org units', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getOrgUnitsWithFilters({ type: ['team'] });

      expect(result).toEqual([]);
    });
  });

  describe('getOrgUnitsWithFilters() by level', () => {
    it('should filter org units by level', async () => {
      const mockOrgUnits = [
        createMockOrgUnit({ level: 1 }),
        createMockOrgUnit({ level: 1 }),
        createMockOrgUnit({ level: 2 }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockOrgUnits.map((o) => ({ data: () => o })),
      });

      const result = await getOrgUnitsWithFilters({ level: 1 });

      expect(result).toHaveLength(2);
      expect(result.every((o) => o.level === 1)).toBe(true);
    });
  });

  describe('getOrgUnitChildren()', () => {
    it('should fetch org units filtered by parent ID', async () => {
      const mockOrgUnits = [
        createMockOrgUnit({ parentId: 'parent-123' }),
        createMockOrgUnit({ parentId: 'parent-123' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockOrgUnits.map((o) => ({ data: () => o })),
      });

      const result = await getOrgUnitChildren('parent-123');

      expect(result).toHaveLength(2);
      expect(result.every((o) => o.parentId === 'parent-123')).toBe(true);
    });
  });

  describe('getRootOrgUnits()', () => {
    it('should fetch org units with no parent', async () => {
      const mockOrgUnits = [
        createMockOrgUnit({ parentId: undefined }),
        createMockOrgUnit({ parentId: undefined }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockOrgUnits.map((o) => ({ data: () => o })),
      });

      const result = await getRootOrgUnits();

      expect(result).toHaveLength(2);
      expect(result.every((o) => o.parentId === undefined)).toBe(true);
    });
  });

  describe('getOrgUnitAncestry()', () => {
    it('should return ancestry path from root to current', async () => {
      const mockOrgUnit = createMockOrgUnit({ id: 'child-org', parentId: undefined });

      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => mockOrgUnit,
      });

      const result = await getOrgUnitAncestry('child-org');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('child-org');
    });

    it('should handle errors gracefully', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getOrgUnitAncestry('org-123')).rejects.toThrow('Firestore error');
    });
  });

  describe('Edge Cases', () => {
    it('should handle concurrent updates correctly', async () => {
      mockUpdateDoc.mockResolvedValue(undefined);

      await Promise.all([
        updateOrgUnit('org-123', { name: 'Update 1' }),
        updateOrgUnit('org-123', { name: 'Update 2' }),
      ]);

      expect(mockUpdateDoc).toHaveBeenCalledTimes(2);
    });

    it('should handle org units with minimal data', async () => {
      const minimalOrgUnit = createMockOrgUnit({
        tags: [],
        annualBudget: undefined,
        employeeCount: undefined,
      });

      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => minimalOrgUnit,
      });

      const result = await getOrgUnitById('org-123');

      expect(result).toEqual(minimalOrgUnit);
      expect(result?.tags).toEqual([]);
    });

    it('should preserve array fields during updates', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateOrgUnit('org-123', {
        tags: ['tag1', 'tag2', 'tag3'],
      });

      const updateCall = mockUpdateDoc.mock.calls[0][1] as any;
      expect(Array.isArray(updateCall.tags)).toBe(true);
      expect(updateCall.tags[0]).toBe('tag1');
    });
  });
});
