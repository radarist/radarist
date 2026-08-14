/**
 * Unit Tests for Use Cases Module
 *
 * Tests CRUD operations for use cases including:
 * - getUseCases - Fetches all use cases
 * - getUseCaseById - Retrieves a specific use case
 * - createUseCase - Creates a new use case via entity-factory
 * - updateUseCase - Updates use case fields
 * - deleteUseCase - Removes a use case with cascade relation cleanup
 * - deleteUseCases - Bulk delete with batching
 * - linkUseCaseToBlip / unlinkUseCaseFromBlip - Technology linking
 * - linkUseCaseToCompany / unlinkUseCaseFromCompany - Company linking
 * - getUseCasesByBlipId - Query by technology
 * - getUseCasesByCompanyId - Query by company
 * - createUseCaseFromAgent - Agent-originated creation
 *
 * @jest-environment node
 */

import type { UseCase } from '../types';
import { DuplicateEntityError } from '../entity-factory';

// ============================================================================
// Mocks
// ============================================================================

jest.mock('../firebase', () => ({
  db: {},
  removeUndefinedFields: jest.fn((obj: Record<string, unknown>) => {
    const result: Record<string, unknown> = {};
    for (const key in obj) {
      if (obj[key] !== undefined) result[key] = obj[key];
    }
    return result;
  }),
}));

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(() => ({ id: 'doc-id', path: 'use-cases/doc-id' })),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  arrayUnion: jest.fn((val: string) => ({ _arrayUnion: val })),
  arrayRemove: jest.fn((val: string) => ({ _arrayRemove: val })),
  writeBatch: jest.fn(() => ({
    delete: jest.fn(),
    commit: jest.fn().mockResolvedValue(undefined),
  })),
  Timestamp: { now: jest.fn() },
}));

let entityCounter = 0;
jest.mock('../entity-factory', () => ({
  createEntity: jest.fn((_type: string, data: Record<string, unknown>) => {
    entityCounter++;
    return Promise.resolve({
      entity: { id: `uc-${entityCounter}`, slug: `slug-${entityCounter}`, createdAt: Date.now(), updatedAt: Date.now(), ...data },
      isNew: true,
    });
  }),
  DuplicateEntityError: jest.requireActual('../entity-factory').DuplicateEntityError,
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

jest.mock('../events/data-refresh', () => ({
  emitDataRefresh: jest.fn(),
}));

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

// ============================================================================
// Import mocked modules
// ============================================================================

import { getDocs, getDoc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { createEntity } from '../entity-factory';
import {
  requestEntityGraphDeletion,
  requestEntityGraphDeletions,
  requestEntityGraphSync,
  triggerEntitySync,
} from '../entity-sync';
import { emitDataRefresh } from '../events/data-refresh';
import { deleteRelationsForEntity } from '../relations';

const mockGetDocs = getDocs as jest.Mock;
const mockGetDoc = getDoc as jest.Mock;
const mockUpdateDoc = updateDoc as jest.Mock;
const mockDeleteDoc = deleteDoc as jest.Mock;
const mockCreateEntity = createEntity as jest.Mock;
const mockTriggerSync = triggerEntitySync as jest.Mock;
const mockRequestGraphSync = requestEntityGraphSync as jest.Mock;
const mockRequestEntityGraphDeletion = requestEntityGraphDeletion as jest.Mock;
const mockRequestEntityGraphDeletions = requestEntityGraphDeletions as jest.Mock;
const mockEmitDataRefresh = emitDataRefresh as jest.Mock;
const mockDeleteRelationsForEntity = deleteRelationsForEntity as jest.Mock;
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

// ============================================================================
// Import functions under test (after mocks)
// ============================================================================

import {
  getUseCases,
  getUseCaseById,
  createUseCase,
  updateUseCase,
  deleteUseCase,
  deleteUseCases,
  linkUseCaseToBlip,
  unlinkUseCaseFromBlip,
  linkUseCaseToCompany,
  unlinkUseCaseFromCompany,
  getUseCasesByBlipId,
  getUseCasesByCompanyId,
  createUseCaseFromAgent,
} from '../use-cases';

// ============================================================================
// Helpers
// ============================================================================

function createMockUseCase(overrides?: Partial<UseCase>): UseCase {
  return {
    id: 'uc-test-1',
    title: 'Fraud Detection',
    slug: 'fraud-detection',
    description: 'Detect fraudulent transactions in real-time',
    problem: 'High fraud losses',
    solution: 'ML-based detection',
    outcomes: ['Reduced fraud by 80%'],
    status: 'Proposed',
    category: 'Security',
    radarTechnologyIds: ['tech-1'],
    companyIds: ['company-1'],
    tags: ['security', 'ml'],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Use Cases Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    entityCounter = 0;
  });

  // --------------------------------------------------------------------------
  // getUseCases
  // --------------------------------------------------------------------------
  describe('getUseCases()', () => {
    it('should return all use cases from Firestore', async () => {
      const mockUc1 = createMockUseCase({ id: 'uc-1', title: 'Fraud Detection' });
      const mockUc2 = createMockUseCase({ id: 'uc-2', title: 'Predictive Maintenance' });

      mockGetDocs.mockResolvedValueOnce({
        docs: [
          { data: () => mockUc1 },
          { data: () => mockUc2 },
        ],
      });

      const result = await getUseCases();

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('Fraud Detection');
      expect(result[1].title).toBe('Predictive Maintenance');
    });

    it('should return empty array when no use cases exist', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getUseCases();

      expect(result).toEqual([]);
    });

    it('should propagate Firestore errors', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('Firestore connection failed'));

      await expect(getUseCases()).rejects.toThrow('Firestore connection failed');
    });
  });

  // --------------------------------------------------------------------------
  // getUseCaseById
  // --------------------------------------------------------------------------
  describe('getUseCaseById()', () => {
    it('should return a use case when it exists', async () => {
      const mockUc = createMockUseCase();
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => mockUc,
      });

      const result = await getUseCaseById('uc-test-1');

      expect(result).toEqual(mockUc);
      expect(result?.title).toBe('Fraud Detection');
    });

    it('should return null when use case does not exist', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => false,
      });

      const result = await getUseCaseById('nonexistent-id');

      expect(result).toBeNull();
    });

    it('should propagate Firestore errors', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('Permission denied'));

      await expect(getUseCaseById('uc-test-1')).rejects.toThrow('Permission denied');
    });
  });

  // --------------------------------------------------------------------------
  // createUseCase
  // --------------------------------------------------------------------------
  describe('createUseCase()', () => {
    it('should create a use case via entity-factory', async () => {
      const input = {
        title: 'Real-time Analytics',
        description: 'Process streaming data in real-time',
        status: 'Proposed' as const,
        radarTechnologyIds: [],
        companyIds: [],
        tags: ['analytics'],
      };

      const result = await createUseCase(input);

      // GRAPH-058: creates must ask for a REQUIRED graph handoff.
      expect(mockCreateEntity).toHaveBeenCalledWith('useCase', input, { graphSync: 'required' });
      expect(result.id).toBe('uc-1');
      expect(result.title).toBe('Real-time Analytics');
    });

    it('should leave create graph sync ownership to entity-factory', async () => {
      const input = {
        title: 'Test Use Case',
        description: 'Testing',
        status: 'Proposed' as const,
        radarTechnologyIds: [],
        companyIds: [],
        tags: [],
      };

      await createUseCase(input);

      expect(mockTriggerSync).not.toHaveBeenCalled();
    });

    it('should re-throw DuplicateEntityError without wrapping', async () => {
      const dupError = new DuplicateEntityError('useCase', 'slug', 'real-time-analytics', 'uc-existing');
      mockCreateEntity.mockRejectedValueOnce(dupError);

      const input = {
        title: 'Real-time Analytics',
        description: 'Duplicate',
        status: 'Proposed' as const,
        radarTechnologyIds: [],
        companyIds: [],
        tags: [],
      };

      await expect(createUseCase(input)).rejects.toBeInstanceOf(DuplicateEntityError);
    });

    it('should wrap generic errors with descriptive message', async () => {
      mockCreateEntity.mockRejectedValueOnce(new Error('Firestore write failed'));

      const input = {
        title: 'Failing Use Case',
        description: '',
        status: 'Proposed' as const,
        radarTechnologyIds: [],
        companyIds: [],
        tags: [],
      };

      await expect(createUseCase(input)).rejects.toThrow('Failed to create use case: Firestore write failed');
    });

    it('should handle non-Error thrown objects gracefully', async () => {
      mockCreateEntity.mockRejectedValueOnce('string error');

      const input = {
        title: 'Bad Error',
        description: '',
        status: 'Proposed' as const,
        radarTechnologyIds: [],
        companyIds: [],
        tags: [],
      };

      await expect(createUseCase(input)).rejects.toThrow('Failed to create use case: Unknown error');
    });
  });

  // --------------------------------------------------------------------------
  // updateUseCase
  // --------------------------------------------------------------------------
  describe('updateUseCase()', () => {
    it('should update a use case and set updatedAt', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateUseCase('uc-1', { title: 'Updated Title' });

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updatePayload = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updatePayload.title).toBe('Updated Title');
      expect(updatePayload.updatedAt).toBeDefined();
      expect(typeof updatePayload.updatedAt).toBe('number');
    });

    it('should strip undefined fields before updating', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateUseCase('uc-1', { title: 'Valid', category: undefined });

      const updatePayload = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updatePayload.title).toBe('Valid');
      expect(updatePayload).not.toHaveProperty('category');
    });

    it('requires an acknowledged Neo4j handoff after update', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateUseCase('uc-1', { status: 'In Progress' });

      // GRAPH-058: awaited and required, not fire-and-forget.
      expect(mockRequestGraphSync).toHaveBeenCalledWith('useCase', 'uc-1', 'update');
      expect(mockTriggerSync).not.toHaveBeenCalled();
    });

    it('should propagate Firestore update errors', async () => {
      mockUpdateDoc.mockRejectedValueOnce(new Error('Update failed'));

      await expect(updateUseCase('uc-1', { title: 'Fail' })).rejects.toThrow('Update failed');
    });
  });

  // --------------------------------------------------------------------------
  // deleteUseCase
  // --------------------------------------------------------------------------
  describe('deleteUseCase()', () => {
    it('should delete relations and then the use case document', async () => {
      mockDeleteRelationsForEntity.mockResolvedValueOnce(3);
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deleteUseCase('uc-1');

      expect(mockPreflightEntityReferenceCleanup).toHaveBeenCalledWith(
        'useCase',
        'uc-1',
        expect.anything()
      );
      expect(mockApplyEntityReferenceCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'useCase', entityId: 'uc-1' }),
        expect.anything()
      );
      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('useCase', 'uc-1');
      expect(mockDeleteRelationsForEntity).toHaveBeenCalledWith('uc-1');
      expect(mockDeleteAllEntityNotes).toHaveBeenCalledWith({}, 'use-cases', 'uc-1');
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
      expect(mockRequestEntityGraphDeletion.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteLinksForEntity.mock.invocationCallOrder[0]
      );
      expect(mockDeleteLinksForEntity.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteRelationsForEntity.mock.invocationCallOrder[0]
      );
      expect(mockDeleteRelationsForEntity.mock.invocationCallOrder[0]).toBeLessThan(
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
      mockDeleteRelationsForEntity.mockResolvedValueOnce(0);
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deleteUseCase('uc-1');

      expect(mockRequestEntityGraphDeletion).toHaveBeenCalledWith('useCase', 'uc-1');
      expect(mockRequestEntityGraphDeletion.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteDoc.mock.invocationCallOrder[0]
      );
    });

    it('should retain the Firestore document when graph deletion is not acknowledged', async () => {
      mockRequestEntityGraphDeletion.mockRejectedValueOnce(new Error('handoff failed'));

      await expect(deleteUseCase('uc-1')).rejects.toThrow('handoff failed');

      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('should handle zero relations gracefully', async () => {
      mockDeleteRelationsForEntity.mockResolvedValueOnce(0);
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await expect(deleteUseCase('uc-1')).resolves.toBeUndefined();
    });

    it('should propagate Firestore delete errors', async () => {
      mockDeleteRelationsForEntity.mockResolvedValueOnce(0);
      mockDeleteDoc.mockRejectedValueOnce(new Error('Delete failed'));

      await expect(deleteUseCase('uc-1')).rejects.toThrow('Delete failed');
    });

    it('retains the parent when note cleanup fails', async () => {
      mockDeleteAllEntityNotes.mockRejectedValueOnce(new Error('note cleanup failed'));

      await expect(deleteUseCase('uc-1')).rejects.toThrow('note cleanup failed');
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when document-link cleanup fails', async () => {
      mockDeleteLinksForEntity.mockRejectedValueOnce(new Error('link cleanup failed'));

      await expect(deleteUseCase('uc-1')).rejects.toThrow('link cleanup failed');
      expect(mockDeleteRelationsForEntity).not.toHaveBeenCalled();
      expect(mockDeleteAllEntityNotes).not.toHaveBeenCalled();
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when live-reference cleanup fails', async () => {
      mockApplyEntityReferenceCleanup.mockRejectedValueOnce(new Error('reference cleanup failed'));

      await expect(deleteUseCase('uc-1')).rejects.toThrow('reference cleanup failed');
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // deleteUseCases (bulk)
  // --------------------------------------------------------------------------
  describe('deleteUseCases()', () => {
    it('preflights every ID before graph handoff and isolates a failed preflight', async () => {
      const cleanupPlan = {
        entityType: 'useCase',
        entityId: 'uc-1',
        ownedReferences: [],
        liveArrayReferences: [],
      };
      mockPreflightEntityReferenceCleanups.mockResolvedValueOnce({
        prepared: [{ id: 'uc-1', plan: cleanupPlan }],
        failed: [{ id: 'uc-2', error: new Error('blocked') }],
      });
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteRelationsForEntity.mockResolvedValue(0);

      const result = await deleteUseCases(['uc-1', 'uc-2']);

      expect(result).toEqual({ deleted: 1, failed: ['uc-2'], relationsDeleted: 0 });
      expect(mockPreflightEntityReferenceCleanups).toHaveBeenCalledWith(
        'useCase',
        ['uc-1', 'uc-2'],
        expect.anything()
      );
      expect(mockPreflightEntityReferenceCleanups.mock.invocationCallOrder[0]).toBeLessThan(
        mockRequestEntityGraphDeletions.mock.invocationCallOrder[0]
      );
      expect(mockRequestEntityGraphDeletions).toHaveBeenCalledWith('useCase', ['uc-1']);
      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('useCase', 'uc-1');
      expect(mockDeleteLinksForEntity).not.toHaveBeenCalledWith('useCase', 'uc-2');
      expect(mockApplyEntityReferenceCleanup).toHaveBeenCalledWith(cleanupPlan, expect.anything());
      expect(mockBatch.delete).toHaveBeenCalledTimes(1);
    });

    it('should bulk delete use cases and return result summary', async () => {
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteRelationsForEntity.mockResolvedValue(2);

      const result = await deleteUseCases(['uc-1', 'uc-2', 'uc-3']);

      expect(result.deleted).toBe(3);
      expect(result.failed).toEqual([]);
      expect(result.relationsDeleted).toBe(6); // 2 per entity * 3
      expect(mockBatch.delete).toHaveBeenCalledTimes(3);
    });

    it('should emit data refresh event after successful bulk delete', async () => {
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteRelationsForEntity.mockResolvedValue(0);

      await deleteUseCases(['uc-1']);

      expect(mockEmitDataRefresh).toHaveBeenCalledWith('useCases', 'bulk-delete');
    });

    it('should return empty result when no IDs provided', async () => {
      const result = await deleteUseCases([]);

      expect(result.deleted).toBe(0);
      expect(result.failed).toEqual([]);
      expect(result.relationsDeleted).toBe(0);
      expect(mockEmitDataRefresh).not.toHaveBeenCalled();
    });

    it('should record failed IDs when batch commit fails', async () => {
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockRejectedValue(new Error('Batch failed')) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteRelationsForEntity.mockResolvedValue(0);

      const result = await deleteUseCases(['uc-1', 'uc-2']);

      expect(result.deleted).toBe(0);
      expect(result.failed).toEqual(['uc-1', 'uc-2']);
      // No data refresh emitted for zero deletions
      expect(mockEmitDataRefresh).not.toHaveBeenCalled();
    });

    it('retains only the use case whose document-link cleanup fails', async () => {
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteLinksForEntity
        .mockResolvedValueOnce(0)
        .mockRejectedValueOnce(new Error('link cleanup failed'));
      mockDeleteRelationsForEntity.mockResolvedValue(1);

      const result = await deleteUseCases(['uc-1', 'uc-2']);

      expect(result).toEqual({ deleted: 1, failed: ['uc-2'], relationsDeleted: 1 });
      expect(mockBatch.delete).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // Link / Unlink - Blips
  // --------------------------------------------------------------------------
  describe('linkUseCaseToBlip()', () => {
    it('should add blip ID to radarTechnologyIds with arrayUnion', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await linkUseCaseToBlip('uc-1', 'blip-42');

      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          radarTechnologyIds: { _arrayUnion: 'blip-42' },
        })
      );
    });
  });

  describe('unlinkUseCaseFromBlip()', () => {
    it('should remove blip ID from radarTechnologyIds with arrayRemove', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await unlinkUseCaseFromBlip('uc-1', 'blip-42');

      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          radarTechnologyIds: { _arrayRemove: 'blip-42' },
        })
      );
    });
  });

  // --------------------------------------------------------------------------
  // Link / Unlink - Companies
  // --------------------------------------------------------------------------
  describe('linkUseCaseToCompany()', () => {
    it('should add company ID to companyIds with arrayUnion', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await linkUseCaseToCompany('uc-1', 'company-abc');

      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyIds: { _arrayUnion: 'company-abc' },
        })
      );
    });
  });

  describe('unlinkUseCaseFromCompany()', () => {
    it('should remove company ID from companyIds with arrayRemove', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await unlinkUseCaseFromCompany('uc-1', 'company-abc');

      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyIds: { _arrayRemove: 'company-abc' },
        })
      );
    });
  });

  // --------------------------------------------------------------------------
  // Query by linked entity
  // --------------------------------------------------------------------------
  describe('getUseCasesByBlipId()', () => {
    it('should return use cases linked to a specific blip', async () => {
      const mockUc = createMockUseCase({ radarTechnologyIds: ['blip-42'] });
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => mockUc }],
      });

      const result = await getUseCasesByBlipId('blip-42');

      expect(result).toHaveLength(1);
      expect(result[0].radarTechnologyIds).toContain('blip-42');
    });

    it('should return empty array when no use cases are linked', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getUseCasesByBlipId('blip-999');

      expect(result).toEqual([]);
    });
  });

  describe('getUseCasesByCompanyId()', () => {
    it('should return use cases linked to a specific company', async () => {
      const mockUc = createMockUseCase({ companyIds: ['company-abc'] });
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => mockUc }],
      });

      const result = await getUseCasesByCompanyId('company-abc');

      expect(result).toHaveLength(1);
      expect(result[0].companyIds).toContain('company-abc');
    });

    it('should return empty array when no use cases match', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getUseCasesByCompanyId('company-nonexistent');

      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // createUseCaseFromAgent
  // --------------------------------------------------------------------------
  describe('createUseCaseFromAgent()', () => {
    it('should create a use case from agent input with source lineage', async () => {
      const result = await createUseCaseFromAgent(
        {
          title: 'Agent-discovered Use Case',
          description: 'Discovered by agent',
          problem: 'High costs',
          solution: 'Automation',
          outcomes: ['Cost reduction'],
          category: 'Operations',
          technologies: ['tech-1'],
          companies: ['company-1'],
          tags: ['automation'],
          relevanceScore: 85,
        },
        {
          agentId: 'agent-123',
          agentName: 'Scout Agent',
          taskTemplate: 'look-for-use-cases',
        }
      );

      expect(result.title).toBe('Agent-discovered Use Case');
      expect(result.status).toBe('Proposed');
      expect(result.source).toEqual(
        expect.objectContaining({
          type: 'agent',
          agentId: 'agent-123',
          agentName: 'Scout Agent',
          taskTemplate: 'look-for-use-cases',
        })
      );
      expect(result.aiMetadata).toEqual(
        expect.objectContaining({ relevanceScore: 85 })
      );
    });

    it('should throw when title is empty', async () => {
      await expect(
        createUseCaseFromAgent(
          { title: '' },
          { agentId: 'agent-1' }
        )
      ).rejects.toThrow('Use case title is required');
    });

    it('should throw when title is only whitespace', async () => {
      await expect(
        createUseCaseFromAgent(
          { title: '   ' },
          { agentId: 'agent-1' }
        )
      ).rejects.toThrow('Use case title is required');
    });

    it('should provide sensible defaults for optional fields', async () => {
      const result = await createUseCaseFromAgent(
        { title: 'Minimal Use Case' },
        { agentId: 'agent-1' }
      );

      expect(result.description).toBe('');
      expect(result.problem).toBe('');
      expect(result.solution).toBe('');
      expect(result.outcomes).toEqual([]);
      expect(result.radarTechnologyIds).toEqual([]);
      expect(result.companyIds).toEqual([]);
      expect(result.tags).toEqual([]);
      expect(result.category).toBe('');
    });

    it('should not include aiMetadata when relevanceScore is not provided', async () => {
      const result = await createUseCaseFromAgent(
        { title: 'No Score Use Case' },
        { agentId: 'agent-1' }
      );

      expect(result.aiMetadata).toBeUndefined();
    });
  });
});
