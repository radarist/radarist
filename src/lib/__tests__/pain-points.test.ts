/**
 * Unit Tests for Pain Points Module
 *
 * Tests all pain point management functions including:
 * - CRUD operations (Create, Read, Update, Delete)
 * - Filtering by status, severity, category, org unit
 * - Statistics and metrics calculation
 *
 * @jest-environment node
 */

import type { PainPoint, PainPointStatus, PainPointSeverity, PainPointCategory } from '../types';

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
    const id = `painpoint-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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
import {
  getDocs,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  where,
} from 'firebase/firestore';
import { createEntity } from '../entity-factory';

// Cast to jest.Mock for type safety
const mockGetDocs = getDocs as jest.Mock;
const mockGetDoc = getDoc as jest.Mock;
const _mockSetDoc = setDoc as jest.Mock;
const mockUpdateDoc = updateDoc as jest.Mock;
const mockDeleteDoc = deleteDoc as jest.Mock;
const mockWhere = where as jest.Mock;
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
  getPainPoints,
  getPainPointById,
  createPainPoint,
  updatePainPoint,
  deletePainPoint,
  getPainPointsWithFilters,
  getPainPointsByCategory,
  getPainPointsByOrgUnit,
  getPainPointStats,
} from '../pain-points';

/**
 * Helper to create a mock pain point for testing
 */
function createMockPainPoint(overrides?: Partial<PainPoint>): PainPoint {
  return {
    id: 'pain-123',
    slug: 'manual-data-entry',
    title: 'Manual Data Entry',
    description: 'Employees spend 2+ hours daily on manual data entry',
    status: 'identified',
    severity: 'high',
    category: 'operational',
    affectedOrgUnitIds: ['org-123', 'org-456'],
    impactDescription: 'Lost productivity, data errors, employee frustration',
    estimatedImpact: 150000,
    linkedPrototypeIds: ['proto-456'],
    linkedTechnologyIds: ['tech-789'],
    linkedInitiativeIds: ['init-123'],
    tags: ['automation', 'efficiency', 'data'],
    identifiedAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
    createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('Pain Points Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getPainPoints()', () => {
    it('should fetch all pain points ordered by severity', async () => {
      const mockPainPoints = [
        createMockPainPoint({ id: 'pain-1', title: 'Critical Issue', severity: 'critical' }),
        createMockPainPoint({ id: 'pain-2', title: 'High Issue', severity: 'high' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockPainPoints.map((p) => ({ data: () => p })),
      });

      const result = await getPainPoints();

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('Critical Issue');
      expect(result[1].title).toBe('High Issue');
      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no pain points exist', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getPainPoints();

      expect(result).toEqual([]);
      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should handle errors gracefully', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getPainPoints()).rejects.toThrow('Firestore error');
    });
  });

  describe('getPainPointById()', () => {
    it('should fetch a pain point by ID', async () => {
      const mockPainPoint = createMockPainPoint();
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => mockPainPoint,
      });

      const result = await getPainPointById('pain-123');

      expect(result).toEqual(mockPainPoint);
      expect(mockGetDoc).toHaveBeenCalledTimes(1);
    });

    it('should return null when pain point does not exist', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => false,
      });

      const result = await getPainPointById('nonexistent');

      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getPainPointById('pain-123')).rejects.toThrow('Firestore error');
    });
  });

  // UX-059 — sparse triage-created Pain Points must not crash the library.
  describe('sparse / legacy normalization (UX-059)', () => {
    it('getPainPoints() renders a sparse record and exposes [] array defaults', async () => {
      // A scout-approved record that omitted every optional array field.
      const sparse = {
        id: 'painpoint-sparse',
        slug: 'sparse',
        title: 'Sparse Scout Pain',
        description: 'A sparse discovered pain point.',
        severity: 'medium',
        status: 'identified',
        category: 'operational',
        tags: ['scout'],
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      };
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => sparse }],
      });

      const result = await getPainPoints();

      expect(result).toHaveLength(1);
      const pp = result[0];
      // The expressions the library page previously crashed on are now safe.
      expect(pp.affectedOrgUnitIds.length).toBe(0);
      expect(pp.tags.length).toBe(1);
      expect(pp.linkedPrototypeIds).toEqual([]);
      expect(pp.linkedTechnologyIds).toEqual([]);
      expect(pp.linkedInitiativeIds).toEqual([]);
    });

    it('getPainPoints() accepts the exact retained legacy category and import provenance', async () => {
      const retainedLegacy = {
        id: 'painpoint-retained-legacy',
        slug: 'retained-legacy',
        title: 'Retained Legacy Pain',
        description: 'Imported before the current stored boundary.',
        severity: 'medium',
        status: 'identified',
        category: 'process',
        source: { type: 'import' },
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      };
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => retainedLegacy }],
      });

      const [painPoint] = await getPainPoints();

      expect(painPoint.category).toBe('operational');
      expect(painPoint.source).toEqual({ type: 'import' });
      expect(painPoint.source).not.toHaveProperty('discoveredAt');
      expect(painPoint.affectedOrgUnitIds).toEqual([]);
    });

    it('getPainPointById() returns a normalized sparse single record', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => ({
          id: 'painpoint-sparse-2',
          slug: 'no-tags-no-orgs',
          title: 'No Tags No Orgs',
          description: 'A second sparse discovered pain point.',
          severity: 'high',
          status: 'identified',
          category: 'customer',
          createdAt: 1,
          updatedAt: 1,
        }),
      });

      const pp = await getPainPointById('painpoint-sparse-2');
      expect(pp).not.toBeNull();
      expect(pp!.tags).toEqual([]);
      expect(pp!.affectedOrgUnitIds).toEqual([]);
    });

    it('preserves populated arrays exactly through normalization', async () => {
      const populated = createMockPainPoint({
        affectedOrgUnitIds: ['org-a', 'org-b', 'org-c'],
        tags: ['x', 'y', 'z'],
        linkedPrototypeIds: ['proto-1'],
      });
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => populated }],
      });

      const [pp] = await getPainPoints();
      expect(pp.affectedOrgUnitIds).toEqual(['org-a', 'org-b', 'org-c']);
      expect(pp.tags).toEqual(['x', 'y', 'z']);
      expect(pp.linkedPrototypeIds).toEqual(['proto-1']);
    });

    it('getPainPointsByCategory() normalizes filtered sparse records', async () => {
      const sparse = {
        id: 'painpoint-cat',
        slug: 'category-sparse',
        title: 'Category Sparse',
        description: 'A sparse categorized pain point.',
        severity: 'low',
        status: 'identified',
        category: 'operational',
        createdAt: 1,
        updatedAt: 1,
      };
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => sparse }],
      });

      const [pp] = await getPainPointsByCategory('operational');
      expect(pp.affectedOrgUnitIds).toEqual([]);
      expect(pp.tags).toEqual([]);
      expect(mockWhere).toHaveBeenLastCalledWith(
        'category',
        'in',
        ['operational', 'process'],
      );
    });

    it('includes retained process rows in canonical operational results', async () => {
      const canonical = {
        id: 'painpoint-canonical-operational',
        slug: 'canonical-operational',
        title: 'Canonical Operational Pain',
        description: 'Stored with the current category vocabulary.',
        severity: 'medium',
        status: 'identified',
        category: 'operational',
        createdAt: 1,
        updatedAt: 1,
      };
      const legacy = {
        id: 'painpoint-legacy-process',
        slug: 'legacy-process',
        title: 'Legacy Process Pain',
        description: 'Stored before the canonical category vocabulary.',
        severity: 'medium',
        status: 'identified',
        category: 'process',
        createdAt: 1,
        updatedAt: 1,
      };
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => canonical }, { data: () => legacy }],
      });

      const painPoints = await getPainPointsByCategory('operational');

      expect(mockWhere).toHaveBeenLastCalledWith(
        'category',
        'in',
        ['operational', 'process'],
      );
      expect(painPoints).toHaveLength(2);
      expect(painPoints.map((painPoint) => painPoint.category)).toEqual([
        'operational',
        'operational',
      ]);
    });

    it('keeps unrelated category queries canonical-only', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      await getPainPointsByCategory('customer');

      expect(mockWhere).toHaveBeenLastCalledWith('category', '==', 'customer');
    });
  });

  describe('createPainPoint()', () => {
    it('should create a new pain point with generated ID', async () => {
      const newPainPoint = {
        title: 'New Pain Point',
        description: 'Test pain point',
        status: 'identified' as PainPointStatus,
        severity: 'medium' as PainPointSeverity,
        category: 'technical' as PainPointCategory,
        affectedOrgUnitIds: ['org-123'],
        impactDescription: 'Delays in project delivery',
        estimatedImpact: 50000,
        linkedPrototypeIds: [],
        linkedTechnologyIds: [],
        linkedInitiativeIds: [],
        tags: ['new'],
      };

      const result = await createPainPoint(newPainPoint);

      expect(result.id).toBeDefined();
      expect(result.title).toBe('New Pain Point');
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(mockCreateEntity).toHaveBeenCalledTimes(1);
      // GRAPH-058: the factory is asked for a REQUIRED handoff, so a lost
      // dispatch can be surfaced as saved-locally rather than swallowed.
      expect(mockCreateEntity).toHaveBeenCalledWith('painPoint', expect.anything(), { graphSync: 'required' });
      expect(mockTriggerSync).not.toHaveBeenCalled();
    });

    it('should generate unique IDs for different pain points', async () => {
      const createInput1 = {
        title: 'Pain 1',
        description: 'Test',
        status: 'identified' as PainPointStatus,
        severity: 'medium' as PainPointSeverity,
        category: 'operational' as PainPointCategory,
        affectedOrgUnitIds: [],
        linkedPrototypeIds: [],
        linkedTechnologyIds: [],
        linkedInitiativeIds: [],
        tags: [],
      };
      const createInput2 = {
        title: 'Pain 2',
        description: 'Test',
        status: 'identified' as PainPointStatus,
        severity: 'medium' as PainPointSeverity,
        category: 'operational' as PainPointCategory,
        affectedOrgUnitIds: [],
        linkedPrototypeIds: [],
        linkedTechnologyIds: [],
        linkedInitiativeIds: [],
        tags: [],
      };

      const pain1 = await createPainPoint(createInput1);
      const pain2 = await createPainPoint(createInput2);

      expect(pain1.id).not.toBe(pain2.id);
    });

    it('should handle creation errors', async () => {
      mockCreateEntity.mockRejectedValueOnce(new Error('Firestore error'));

      const createInput = {
        title: 'Error Pain Point',
        description: 'Test',
        status: 'identified' as PainPointStatus,
        severity: 'medium' as PainPointSeverity,
        category: 'operational' as PainPointCategory,
        affectedOrgUnitIds: [],
        linkedPrototypeIds: [],
        linkedTechnologyIds: [],
        linkedInitiativeIds: [],
        tags: [],
      };

      await expect(createPainPoint(createInput)).rejects.toThrow('Firestore error');
    });
  });

  describe('updatePainPoint()', () => {
    it('should update an existing pain point', async () => {
      const updates = {
        title: 'Updated Title',
        status: 'being_addressed' as PainPointStatus,
      };

      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updatePainPoint('pain-123', updates);

      // GRAPH-058: the update awaits a REQUIRED handoff, so a lost dispatch
      // is surfaceable as saved-locally instead of being swallowed.
      expect(mockRequestGraphSync).toHaveBeenCalledWith('painPoint', 'pain-123', 'update');
      expect(mockTriggerSync).not.toHaveBeenCalled();

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall).toMatchObject({
        title: 'Updated Title',
        status: 'being_addressed',
      });
      expect(typeof updateCall.updatedAt).toBe('number');
    });

    it('should update timestamp on every update', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const beforeTime = Date.now();
      await updatePainPoint('pain-123', { title: 'Test' });
      const afterTime = Date.now();

      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(updateCall.updatedAt).toBeLessThanOrEqual(afterTime);
    });

    it('should handle update errors', async () => {
      mockUpdateDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(
        updatePainPoint('pain-123', { title: 'Test' })
      ).rejects.toThrow('Firestore error');
    });
  });

  describe('deletePainPoint()', () => {
    it('should delete a pain point by ID', async () => {
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deletePainPoint('pain-123');

      expect(mockPreflightEntityReferenceCleanup).toHaveBeenCalledWith(
        'painPoint',
        'pain-123',
        expect.anything()
      );
      expect(mockApplyEntityReferenceCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'painPoint', entityId: 'pain-123' }),
        expect.anything()
      );
      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('painPoint', 'pain-123');
      expect(mockDeleteAllEntityNotes).toHaveBeenCalledWith({}, 'painPoints', 'pain-123');
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
      expect(mockRequestEntityGraphDeletion).toHaveBeenCalledWith('painPoint', 'pain-123');
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
      (deleteRelationsForEntity as jest.Mock).mockResolvedValueOnce(2);
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deletePainPoint('pain-123');

      expect(deleteRelationsForEntity).toHaveBeenCalledWith('pain-123');
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    });

    it('should handle deletion errors', async () => {
      mockDeleteDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(deletePainPoint('pain-123')).rejects.toThrow('Firestore error');
    });

    it('should retain the Firestore document when graph deletion is not acknowledged', async () => {
      mockRequestEntityGraphDeletion.mockRejectedValueOnce(new Error('handoff failed'));

      await expect(deletePainPoint('pain-123')).rejects.toThrow('handoff failed');

      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when note cleanup fails', async () => {
      mockDeleteAllEntityNotes.mockRejectedValueOnce(new Error('note cleanup failed'));

      await expect(deletePainPoint('pain-123')).rejects.toThrow('note cleanup failed');
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when live-reference cleanup fails', async () => {
      mockApplyEntityReferenceCleanup.mockRejectedValueOnce(new Error('reference cleanup failed'));

      await expect(deletePainPoint('pain-123')).rejects.toThrow('reference cleanup failed');
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });
  });

  describe('getPainPointsWithFilters()', () => {
    it('should filter pain points by status', async () => {
      const mockPainPoints = [
        createMockPainPoint({ status: 'identified' }),
        createMockPainPoint({ status: 'identified' }),
        createMockPainPoint({ status: 'resolved' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockPainPoints.map((p) => ({ data: () => p })),
      });

      const result = await getPainPointsWithFilters({ status: ['identified'] });

      expect(result).toHaveLength(2);
      expect(result.every((p) => p.status === 'identified')).toBe(true);
    });

    it('should filter pain points by severity', async () => {
      const mockPainPoints = [
        createMockPainPoint({ severity: 'critical' }),
        createMockPainPoint({ severity: 'critical' }),
        createMockPainPoint({ severity: 'low' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockPainPoints.map((p) => ({ data: () => p })),
      });

      const result = await getPainPointsWithFilters({ severity: ['critical'] });

      expect(result).toHaveLength(2);
      expect(result.every((p) => p.severity === 'critical')).toBe(true);
    });

    it('should return empty array when no matching pain points', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getPainPointsWithFilters({ status: ['resolved'] });

      expect(result).toEqual([]);
    });
  });

  describe('getPainPointsByCategory()', () => {
    it('should fetch pain points filtered by category', async () => {
      const mockPainPoints = [
        createMockPainPoint({ category: 'operational' }),
        createMockPainPoint({ category: 'operational' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockPainPoints.map((p) => ({ data: () => p })),
      });

      const result = await getPainPointsByCategory('operational');

      expect(result).toHaveLength(2);
      expect(result.every((p) => p.category === 'operational')).toBe(true);
    });
  });

  describe('getPainPointsByOrgUnit()', () => {
    it('should fetch pain points filtered by org unit', async () => {
      const mockPainPoints = [
        createMockPainPoint({ affectedOrgUnitIds: ['org-456'] }),
        createMockPainPoint({ affectedOrgUnitIds: ['org-456', 'org-789'] }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockPainPoints.map((p) => ({ data: () => p })),
      });

      const result = await getPainPointsByOrgUnit('org-456');

      expect(result).toHaveLength(2);
      expect(result.every((p) => p.affectedOrgUnitIds.includes('org-456'))).toBe(true);
    });
  });

  describe('getPainPointStats()', () => {
    it('should calculate correct statistics', async () => {
      const mockPainPoints = [
        createMockPainPoint({ status: 'identified', severity: 'critical', category: 'operational' }),
        createMockPainPoint({ status: 'being_addressed', severity: 'high', category: 'technical' }),
        createMockPainPoint({ status: 'resolved', severity: 'medium', category: 'customer' }),
        createMockPainPoint({ status: 'validated', severity: 'low', category: 'market' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockPainPoints.map((p) => ({ data: () => p })),
      });

      const stats = await getPainPointStats();

      expect(stats.total).toBe(4);
      expect(stats.byStatus.identified).toBe(1);
      expect(stats.byStatus.being_addressed).toBe(1);
      expect(stats.byStatus.resolved).toBe(1);
      expect(stats.byStatus.validated).toBe(1);
      expect(stats.bySeverity.critical).toBe(1);
      expect(stats.bySeverity.high).toBe(1);
      expect(stats.byCategory.operational).toBe(1);
      expect(stats.byCategory.technical).toBe(1);
    });

    it('should handle empty pain point list', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const stats = await getPainPointStats();

      expect(stats.total).toBe(0);
      expect(stats.byStatus.identified).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle concurrent updates correctly', async () => {
      mockUpdateDoc.mockResolvedValue(undefined);

      await Promise.all([
        updatePainPoint('pain-123', { title: 'Update 1' }),
        updatePainPoint('pain-123', { title: 'Update 2' }),
      ]);

      expect(mockUpdateDoc).toHaveBeenCalledTimes(2);
    });

    it('should handle pain points with minimal data', async () => {
      const minimalPainPoint = createMockPainPoint({
        linkedPrototypeIds: [],
        linkedTechnologyIds: [],
        linkedInitiativeIds: [],
        estimatedImpact: undefined,
        impactDescription: undefined,
      });

      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => minimalPainPoint,
      });

      const result = await getPainPointById('pain-123');

      expect(result).toEqual(minimalPainPoint);
      expect(result?.linkedPrototypeIds).toEqual([]);
    });

    it('should preserve array fields during updates', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updatePainPoint('pain-123', {
        tags: ['tag1', 'tag2', 'tag3'],
      });

      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(Array.isArray(updateCall.tags)).toBe(true);
      expect(updateCall.tags).toEqual(['tag1', 'tag2', 'tag3']);
    });

    it('should handle multiple affected org units', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updatePainPoint('pain-123', {
        affectedOrgUnitIds: ['org-1', 'org-2', 'org-3'],
      });

      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.affectedOrgUnitIds).toHaveLength(3);
    });
  });
});
