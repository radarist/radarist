/**
 * Unit Tests for Companies Module
 *
 * Tests CRUD operations for companies including:
 * - getCompanies - Fetches all companies
 * - getCompanyById - Retrieves a specific company
 * - createCompany - Creates a new company with entity-factory
 * - updateCompany - Updates company fields with validation
 * - deleteCompany - Removes a company with relation cleanup
 * - deleteCompanies - Bulk delete with batching
 * - updateCompanyStatus - Convenience status updater
 * - searchCompanies - Client-side filtering and fuzzy search
 * - getCompaniesByBlipId - Stub for blip linking
 * - getCompaniesByUseCaseId - Fetches companies linked to a use case
 * - createCompanyFromAgent - Agent-sourced company creation
 *
 * @jest-environment node
 */

import type { Company } from '../types';

// =============================================================================
// MOCKS
// =============================================================================

// Mock firebase
jest.mock('../firebase', () => ({
  db: {},
  removeUndefinedFields: jest.fn((obj: Record<string, unknown>) => {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }),
}));

// Mock firebase/firestore
jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(() => ({ id: 'doc-id', path: 'companies/doc-id' })),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  runTransaction: jest.fn(),
  writeBatch: jest.fn(() => ({
    delete: jest.fn(),
    commit: jest.fn().mockResolvedValue(undefined),
  })),
  Timestamp: {
    now: jest.fn(),
    fromDate: jest.fn(),
  },
}));

// Mock entity-factory
let entityCounter = 0;
jest.mock('../entity-factory', () => ({
  __esModule: true,
  createEntity: jest.fn().mockImplementation(
    async (_type: string, data: Record<string, unknown>) => {
      entityCounter++;
      return {
        entity: {
          ...data,
          id: `company-${entityCounter}`,
          slug: `slug-${entityCounter}`,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
        isNew: true,
      };
    }
  ),
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

// Mock inngest sync
jest.mock('../inngest/functions/sync-entity-to-neo4j', () => ({
  triggerUnifiedEntitySync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../entity-sync', () => ({
  requestEntityGraphSync: jest.fn().mockResolvedValue(undefined),
  requestEntityGraphDeletion: jest.fn().mockResolvedValue(undefined),
  requestEntityGraphDeletions: jest.fn(async (_type: string, ids: string[]) => ({
    acknowledged: [...ids],
    failed: [],
  })),
  triggerEntitySync: jest.fn().mockResolvedValue(undefined),
}));

// Mock inngest client (in case it's transitively imported)
jest.mock('../inngest/client', () => ({
  inngest: {
    send: jest.fn(),
    createFunction: jest.fn().mockReturnValue(jest.fn()),
  },
}));

// Mock fuzzy-search
jest.mock('../fuzzy-search', () => ({
  fuzzySearch: jest.fn((items: Record<string, unknown>[], _query: string) => items),
}));

// Mock data-refresh events
jest.mock('../events/data-refresh', () => ({
  emitDataRefresh: jest.fn(),
}));

// Mock company schema validation (pass through with normalization)
jest.mock('../schemas/company', () => ({
  validateCreateCompanyWithNormalize: jest.fn((data: Record<string, unknown>) => data),
  validateUpdateCompanyWithNormalize: jest.fn((data: Record<string, unknown>) => data),
}));

// Mock relations (dynamically imported in deleteCompany)
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

// Mock use-cases (dynamically imported in getCompaniesByUseCaseId)
jest.mock('../use-cases', () => ({
  getUseCaseById: jest.fn(),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { getDocs, getDoc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { createEntity, DuplicateEntityError } from '../entity-factory';
import { triggerUnifiedEntitySync } from '../inngest/functions/sync-entity-to-neo4j';
import { fuzzySearch } from '../fuzzy-search';
import { emitDataRefresh } from '../events/data-refresh';
import { validateCreateCompanyWithNormalize, validateUpdateCompanyWithNormalize } from '../schemas/company';
import { deleteRelationsForEntity } from '../relations';
import { getUseCaseById } from '../use-cases';
import {
  requestEntityGraphSync,
  requestEntityGraphDeletion,
  requestEntityGraphDeletions,
} from '../entity-sync';

import {
  getCompanies,
  getCompanyById,
  createCompany,
  updateCompany,
  deleteCompany,
  deleteCompanies,
  updateCompanyStatus,
  searchCompanies,
  getCompaniesByBlipId,
  getCompaniesByUseCaseId,
  createCompanyFromAgent,
} from '../companies';

// Cast mocks for type safety
const mockGetDocs = getDocs as jest.Mock;
const mockGetDoc = getDoc as jest.Mock;
const mockUpdateDoc = updateDoc as jest.Mock;
const mockDeleteDoc = deleteDoc as jest.Mock;
const mockWriteBatch = writeBatch as jest.Mock;
const mockCreateEntity = createEntity as jest.Mock;
const mockTriggerSync = triggerUnifiedEntitySync as jest.Mock;
const mockFuzzySearch = fuzzySearch as jest.Mock;
const mockEmitDataRefresh = emitDataRefresh as jest.Mock;
const mockValidateCreate = validateCreateCompanyWithNormalize as jest.Mock;
const mockValidateUpdate = validateUpdateCompanyWithNormalize as jest.Mock;
const mockDeleteRelationsForEntity = deleteRelationsForEntity as jest.Mock;
const mockGetUseCaseById = getUseCaseById as jest.Mock;
const mockRequestEntityGraphSync = requestEntityGraphSync as jest.Mock;
const mockRequestEntityGraphDeletion = requestEntityGraphDeletion as jest.Mock;
const mockRequestEntityGraphDeletions = requestEntityGraphDeletions as jest.Mock;
const {
  preflightEntityReferenceCleanup: mockPreflightEntityReferenceCleanup,
  preflightEntityReferenceCleanups: mockPreflightEntityReferenceCleanups,
  applyEntityReferenceCleanup: mockApplyEntityReferenceCleanup,
} = jest.requireMock('../entity-reference-cleanup') as {
  preflightEntityReferenceCleanup: jest.Mock;
  preflightEntityReferenceCleanups: jest.Mock;
  applyEntityReferenceCleanup: jest.Mock;
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Creates a mock Company object for testing.
 */
function createMockCompany(overrides?: Partial<Company>): Company {
  return {
    id: 'company-test-1',
    slug: 'datadog',
    name: 'Datadog',
    description: 'Monitoring and analytics platform',
    logo: '',
    website: 'https://www.datadoghq.com',
    type: ['corporate'],
    industry: ['technology'],
    size: 'enterprise',
    stage: 'public',
    location: { city: 'New York', country: 'USA' },
    status: 'Watching',
    tags: ['monitoring', 'apm'],
    socialLinks: { linkedin: '', twitter: '', github: '' },
    technologyStack: ['Python', 'Go'],
    documents: [],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

/**
 * Creates a valid company input (without id/slug/timestamps).
 */
function createCompanyInput(): Omit<Company, 'id' | 'slug' | 'createdAt' | 'updatedAt'> {
  return {
    name: 'Datadog',
    description: 'Monitoring and analytics platform',
    logo: '',
    website: 'https://www.datadoghq.com',
    type: ['corporate'],
    industry: ['technology'],
    size: 'enterprise',
    stage: 'public',
    location: { city: 'New York', country: 'USA' },
    status: 'Watching',
    tags: ['monitoring', 'apm'],
    socialLinks: { linkedin: '', twitter: '', github: '' },
    technologyStack: ['Python', 'Go'],
    documents: [],
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Companies Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    entityCounter = 0;
  });

  // ---------------------------------------------------------------------------
  // getCompanies
  // ---------------------------------------------------------------------------

  describe('getCompanies()', () => {
    it('should return all companies from Firestore', async () => {
      const mockCompanies = [
        createMockCompany({ id: 'c-1', name: 'Alpha' }),
        createMockCompany({ id: 'c-2', name: 'Beta' }),
      ];
      mockGetDocs.mockResolvedValueOnce({
        docs: mockCompanies.map((c) => ({ data: () => c })),
      });

      const result = await getCompanies();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Alpha');
      expect(result[1].name).toBe('Beta');
      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should return an empty array when no companies exist', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getCompanies();

      expect(result).toEqual([]);
    });

    it('should propagate Firestore errors', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('Firestore unavailable'));

      await expect(getCompanies()).rejects.toThrow('Firestore unavailable');
    });
  });

  // ---------------------------------------------------------------------------
  // getCompanyById
  // ---------------------------------------------------------------------------

  describe('getCompanyById()', () => {
    it('should return a company when it exists', async () => {
      const mockCompany = createMockCompany();
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => mockCompany,
      });

      const result = await getCompanyById('company-test-1');

      expect(result).toEqual(mockCompany);
      expect(result?.name).toBe('Datadog');
      expect(mockGetDoc).toHaveBeenCalledTimes(1);
    });

    it('should return null when the company does not exist', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => false,
        data: () => null,
      });

      const result = await getCompanyById('non-existent-id');

      expect(result).toBeNull();
    });

    it('should propagate Firestore errors', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('Permission denied'));

      await expect(getCompanyById('some-id')).rejects.toThrow('Permission denied');
    });
  });

  // ---------------------------------------------------------------------------
  // createCompany
  // ---------------------------------------------------------------------------

  describe('createCompany()', () => {
    it('should create a company via entity-factory and return it', async () => {
      const input = createCompanyInput();

      const result = await createCompany(input);

      expect(result.id).toBe('company-1');
      expect(result.name).toBe('Datadog');
      expect(mockValidateCreate).toHaveBeenCalledWith(input);
      expect(mockCreateEntity).toHaveBeenCalledTimes(1);
      expect(mockCreateEntity).toHaveBeenCalledWith(
        'company',
        expect.objectContaining({ name: 'Datadog' }),
        { graphSync: 'required' }
      );
    });

    it('should emit a data refresh event on creation', async () => {
      const input = createCompanyInput();

      await createCompany(input);

      expect(mockEmitDataRefresh).toHaveBeenCalledWith('companies', 'create');
    });

    it('should not call deprecated unified sync hook on creation', async () => {
      const input = createCompanyInput();

      await createCompany(input);

      await new Promise(process.nextTick);

      expect(mockTriggerSync).not.toHaveBeenCalled();
    });

    it('should propagate DuplicateEntityError from entity-factory', async () => {
      mockCreateEntity.mockRejectedValueOnce(
        new DuplicateEntityError('Company', 'name', 'Datadog', 'existing-id')
      );
      const input = createCompanyInput();

      await expect(createCompany(input)).rejects.toThrow('already exists');
    });

    it('should propagate validation errors', async () => {
      mockValidateCreate.mockImplementationOnce(() => {
        throw new Error('Validation failed: name is required');
      });
      const input = createCompanyInput();

      await expect(createCompany(input)).rejects.toThrow('Validation failed');
    });
  });

  // ---------------------------------------------------------------------------
  //  // ---------------------------------------------------------------------------

  

  // ---------------------------------------------------------------------------
  // updateCompany
  // ---------------------------------------------------------------------------

  describe('updateCompany()', () => {
    it('should validate, clean, and update a company', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateCompany('company-1', { name: 'Updated Datadog' });

      expect(mockValidateUpdate).toHaveBeenCalledWith({ name: 'Updated Datadog' });
      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      expect(mockUpdateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: 'Updated Datadog', updatedAt: expect.any(Number) })
      );
    });

    it('should emit a data refresh event on update', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateCompany('company-1', { status: 'Partner' });

      expect(mockEmitDataRefresh).toHaveBeenCalledWith('companies', 'update');
    });

    it('should require an acknowledged graph handoff after update', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateCompany('company-1', { name: 'Updated' });
      await new Promise(process.nextTick);

      expect(mockTriggerSync).not.toHaveBeenCalled();
      expect(mockRequestEntityGraphSync).toHaveBeenCalledWith(
        'company',
        'company-1',
        'update'
      );
    });

    it('should propagate Firestore errors', async () => {
      mockUpdateDoc.mockRejectedValueOnce(new Error('Update failed'));

      await expect(updateCompany('company-1', { name: 'Test' })).rejects.toThrow('Update failed');
    });
  });

  // ---------------------------------------------------------------------------
  // deleteCompany
  // ---------------------------------------------------------------------------

  describe('deleteCompany()', () => {
    it('should require the graph handoff, then delete relations and the company document', async () => {
      mockDeleteRelationsForEntity.mockResolvedValueOnce(3);
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deleteCompany('company-1');

      expect(mockPreflightEntityReferenceCleanup).toHaveBeenCalledWith(
        'company',
        'company-1',
        expect.anything()
      );
      expect(mockApplyEntityReferenceCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'company', entityId: 'company-1' }),
        expect.anything()
      );
      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('company', 'company-1');
      expect(mockDeleteRelationsForEntity).toHaveBeenCalledWith('company-1');
      expect(mockDeleteAllEntityNotes).toHaveBeenCalledWith({}, 'companies', 'company-1');
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
      expect(mockPreflightEntityReferenceCleanup.mock.invocationCallOrder[0]).toBeLessThan(
        mockRequestEntityGraphDeletion.mock.invocationCallOrder[0]
      );
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

    it('should emit a data refresh event on delete', async () => {
      mockDeleteRelationsForEntity.mockResolvedValueOnce(0);
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deleteCompany('company-1');

      expect(mockEmitDataRefresh).toHaveBeenCalledWith('companies', 'delete');
    });

    it('should require graph deletion delivery before deleting Firestore', async () => {
      mockDeleteRelationsForEntity.mockResolvedValueOnce(0);
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deleteCompany('company-1');
      await new Promise(process.nextTick);

      expect(mockTriggerSync).not.toHaveBeenCalled();
      expect(mockRequestEntityGraphDeletion).toHaveBeenCalledWith('company', 'company-1');
      expect(mockRequestEntityGraphDeletion.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteDoc.mock.invocationCallOrder[0]
      );
    });

    it('should retain the Firestore document when graph deletion is not acknowledged', async () => {
      mockRequestEntityGraphDeletion.mockRejectedValueOnce(new Error('handoff failed'));

      await expect(deleteCompany('company-1')).rejects.toThrow('handoff failed');

      expect(mockDeleteRelationsForEntity).not.toHaveBeenCalled();
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('should propagate Firestore deletion errors', async () => {
      mockDeleteRelationsForEntity.mockResolvedValueOnce(0);
      mockDeleteDoc.mockRejectedValueOnce(new Error('Delete failed'));

      await expect(deleteCompany('company-1')).rejects.toThrow('Delete failed');
    });

    it('retains the parent when document-link cleanup fails', async () => {
      mockDeleteLinksForEntity.mockRejectedValueOnce(new Error('link cleanup failed'));

      await expect(deleteCompany('company-1')).rejects.toThrow('link cleanup failed');

      expect(mockDeleteRelationsForEntity).not.toHaveBeenCalled();
      expect(mockDeleteAllEntityNotes).not.toHaveBeenCalled();
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when note cleanup fails', async () => {
      mockDeleteAllEntityNotes.mockRejectedValueOnce(new Error('note cleanup failed'));

      await expect(deleteCompany('company-1')).rejects.toThrow('note cleanup failed');

      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when live-reference cleanup fails', async () => {
      mockApplyEntityReferenceCleanup.mockRejectedValueOnce(new Error('reference cleanup failed'));

      await expect(deleteCompany('company-1')).rejects.toThrow('reference cleanup failed');

      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('can retry the final Firestore delete after an accepted graph handoff', async () => {
      mockDeleteDoc.mockRejectedValueOnce(new Error('Delete failed')).mockResolvedValueOnce(undefined);

      await expect(deleteCompany('company-1')).rejects.toThrow('Delete failed');
      await expect(deleteCompany('company-1')).resolves.toBeUndefined();

      expect(mockRequestEntityGraphDeletion).toHaveBeenCalledTimes(2);
      expect(mockDeleteDoc).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteCompanies (bulk)
  // ---------------------------------------------------------------------------

  describe('deleteCompanies()', () => {
    it('preflights every ID before graph handoff and isolates a failed preflight', async () => {
      const cleanupPlan = {
        entityType: 'company',
        entityId: 'c-1',
        ownedReferences: [],
        liveArrayReferences: [],
      };
      mockPreflightEntityReferenceCleanups.mockResolvedValueOnce({
        prepared: [{ id: 'c-1', plan: cleanupPlan }],
        failed: [{ id: 'c-2', error: new Error('blocked') }],
      });
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteRelationsForEntity.mockResolvedValue(0);

      const result = await deleteCompanies(['c-1', 'c-2']);

      expect(result).toEqual({ deleted: 1, failed: ['c-2'], relationsDeleted: 0 });
      expect(mockPreflightEntityReferenceCleanups).toHaveBeenCalledWith(
        'company',
        ['c-1', 'c-2'],
        expect.anything()
      );
      expect(mockPreflightEntityReferenceCleanups.mock.invocationCallOrder[0]).toBeLessThan(
        mockRequestEntityGraphDeletions.mock.invocationCallOrder[0]
      );
      expect(mockRequestEntityGraphDeletions).toHaveBeenCalledWith('company', ['c-1']);
      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('company', 'c-1');
      expect(mockDeleteLinksForEntity).not.toHaveBeenCalledWith('company', 'c-2');
      expect(mockApplyEntityReferenceCleanup).toHaveBeenCalledWith(cleanupPlan, expect.anything());
      expect(mockBatch.delete).toHaveBeenCalledTimes(1);
    });

    it('should delete multiple companies in a batch', async () => {
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteRelationsForEntity.mockResolvedValue(1);

      const result = await deleteCompanies(['c-1', 'c-2', 'c-3']);

      expect(result.deleted).toBe(3);
      expect(result.failed).toEqual([]);
      expect(result.relationsDeleted).toBe(3); // 1 per company
      expect(mockBatch.delete).toHaveBeenCalledTimes(3);
      expect(mockBatch.commit).toHaveBeenCalledTimes(1);
      expect(mockRequestEntityGraphDeletions).toHaveBeenCalledWith('company', ['c-1', 'c-2', 'c-3']);
      expect(mockRequestEntityGraphDeletions.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteRelationsForEntity.mock.invocationCallOrder[0]
      );
      expect(mockDeleteRelationsForEntity.mock.invocationCallOrder[0]).toBeLessThan(
        mockBatch.delete.mock.invocationCallOrder[0]
      );
    });

    it('mutates only IDs whose bulk graph handoff was acknowledged', async () => {
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockRequestEntityGraphDeletions.mockResolvedValueOnce({
        acknowledged: ['c-1'],
        failed: [{ id: 'c-2', error: new Error('handoff failed') }],
      });
      mockDeleteRelationsForEntity.mockResolvedValue(2);

      const result = await deleteCompanies(['c-1', 'c-2']);

      expect(result).toEqual({ deleted: 1, failed: ['c-2'], relationsDeleted: 2 });
      expect(mockDeleteRelationsForEntity).toHaveBeenCalledTimes(1);
      expect(mockDeleteRelationsForEntity).toHaveBeenCalledWith('c-1');
      expect(mockDeleteRelationsForEntity).not.toHaveBeenCalledWith('c-2');
      expect(mockBatch.delete).toHaveBeenCalledTimes(1);
    });

    it('should emit data refresh when companies are deleted', async () => {
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteRelationsForEntity.mockResolvedValue(0);

      await deleteCompanies(['c-1']);

      expect(mockEmitDataRefresh).toHaveBeenCalledWith('companies', 'bulk-delete');
    });

    it('should handle batch commit failure by recording failed IDs', async () => {
      const mockBatch = {
        delete: jest.fn(),
        commit: jest.fn().mockRejectedValue(new Error('Batch failed')),
      };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteRelationsForEntity.mockResolvedValue(0);

      const result = await deleteCompanies(['c-1', 'c-2']);

      expect(result.deleted).toBe(0);
      expect(result.failed).toEqual(['c-1', 'c-2']);
    });

    it('should handle empty ID array', async () => {
      const result = await deleteCompanies([]);

      expect(result.deleted).toBe(0);
      expect(result.failed).toEqual([]);
      expect(result.relationsDeleted).toBe(0);
      expect(mockEmitDataRefresh).not.toHaveBeenCalled();
    });

    it('keeps graph handoffs and parent batches at the 450-write boundary', async () => {
      const parentBatches: Array<{ delete: jest.Mock; commit: jest.Mock }> = [];
      mockWriteBatch.mockImplementation(() => {
        const batch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
        parentBatches.push(batch);
        return batch;
      });
      mockDeleteRelationsForEntity.mockResolvedValue(0);
      const ids = Array.from({ length: 451 }, (_, index) => `company-${index}`);

      const result = await deleteCompanies(ids);

      expect(result).toMatchObject({ deleted: 451, failed: [] });
      expect(mockRequestEntityGraphDeletions.mock.calls.map((call) => call[1].length)).toEqual([450, 1]);
      expect(parentBatches.map((batch) => batch.delete.mock.calls.length)).toEqual([450, 1]);
    });

    it('retains the exact company whose relation cleanup fails', async () => {
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      // First call succeeds, second fails.
      mockDeleteRelationsForEntity
        .mockResolvedValueOnce(2)
        .mockRejectedValueOnce(new Error('Relation delete failed'));

      const result = await deleteCompanies(['c-1', 'c-2']);

      expect(result).toEqual({ deleted: 1, failed: ['c-2'], relationsDeleted: 2 });
      expect(mockBatch.delete).toHaveBeenCalledTimes(1);
    });

    it('retains only the company whose note cleanup fails', async () => {
      const mockBatch = { delete: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
      mockWriteBatch.mockReturnValueOnce(mockBatch);
      mockDeleteRelationsForEntity.mockResolvedValue(1);
      mockDeleteAllEntityNotes
        .mockResolvedValueOnce(0)
        .mockRejectedValueOnce(new Error('note cleanup failed'));

      const result = await deleteCompanies(['c-1', 'c-2']);

      expect(result).toEqual({ deleted: 1, failed: ['c-2'], relationsDeleted: 1 });
      expect(mockBatch.delete).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // updateCompanyStatus
  // ---------------------------------------------------------------------------

  describe('updateCompanyStatus()', () => {
    it('should delegate to updateCompany with the new status', async () => {
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateCompanyStatus('company-1', 'Partner');

      expect(mockValidateUpdate).toHaveBeenCalledWith({ status: 'Partner' });
      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // searchCompanies
  // ---------------------------------------------------------------------------

  describe('searchCompanies()', () => {
    const companiesDataset = [
      createMockCompany({ id: 'c-1', name: 'Datadog', status: 'Watching', type: ['corporate'], industry: ['technology'], size: 'enterprise', stage: 'public', tags: ['monitoring'] }),
      createMockCompany({ id: 'c-2', name: 'Sentry', status: 'Partner', type: ['startup'], industry: ['technology'], size: 'small', stage: 'series_b', tags: ['error-tracking'] }),
      createMockCompany({ id: 'c-3', name: 'FreshProduce Co', status: 'Watching', type: ['sme'], industry: ['food_agriculture'], size: 'medium', stage: 'private', tags: ['food'] }),
    ];

    beforeEach(() => {
      mockGetDocs.mockResolvedValue({
        docs: companiesDataset.map((c) => ({ data: () => c })),
      });
    });

    it('should return all companies when no filters are provided', async () => {
      const results = await searchCompanies();

      expect(results).toHaveLength(3);
    });

    it('should apply fuzzy search when searchQuery is provided', async () => {
      // Mock fuzzySearch to return only matching results
      mockFuzzySearch.mockReturnValueOnce([companiesDataset[0]]);

      const results = await searchCompanies({ searchQuery: 'Datadog' });

      expect(mockFuzzySearch).toHaveBeenCalledWith(
        expect.any(Array),
        'Datadog',
        { keys: ['name', 'description'], threshold: 0.2 }
      );
      expect(results).toHaveLength(1);
    });

    it('should filter by status', async () => {
      const results = await searchCompanies({ status: ['Watching'] });

      expect(results).toHaveLength(2);
      expect(results.every((c) => c.status === 'Watching')).toBe(true);
    });

    it('should filter by type (multi-value)', async () => {
      const results = await searchCompanies({ type: ['corporate', 'startup'] });

      expect(results).toHaveLength(2);
    });

    it('should filter by industry', async () => {
      const results = await searchCompanies({ industry: ['food_agriculture'] });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('FreshProduce Co');
    });

    it('should filter by size', async () => {
      const results = await searchCompanies({ size: ['enterprise'] });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Datadog');
    });

    it('should filter by stage', async () => {
      const results = await searchCompanies({ stage: ['series_b'] });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Sentry');
    });

    it('should filter by tags', async () => {
      const results = await searchCompanies({ tags: ['monitoring'] });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Datadog');
    });

    it('should combine multiple filters (intersection)', async () => {
      const results = await searchCompanies({
        status: ['Watching'],
        type: ['corporate'],
      });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Datadog');
    });

    it('should return empty array when no companies match filters', async () => {
      const results = await searchCompanies({ status: ['Rejected'] });

      expect(results).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getCompaniesByBlipId
  // ---------------------------------------------------------------------------

  describe('getCompaniesByBlipId()', () => {
    it('should return an empty array (stub implementation)', async () => {
      const result = await getCompaniesByBlipId('42', 'tech-radar-2024');

      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getCompaniesByUseCaseId
  // ---------------------------------------------------------------------------

  describe('getCompaniesByUseCaseId()', () => {
    it('should return companies linked to a use case', async () => {
      const company1 = createMockCompany({ id: 'c-1', name: 'Alpha' });
      const company2 = createMockCompany({ id: 'c-2', name: 'Beta' });

      mockGetUseCaseById.mockResolvedValueOnce({
        id: 'uc-1',
        companyIds: ['c-1', 'c-2'],
      });
      // getCompanyById calls getDoc internally
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => company1 })
        .mockResolvedValueOnce({ exists: () => true, data: () => company2 });

      const results = await getCompaniesByUseCaseId('uc-1');

      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('Alpha');
      expect(results[1].name).toBe('Beta');
    });

    it('should return empty array when use case is not found', async () => {
      mockGetUseCaseById.mockResolvedValueOnce(null);

      const results = await getCompaniesByUseCaseId('non-existent');

      expect(results).toEqual([]);
    });

    it('should return empty array when use case has no linked companies', async () => {
      mockGetUseCaseById.mockResolvedValueOnce({
        id: 'uc-1',
        companyIds: [],
      });

      const results = await getCompaniesByUseCaseId('uc-1');

      expect(results).toEqual([]);
    });

    it('should filter out null values for deleted companies', async () => {
      mockGetUseCaseById.mockResolvedValueOnce({
        id: 'uc-1',
        companyIds: ['c-1', 'c-deleted'],
      });
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => createMockCompany({ id: 'c-1' }) })
        .mockResolvedValueOnce({ exists: () => false, data: () => null });

      const results = await getCompaniesByUseCaseId('uc-1');

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('c-1');
    });
  });

  // ---------------------------------------------------------------------------
  // createCompanyFromAgent
  // ---------------------------------------------------------------------------

  describe('createCompanyFromAgent()', () => {
    const agentMetadata = {
      agentId: 'agent-123',
      agentName: 'Company Scout',
      taskTemplate: 'search-companies',
    };

    it('should create a company with agent source lineage', async () => {
      const input = {
        name: 'NewStartup',
        description: 'AI-powered platform',
        website: 'https://newstartup.com',
        technologies: ['Python', 'TensorFlow'],
        relevanceScore: 85,
        size: 'Startup',
        stage: 'Seed',
      };

      const result = await createCompanyFromAgent(input, agentMetadata);

      expect(result.id).toBeDefined();
      expect(mockValidateCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'NewStartup',
          status: 'Watching',
          technologyStack: ['Python', 'TensorFlow'],
          source: expect.objectContaining({
            type: 'agent',
            agentId: 'agent-123',
            agentName: 'Company Scout',
          }),
          aiMetadata: expect.objectContaining({
            relevanceScore: 85,
          }),
        })
      );
    });

    it('should throw when company name is empty', async () => {
      await expect(
        createCompanyFromAgent({ name: '' }, agentMetadata)
      ).rejects.toThrow('Company name is required');
    });

    it('should throw when company name is only whitespace', async () => {
      await expect(
        createCompanyFromAgent({ name: '   ' }, agentMetadata)
      ).rejects.toThrow('Company name is required');
    });

    it('should map enterprise size correctly', async () => {
      const input = { name: 'BigCorp', size: 'Enterprise' };

      await createCompanyFromAgent(input, agentMetadata);

      expect(mockValidateCreate).toHaveBeenCalledWith(
        expect.objectContaining({ size: 'enterprise' })
      );
    });

    it('should map public stage correctly', async () => {
      const input = { name: 'PublicCo', stage: 'Public' };

      await createCompanyFromAgent(input, agentMetadata);

      expect(mockValidateCreate).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'public' })
      );
    });

    it('should use defaults when size and stage are not provided', async () => {
      const input = { name: 'MinimalCo' };

      await createCompanyFromAgent(input, agentMetadata);

      expect(mockValidateCreate).toHaveBeenCalledWith(
        expect.objectContaining({ size: 'small', stage: 'private' })
      );
    });

    it('should not include aiMetadata when relevanceScore is undefined', async () => {
      const input = { name: 'NoScore Co' };

      await createCompanyFromAgent(input, agentMetadata);

      expect(mockValidateCreate).toHaveBeenCalledWith(
        expect.objectContaining({ aiMetadata: undefined })
      );
    });

    it('should trim name and description', async () => {
      const input = {
        name: '  Spaces Corp  ',
        description: '  Some description  ',
      };

      await createCompanyFromAgent(input, agentMetadata);

      expect(mockValidateCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Spaces Corp',
          description: 'Some description',
        })
      );
    });
  });
});
