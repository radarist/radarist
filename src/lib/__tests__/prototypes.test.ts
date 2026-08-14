/**
 * Unit Tests for Prototypes Module
 *
 * Tests all prototype management functions including:
 * - CRUD operations (Create, Read, Update, Delete)
 * - Filtering by status, business unit, technology, company, use case, strategy
 * - Entity linking/unlinking (technologies, companies, use cases, strategies)
 * - Statistics and metrics calculation
 *
 * @jest-environment node
 */

import type { Prototype, PrototypeStatus, BusinessUnit } from '../types';

// Mock firebase with jest.fn() in factory (proper hoisting pattern)
jest.mock('../firebase', () => ({
  db: {},
  removeUndefinedFields: jest.fn((obj) => {
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
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  arrayUnion: jest.fn((value) => ({ type: 'arrayUnion', value })),
  arrayRemove: jest.fn((value) => ({ type: 'arrayRemove', value })),
  writeBatch: jest.fn(() => ({ delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) })),
  runTransaction: jest.fn(),
  limit: jest.fn(),
}));

// Mock entity-factory: createEntity returns a fake entity with id/slug/timestamps
jest.mock('../entity-factory', () => ({
  __esModule: true,
  createEntity: jest.fn((_type: string, data: Record<string, unknown>) => {
    const id = `proto-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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
  requestEntityGraphDeletions: jest.fn(async (_type: string, ids: string[]) => ({
    acknowledged: [...ids],
    failed: [],
  })),
}));

// Mock migration utilities
jest.mock('../migration', () => ({
  idResolver: { isNewFormat: jest.fn().mockReturnValue(false), getOldId: jest.fn() },
  safeResolve: jest.fn((id: string) => id),
  needsResolution: jest.fn().mockReturnValue(false),
}));

// Mock data refresh events
jest.mock('../events/data-refresh', () => ({
  emitDataRefresh: jest.fn(),
}));

// Mock the relations module for deletePrototype's dynamic import
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

// Import mocked modules to get references
import { getDocs, getDoc, setDoc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { createEntity } from '../entity-factory';
import { EntitySyncDispatchError } from '../entity-sync';

// Cast to jest.Mock for type safety
const mockGetDocs = getDocs as jest.Mock;
const mockGetDoc = getDoc as jest.Mock;
const _mockSetDoc = setDoc as jest.Mock;
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
const {
  triggerEntitySync: mockTriggerSync,
  requestEntityGraphSync: mockRequestGraphSync,
  requestEntityGraphDeletion: mockRequestEntityGraphDeletion,
  requestEntityGraphDeletions: mockRequestEntityGraphDeletions,
} = jest.requireMock('../entity-sync') as {
  triggerEntitySync: jest.Mock;
  requestEntityGraphSync: jest.Mock;
  requestEntityGraphDeletion: jest.Mock;
  requestEntityGraphDeletions: jest.Mock;
};

// Import functions after mocking
import {
  getPrototypes,
  getPrototypeById,
  createPrototype,
  updatePrototype,
  deletePrototype,
  deletePrototypes,
  getPrototypesByStatus,
  getPrototypesByBusinessUnit,
  getPrototypesByTechnology,
  linkPrototypeToTechnology,
  unlinkPrototypeFromTechnology,
  linkPrototypeToCompany,
  unlinkPrototypeFromCompany,
  getPrototypeStatistics,
  updatePrototypeCosts,
  addCostBreakdownItem,
  removeCostBreakdownItem,
  getCostStatistics,
} from '../prototypes';

/**
 * Helper to create a mock prototype for testing
 */
function createMockPrototype(overrides?: Partial<Prototype>): Prototype {
  return {
    id: 'proto-123',
    slug: 'ai-flavor-lab',
    name: 'AI Flavor Lab',
    description: 'AI-powered flavor formulation system',
    status: 'In Development',
    linkedTechnologies: ['tech-radar-1:ai-ml'],
    linkedCompanies: ['company-123'],
    linkedUseCases: ['usecase-456'],
    linkedStrategies: ['strategy-789'],
    targetBusinessUnit: 'Taste',
    presentedTo: [],
    artifacts: {
      presentations: [],
    },
    impact: {
      type: 'Revenue Generation',
      estimatedValue: 500000,
      timeToImpact: '6 months',
      confidence: 80,
      notes: 'Expected to reduce formulation time by 50%',
    },
    team: ['Jane Doe', 'John Smith', 'Alice Johnson'],
    createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('Prototypes Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getPrototypes()', () => {
    it('should fetch all prototypes ordered by creation date', async () => {
      const mockPrototypes = [
        createMockPrototype({ id: 'proto-1', name: 'Prototype 1' }),
        createMockPrototype({ id: 'proto-2', name: 'Prototype 2' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockPrototypes.map((p) => ({ data: () => p })),
      });

      const result = await getPrototypes();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Prototype 1');
      expect(result[1].name).toBe('Prototype 2');
      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no prototypes exist', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getPrototypes();

      expect(result).toEqual([]);
      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should handle errors gracefully', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getPrototypes()).rejects.toThrow('Failed to fetch prototypes');
    });
  });

  describe('getPrototypeById()', () => {
    it('should fetch a prototype by ID', async () => {
      const mockPrototype = createMockPrototype();
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => mockPrototype,
      });

      const result = await getPrototypeById('proto-123');

      expect(result).toEqual(mockPrototype);
      expect(mockGetDoc).toHaveBeenCalledTimes(1);
    });

    it('should return null when prototype does not exist', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => false,
      });

      const result = await getPrototypeById('nonexistent');

      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getPrototypeById('proto-123')).rejects.toThrow('Failed to fetch prototype proto-123');
    });
  });

  describe('createPrototype()', () => {
    it('should create a new prototype with generated ID', async () => {
      const newPrototype = {
        name: 'New Prototype',
        description: 'Test prototype',
        status: 'Ideation' as PrototypeStatus,
        linkedTechnologies: [],
        linkedCompanies: [],
        linkedUseCases: [],
        linkedStrategies: [],
        targetBusinessUnit: 'Taste' as BusinessUnit,
        presentedTo: [],
        artifacts: {
          presentations: [],
        },
        impact: {
          type: 'Cost Saving' as const,
          estimatedValue: 100000,
          timeToImpact: '3 months',
          confidence: 75,
          notes: 'Expected savings',
        },
        team: ['John Doe'],
      };

      const result = await createPrototype(newPrototype);

      expect(result.id).toBeDefined();
      expect(result.name).toBe('New Prototype');
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(mockCreateEntity).toHaveBeenCalledTimes(1);
      // GRAPH-058: the factory is asked for a REQUIRED handoff, so a lost
      // dispatch can be surfaced as saved-locally rather than swallowed.
      expect(mockCreateEntity).toHaveBeenCalledWith('prototype', expect.anything(), { graphSync: 'required' });
      expect(mockTriggerSync).not.toHaveBeenCalled();
    });

    it('should generate unique IDs for different prototypes', async () => {
      const createInput = {
        name: 'Proto 1',
        description: 'Test',
        status: 'Ideation' as PrototypeStatus,
        linkedTechnologies: [],
        linkedCompanies: [],
        linkedUseCases: [],
        linkedStrategies: [],
        targetBusinessUnit: 'Taste' as BusinessUnit,
        presentedTo: [],
        artifacts: { presentations: [] },
        impact: {
          type: 'Cost Saving' as const,
          estimatedValue: 100000,
          timeToImpact: '3 months',
          confidence: 75,
          notes: '',
        },
        team: [],
      };

      const proto1 = await createPrototype({ ...createInput, name: 'Proto 1' });
      const proto2 = await createPrototype({ ...createInput, name: 'Proto 2' });

      expect(proto1.id).not.toBe(proto2.id);
    });

    it('should handle creation errors', async () => {
      mockCreateEntity.mockRejectedValueOnce(new Error('Firestore error'));

      const createInput = {
        name: 'Error Proto',
        description: 'Test',
        status: 'Ideation' as PrototypeStatus,
        linkedTechnologies: [],
        linkedCompanies: [],
        linkedUseCases: [],
        linkedStrategies: [],
        targetBusinessUnit: 'Taste' as BusinessUnit,
        presentedTo: [],
        artifacts: { presentations: [] },
        impact: {
          type: 'Cost Saving' as const,
          estimatedValue: 100000,
          timeToImpact: '3 months',
          confidence: 75,
          notes: '',
        },
        team: [],
      };

      await expect(createPrototype(createInput)).rejects.toThrow('Failed to create prototype');
    });
  });

  describe('updatePrototype()', () => {
    it('should update an existing prototype', async () => {
      const updates = {
        name: 'Updated Name',
        status: 'Demo Ready' as PrototypeStatus,
      };

      // Mock getDoc for existence check
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => createMockPrototype(),
      });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updatePrototype('proto-123', updates);

      // GRAPH-058: the update awaits a REQUIRED handoff, so a lost dispatch
      // is surfaceable as saved-locally instead of being swallowed.
      expect(mockRequestGraphSync).toHaveBeenCalledWith('prototype', 'proto-123', 'update');
      expect(mockTriggerSync).not.toHaveBeenCalled();

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall).toMatchObject({
        name: 'Updated Name',
        status: 'Demo Ready',
      });
      expect(typeof updateCall.updatedAt).toBe('number');
    });

    it('should update timestamp on every update', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => createMockPrototype(),
      });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const beforeTime = Date.now();
      await updatePrototype('proto-123', { name: 'Test' });
      const afterTime = Date.now();

      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(updateCall.updatedAt).toBeLessThanOrEqual(afterTime);
    });

    it('should handle update errors', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => createMockPrototype(),
      });
      mockUpdateDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(updatePrototype('proto-123', { name: 'Test' })).rejects.toThrow(
        'Failed to update prototype proto-123'
      );
    });
  });

  describe('deletePrototype()', () => {
    it('should delete a prototype by ID', async () => {
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deletePrototype('proto-123');

      expect(mockPreflightEntityReferenceCleanup).toHaveBeenCalledWith(
        'prototype',
        'proto-123',
        expect.anything()
      );
      expect(mockApplyEntityReferenceCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'prototype', entityId: 'proto-123' }),
        expect.anything()
      );
      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('prototype', 'proto-123');
      expect(mockDeleteAllEntityNotes).toHaveBeenCalledWith({}, 'prototypes', 'proto-123');
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
      expect(mockRequestEntityGraphDeletion).toHaveBeenCalledWith('prototype', 'proto-123');
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

    it('should handle deletion errors', async () => {
      mockDeleteDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(deletePrototype('proto-123')).rejects.toThrow('Failed to delete prototype proto-123');
    });

    it('should retain the Firestore document when graph deletion is not acknowledged', async () => {
      mockRequestEntityGraphDeletion.mockRejectedValueOnce(
        new EntitySyncDispatchError('prototype', 'proto-123', 'delete', new Error('handoff failed'))
      );

      await expect(deletePrototype('proto-123')).rejects.toThrow('handoff failed');

      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when note cleanup fails', async () => {
      mockDeleteAllEntityNotes.mockRejectedValueOnce(new Error('note cleanup failed'));

      await expect(deletePrototype('proto-123')).rejects.toThrow('Failed to delete prototype proto-123');
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when document-link cleanup fails', async () => {
      mockDeleteLinksForEntity.mockRejectedValueOnce(new Error('link cleanup failed'));

      await expect(deletePrototype('proto-123')).rejects.toThrow('Failed to delete prototype proto-123');
      expect(mockDeleteAllEntityNotes).not.toHaveBeenCalled();
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when live-reference cleanup fails', async () => {
      const cause = new Error('reference cleanup failed');
      mockApplyEntityReferenceCleanup.mockRejectedValueOnce(cause);

      await expect(deletePrototype('proto-123')).rejects.toMatchObject({
        message: 'Failed to delete prototype proto-123',
        cause,
      });
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });
  });

  describe('deletePrototypes()', () => {
    it('preflights every ID before graph handoff and isolates a failed preflight', async () => {
      const cleanupPlan = {
        entityType: 'prototype',
        entityId: 'p-1',
        ownedReferences: [],
        liveArrayReferences: [],
      };
      mockPreflightEntityReferenceCleanups.mockResolvedValueOnce({
        prepared: [{ id: 'p-1', plan: cleanupPlan }],
        failed: [{ id: 'p-2', error: new Error('blocked') }],
      });
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      const { deleteRelationsForEntity } = jest.requireMock('../relations') as {
        deleteRelationsForEntity: jest.Mock;
      };
      deleteRelationsForEntity.mockResolvedValue(0);

      const result = await deletePrototypes(['p-1', 'p-2']);

      expect(result).toEqual({ deleted: 1, failed: ['p-2'], relationsDeleted: 0 });
      expect(mockPreflightEntityReferenceCleanups).toHaveBeenCalledWith(
        'prototype',
        ['p-1', 'p-2'],
        expect.anything()
      );
      expect(mockPreflightEntityReferenceCleanups.mock.invocationCallOrder[0]).toBeLessThan(
        mockRequestEntityGraphDeletions.mock.invocationCallOrder[0]
      );
      expect(mockRequestEntityGraphDeletions).toHaveBeenCalledWith('prototype', ['p-1']);
      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('prototype', 'p-1');
      expect(mockDeleteLinksForEntity).not.toHaveBeenCalledWith('prototype', 'p-2');
      expect(mockApplyEntityReferenceCleanup).toHaveBeenCalledWith(cleanupPlan, expect.anything());
      expect(mockBatch.delete).toHaveBeenCalledTimes(1);
    });

    it('batches only prototypes whose complete cascade preparation succeeds', async () => {
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      const { deleteRelationsForEntity } = jest.requireMock('../relations') as {
        deleteRelationsForEntity: jest.Mock;
      };
      deleteRelationsForEntity.mockResolvedValue(2);
      mockDeleteAllEntityNotes
        .mockResolvedValueOnce(0)
        .mockRejectedValueOnce(new Error('note cleanup failed'));

      const result = await deletePrototypes(['p-1', 'p-2']);

      expect(result).toEqual({ deleted: 1, failed: ['p-2'], relationsDeleted: 2 });
      expect(mockBatch.delete).toHaveBeenCalledTimes(1);
    });

    it('reports every prepared ID when the parent batch fails', async () => {
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockRejectedValue(new Error('batch failed')) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);

      await expect(deletePrototypes(['p-1', 'p-2'])).resolves.toMatchObject({
        deleted: 0,
        failed: ['p-1', 'p-2'],
      });
    });
  });

  describe('getPrototypesByStatus()', () => {
    it('should fetch prototypes filtered by status', async () => {
      const mockPrototypes = [
        createMockPrototype({ status: 'In Development' }),
        createMockPrototype({ status: 'In Development' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockPrototypes.map((p) => ({ data: () => p })),
      });

      const result = await getPrototypesByStatus('In Development');

      expect(result).toHaveLength(2);
      expect(result.every((p) => p.status === 'In Development')).toBe(true);
    });

    it('should return empty array when no matching prototypes', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getPrototypesByStatus('Archived');

      expect(result).toEqual([]);
    });
  });

  describe('getPrototypesByBusinessUnit()', () => {
    it('should fetch prototypes filtered by business unit', async () => {
      const mockPrototypes = [
        createMockPrototype({ targetBusinessUnit: 'Taste' }),
        createMockPrototype({ targetBusinessUnit: 'Taste' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockPrototypes.map((p) => ({ data: () => p })),
      });

      const result = await getPrototypesByBusinessUnit('Taste');

      expect(result).toHaveLength(2);
      expect(result.every((p) => p.targetBusinessUnit === 'Taste')).toBe(true);
    });
  });

  describe('getPrototypesByTechnology()', () => {
    it('should fetch prototypes linked to a technology', async () => {
      const mockPrototypes = [
        createMockPrototype({
          linkedTechnologies: ['tech-radar-1:ai-ml'],
        }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockPrototypes.map((p) => ({ data: () => p })),
      });

      const result = await getPrototypesByTechnology('tech-radar-1:ai-ml');

      expect(result).toHaveLength(1);
      expect(result[0].linkedTechnologies?.includes('tech-radar-1:ai-ml')).toBe(true);
    });
  });

  describe('Entity Linking', () => {
    describe('linkPrototypeToTechnology()', () => {
      it('should add technology to prototype links', async () => {
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        await linkPrototypeToTechnology('proto-123', 'tech-radar-1:new-tech');

        expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
        const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
        expect(updateCall).toMatchObject({
          linkedTechnologies: { type: 'arrayUnion', value: 'tech-radar-1:new-tech' },
        });
        expect(typeof updateCall.updatedAt).toBe('number');
      });
    });

    describe('unlinkPrototypeFromTechnology()', () => {
      it('should remove technology from prototype links', async () => {
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        await unlinkPrototypeFromTechnology('proto-123', 'tech-radar-1:old-tech');

        expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
        const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
        expect(updateCall).toMatchObject({
          linkedTechnologies: { type: 'arrayRemove', value: 'tech-radar-1:old-tech' },
        });
      });
    });

    describe('linkPrototypeToCompany()', () => {
      it('should add company to prototype links', async () => {
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        await linkPrototypeToCompany('proto-123', 'company-456');

        const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
        expect(updateCall).toMatchObject({
          linkedCompanies: { type: 'arrayUnion', value: 'company-456' },
        });
      });
    });

    describe('unlinkPrototypeFromCompany()', () => {
      it('should remove company from prototype links', async () => {
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        await unlinkPrototypeFromCompany('proto-123', 'company-456');

        const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
        expect(updateCall).toMatchObject({
          linkedCompanies: { type: 'arrayRemove', value: 'company-456' },
        });
      });
    });
  });

  describe('getPrototypeStatistics()', () => {
    it('should calculate correct statistics', async () => {
      const mockPrototypes = [
        createMockPrototype({ status: 'Ideation', targetBusinessUnit: 'Taste' }),
        createMockPrototype({ status: 'In Development', targetBusinessUnit: 'Taste' }),
        createMockPrototype({ status: 'Demo Ready', targetBusinessUnit: 'Health' }),
        createMockPrototype({ status: 'Delivered', targetBusinessUnit: 'Health' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockPrototypes.map((p) => ({ data: () => p })),
      });

      const stats = await getPrototypeStatistics();

      expect(stats.total).toBe(4);
      expect(stats.activeCount).toBe(2); // In Development + Demo Ready
      expect(stats.deliveredCount).toBe(1);
      expect(stats.archivedCount).toBe(0);
    });

    it('should handle empty prototype list', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const stats = await getPrototypeStatistics();

      expect(stats.total).toBe(0);
      expect(stats.activeCount).toBe(0);
    });

    it('should calculate total estimated value', async () => {
      const mockPrototypes = [
        createMockPrototype({
          impact: {
            type: 'Revenue Generation',
            estimatedValue: 100000,
            timeToImpact: '3 months',
            confidence: 80,
            notes: '',
          },
        }),
        createMockPrototype({
          impact: { type: 'Cost Saving', estimatedValue: 200000, timeToImpact: '6 months', confidence: 75, notes: '' },
        }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockPrototypes.map((p) => ({ data: () => p })),
      });

      const stats = await getPrototypeStatistics();

      expect(stats.totalEstimatedValue).toBe(300000);
    });
  });

  describe('Edge Cases', () => {
    it('should handle concurrent updates correctly', async () => {
      mockGetDoc.mockResolvedValue({
        exists: () => true,
        data: () => createMockPrototype(),
      });
      mockUpdateDoc.mockResolvedValue(undefined);

      await Promise.all([
        updatePrototype('proto-123', { name: 'Update 1' }),
        updatePrototype('proto-123', { name: 'Update 2' }),
      ]);

      expect(mockUpdateDoc).toHaveBeenCalledTimes(2);
    });

    it('should handle prototypes with minimal data', async () => {
      const minimalPrototype = createMockPrototype({
        presentedTo: [],
        aiGeneratedBrief: undefined,
      });

      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => minimalPrototype,
      });

      const result = await getPrototypeById('proto-123');

      expect(result).toEqual(minimalPrototype);
      expect(result?.presentedTo).toEqual([]);
    });

    it('should preserve array fields during updates', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => createMockPrototype(),
      });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updatePrototype('proto-123', {
        team: ['Alice', 'Bob', 'Charlie'],
      });

      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(Array.isArray(updateCall.team)).toBe(true);
      expect((updateCall.team as string[])[0]).toBe('Alice');
    });
  });

  // ============================================================================
  // Cost Tracking Tests (Phase 0 Task 0.2.4)
  // ============================================================================

  describe('Cost Tracking (Task 0.2.4)', () => {
    describe('updatePrototypeCosts()', () => {
      it('should update prototype costs with estimated and actual values', async () => {
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        await updatePrototypeCosts('proto-123', {
          estimated: 150,
          actual: 175,
          currency: 'USD',
        });

        expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
        const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
        const costs = updateCall.costs as Record<string, unknown>;
        expect(costs.estimated).toBe(150);
        expect(costs.actual).toBe(175);
        expect(costs.currency).toBe('USD');
        expect(typeof costs.lastUpdated).toBe('number');
      });

      it('should update only specified cost fields', async () => {
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        await updatePrototypeCosts('proto-123', {
          actual: 200,
        });

        const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
        const costs = updateCall.costs as Record<string, unknown>;
        expect(costs.actual).toBe(200);
        expect(costs.estimated).toBeUndefined();
      });

      it('should handle errors gracefully', async () => {
        mockUpdateDoc.mockRejectedValueOnce(new Error('Firestore error'));

        await expect(updatePrototypeCosts('proto-123', { estimated: 100 })).rejects.toThrow('Failed to update costs');
      });
    });

    describe('addCostBreakdownItem()', () => {
      it('should add a new cost breakdown item', async () => {
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () => createMockPrototype({ costs: { currency: 'USD', lastUpdated: Date.now() } }),
        });
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        await addCostBreakdownItem('proto-123', {
          category: 'Development',
          amount: 50,
          description: 'Sprint 1 development costs',
        });

        expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
        const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
        const costs = updateCall.costs as Record<string, unknown>;
        const breakdown = costs.breakdown as Array<{ category: string; amount: number; description?: string }>;
        expect(breakdown).toHaveLength(1);
        expect(breakdown[0].category).toBe('Development');
        expect(breakdown[0].amount).toBe(50);
        expect(breakdown[0].description).toBe('Sprint 1 development costs');
      });

      it('should append to existing breakdown items', async () => {
        const existingBreakdown = [{ category: 'Development', amount: 50, description: 'Sprint 1' }];
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () =>
            createMockPrototype({
              costs: { currency: 'USD', breakdown: existingBreakdown, lastUpdated: Date.now() },
            }),
        });
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        await addCostBreakdownItem('proto-123', {
          category: 'Cloud Infrastructure',
          amount: 25,
        });

        const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
        const costs = updateCall.costs as Record<string, unknown>;
        const breakdown = costs.breakdown as Array<{ category: string; amount: number }>;
        expect(breakdown).toHaveLength(2);
        expect(breakdown[1].category).toBe('Cloud Infrastructure');
      });

      it('should throw error when prototype not found', async () => {
        mockGetDoc.mockResolvedValueOnce({
          exists: () => false,
          data: () => null,
        });

        await expect(addCostBreakdownItem('non-existent', { category: 'Test', amount: 10 })).rejects.toThrow(
          'Failed to add cost breakdown item'
        );
      });
    });

    describe('removeCostBreakdownItem()', () => {
      it('should remove a cost breakdown item by category', async () => {
        const existingBreakdown = [
          { category: 'Development', amount: 50 },
          { category: 'Cloud Infrastructure', amount: 25 },
        ];
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () =>
            createMockPrototype({
              costs: { currency: 'USD', breakdown: existingBreakdown, lastUpdated: Date.now() },
            }),
        });
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        await removeCostBreakdownItem('proto-123', 'Development');

        const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
        const costs = updateCall.costs as Record<string, unknown>;
        const breakdown = costs.breakdown as Array<{ category: string }>;
        expect(breakdown).toHaveLength(1);
        expect(breakdown[0].category).toBe('Cloud Infrastructure');
      });

      it('should handle removing non-existent category', async () => {
        const existingBreakdown = [{ category: 'Development', amount: 50 }];
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () =>
            createMockPrototype({
              costs: { currency: 'USD', breakdown: existingBreakdown, lastUpdated: Date.now() },
            }),
        });
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        await removeCostBreakdownItem('proto-123', 'Non-Existent');

        const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
        const costs = updateCall.costs as Record<string, unknown>;
        const breakdown = costs.breakdown as Array<{ category: string }>;
        expect(breakdown).toHaveLength(1);
        expect(breakdown[0].category).toBe('Development');
      });
    });

    describe('getCostStatistics()', () => {
      it('should calculate cost statistics correctly', async () => {
        const mockPrototypes = [
          createMockPrototype({
            costs: {
              estimated: 100,
              actual: 120,
              currency: 'USD',
              breakdown: [
                { category: 'Development', amount: 80 },
                { category: 'Cloud Infrastructure', amount: 40 },
              ],
              lastUpdated: Date.now(),
            },
          }),
          createMockPrototype({
            costs: {
              estimated: 200,
              actual: 180,
              currency: 'USD',
              breakdown: [
                { category: 'Development', amount: 150 },
                { category: 'Hardware', amount: 30 },
              ],
              lastUpdated: Date.now(),
            },
          }),
        ];

        mockGetDocs.mockResolvedValueOnce({
          docs: mockPrototypes.map((p) => ({ data: () => p })),
        });

        const stats = await getCostStatistics();

        expect(stats.totalEstimated).toBe(300);
        expect(stats.totalActual).toBe(300);
        expect(stats.varianceAmount).toBe(0);
        expect(stats.prototypesWithCosts).toBe(2);
        expect(stats.averageEstimated).toBe(150);
        expect(stats.averageActual).toBe(150);
        expect(stats.breakdownByCategory['Development']).toBe(230);
        expect(stats.breakdownByCategory['Cloud Infrastructure']).toBe(40);
        expect(stats.breakdownByCategory['Hardware']).toBe(30);
      });

      it('should handle prototypes without costs', async () => {
        const mockPrototypes = [
          createMockPrototype({ costs: undefined }),
          createMockPrototype({
            costs: {
              estimated: 100,
              actual: 100,
              currency: 'USD',
              lastUpdated: Date.now(),
            },
          }),
        ];

        mockGetDocs.mockResolvedValueOnce({
          docs: mockPrototypes.map((p) => ({ data: () => p })),
        });

        const stats = await getCostStatistics();

        expect(stats.totalEstimated).toBe(100);
        expect(stats.totalActual).toBe(100);
        expect(stats.prototypesWithCosts).toBe(1);
      });

      it('should calculate variance percentage correctly', async () => {
        const mockPrototypes = [
          createMockPrototype({
            costs: {
              estimated: 100,
              actual: 150,
              currency: 'USD',
              lastUpdated: Date.now(),
            },
          }),
        ];

        mockGetDocs.mockResolvedValueOnce({
          docs: mockPrototypes.map((p) => ({ data: () => p })),
        });

        const stats = await getCostStatistics();

        expect(stats.varianceAmount).toBe(50);
        expect(stats.variancePercentage).toBe(50);
      });

      it('should handle empty prototype list', async () => {
        mockGetDocs.mockResolvedValueOnce({ docs: [] });

        const stats = await getCostStatistics();

        expect(stats.totalEstimated).toBe(0);
        expect(stats.totalActual).toBe(0);
        expect(stats.prototypesWithCosts).toBe(0);
        expect(stats.averageEstimated).toBe(0);
        expect(stats.averageActual).toBe(0);
      });
    });
  });
});
