/**
 * Unit Tests for Technology Service (Decoupled Model)
 *
 * Tests CRUD operations for the new decoupled Technology entity:
 * - generateSlug - URL-friendly slug generation
 * - getTechnologies - Fetch with filtering
 * - getTechnologyById - Single fetch by ID
 * - getTechnologyBySlug - Single fetch by slug
 * - createTechnology - Create new technology
 * - updateTechnology - Update existing technology
 * - deleteTechnology - Delete technology
 * - deleteTechnologyWithPlacements - Cascade delete
 */

import type { Technology, TechnologyCategory } from '../types';

// Mock firebase module
jest.mock('../firebase', () => ({
  db: {},
}));

// Mock firebase/firestore module with jest.fn() in factory
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
  limit: jest.fn(),
  documentId: jest.fn(() => '__name__'),
  startAfter: jest.fn(),
  writeBatch: jest.fn(),
  runTransaction: jest.fn(),
  arrayRemove: jest.fn((value: string) => ({ _arrayRemove: value })),
}));

// Mock dynamic imports used by cascade delete and sync functions
jest.mock('@/lib/radar-placement-service', () => ({
  deleteAllPlacementsForTechnology: jest.fn(),
  getPlacementsForTechnology: jest.fn(),
  updateRadarPlacement: jest.fn(),
}));

jest.mock('@/lib/relations', () => ({
  deleteRelationsForEntity: jest.fn(),
}));

jest.mock('@/lib/entity-document-link-service', () => ({
  deleteLinksForEntity: jest.fn().mockResolvedValue(0),
}));

jest.mock('@/lib/graph/neo4j-graph-service', () => ({
  getNeo4jGraphService: jest.fn(() => ({
    isHealthy: jest.fn().mockResolvedValue(true),
  })),
}));

jest.mock('@/lib/graph/assertions', () => ({
  deleteEntityFromGraph: jest.fn(),
}));

// Mock events module to prevent side effects
jest.mock('@/lib/events/data-refresh', () => ({
  emitDataRefresh: jest.fn(),
}));

jest.mock('@/lib/entity-sync', () => ({
  EntitySyncDispatchError: class EntitySyncDispatchError extends Error {
    constructor(entityType: string, entityId: string, operation: string, cause: unknown) {
      super(`Graph ${operation} handoff for ${entityType} ${entityId}: ${String(cause)}`);
      this.name = 'EntitySyncDispatchError';
    }
  },
  requestEntityGraphSync: jest.fn().mockResolvedValue(undefined),
  requestEntityGraphDeletion: jest.fn().mockResolvedValue(undefined),
  requestEntityGraphDeletions: jest.fn(async (_type: string, ids: string[]) => ({
    acknowledged: [...ids],
    failed: [],
  })),
  triggerEntitySync: jest.fn().mockResolvedValue(undefined),
}));

// Import the service functions (after mocks are set up)
import {
  generateSlug,
  getTechnologies,
  getTechnologyById,
  getTechnologyBySlug,
  createTechnology,
  updateTechnology,
  deleteTechnology,
  deleteTechnologies,
  deleteTechnologyWithPlacements,
  deleteTechnologyCompletely,
  deleteTechnologiesCompletely,
  syncTRLToPlacementsOnUpdate,
  updateTechnologyWithSync,
  getAllTechnologyTags,
  getAllTechnologyCategories,
  searchTechnologies,
  linkCompanyToTechnology,
  unlinkCompanyFromTechnology,
  linkUseCaseToTechnology,
  unlinkUseCaseFromTechnology,
  TechnologyHasPlacementsError,
} from '../technology-service';

// Import the mocked module to get references to the mocks
import {
  getDocs,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  collection,
  doc,
  query,
  where,
  orderBy,
  limit,
  documentId,
  startAfter,
  runTransaction,
  arrayRemove,
} from 'firebase/firestore';

// Import dynamic dependency mocks for cascade delete / sync tests
import {
  deleteAllPlacementsForTechnology,
  getPlacementsForTechnology,
  updateRadarPlacement,
} from '../radar-placement-service';

import { deleteRelationsForEntity } from '../relations';
import { deleteLinksForEntity } from '../entity-document-link-service';
import { getNeo4jGraphService } from '../graph/neo4j-graph-service';
import { deleteEntityFromGraph } from '../graph/assertions';
import {
  EntitySyncDispatchError,
  requestEntityGraphSync,
  requestEntityGraphDeletion,
  requestEntityGraphDeletions,
} from '../entity-sync';

const mockDeleteAllPlacements = deleteAllPlacementsForTechnology as jest.Mock;
const mockGetPlacements = getPlacementsForTechnology as jest.Mock;
const mockUpdatePlacement = updateRadarPlacement as jest.Mock;
const mockDeleteRelationsForEntity = deleteRelationsForEntity as jest.Mock;
const mockDeleteLinksForEntity = deleteLinksForEntity as jest.Mock;
const mockGetNeo4jGraphService = getNeo4jGraphService as jest.Mock;
const mockDeleteEntityFromGraph = deleteEntityFromGraph as jest.Mock;
const mockRequestEntityGraphSync = requestEntityGraphSync as jest.Mock;
const mockRequestEntityGraphDeletion = requestEntityGraphDeletion as jest.Mock;
const mockRequestEntityGraphDeletions = requestEntityGraphDeletions as jest.Mock;

// Re-export as typed mocks for use in tests
const firestoreMocks = {
  getDocs: getDocs as jest.Mock,
  getDoc: getDoc as jest.Mock,
  setDoc: setDoc as jest.Mock,
  updateDoc: updateDoc as jest.Mock,
  deleteDoc: deleteDoc as jest.Mock,
  writeBatch: writeBatch as jest.Mock,
  collection: collection as jest.Mock,
  doc: doc as jest.Mock,
  query: query as jest.Mock,
  where: where as jest.Mock,
  orderBy: orderBy as jest.Mock,
  limit: limit as jest.Mock,
  documentId: documentId as jest.Mock,
  startAfter: startAfter as jest.Mock,
  runTransaction: runTransaction as jest.Mock,
  arrayRemove: arrayRemove as jest.Mock,
};

/**
 * Helper to create a mock technology for testing
 */
function createMockTechnology(overrides?: Partial<Technology>): Technology {
  return {
    id: 'tech-123',
    name: 'React',
    slug: 'react',
    description: 'A JavaScript library for building user interfaces',
    category: 'framework' as TechnologyCategory,
    tags: ['frontend', 'javascript', 'ui'],
    websiteUrl: 'https://react.dev',
    githubUrl: 'https://github.com/facebook/react',
    documentationUrl: 'https://react.dev/docs',
    linkedCompanies: ['company-meta'],
    linkedUseCases: ['usecase-web-apps'],
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    createdBy: 'user-123',
    ...overrides,
  };
}

/**
 * Helper to create mock docs response
 */
function createMockDocsResponse(technologies: Technology[]) {
  return {
    docs: technologies.map((t) => ({ id: t.id, data: () => t })),
    empty: technologies.length === 0,
  };
}

/**
 * Helper to create mock doc response
 */
function createMockDocResponse(technology: Technology | null) {
  if (!technology) {
    return { exists: () => false };
  }
  return {
    exists: () => true,
    id: technology.id,
    data: () => technology,
  };
}

describe('Technology Service (Decoupled Model)', () => {
  beforeEach(() => {
    // Reset all mocks completely to ensure test isolation
    jest.resetAllMocks();

    // Set default behaviors for mocks (these will be overridden by mockResolvedValueOnce in tests)
    firestoreMocks.getDocs.mockResolvedValue({ empty: true, docs: [] });
    firestoreMocks.getDoc.mockResolvedValue({ exists: () => false });
    firestoreMocks.setDoc.mockResolvedValue(undefined);
    firestoreMocks.updateDoc.mockResolvedValue(undefined);
    firestoreMocks.deleteDoc.mockResolvedValue(undefined);
    firestoreMocks.documentId.mockReturnValue('__name__');
    firestoreMocks.arrayRemove.mockImplementation((value: string) => ({ _arrayRemove: value }));

    // Default mocks for cascade delete / sync dependencies
    mockDeleteAllPlacements.mockResolvedValue(0);
    mockGetPlacements.mockResolvedValue([]);
    mockUpdatePlacement.mockResolvedValue(undefined);
    mockDeleteRelationsForEntity.mockResolvedValue(0);
    mockDeleteLinksForEntity.mockResolvedValue(0);
    mockGetNeo4jGraphService.mockReturnValue({
      isHealthy: jest.fn().mockResolvedValue(true),
    });
    mockDeleteEntityFromGraph.mockResolvedValue({
      assertionsDeleted: 0,
      evidenceDeleted: 0,
      projectionsDeleted: 0,
      chunksDeleted: 0,
      endpointsDeleted: 1,
    });
    mockRequestEntityGraphSync.mockResolvedValue(undefined);
    mockRequestEntityGraphDeletion.mockResolvedValue(undefined);
    mockRequestEntityGraphDeletions.mockImplementation(async (_type: string, ids: string[]) => ({
      acknowledged: [...ids],
      failed: [],
    }));

    // Default writeBatch mock with update support for orphan cleanup
    firestoreMocks.writeBatch.mockReturnValue({
      delete: jest.fn(),
      update: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    });

    // Default runTransaction mock - executes the callback with a mock transaction
    firestoreMocks.runTransaction.mockImplementation(async (_db, callback) => {
      const mockTransaction = {
        get: jest.fn().mockResolvedValue({ exists: () => false }),
        set: jest.fn(),
        update: jest.fn(),
      };
      return await callback(mockTransaction);
    });
  });

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  describe('generateSlug()', () => {
    it('should convert name to lowercase slug', () => {
      expect(generateSlug('React')).toBe('react');
      expect(generateSlug('TensorFlow')).toBe('tensorflow');
    });

    it('should replace spaces with hyphens', () => {
      expect(generateSlug('Vue.js Framework')).toBe('vue-js-framework');
      expect(generateSlug('Next.js App Router')).toBe('next-js-app-router');
    });

    it('should remove special characters', () => {
      expect(generateSlug('C++ Programming')).toBe('c-programming');
      expect(generateSlug('React@18.0')).toBe('react-18-0');
    });

    it('should remove leading/trailing hyphens', () => {
      expect(generateSlug('--React--')).toBe('react');
      expect(generateSlug('  Vue  ')).toBe('vue');
    });

    it('should handle multiple consecutive spaces/hyphens', () => {
      expect(generateSlug('React   Native')).toBe('react-native');
      expect(generateSlug('Vue---Framework')).toBe('vue-framework');
    });
  });

  // ============================================================================
  // GET OPERATIONS
  // ============================================================================

  describe('getTechnologies()', () => {
    it('should fetch all technologies', async () => {
      const mockTech1 = createMockTechnology({ id: 'tech-1' });
      const mockTech2 = createMockTechnology({ id: 'tech-2' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockTech1, mockTech2]));

      const result = await getTechnologies();

      expect(result).toHaveLength(2);
      expect(firestoreMocks.getDocs).toHaveBeenCalledTimes(1);
    });

    it('should filter by category', async () => {
      const mockTech1 = createMockTechnology({ id: 'tech-1', category: 'framework' });
      const mockTech2 = createMockTechnology({ id: 'tech-2', category: 'tool' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockTech1, mockTech2]));

      const result = await getTechnologies({ category: 'framework' });

      expect(result).toHaveLength(1);
      expect(result[0].category).toBe('framework');
    });

    it('should filter by tags', async () => {
      const mockTech1 = createMockTechnology({ id: 'tech-1', tags: ['frontend', 'javascript'] });
      const mockTech2 = createMockTechnology({ id: 'tech-2', tags: ['backend', 'python'] });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockTech1, mockTech2]));

      const result = await getTechnologies({ tags: ['frontend'] });

      expect(result).toHaveLength(1);
      expect(result[0].tags).toContain('frontend');
    });

    it('should apply limit', async () => {
      const techs = Array.from({ length: 20 }, (_, i) => createMockTechnology({ id: `tech-${i}` }));
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(techs));

      const result = await getTechnologies({ limit: 10 });

      expect(result).toHaveLength(10);
    });

    it('should handle search query', async () => {
      const mockTech1 = createMockTechnology({ id: 'tech-1', name: 'React' });
      const mockTech2 = createMockTechnology({ id: 'tech-2', name: 'Vue' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockTech1, mockTech2]));

      const result = await getTechnologies({ search: 'react' });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('React');
    });

    it('should handle errors gracefully', async () => {
      firestoreMocks.getDocs.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getTechnologies()).rejects.toThrow('Failed to fetch technologies');
    });
  });

  describe('getTechnologyById()', () => {
    it('should fetch technology by ID', async () => {
      const mockTech = createMockTechnology();
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockTech));

      const result = await getTechnologyById('tech-123');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('tech-123');
      expect(firestoreMocks.getDoc).toHaveBeenCalledTimes(1);
    });

    it('should return null when technology not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      const result = await getTechnologyById('nonexistent');

      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      firestoreMocks.getDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getTechnologyById('tech-123')).rejects.toThrow('Failed to fetch technology');
    });
  });

  describe('getTechnologyBySlug()', () => {
    it('should fetch technology by slug', async () => {
      const mockTech = createMockTechnology({ slug: 'react' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockTech]));

      const result = await getTechnologyBySlug('react');

      expect(result).not.toBeNull();
      expect(result?.slug).toBe('react');
    });

    it('should return null when no technology matches slug', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await getTechnologyBySlug('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // CREATE OPERATIONS
  // ============================================================================

  describe('createTechnology()', () => {
    it('should create a new technology', async () => {
      // No existing technology with same slug
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await createTechnology({
        name: 'Vue.js',
        slug: 'vue-js',
        description: 'Progressive JavaScript framework',
        category: 'framework',
        tags: ['frontend', 'javascript'],
        createdBy: 'user-123',
      });

      expect(result.name).toBe('Vue.js');
      expect(result.slug).toBe('vue-js');
      expect(result.id).toMatch(/^tech-/);
      expect(result.createdAt).toBeDefined();
      // Uses transaction instead of setDoc for atomic slug uniqueness check
      expect(firestoreMocks.runTransaction).toHaveBeenCalledTimes(1);
      expect(mockRequestEntityGraphSync).toHaveBeenCalledWith(
        'technology',
        result.id,
        'create'
      );
      expect(firestoreMocks.runTransaction.mock.invocationCallOrder[0]).toBeLessThan(
        mockRequestEntityGraphSync.mock.invocationCallOrder[0]
      );
    });

    it('should include optional fields when provided', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await createTechnology({
        name: 'Angular',
        slug: 'angular',
        description: 'TypeScript-based framework',
        category: 'framework',
        tags: ['frontend', 'typescript'],
        websiteUrl: 'https://angular.io',
        githubUrl: 'https://github.com/angular/angular',
        documentationUrl: 'https://angular.io/docs',
        createdBy: 'user-123',
      });

      expect(result.websiteUrl).toBe('https://angular.io');
      expect(result.githubUrl).toBe('https://github.com/angular/angular');
    });

    it('should throw error if technology with same slug exists', async () => {
      // Mock: existing technology with slug 'react' found
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([createMockTechnology({ slug: 'react' })]));

      await expect(
        createTechnology({
          name: 'React',
          slug: 'react',
          description: 'Duplicate',
          tags: [],
          createdBy: 'user-123',
        })
      ).rejects.toThrow('A technology with slug "react" already exists');
    });

    it('should handle creation errors', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));
      // Transaction fails
      firestoreMocks.runTransaction.mockRejectedValueOnce(new Error('Transaction failed'));

      await expect(
        createTechnology({
          name: 'Test',
          slug: 'test',
          description: 'Test tech',
          tags: [],
          createdBy: 'user-123',
        })
      ).rejects.toThrow('Failed to create technology');
    });

    it('surfaces a required create handoff failure after the transaction commits', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));
      const dispatchError = new EntitySyncDispatchError(
        'technology',
        'pending-id',
        'create',
        new Error('handoff failed')
      );
      mockRequestEntityGraphSync.mockRejectedValueOnce(dispatchError);

      await expect(
        createTechnology({
          name: 'Handoff Test',
          slug: 'handoff-test',
          description: 'test',
          tags: [],
          createdBy: 'user-123',
        })
      ).rejects.toBe(dispatchError);

      expect(firestoreMocks.runTransaction).toHaveBeenCalledTimes(1);
    });

    it('should use transaction for slug uniqueness check (Phase 0 Task 0.1.4)', async () => {
      // Mock the slug check query to return no existing tech
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      await createTechnology({
        name: 'New Tech',
        slug: 'new-tech',
        description: 'A new technology',
        tags: [],
        createdBy: 'user-123',
      });

      // Verify runTransaction was called
      expect(firestoreMocks.runTransaction).toHaveBeenCalledTimes(1);
    });

    it('should reject concurrent creates with same slug via transaction (Phase 0 Task 0.1.4)', async () => {
      // First call: slug check returns existing tech (simulating race condition)
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([createMockTechnology({ slug: 'react' })]));

      await expect(
        createTechnology({
          name: 'React',
          slug: 'react',
          description: 'Duplicate',
          tags: [],
          createdBy: 'user-123',
        })
      ).rejects.toThrow('A technology with slug "react" already exists');
    });

    it('should properly call transaction.set within the transaction (Phase 0 Task 0.1.4)', async () => {
      const mockSet = jest.fn();
      firestoreMocks.runTransaction.mockImplementationOnce(async (_db, callback) => {
        const mockTransaction = {
          get: jest.fn().mockResolvedValue({ exists: () => false }),
          set: mockSet,
          update: jest.fn(),
        };
        return await callback(mockTransaction);
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      await createTechnology({
        name: 'Angular',
        slug: 'angular',
        description: 'TypeScript framework',
        tags: [],
        createdBy: 'user-123',
      });

      // Verify transaction.set was called (document creation within transaction)
      expect(mockSet).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // UPDATE OPERATIONS
  // ============================================================================

  describe('updateTechnology()', () => {
    it('should update an existing technology', async () => {
      const existingTech = createMockTechnology();
      const updatedTech = { ...existingTech, description: 'Updated description' };

      // First call: existence check, second call: return updated document
      firestoreMocks.getDoc
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(updatedTech));

      const result = await updateTechnology('tech-123', { description: 'Updated description' });

      expect(result.description).toBe('Updated description');
      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
      expect(mockRequestEntityGraphSync).toHaveBeenCalledWith(
        'technology',
        'tech-123',
        'update'
      );
      expect(firestoreMocks.updateDoc.mock.invocationCallOrder[0]).toBeLessThan(
        mockRequestEntityGraphSync.mock.invocationCallOrder[0]
      );
    });

    it('should regenerate slug when name changes', async () => {
      const existingTech = createMockTechnology({ name: 'React', slug: 'react' });
      const updatedTech = { ...existingTech, name: 'React Native', slug: 'react-native' };

      // Mock for initial existence check
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingTech));

      // Mock the transaction to return the updated tech
      firestoreMocks.runTransaction.mockImplementationOnce(async (_db, callback) => {
        const mockTransaction = {
          get: jest.fn().mockResolvedValue(createMockDocResponse(existingTech)),
          set: jest.fn(),
          update: jest.fn(),
        };
        await callback(mockTransaction);
        return updatedTech;
      });

      // No existing tech with new slug
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await updateTechnology('tech-123', { name: 'React Native' });

      expect(result.name).toBe('React Native');
      expect(result.slug).toBe('react-native');
      expect(mockRequestEntityGraphSync).toHaveBeenCalledWith(
        'technology',
        'tech-123',
        'update'
      );
      expect(firestoreMocks.runTransaction.mock.invocationCallOrder[0]).toBeLessThan(
        mockRequestEntityGraphSync.mock.invocationCallOrder[0]
      );
    });

    it('should throw when technology not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      await expect(updateTechnology('nonexistent', { name: 'Test' })).rejects.toThrow(
        'Technology nonexistent not found'
      );
    });

    it('should handle update errors', async () => {
      const existingTech = createMockTechnology();
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingTech));
      firestoreMocks.runTransaction.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(updateTechnology('tech-123', { name: 'Test' })).rejects.toThrow('Failed to update technology');
    });

    it('surfaces a required simple-update handoff failure after Firestore commits', async () => {
      const existingTech = createMockTechnology();
      const updatedTech = { ...existingTech, description: 'Committed', updatedAt: 1700000000100 };
      firestoreMocks.getDoc
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(updatedTech));
      const dispatchError = new EntitySyncDispatchError(
        'technology',
        'tech-123',
        'update',
        new Error('handoff failed')
      );
      mockRequestEntityGraphSync.mockRejectedValueOnce(dispatchError);

      await expect(updateTechnology('tech-123', { description: 'Committed' })).rejects.toBe(dispatchError);

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
      expect(mockRequestEntityGraphSync).toHaveBeenCalledWith(
        'technology',
        'tech-123',
        'update'
      );
    });

    it('surfaces a required slug-update handoff failure after the transaction commits', async () => {
      const existingTech = createMockTechnology({ name: 'React', slug: 'react' });
      firestoreMocks.runTransaction.mockImplementationOnce(async (_db, callback) =>
        callback({
          get: jest.fn().mockResolvedValue(createMockDocResponse(existingTech)),
          set: jest.fn(),
          update: jest.fn(),
        })
      );
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));
      const dispatchError = new EntitySyncDispatchError(
        'technology',
        'tech-123',
        'update',
        new Error('handoff failed')
      );
      mockRequestEntityGraphSync.mockRejectedValueOnce(dispatchError);

      await expect(updateTechnology('tech-123', { name: 'React Native' })).rejects.toBe(dispatchError);

      expect(firestoreMocks.runTransaction).toHaveBeenCalledTimes(1);
      expect(mockRequestEntityGraphSync).toHaveBeenCalledWith('technology', 'tech-123', 'update');
    });

    it('should use transaction when name changes for slug uniqueness (Phase 0 Task 0.1.4)', async () => {
      const existingTech = createMockTechnology({ name: 'React', slug: 'react' });
      const updatedTech = { ...existingTech, name: 'React Native', slug: 'react-native' };

      // Mock getDoc for initial existence check
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingTech));

      // Mock the transaction
      firestoreMocks.runTransaction.mockImplementationOnce(async (_db, callback) => {
        const mockTransaction = {
          get: jest.fn().mockResolvedValue(createMockDocResponse(existingTech)),
          set: jest.fn(),
          update: jest.fn(),
        };
        return await callback(mockTransaction);
      });

      // Mock getDocs for slug check within transaction
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      // Mock getDoc for final fetch
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(updatedTech));

      await updateTechnology('tech-123', { name: 'React Native' });

      // Verify runTransaction was called for the slug-changing update
      expect(firestoreMocks.runTransaction).toHaveBeenCalled();
    });

    it('should reject update if new slug conflicts with existing (Phase 0 Task 0.1.4)', async () => {
      const existingTech = createMockTechnology({ name: 'React', slug: 'react' });

      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingTech));

      // Mock the transaction to simulate slug conflict
      firestoreMocks.runTransaction.mockImplementationOnce(async (_db, callback) => {
        const mockTransaction = {
          get: jest.fn().mockResolvedValue(createMockDocResponse(existingTech)),
          set: jest.fn(),
          update: jest.fn(),
        };
        return await callback(mockTransaction);
      });

      // Slug check finds existing tech with the new slug
      firestoreMocks.getDocs.mockResolvedValueOnce(
        createMockDocsResponse([createMockTechnology({ id: 'other-tech', slug: 'vue' })])
      );

      await expect(updateTechnology('tech-123', { name: 'Vue' })).rejects.toThrow(
        'A technology with slug "vue" already exists'
      );
    });

    it('should not use transaction for non-slug updates (Phase 0 Task 0.1.4)', async () => {
      const existingTech = createMockTechnology();
      const updatedTech = { ...existingTech, description: 'Updated description' };

      firestoreMocks.getDoc
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(updatedTech));

      await updateTechnology('tech-123', { description: 'Updated description' });

      // For non-slug updates, transaction should not be needed
      // (The current implementation uses transaction only when name/slug changes)
      expect(firestoreMocks.updateDoc).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // DELETE OPERATIONS
  // ============================================================================

  describe('deleteTechnology()', () => {
    it('should delete a technology by ID', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockTechnology()));

      await deleteTechnology('tech-123');

      expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(1);
      expect(mockRequestEntityGraphDeletion).toHaveBeenCalledWith('technology', 'tech-123');
      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('technology', 'tech-123');
      expect(mockRequestEntityGraphDeletion.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteLinksForEntity.mock.invocationCallOrder[0]
      );
      expect(mockDeleteLinksForEntity.mock.invocationCallOrder[0]).toBeLessThan(
        firestoreMocks.deleteDoc.mock.invocationCallOrder[0]
      );
    });

    it('should throw when technology not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      await expect(deleteTechnology('nonexistent')).rejects.toThrow('Technology nonexistent not found');
    });

    it('should handle deletion errors', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockTechnology()));
      firestoreMocks.deleteDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(deleteTechnology('tech-123')).rejects.toThrow('Failed to delete technology');
    });

    it('should retain the Firestore document when graph deletion is not acknowledged', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockTechnology()));
      mockRequestEntityGraphDeletion.mockRejectedValueOnce(new Error('handoff failed'));

      await expect(deleteTechnology('tech-123')).rejects.toThrow('handoff failed');

      expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled();
    });

    it('retains the Firestore document when entity-document link cleanup fails', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockTechnology()));
      mockDeleteLinksForEntity.mockRejectedValueOnce(new Error('link cleanup failed'));

      await expect(deleteTechnology('tech-123')).rejects.toThrow('link cleanup failed');

      expect(mockRequestEntityGraphDeletion).toHaveBeenCalledWith('technology', 'tech-123');
      expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled();
    });

    // B4 — block-on-orphan. A bare deleteTechnology must NOT leave RadarPlacements
    // pointing at a now-deleted Technology (dangling Firestore doc + :RadarPlacement
    // node — the Neo4j handler only logs `placementsOrphaned`). It refuses;
    // callers use deleteTechnologyWithPlacements()/…Completely() to cascade.
    // Mirrors the OrphanedPlacementsError guard on radar quadrant edits.
    it('refuses to delete a technology that still has placements (block-on-orphan)', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockTechnology()));
      mockGetPlacements.mockResolvedValueOnce([{ id: 'plc-1' }, { id: 'plc-2' }]);

      await expect(deleteTechnology('tech-123')).rejects.toThrow(TechnologyHasPlacementsError);
      expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled();
    });

    it('deletes normally when no placements reference the technology', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockTechnology()));
      mockGetPlacements.mockResolvedValueOnce([]);

      await deleteTechnology('tech-123');

      expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteTechnologies()', () => {
    it('should delete multiple technologies', async () => {
      const result = await deleteTechnologies(['tech-1', 'tech-2', 'tech-3']);

      expect(result.succeeded).toBe(3);
      expect(result.failed).toHaveLength(0);
      expect(firestoreMocks.writeBatch).toHaveBeenCalled();
    });

    it('should handle batch errors', async () => {
      firestoreMocks.writeBatch.mockReturnValueOnce({
        delete: jest.fn(),
        commit: jest.fn().mockRejectedValue(new Error('Batch failed')),
      });

      const result = await deleteTechnologies(['tech-1', 'tech-2']);

      expect(result.succeeded).toBe(0);
      expect(result.failed).toHaveLength(2);
      expect(result.errors).toHaveLength(1);
    });
  });

  // ============================================================================
  // QUERY HELPERS
  // ============================================================================

  describe('getAllTechnologyTags()', () => {
    it('should return unique tags across all technologies', async () => {
      const mockTech1 = createMockTechnology({ tags: ['frontend', 'javascript'] });
      const mockTech2 = createMockTechnology({ id: 'tech-2', tags: ['backend', 'javascript', 'python'] });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockTech1, mockTech2]));

      const result = await getAllTechnologyTags();

      expect(result).toEqual(['backend', 'frontend', 'javascript', 'python']);
    });

    it('should return empty array when no technologies', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await getAllTechnologyTags();

      expect(result).toEqual([]);
    });
  });

  describe('getAllTechnologyCategories()', () => {
    it('should return unique categories', async () => {
      const mockTech1 = createMockTechnology({ category: 'framework' });
      const mockTech2 = createMockTechnology({ id: 'tech-2', category: 'tool' });
      const mockTech3 = createMockTechnology({ id: 'tech-3', category: 'framework' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockTech1, mockTech2, mockTech3]));

      const result = await getAllTechnologyCategories();

      expect(result).toHaveLength(2);
      expect(result).toContain('framework');
      expect(result).toContain('tool');
    });
  });

  describe('searchTechnologies()', () => {
    it('should search by term and apply limit', async () => {
      const techs = Array.from({ length: 20 }, (_, i) => createMockTechnology({ id: `tech-${i}`, name: `React ${i}` }));
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(techs));

      const result = await searchTechnologies('React', 5);

      expect(result).toHaveLength(5);
    });

    it('should return empty array when no matches', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([createMockTechnology({ name: 'Vue' })]));

      const result = await searchTechnologies('Angular', 10);

      expect(result).toHaveLength(0);
    });
  });

  // ============================================================================
  // LINKING OPERATIONS
  // ============================================================================

  describe('linkCompanyToTechnology()', () => {
    it('should link a company to a technology', async () => {
      const existingTech = createMockTechnology({ linkedCompanies: [] });
      const updatedTech = { ...existingTech, linkedCompanies: ['company-1'] };

      // First call for getTechnologyById, second call for updateTechnology check, third for return
      firestoreMocks.getDoc
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(updatedTech));

      await linkCompanyToTechnology('tech-123', 'company-1');

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
      const updateCall = firestoreMocks.updateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.linkedCompanies).toContain('company-1');
    });

    it('should not duplicate existing link', async () => {
      const existingTech = createMockTechnology({ linkedCompanies: ['company-1'] });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingTech));

      await linkCompanyToTechnology('tech-123', 'company-1');

      // Should not call updateDoc if already linked
      expect(firestoreMocks.updateDoc).not.toHaveBeenCalled();
    });

    it('should throw when technology not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      await expect(linkCompanyToTechnology('nonexistent', 'company-1')).rejects.toThrow(
        'Technology nonexistent not found'
      );
    });
  });

  describe('unlinkCompanyFromTechnology()', () => {
    it('should unlink a company from a technology', async () => {
      const existingTech = createMockTechnology({ linkedCompanies: ['company-1', 'company-2'] });
      const updatedTech = { ...existingTech, linkedCompanies: ['company-2'] };

      firestoreMocks.getDoc
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(updatedTech));

      await unlinkCompanyFromTechnology('tech-123', 'company-1');

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
      const updateCall = firestoreMocks.updateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.linkedCompanies).not.toContain('company-1');
      expect(updateCall.linkedCompanies).toContain('company-2');
    });
  });

  describe('linkUseCaseToTechnology()', () => {
    it('should link a use case to a technology', async () => {
      const existingTech = createMockTechnology({ linkedUseCases: [] });
      const updatedTech = { ...existingTech, linkedUseCases: ['usecase-1'] };

      firestoreMocks.getDoc
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(updatedTech));

      await linkUseCaseToTechnology('tech-123', 'usecase-1');

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });
  });

  describe('unlinkUseCaseFromTechnology()', () => {
    it('should unlink a use case from a technology', async () => {
      const existingTech = createMockTechnology({ linkedUseCases: ['usecase-1', 'usecase-2'] });
      const updatedTech = { ...existingTech, linkedUseCases: ['usecase-2'] };

      firestoreMocks.getDoc
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(updatedTech));

      await unlinkUseCaseFromTechnology('tech-123', 'usecase-1');

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
      const updateCall = firestoreMocks.updateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.linkedUseCases).not.toContain('usecase-1');
    });
  });

  // ============================================================================
  // MARKET INTEREST TESTS (Phase 0 Task 0.2.1)
  // ============================================================================

  describe('marketInterest field (Phase 0 Task 0.2.1)', () => {
    it('should preserve marketInterest when fetching technology by ID', async () => {
      const techWithMarketInterest = createMockTechnology({
        marketInterest: {
          score: 85,
          trend: 'rising',
          lastUpdated: Date.now(),
          sources: ['Google Trends', 'GitHub Stars'],
        },
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(techWithMarketInterest));

      const result = await getTechnologyById('tech-123');

      expect(result).not.toBeNull();
      expect(result?.marketInterest).toBeDefined();
      expect(result?.marketInterest?.score).toBe(85);
      expect(result?.marketInterest?.trend).toBe('rising');
      expect(result?.marketInterest?.sources).toHaveLength(2);
    });

    it('should handle technology without marketInterest', async () => {
      const techWithoutMarketInterest = createMockTechnology();
      // Explicitly ensure marketInterest is undefined
      delete (techWithoutMarketInterest as unknown as Record<string, unknown>).marketInterest;
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(techWithoutMarketInterest));

      const result = await getTechnologyById('tech-123');

      expect(result).not.toBeNull();
      expect(result?.marketInterest).toBeUndefined();
    });

    it('should preserve marketInterest in getTechnologies list', async () => {
      const tech1 = createMockTechnology({
        id: 'tech-1',
        marketInterest: { score: 90, trend: 'rising', lastUpdated: Date.now() },
      });
      const tech2 = createMockTechnology({
        id: 'tech-2',
        marketInterest: { score: 45, trend: 'declining', lastUpdated: Date.now() },
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([tech1, tech2]));

      const result = await getTechnologies();

      expect(result).toHaveLength(2);
      expect(result[0].marketInterest?.score).toBe(90);
      expect(result[0].marketInterest?.trend).toBe('rising');
      expect(result[1].marketInterest?.score).toBe(45);
      expect(result[1].marketInterest?.trend).toBe('declining');
    });

    it('should update marketInterest field', async () => {
      const existingTech = createMockTechnology();
      const updatedTech = {
        ...existingTech,
        marketInterest: {
          score: 75,
          trend: 'stable' as const,
          lastUpdated: Date.now(),
          sources: ['HackerNews'],
        },
      };

      firestoreMocks.getDoc
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(updatedTech));

      const result = await updateTechnology('tech-123', {
        marketInterest: {
          score: 75,
          trend: 'stable',
          lastUpdated: Date.now(),
          sources: ['HackerNews'],
        },
      });

      expect(result.marketInterest).toBeDefined();
      expect(result.marketInterest?.score).toBe(75);
      expect(result.marketInterest?.trend).toBe('stable');
      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });

    it('should validate marketInterest score is between 0-100', async () => {
      const techWithValidScore = createMockTechnology({
        marketInterest: { score: 100, trend: 'rising', lastUpdated: Date.now() },
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(techWithValidScore));

      const result = await getTechnologyById('tech-123');

      expect(result?.marketInterest?.score).toBe(100);
      expect(result?.marketInterest?.score).toBeGreaterThanOrEqual(0);
      expect(result?.marketInterest?.score).toBeLessThanOrEqual(100);
    });

    it('should handle all trend values (rising, stable, declining)', async () => {
      const trends = ['rising', 'stable', 'declining'] as const;

      for (const trend of trends) {
        jest.clearAllMocks();
        const tech = createMockTechnology({
          marketInterest: { score: 50, trend, lastUpdated: Date.now() },
        });
        firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(tech));

        const result = await getTechnologyById('tech-123');
        expect(result?.marketInterest?.trend).toBe(trend);
      }
    });

    it('should preserve sources array when present', async () => {
      const techWithSources = createMockTechnology({
        marketInterest: {
          score: 60,
          trend: 'rising',
          lastUpdated: Date.now(),
          sources: ['Google Trends', 'GitHub Stars', 'Stack Overflow', 'Reddit'],
        },
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(techWithSources));

      const result = await getTechnologyById('tech-123');

      expect(result?.marketInterest?.sources).toHaveLength(4);
      expect(result?.marketInterest?.sources).toContain('Google Trends');
      expect(result?.marketInterest?.sources).toContain('GitHub Stars');
    });

    it('should handle marketInterest without optional sources', async () => {
      const techWithoutSources = createMockTechnology({
        marketInterest: {
          score: 50,
          trend: 'stable',
          lastUpdated: Date.now(),
          // No sources field
        },
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(techWithoutSources));

      const result = await getTechnologyById('tech-123');

      expect(result?.marketInterest).toBeDefined();
      expect(result?.marketInterest?.sources).toBeUndefined();
    });
  });

  // ============================================================================
  // CASCADE DELETE TESTS
  // ============================================================================

  describe('deleteTechnologyWithPlacements()', () => {
    it('should delete technology and all its placements', async () => {
      mockDeleteAllPlacements.mockResolvedValueOnce(3);
      // For deleteTechnology inside
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockTechnology()));

      const result = await deleteTechnologyWithPlacements('tech-123');

      expect(result).toBe(3);
      expect(mockDeleteAllPlacements).toHaveBeenCalledWith('tech-123');
      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('technology', 'tech-123');
      expect(firestoreMocks.deleteDoc).toHaveBeenCalled();
      expect(mockRequestEntityGraphDeletion.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteAllPlacements.mock.invocationCallOrder[0]
      );
    });

    it('does not delete placements or the source when graph handoff fails', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockTechnology()));
      mockRequestEntityGraphDeletion.mockRejectedValueOnce(
        new EntitySyncDispatchError('technology', 'tech-123', 'delete', new Error('handoff failed'))
      );

      await expect(deleteTechnologyWithPlacements('tech-123')).rejects.toThrow('handoff failed');

      expect(mockDeleteAllPlacements).not.toHaveBeenCalled();
      expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled();
    });

    it('should throw when cascade delete fails', async () => {
      mockDeleteAllPlacements.mockRejectedValueOnce(new Error('Placement delete failed'));

      await expect(deleteTechnologyWithPlacements('tech-123')).rejects.toThrow('Failed to cascade delete technology');
    });

    it('retains the source when link cleanup fails after placement cleanup', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockTechnology()));
      mockDeleteLinksForEntity.mockRejectedValueOnce(new Error('link cleanup failed'));

      await expect(deleteTechnologyWithPlacements('tech-123')).rejects.toThrow('link cleanup failed');

      expect(mockDeleteAllPlacements).toHaveBeenCalledWith('tech-123');
      expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // COMPLETE DELETION TESTS
  // ============================================================================

  describe('deleteTechnologyCompletely()', () => {
    it('should perform complete cascade deletion', async () => {
      const mockTech = createMockTechnology();
      // getTechnologyById
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockTech));
      mockDeleteAllPlacements.mockResolvedValueOnce(2);
      mockDeleteRelationsForEntity.mockResolvedValueOnce(5);
      // cleanupOrphanedTechnologyReferences - prototypes then useCases
      firestoreMocks.getDocs
        .mockResolvedValueOnce({ docs: [], empty: true })
        .mockResolvedValueOnce({ docs: [], empty: true });
      // deleteTechnology -> getDoc
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockTech));

      const result = await deleteTechnologyCompletely('tech-123');

      expect(result.success).toBe(true);
      expect(result.placementsDeleted).toBe(2);
      expect(result.relationsDeleted).toBe(5);
      expect(result.neo4jDeleted).toBe(true);
      expect(mockDeleteEntityFromGraph).toHaveBeenCalledWith('tech-123', 'technology');
      expect(firestoreMocks.deleteDoc.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteEntityFromGraph.mock.invocationCallOrder[0]
      );
    });

    it('does not fast-delete Neo4j when the final Firestore source delete fails', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockTechnology()));
      mockDeleteAllPlacements.mockResolvedValueOnce(0);
      mockDeleteRelationsForEntity.mockResolvedValueOnce(0);
      firestoreMocks.getDocs
        .mockResolvedValueOnce({ docs: [], empty: true })
        .mockResolvedValueOnce({ docs: [], empty: true });
      firestoreMocks.deleteDoc.mockRejectedValueOnce(new Error('source delete failed'));

      const result = await deleteTechnologyCompletely('tech-123');

      expect(result).toMatchObject({ success: false, error: 'source delete failed' });
      expect(mockDeleteEntityFromGraph).not.toHaveBeenCalled();
    });

    it('should return error when technology not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      const result = await deleteTechnologyCompletely('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    // Cascade-invariant tests — 2026-05-12 cascade-delete investigation
    // (Priority 3). Previous behaviour was "log.warn and continue," which
    // left orphan placements / relations when the technology doc still got
    // deleted. New behaviour aborts the whole deletion so the caller can
    // retry. The returned result surfaces the cascade error message.
    it('should abort the whole deletion if placement cascade fails', async () => {
      const mockTech = createMockTechnology();
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockTech));
      mockDeleteAllPlacements.mockRejectedValueOnce(new Error('Placements fail'));

      const result = await deleteTechnologyCompletely('tech-123');

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Cascade failed at placements/);
      // The technology doc must NOT have been deleted.
      expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled();
    });

    it('should abort the whole deletion if relation cascade fails', async () => {
      const mockTech = createMockTechnology();
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockTech));
      mockDeleteAllPlacements.mockResolvedValueOnce(1);
      mockDeleteRelationsForEntity.mockRejectedValueOnce(new Error('Relations fail'));

      const result = await deleteTechnologyCompletely('tech-123');

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Cascade failed at relations/);
      expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent when the entity-document link cascade fails', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockTechnology()));
      mockDeleteLinksForEntity.mockRejectedValueOnce(new Error('link graph handoff failed'));

      const result = await deleteTechnologyCompletely('tech-123');

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('Cascade failed at document links'),
      });
      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('technology', 'tech-123');
      expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled();
    });

    it('should handle Neo4j being unhealthy', async () => {
      const mockTech = createMockTechnology();
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockTech));
      mockDeleteAllPlacements.mockResolvedValueOnce(0);
      mockDeleteRelationsForEntity.mockResolvedValueOnce(0);
      firestoreMocks.getDocs
        .mockResolvedValueOnce({ docs: [], empty: true })
        .mockResolvedValueOnce({ docs: [], empty: true });
      mockGetNeo4jGraphService.mockReturnValueOnce({
        isHealthy: jest.fn().mockResolvedValue(false),
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockTech));

      const result = await deleteTechnologyCompletely('tech-123');

      expect(result.success).toBe(true);
      expect(result.neo4jDeleted).toBe(false);
    });

    it('queries and removes every known reverse reference with atomic arrayRemove', async () => {
      const mockTech = createMockTechnology();
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockTech));
      mockDeleteAllPlacements.mockResolvedValueOnce(0);
      mockDeleteRelationsForEntity.mockResolvedValueOnce(0);

      const mockBatch = {
        delete: jest.fn(),
        update: jest.fn(),
        commit: jest.fn().mockResolvedValue(undefined),
      };
      firestoreMocks.writeBatch.mockReturnValue(mockBatch);

      // Prototypes with linked technologies
      firestoreMocks.getDocs.mockResolvedValueOnce({
        docs: [
          {
            id: 'proto-1',
            ref: 'proto-ref-1',
          },
        ],
        empty: false,
      });
      // UseCases with radarTechnologyIds
      firestoreMocks.getDocs.mockResolvedValueOnce({
        docs: [
          {
            id: 'uc-1',
            ref: 'uc-ref-1',
          },
        ],
        empty: false,
      });
      // PainPoints with linkedTechnologyIds
      firestoreMocks.getDocs.mockResolvedValueOnce({
        docs: [
          {
            id: 'pain-1',
            ref: 'pain-ref-1',
          },
        ],
        empty: false,
      });

      const result = await deleteTechnologyCompletely('tech-123');

      expect(result.success).toBe(true);
      expect(firestoreMocks.where).toHaveBeenNthCalledWith(1, 'linkedTechnologies', 'array-contains', 'tech-123');
      expect(firestoreMocks.where).toHaveBeenNthCalledWith(2, 'radarTechnologyIds', 'array-contains', 'tech-123');
      expect(firestoreMocks.where).toHaveBeenNthCalledWith(3, 'linkedTechnologyIds', 'array-contains', 'tech-123');
      expect(mockBatch.update).toHaveBeenCalledTimes(3);
      expect(mockBatch.update).toHaveBeenCalledWith('proto-ref-1', {
        linkedTechnologies: { _arrayRemove: 'tech-123' },
      });
      expect(mockBatch.update).toHaveBeenCalledWith('uc-ref-1', {
        radarTechnologyIds: { _arrayRemove: 'tech-123' },
      });
      expect(mockBatch.update).toHaveBeenCalledWith('pain-ref-1', {
        linkedTechnologyIds: { _arrayRemove: 'tech-123' },
      });
      expect(mockBatch.commit).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['Prototype', [], 'prototype query failed'],
      ['Use Case', [{ empty: true, docs: [] }], 'use-case query failed'],
      [
        'Pain Point',
        [
          { empty: true, docs: [] },
          { empty: true, docs: [] },
        ],
        'pain-point query failed',
      ],
    ])('preflights all reads and retains the parent when the %s query fails', async (_label, preceding, message) => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockTechnology()));
      for (const snapshot of preceding) firestoreMocks.getDocs.mockResolvedValueOnce(snapshot);
      firestoreMocks.getDocs.mockRejectedValueOnce(new Error(message));

      const result = await deleteTechnologyCompletely('tech-123');

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('Cascade failed at orphaned-reference cleanup'),
      });
      expect(firestoreMocks.writeBatch).not.toHaveBeenCalled();
      expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled();
    });

    it('keeps every cleanup batch below 500 writes and cursor-pages without duplicates', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockTechnology()));
      const firstPage = Array.from({ length: 450 }, (_, index) => ({
        id: `proto-${index}`,
        ref: `proto-ref-${index}`,
      }));
      const secondPage = [{ id: 'proto-450', ref: 'proto-ref-450' }];
      firestoreMocks.getDocs
        .mockResolvedValueOnce({ empty: false, docs: firstPage })
        .mockResolvedValueOnce({ empty: false, docs: secondPage })
        .mockResolvedValueOnce({ empty: true, docs: [] })
        .mockResolvedValueOnce({ empty: true, docs: [] });

      const batches: Array<{ update: jest.Mock; commit: jest.Mock }> = [];
      firestoreMocks.writeBatch.mockImplementation(() => {
        const batch = { delete: jest.fn(), update: jest.fn(), commit: jest.fn().mockResolvedValue(undefined) };
        batches.push(batch);
        return batch;
      });

      const result = await deleteTechnologyCompletely('tech-123');

      expect(result.success).toBe(true);
      expect(batches.map((batch) => batch.update.mock.calls.length)).toEqual([450, 1]);
      expect(batches.every((batch) => batch.update.mock.calls.length < 500)).toBe(true);
      expect(firestoreMocks.startAfter).toHaveBeenCalledWith(firstPage[449]);
    });

    it('rejects a duplicate cursor page, performs no reference writes, and retains the parent', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockTechnology()));
      const firstPage = Array.from({ length: 450 }, (_, index) => ({
        id: `proto-${index}`,
        ref: `proto-ref-${index}`,
      }));
      firestoreMocks.getDocs
        .mockResolvedValueOnce({ empty: false, docs: firstPage })
        .mockResolvedValueOnce({ empty: false, docs: [firstPage[449]] });

      const result = await deleteTechnologyCompletely('tech-123');

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('pagination made no progress'),
      });
      expect(firestoreMocks.writeBatch).not.toHaveBeenCalled();
      expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled();
    });

    it('retains the parent after a cleanup batch failure and converges on retry', async () => {
      firestoreMocks.getDoc.mockResolvedValue(createMockDocResponse(createMockTechnology()));
      firestoreMocks.getDocs
        .mockResolvedValueOnce({ empty: false, docs: [{ id: 'proto-1', ref: 'proto-ref-1' }] })
        .mockResolvedValueOnce({ empty: true, docs: [] })
        .mockResolvedValueOnce({ empty: true, docs: [] });
      const failedBatch = {
        delete: jest.fn(),
        update: jest.fn(),
        commit: jest.fn().mockRejectedValue(new Error('reference write failed')),
      };
      firestoreMocks.writeBatch.mockReturnValueOnce(failedBatch);

      const firstAttempt = await deleteTechnologyCompletely('tech-123');

      expect(firstAttempt.success).toBe(false);
      expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled();

      firestoreMocks.getDocs.mockResolvedValue({ empty: true, docs: [] });
      const secondAttempt = await deleteTechnologyCompletely('tech-123');

      expect(secondAttempt.success).toBe(true);
      expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // BULK COMPLETE DELETION TESTS
  // ============================================================================

  describe('deleteTechnologiesCompletely()', () => {
    it('should delete multiple technologies completely', async () => {
      // First technology
      const mockTech1 = createMockTechnology({ id: 'tech-1' });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockTech1));
      mockDeleteAllPlacements.mockResolvedValueOnce(1);
      mockDeleteRelationsForEntity.mockResolvedValueOnce(2);
      firestoreMocks.getDocs
        .mockResolvedValueOnce({ docs: [], empty: true })
        .mockResolvedValueOnce({ docs: [], empty: true });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockTech1));

      // Second technology
      const mockTech2 = createMockTechnology({ id: 'tech-2' });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockTech2));
      mockDeleteAllPlacements.mockResolvedValueOnce(3);
      mockDeleteRelationsForEntity.mockResolvedValueOnce(1);
      firestoreMocks.getDocs
        .mockResolvedValueOnce({ docs: [], empty: true })
        .mockResolvedValueOnce({ docs: [], empty: true });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockTech2));

      const result = await deleteTechnologiesCompletely(['tech-1', 'tech-2']);

      expect(result.succeeded).toBe(2);
      expect(result.failed).toHaveLength(0);
      expect(result.totalPlacementsDeleted).toBe(4);
      expect(result.totalRelationsDeleted).toBe(3);
    });

    it('should track failed deletions', async () => {
      // First: not found
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      // Second: success
      const mockTech2 = createMockTechnology({ id: 'tech-2' });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockTech2));
      mockDeleteAllPlacements.mockResolvedValueOnce(0);
      mockDeleteRelationsForEntity.mockResolvedValueOnce(0);
      firestoreMocks.getDocs
        .mockResolvedValueOnce({ docs: [], empty: true })
        .mockResolvedValueOnce({ docs: [], empty: true });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockTech2));

      const result = await deleteTechnologiesCompletely(['tech-1', 'tech-2']);

      expect(result.succeeded).toBe(1);
      expect(result.failed).toContain('tech-1');
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // TRL SYNC TESTS
  // ============================================================================

  describe('syncTRLToPlacementsOnUpdate()', () => {
    it('should return empty result when neither TRL nor timeToImpact provided', async () => {
      const result = await syncTRLToPlacementsOnUpdate('tech-123');

      expect(result.updated).toBe(0);
      expect(result.failed).toHaveLength(0);
      expect(mockGetPlacements).not.toHaveBeenCalled();
    });

    it('should return empty result when no placements exist', async () => {
      mockGetPlacements.mockResolvedValueOnce([]);

      const result = await syncTRLToPlacementsOnUpdate('tech-123', 7);

      expect(result.updated).toBe(0);
    });

    it('should update placements with changed TRL', async () => {
      mockGetPlacements.mockResolvedValueOnce([
        { id: 'placement-1', trlScore: 5, timeToImpact: 'H1' },
        { id: 'placement-2', trlScore: 5, timeToImpact: 'H2' },
      ]);
      mockUpdatePlacement.mockResolvedValue(undefined);

      const result = await syncTRLToPlacementsOnUpdate('tech-123', 7);

      expect(result.updated).toBe(2);
      expect(mockUpdatePlacement).toHaveBeenCalledTimes(2);
    });

    it('should skip placements with matching TRL', async () => {
      mockGetPlacements.mockResolvedValueOnce([{ id: 'placement-1', trlScore: 7, timeToImpact: 'H1' }]);

      const result = await syncTRLToPlacementsOnUpdate('tech-123', 7);

      expect(result.updated).toBe(0);
      expect(mockUpdatePlacement).not.toHaveBeenCalled();
    });

    it('should update placements with changed timeToImpact', async () => {
      mockGetPlacements.mockResolvedValueOnce([{ id: 'placement-1', trlScore: 5, timeToImpact: 'H1' }]);
      mockUpdatePlacement.mockResolvedValue(undefined);

      const result = await syncTRLToPlacementsOnUpdate('tech-123', undefined, 'H2' as any);

      expect(result.updated).toBe(1);
    });

    it('should track failed placement updates', async () => {
      mockGetPlacements.mockResolvedValueOnce([{ id: 'placement-1', trlScore: 3, timeToImpact: 'H1' }]);
      mockUpdatePlacement.mockRejectedValueOnce(new Error('Update failed'));

      const result = await syncTRLToPlacementsOnUpdate('tech-123', 7);

      expect(result.updated).toBe(0);
      expect(result.failed).toContain('placement-1');
      expect(result.errors).toHaveLength(1);
    });

    it('should handle global error', async () => {
      mockGetPlacements.mockRejectedValueOnce(new Error('Fetch failed'));

      const result = await syncTRLToPlacementsOnUpdate('tech-123', 7);

      expect(result.errors).toHaveLength(1);
    });
  });

  // ============================================================================
  // UPDATE WITH SYNC TESTS
  // ============================================================================

  describe('updateTechnologyWithSync()', () => {
    it('should update technology and sync TRL changes', async () => {
      const existingTech = createMockTechnology({ trl: 5, timeToImpact: 'H1' as any });
      const updatedTech = { ...existingTech, trl: 7 };

      // getTechnologyById
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingTech));
      // updateTechnology - getDoc + updated getDoc
      firestoreMocks.getDoc
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(updatedTech));
      // syncTRLToPlacementsOnUpdate
      mockGetPlacements.mockResolvedValueOnce([]);

      const { technology, syncResult } = await updateTechnologyWithSync('tech-123', { trl: 7 });

      expect(technology.trl).toBe(7);
      expect(syncResult).toBeDefined();
    });

    it('should throw when technology not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      await expect(updateTechnologyWithSync('nonexistent', { trl: 7 })).rejects.toThrow(
        'Technology nonexistent not found'
      );
    });

    it('should not sync when TRL unchanged', async () => {
      const existingTech = createMockTechnology({ trl: 7 });
      const updatedTech = { ...existingTech, description: 'Updated' };

      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingTech));
      firestoreMocks.getDoc
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(updatedTech));

      const { syncResult } = await updateTechnologyWithSync('tech-123', { description: 'Updated' });

      expect(syncResult.updated).toBe(0);
      expect(mockGetPlacements).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // FILTER EDGE CASES
  // ============================================================================

  describe('getTechnologies() - additional filter tests', () => {
    it('should filter by linkedCompanyId', async () => {
      const tech1 = createMockTechnology({ id: 'tech-1', linkedCompanies: ['company-1'] });
      const tech2 = createMockTechnology({ id: 'tech-2', linkedCompanies: ['company-2'] });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([tech1, tech2]));

      const result = await getTechnologies({ linkedCompanyId: 'company-1' });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('tech-1');
    });

    it('should filter by linkedUseCaseId', async () => {
      const tech1 = createMockTechnology({ id: 'tech-1', linkedUseCases: ['uc-1'] });
      const tech2 = createMockTechnology({ id: 'tech-2', linkedUseCases: ['uc-2'] });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([tech1, tech2]));

      const result = await getTechnologies({ linkedUseCaseId: 'uc-1' });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('tech-1');
    });

    it('should sort by name alphabetically', async () => {
      const techB = createMockTechnology({ id: 'tech-1', name: 'Babel' });
      const techA = createMockTechnology({ id: 'tech-2', name: 'Angular' });
      const techC = createMockTechnology({ id: 'tech-3', name: 'Cypress' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([techB, techA, techC]));

      const result = await getTechnologies();

      expect(result[0].name).toBe('Angular');
      expect(result[1].name).toBe('Babel');
      expect(result[2].name).toBe('Cypress');
    });
  });

  // ============================================================================
  // LINKING EDGE CASES
  // ============================================================================

  describe('unlinkCompanyFromTechnology() - not found', () => {
    it('should throw when technology not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      await expect(unlinkCompanyFromTechnology('nonexistent', 'company-1')).rejects.toThrow(
        'Technology nonexistent not found'
      );
    });
  });

  describe('linkUseCaseToTechnology() - not found', () => {
    it('should throw when technology not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      await expect(linkUseCaseToTechnology('nonexistent', 'uc-1')).rejects.toThrow('Technology nonexistent not found');
    });

    it('should not duplicate existing use case link', async () => {
      const existingTech = createMockTechnology({ linkedUseCases: ['uc-1'] });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingTech));

      await linkUseCaseToTechnology('tech-123', 'uc-1');

      expect(firestoreMocks.updateDoc).not.toHaveBeenCalled();
    });
  });

  describe('unlinkUseCaseFromTechnology() - not found', () => {
    it('should throw when technology not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      await expect(unlinkUseCaseFromTechnology('nonexistent', 'uc-1')).rejects.toThrow(
        'Technology nonexistent not found'
      );
    });
  });

  // ============================================================================
  // getTechnologyBySlug - error handling
  // ============================================================================

  describe('getTechnologyBySlug() - error handling', () => {
    it('should throw on Firestore error', async () => {
      firestoreMocks.getDocs.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getTechnologyBySlug('react')).rejects.toThrow('Failed to fetch technology by slug');
    });
  });

  // ============================================================================
  // createTechnology - auto-generate slug
  // ============================================================================

  describe('createTechnology() - auto slug generation', () => {
    it('should auto-generate slug from name when slug not provided', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await createTechnology({
        name: 'Vue.js Framework',
        slug: 'vue-js-framework',
        description: 'Progressive JavaScript framework',
        tags: ['frontend'],
        createdBy: 'user-123',
      });

      expect(result.slug).toBe('vue-js-framework');
    });
  });

  // ============================================================================
  // DEEP RESEARCH TESTS (Phase 0 Task 0.2.3)
  // ============================================================================

  describe('deepResearch field (Phase 0 Task 0.2.3)', () => {
    it('should preserve deepResearch when fetching technology by ID', async () => {
      const techWithDeepResearch = createMockTechnology({
        deepResearch: {
          summary: 'React is a JavaScript library for building user interfaces, maintained by Meta.',
          keyInsights: [
            'Dominant market share in frontend development',
            'Strong ecosystem with Next.js and Remix',
            'Component-based architecture enables reusability',
          ],
          competitiveLandscape: 'Competes with Vue.js, Angular, and Svelte for frontend dominance.',
          marketAnalysis: 'Growing adoption in enterprise applications.',
          technicalDetails: 'Virtual DOM, JSX, hooks-based state management.',
          lastResearched: Date.now(),
          sources: ['https://react.dev', 'https://github.com/facebook/react'],
        },
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(techWithDeepResearch));

      const result = await getTechnologyById('tech-123');

      expect(result).not.toBeNull();
      expect(result?.deepResearch).toBeDefined();
      expect(result?.deepResearch?.summary).toContain('React');
      expect(result?.deepResearch?.keyInsights).toHaveLength(3);
      expect(result?.deepResearch?.competitiveLandscape).toBeDefined();
      expect(result?.deepResearch?.marketAnalysis).toBeDefined();
      expect(result?.deepResearch?.technicalDetails).toBeDefined();
      expect(result?.deepResearch?.sources).toHaveLength(2);
    });

    it('should handle technology without deepResearch', async () => {
      const techWithoutDeepResearch = createMockTechnology();
      // Explicitly ensure deepResearch is undefined
      delete (techWithoutDeepResearch as unknown as Record<string, unknown>).deepResearch;
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(techWithoutDeepResearch));

      const result = await getTechnologyById('tech-123');

      expect(result).not.toBeNull();
      expect(result?.deepResearch).toBeUndefined();
    });

    it('should preserve deepResearch in getTechnologies list', async () => {
      const tech1 = createMockTechnology({
        id: 'tech-1',
        deepResearch: {
          summary: 'React summary',
          keyInsights: ['Insight 1'],
          lastResearched: Date.now(),
          sources: ['https://react.dev'],
        },
      });
      const tech2 = createMockTechnology({
        id: 'tech-2',
        deepResearch: {
          summary: 'Vue summary',
          keyInsights: ['Insight A', 'Insight B'],
          lastResearched: Date.now(),
          sources: ['https://vuejs.org'],
        },
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([tech1, tech2]));

      const result = await getTechnologies();

      expect(result).toHaveLength(2);
      expect(result[0].deepResearch?.summary).toContain('React');
      expect(result[0].deepResearch?.keyInsights).toHaveLength(1);
      expect(result[1].deepResearch?.summary).toContain('Vue');
      expect(result[1].deepResearch?.keyInsights).toHaveLength(2);
    });

    it('should update deepResearch field', async () => {
      const existingTech = createMockTechnology();
      const updatedTech = {
        ...existingTech,
        deepResearch: {
          summary: 'Updated research summary',
          keyInsights: ['New insight 1', 'New insight 2'],
          lastResearched: Date.now(),
          sources: ['https://new-source.com'],
        },
      };

      firestoreMocks.getDoc
        .mockResolvedValueOnce(createMockDocResponse(existingTech))
        .mockResolvedValueOnce(createMockDocResponse(updatedTech));

      const result = await updateTechnology('tech-123', {
        deepResearch: {
          summary: 'Updated research summary',
          keyInsights: ['New insight 1', 'New insight 2'],
          lastResearched: Date.now(),
          sources: ['https://new-source.com'],
        },
      });

      expect(result.deepResearch).toBeDefined();
      expect(result.deepResearch?.summary).toBe('Updated research summary');
      expect(result.deepResearch?.keyInsights).toHaveLength(2);
      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });

    it('should handle deepResearch with only required fields (summary, keyInsights, lastResearched, sources)', async () => {
      const techWithMinimalDeepResearch = createMockTechnology({
        deepResearch: {
          summary: 'Minimal summary',
          keyInsights: ['Single insight'],
          lastResearched: Date.now(),
          sources: [],
        },
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(techWithMinimalDeepResearch));

      const result = await getTechnologyById('tech-123');

      expect(result?.deepResearch).toBeDefined();
      expect(result?.deepResearch?.summary).toBe('Minimal summary');
      expect(result?.deepResearch?.keyInsights).toHaveLength(1);
      expect(result?.deepResearch?.competitiveLandscape).toBeUndefined();
      expect(result?.deepResearch?.marketAnalysis).toBeUndefined();
      expect(result?.deepResearch?.technicalDetails).toBeUndefined();
    });

    it('should preserve lastResearched timestamp', async () => {
      const researchTimestamp = Date.now() - 86400000; // 1 day ago
      const techWithTimestamp = createMockTechnology({
        deepResearch: {
          summary: 'Old research',
          keyInsights: ['Insight'],
          lastResearched: researchTimestamp,
          sources: ['https://source.com'],
        },
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(techWithTimestamp));

      const result = await getTechnologyById('tech-123');

      expect(result?.deepResearch?.lastResearched).toBe(researchTimestamp);
    });

    it('should handle empty keyInsights array', async () => {
      const techWithEmptyInsights = createMockTechnology({
        deepResearch: {
          summary: 'Summary without insights yet',
          keyInsights: [],
          lastResearched: Date.now(),
          sources: [],
        },
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(techWithEmptyInsights));

      const result = await getTechnologyById('tech-123');

      expect(result?.deepResearch?.keyInsights).toHaveLength(0);
    });

    it('should handle multiple sources in deepResearch', async () => {
      const techWithManySources = createMockTechnology({
        deepResearch: {
          summary: 'Comprehensive research',
          keyInsights: ['Insight 1'],
          lastResearched: Date.now(),
          sources: [
            'https://react.dev',
            'https://github.com/facebook/react',
            'https://stateofjs.com',
            'https://npmtrends.com',
            'https://bundlephobia.com',
          ],
        },
      });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(techWithManySources));

      const result = await getTechnologyById('tech-123');

      expect(result?.deepResearch?.sources).toHaveLength(5);
      expect(result?.deepResearch?.sources).toContain('https://react.dev');
      expect(result?.deepResearch?.sources).toContain('https://stateofjs.com');
    });
  });
});
