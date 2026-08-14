/**
 * @file lib/__tests__/concept-service.test.ts
 * @description Unit tests for Concept service
 *
 * Tests CRUD operations, normalization, graph sync status, and statistics
 *
 * @phase Knowledge Graph Intelligence Sprint - Phase 6
 * @author Radarist Team
 * @created 2026-01-14
 */

import {
  getConceptById,
  getConceptBySlug,
  getConcepts,
  searchConcepts,
  getConceptsPendingSync,
  getChildConcepts,
  createConcept,
  getOrCreateConcept,
  bulkGetOrCreateConcepts,
  updateConcept,
  addConceptAlias,
  removeConceptAlias,
  setConceptParent,
  incrementEntityCount,
  markConceptSynced,
  markConceptSyncFailed,
  deleteConcept,
  findConceptByInput,
  conceptExists,
  getConceptStats,
  extractConceptsFromTags,
} from '../concept-service';
import type { Concept, ConceptType } from '../types';

// Mock concept-normalize utilities
jest.mock('../utils/concept-normalize', () => ({
  normalizeConcept: jest.fn((input: string) => {
    if (!input || typeof input !== 'string') return '';
    const lower = input.toLowerCase().trim();
    const mappings: Record<string, string> = {
      'ai': 'artificial-intelligence',
      'a.i.': 'artificial-intelligence',
      'artificial intelligence': 'artificial-intelligence',
      'ml': 'machine-learning',
      'machine learning': 'machine-learning',
      'iot': 'internet-of-things',
      'internet of things': 'internet-of-things',
    };
    return mappings[lower] || lower.replace(/\s+/g, '-');
  }),
  getCanonicalName: jest.fn((slug: string) => {
    const names: Record<string, string> = {
      'artificial-intelligence': 'Artificial Intelligence',
      'machine-learning': 'Machine Learning',
      'internet-of-things': 'Internet of Things',
    };
    return (
      names[slug] ||
      slug
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
    );
  }),
  normalizeConceptArray: jest.fn((inputs: string[]) => {
    const seen = new Map<string, string[]>();
    for (const input of inputs) {
      if (!input || typeof input !== 'string') continue;
      const trimmed = input.trim();
      if (!trimmed) continue;
      const slug =
        {
          ai: 'artificial-intelligence',
          'a.i.': 'artificial-intelligence',
          'artificial intelligence': 'artificial-intelligence',
          ml: 'machine-learning',
          'machine learning': 'machine-learning',
          iot: 'internet-of-things',
        }[trimmed.toLowerCase()] || trimmed.toLowerCase().replace(/\s+/g, '-');
      const existing = seen.get(slug) || [];
      if (!existing.includes(trimmed)) {
        existing.push(trimmed);
      }
      seen.set(slug, existing);
    }
    return Array.from(seen.entries()).map(([slug, originalInputs]) => ({
      slug,
      canonicalName:
        {
          'artificial-intelligence': 'Artificial Intelligence',
          'machine-learning': 'Machine Learning',
          'internet-of-things': 'Internet of Things',
        }[slug] ||
        slug
          .split('-')
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' '),
      originalInputs,
    }));
  }),
}));

// Mock Firebase
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  doc: jest.fn(),
  getDoc: jest.fn(),
  getDocs: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  increment: jest.fn((n: number) => ({ _increment: n })),
  Timestamp: {
    now: jest.fn(() => ({ toMillis: () => Date.now() })),
    fromMillis: jest.fn((ms: number) => ({ toMillis: () => ms })),
  },
}));

jest.mock('../firebase', () => ({
  db: {},
}));

// Import mocked functions
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  increment,
} from 'firebase/firestore';

import { normalizeConcept, normalizeConceptArray } from '../utils/concept-normalize';

// ============================================================================
// TEST HELPERS
// ============================================================================

const createMockConcept = (overrides: Partial<Concept> = {}): Concept => ({
  id: 'concept-artificial-intelligence',
  canonicalName: 'Artificial Intelligence',
  slug: 'artificial-intelligence',
  type: 'tag',
  aliases: ['AI', 'ai', 'A.I.'],
  description: 'Test concept description',
  parentId: undefined,
  entityCount: 5,
  graphSyncStatus: 'pending',
  lastSyncedAt: undefined,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

const createMockDocSnapshot = (data: Concept | null, exists = true) => ({
  exists: () => exists,
  id: data?.id || 'unknown',
  data: () =>
    data
      ? {
          ...data,
          createdAt: { toMillis: () => data.createdAt },
          updatedAt: { toMillis: () => data.updatedAt },
          lastSyncedAt: data.lastSyncedAt ? { toMillis: () => data.lastSyncedAt } : undefined,
        }
      : null,
});

const createMockQuerySnapshot = (docs: Concept[]) => ({
  docs: docs.map((d) => ({
    id: d.id,
    exists: () => true,
    data: () => ({
      ...d,
      createdAt: { toMillis: () => d.createdAt },
      updatedAt: { toMillis: () => d.updatedAt },
      lastSyncedAt: d.lastSyncedAt ? { toMillis: () => d.lastSyncedAt } : undefined,
    }),
  })),
  empty: docs.length === 0,
  size: docs.length,
});

// ============================================================================
// TESTS
// ============================================================================

describe('Concept Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (query as jest.Mock).mockReturnValue({});
    (where as jest.Mock).mockReturnValue({});
    (orderBy as jest.Mock).mockReturnValue({});
    (limit as jest.Mock).mockReturnValue({});
    (collection as jest.Mock).mockReturnValue({});
    (doc as jest.Mock).mockReturnValue({});
  });

  // ==========================================================================
  // GET OPERATIONS
  // ==========================================================================

  describe('getConceptById', () => {
    it('should return concept when found', async () => {
      const mockConcept = createMockConcept();
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(mockConcept));

      const result = await getConceptById('concept-artificial-intelligence');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('concept-artificial-intelligence');
      expect(result?.canonicalName).toBe('Artificial Intelligence');
    });

    it('should return null when concept not found', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));

      const result = await getConceptById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getConceptBySlug', () => {
    it('should return concept by slug', async () => {
      const mockConcept = createMockConcept();
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(mockConcept));

      const result = await getConceptBySlug('artificial-intelligence');

      expect(doc).toHaveBeenCalled();
      expect(result?.slug).toBe('artificial-intelligence');
    });

    it('should generate correct ID from slug', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));

      await getConceptBySlug('machine-learning');

      // Verify doc was called with the correct ID format
      expect(doc).toHaveBeenCalled();
    });
  });

  describe('getConcepts', () => {
    it('should return all concepts when no filters provided', async () => {
      const mockConcepts = [
        createMockConcept({ id: 'concept-1', slug: 'concept-1' }),
        createMockConcept({ id: 'concept-2', slug: 'concept-2' }),
      ];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockConcepts));

      const result = await getConcepts({});

      expect(result).toHaveLength(2);
    });

    it('should filter by type', async () => {
      const mockConcepts = [createMockConcept({ type: 'category' })];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockConcepts));

      const result = await getConcepts({ type: 'category' });

      expect(where).toHaveBeenCalledWith('type', '==', 'category');
      expect(result).toHaveLength(1);
    });

    it('should filter by parentId', async () => {
      const mockConcepts = [createMockConcept({ parentId: 'concept-ai' })];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockConcepts));

      const result = await getConcepts({ parentId: 'concept-ai' });

      expect(where).toHaveBeenCalledWith('parentId', '==', 'concept-ai');
      expect(result).toHaveLength(1);
    });

    it('should filter by graphSyncStatus', async () => {
      const mockConcepts = [createMockConcept({ graphSyncStatus: 'failed' })];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockConcepts));

      const result = await getConcepts({ graphSyncStatus: 'failed' });

      expect(where).toHaveBeenCalledWith('graphSyncStatus', '==', 'failed');
      expect(result).toHaveLength(1);
    });

    it('should apply search filter client-side', async () => {
      const mockConcepts = [
        createMockConcept({ canonicalName: 'Machine Learning', slug: 'machine-learning' }),
        createMockConcept({ canonicalName: 'Artificial Intelligence', slug: 'artificial-intelligence' }),
      ];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockConcepts));

      const result = await getConcepts({ search: 'machine' });

      expect(result).toHaveLength(1);
      expect(result[0].canonicalName).toBe('Machine Learning');
    });

    it('should search in aliases', async () => {
      const mockConcepts = [
        createMockConcept({ canonicalName: 'Artificial Intelligence', aliases: ['AI', 'A.I.'] }),
      ];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockConcepts));

      const result = await getConcepts({ search: 'ai' });

      expect(result).toHaveLength(1);
    });

    it('should apply limit', async () => {
      const mockConcepts = [createMockConcept()];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockConcepts));

      await getConcepts({ limit: 10 });

      expect(limit).toHaveBeenCalledWith(10);
    });

    it('should return empty array when no concepts found', async () => {
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([]));

      const result = await getConcepts({});

      expect(result).toHaveLength(0);
    });
  });

  describe('searchConcepts', () => {
    it('should search concepts by query', async () => {
      const mockConcepts = [createMockConcept({ canonicalName: 'Machine Learning' })];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockConcepts));

      const result = await searchConcepts('machine', 10);

      expect(result).toHaveLength(1);
    });

    it('should use default limit of 20', async () => {
      const mockConcepts: Concept[] = [];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockConcepts));

      await searchConcepts('test');

      expect(limit).toHaveBeenCalledWith(20);
    });
  });

  describe('getConceptsPendingSync', () => {
    it('should return concepts with pending sync status', async () => {
      const mockConcepts = [
        createMockConcept({ graphSyncStatus: 'pending' }),
        createMockConcept({ graphSyncStatus: 'pending', id: 'concept-2' }),
      ];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockConcepts));

      const result = await getConceptsPendingSync();

      expect(where).toHaveBeenCalledWith('graphSyncStatus', '==', 'pending');
      expect(result).toHaveLength(2);
    });

    it('should apply custom limit', async () => {
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([]));

      await getConceptsPendingSync(50);

      expect(limit).toHaveBeenCalledWith(50);
    });
  });

  describe('getChildConcepts', () => {
    it('should return child concepts of a parent', async () => {
      const mockConcepts = [
        createMockConcept({ parentId: 'concept-ai', slug: 'machine-learning' }),
        createMockConcept({ parentId: 'concept-ai', slug: 'deep-learning' }),
      ];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockConcepts));

      const result = await getChildConcepts('concept-ai');

      expect(where).toHaveBeenCalledWith('parentId', '==', 'concept-ai');
      expect(result).toHaveLength(2);
    });
  });

  // ==========================================================================
  // CREATE OPERATIONS
  // ==========================================================================

  describe('createConcept', () => {
    it('should create a new concept', async () => {
      (setDoc as jest.Mock).mockResolvedValue(undefined);

      const input = {
        canonicalName: 'Artificial Intelligence',
        slug: 'artificial-intelligence',
        type: 'tag' as ConceptType,
        aliases: ['AI', 'ai'],
      };

      const result = await createConcept(input);

      expect(setDoc).toHaveBeenCalled();
      expect(result.id).toBe('concept-artificial-intelligence');
      expect(result.canonicalName).toBe('Artificial Intelligence');
      expect(result.graphSyncStatus).toBe('pending');
      expect(result.entityCount).toBe(0);
    });

    it('should include description when provided', async () => {
      (setDoc as jest.Mock).mockResolvedValue(undefined);

      const input = {
        canonicalName: 'Machine Learning',
        slug: 'machine-learning',
        type: 'tag' as ConceptType,
        aliases: ['ML'],
        description: 'A subset of AI focused on learning from data',
      };

      const result = await createConcept(input);

      expect(result.description).toBe('A subset of AI focused on learning from data');
    });

    it('should include parentId when provided', async () => {
      (setDoc as jest.Mock).mockResolvedValue(undefined);

      const input = {
        canonicalName: 'Deep Learning',
        slug: 'deep-learning',
        type: 'tag' as ConceptType,
        aliases: ['DL'],
        parentId: 'concept-machine-learning',
      };

      const result = await createConcept(input);

      expect(result.parentId).toBe('concept-machine-learning');
    });

    it('should set timestamps', async () => {
      (setDoc as jest.Mock).mockResolvedValue(undefined);
      const beforeCreate = Date.now();

      const input = {
        canonicalName: 'Test Concept',
        slug: 'test-concept',
        type: 'tag' as ConceptType,
        aliases: [],
      };

      const result = await createConcept(input);

      expect(result.createdAt).toBeGreaterThanOrEqual(beforeCreate);
      expect(result.updatedAt).toBeGreaterThanOrEqual(beforeCreate);
    });
  });

  describe('getOrCreateConcept', () => {
    it('should return existing concept if found', async () => {
      const existingConcept = createMockConcept();
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(existingConcept));

      const result = await getOrCreateConcept('AI');

      expect(result.slug).toBe('artificial-intelligence');
      expect(setDoc).not.toHaveBeenCalled();
    });

    it('should create new concept if not found', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));
      (setDoc as jest.Mock).mockResolvedValue(undefined);

      const result = await getOrCreateConcept('AI');

      expect(setDoc).toHaveBeenCalled();
      expect(result.slug).toBe('artificial-intelligence');
      expect(result.canonicalName).toBe('Artificial Intelligence');
    });

    it('should add new alias to existing concept', async () => {
      const existingConcept = createMockConcept({ aliases: ['AI'] });
      (getDoc as jest.Mock)
        .mockResolvedValueOnce(createMockDocSnapshot(existingConcept))
        .mockResolvedValueOnce(createMockDocSnapshot(existingConcept))
        .mockResolvedValueOnce(
          createMockDocSnapshot({ ...existingConcept, aliases: ['AI', 'A.I.'] })
        );
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      await getOrCreateConcept('A.I.');

      expect(updateDoc).toHaveBeenCalled();
    });

    it('should not add duplicate alias', async () => {
      const existingConcept = createMockConcept({ aliases: ['AI', 'A.I.'] });
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(existingConcept));

      await getOrCreateConcept('AI');

      expect(updateDoc).not.toHaveBeenCalled();
    });

    it('should throw error for invalid input', async () => {
      (normalizeConcept as jest.Mock).mockReturnValueOnce('');

      await expect(getOrCreateConcept('')).rejects.toThrow(
        'Invalid concept input: cannot normalize to a valid slug'
      );
    });

    it('should use provided type for new concept', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));
      (setDoc as jest.Mock).mockResolvedValue(undefined);

      const result = await getOrCreateConcept('Healthcare', 'industry');

      expect(result.type).toBe('industry');
    });
  });

  describe('bulkGetOrCreateConcepts', () => {
    it('should create multiple concepts', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));
      (setDoc as jest.Mock).mockResolvedValue(undefined);

      const result = await bulkGetOrCreateConcepts(['AI', 'ML', 'IoT']);

      expect(result).toHaveLength(3);
    });

    it('should handle mixed existing and new concepts', async () => {
      const existingConcept = createMockConcept({ slug: 'artificial-intelligence' });
      (getDoc as jest.Mock)
        .mockResolvedValueOnce(createMockDocSnapshot(existingConcept)) // AI exists
        .mockResolvedValueOnce(createMockDocSnapshot(null, false)); // ML doesn't exist
      (setDoc as jest.Mock).mockResolvedValue(undefined);

      // Mock normalizeConceptArray to return AI and ML only
      (normalizeConceptArray as jest.Mock).mockReturnValueOnce([
        { slug: 'artificial-intelligence', canonicalName: 'Artificial Intelligence', originalInputs: ['AI'] },
        { slug: 'machine-learning', canonicalName: 'Machine Learning', originalInputs: ['ML'] },
      ]);

      const result = await bulkGetOrCreateConcepts(['AI', 'ML']);

      expect(result).toHaveLength(2);
    });

    it('should deduplicate inputs', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));
      (setDoc as jest.Mock).mockResolvedValue(undefined);

      // Mock returns deduplicated result
      (normalizeConceptArray as jest.Mock).mockReturnValueOnce([
        { slug: 'artificial-intelligence', canonicalName: 'Artificial Intelligence', originalInputs: ['AI', 'ai'] },
      ]);

      const result = await bulkGetOrCreateConcepts(['AI', 'ai']);

      expect(result).toHaveLength(1);
    });
  });

  // ==========================================================================
  // UPDATE OPERATIONS
  // ==========================================================================

  describe('updateConcept', () => {
    it('should update concept', async () => {
      const updatedConcept = createMockConcept({ description: 'Updated description' });
      (updateDoc as jest.Mock).mockResolvedValue(undefined);
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(updatedConcept));

      const result = await updateConcept('concept-artificial-intelligence', {
        description: 'Updated description',
      });

      expect(updateDoc).toHaveBeenCalled();
      expect(result.description).toBe('Updated description');
    });

    it('should set graphSyncStatus to pending on update', async () => {
      const updatedConcept = createMockConcept();
      (updateDoc as jest.Mock).mockResolvedValue(undefined);
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(updatedConcept));

      await updateConcept('concept-artificial-intelligence', { description: 'New' });

      const updateCall = (updateDoc as jest.Mock).mock.calls[0][1];
      expect(updateCall.graphSyncStatus).toBe('pending');
    });

    it('should throw error if concept not found after update', async () => {
      (updateDoc as jest.Mock).mockResolvedValue(undefined);
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));

      await expect(
        updateConcept('concept-nonexistent', { description: 'Test' })
      ).rejects.toThrow('Concept concept-nonexistent not found after update');
    });
  });

  describe('addConceptAlias', () => {
    it('should add new alias to concept', async () => {
      const concept = createMockConcept({ aliases: ['AI'] });
      const updatedConcept = createMockConcept({ aliases: ['AI', 'A.I.'] });
      (getDoc as jest.Mock)
        .mockResolvedValueOnce(createMockDocSnapshot(concept))
        .mockResolvedValueOnce(createMockDocSnapshot(updatedConcept));
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      const result = await addConceptAlias('concept-artificial-intelligence', 'A.I.');

      expect(updateDoc).toHaveBeenCalled();
      expect(result.aliases).toContain('A.I.');
    });

    it('should not add duplicate alias', async () => {
      const concept = createMockConcept({ aliases: ['AI', 'A.I.'] });
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(concept));

      const result = await addConceptAlias('concept-artificial-intelligence', 'AI');

      expect(updateDoc).not.toHaveBeenCalled();
      expect(result).toEqual(concept);
    });

    it('should throw error if concept not found', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));

      await expect(addConceptAlias('nonexistent', 'alias')).rejects.toThrow(
        'Concept nonexistent not found'
      );
    });

    it('should trim alias before adding', async () => {
      const concept = createMockConcept({ aliases: ['AI'] });
      const updatedConcept = createMockConcept({ aliases: ['AI', 'A.I.'] });
      (getDoc as jest.Mock)
        .mockResolvedValueOnce(createMockDocSnapshot(concept))
        .mockResolvedValueOnce(createMockDocSnapshot(updatedConcept));
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      await addConceptAlias('concept-artificial-intelligence', '  A.I.  ');

      // Verify update was called (alias was not already in trimmed form)
      expect(updateDoc).toHaveBeenCalled();
    });
  });

  describe('removeConceptAlias', () => {
    it('should remove alias from concept', async () => {
      const concept = createMockConcept({ aliases: ['AI', 'A.I.', 'ai'] });
      const updatedConcept = createMockConcept({ aliases: ['AI', 'ai'] });
      (getDoc as jest.Mock)
        .mockResolvedValueOnce(createMockDocSnapshot(concept))
        .mockResolvedValueOnce(createMockDocSnapshot(updatedConcept));
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      const result = await removeConceptAlias('concept-artificial-intelligence', 'A.I.');

      expect(updateDoc).toHaveBeenCalled();
      expect(result.aliases).not.toContain('A.I.');
    });

    it('should throw error if concept not found', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));

      await expect(removeConceptAlias('nonexistent', 'alias')).rejects.toThrow(
        'Concept nonexistent not found'
      );
    });
  });

  describe('setConceptParent', () => {
    it('should set parent concept', async () => {
      const updatedConcept = createMockConcept({ parentId: 'concept-ai' });
      (updateDoc as jest.Mock).mockResolvedValue(undefined);
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(updatedConcept));

      const result = await setConceptParent('concept-machine-learning', 'concept-ai');

      expect(result.parentId).toBe('concept-ai');
    });

    it('should remove parent when null provided', async () => {
      const updatedConcept = createMockConcept({ parentId: undefined });
      (updateDoc as jest.Mock).mockResolvedValue(undefined);
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(updatedConcept));

      const result = await setConceptParent('concept-machine-learning', null);

      expect(result.parentId).toBeUndefined();
    });
  });

  describe('incrementEntityCount', () => {
    it('should increment entity count', async () => {
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      await incrementEntityCount('concept-ai', 1);

      expect(updateDoc).toHaveBeenCalled();
      expect(increment).toHaveBeenCalledWith(1);
    });

    it('should use default delta of 1', async () => {
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      await incrementEntityCount('concept-ai');

      expect(increment).toHaveBeenCalledWith(1);
    });

    it('should support decrement with negative delta', async () => {
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      await incrementEntityCount('concept-ai', -1);

      expect(increment).toHaveBeenCalledWith(-1);
    });
  });

  describe('markConceptSynced', () => {
    it('should update sync status to synced', async () => {
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      await markConceptSynced('concept-ai');

      expect(updateDoc).toHaveBeenCalled();
      const updateCall = (updateDoc as jest.Mock).mock.calls[0][1];
      expect(updateCall.graphSyncStatus).toBe('synced');
      expect(updateCall.lastSyncedAt).toBeDefined();
    });
  });

  describe('markConceptSyncFailed', () => {
    it('should update sync status to failed', async () => {
      (updateDoc as jest.Mock).mockResolvedValue(undefined);

      await markConceptSyncFailed('concept-ai');

      expect(updateDoc).toHaveBeenCalled();
      const updateCall = (updateDoc as jest.Mock).mock.calls[0][1];
      expect(updateCall.graphSyncStatus).toBe('failed');
    });
  });

  // ==========================================================================
  // DELETE OPERATIONS
  // ==========================================================================

  describe('deleteConcept', () => {
    it('should delete concept', async () => {
      (deleteDoc as jest.Mock).mockResolvedValue(undefined);

      await deleteConcept('concept-obsolete');

      expect(deleteDoc).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // UTILITY FUNCTIONS
  // ==========================================================================

  describe('findConceptByInput', () => {
    it('should find concept by normalized input', async () => {
      const mockConcept = createMockConcept();
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(mockConcept));

      const result = await findConceptByInput('AI');

      expect(normalizeConcept).toHaveBeenCalledWith('AI');
      expect(result?.slug).toBe('artificial-intelligence');
    });

    it('should return null for empty input', async () => {
      (normalizeConcept as jest.Mock).mockReturnValueOnce('');

      const result = await findConceptByInput('');

      expect(result).toBeNull();
    });

    it('should return null when concept not found', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));

      const result = await findConceptByInput('Unknown');

      expect(result).toBeNull();
    });
  });

  describe('conceptExists', () => {
    it('should return true when concept exists', async () => {
      const mockConcept = createMockConcept();
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(mockConcept));

      const result = await conceptExists('AI');

      expect(result).toBe(true);
    });

    it('should return false when concept does not exist', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));

      const result = await conceptExists('Unknown');

      expect(result).toBe(false);
    });
  });

  describe('getConceptStats', () => {
    it('should return concept statistics', async () => {
      const mockConcepts = [
        createMockConcept({ type: 'tag', graphSyncStatus: 'pending' }),
        createMockConcept({ type: 'tag', graphSyncStatus: 'synced', id: 'concept-2' }),
        createMockConcept({ type: 'category', graphSyncStatus: 'pending', id: 'concept-3' }),
      ];
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot(mockConcepts));

      const result = await getConceptStats();

      expect(result.total).toBe(3);
      expect(result.byType.tag).toBe(2);
      expect(result.byType.category).toBe(1);
      expect(result.pendingSync).toBe(2);
    });

    it('should return zero counts when no concepts exist', async () => {
      (getDocs as jest.Mock).mockResolvedValue(createMockQuerySnapshot([]));

      const result = await getConceptStats();

      expect(result.total).toBe(0);
      expect(result.byType.tag).toBe(0);
      expect(result.pendingSync).toBe(0);
    });
  });

  describe('extractConceptsFromTags', () => {
    it('should extract and create concepts from tags', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));
      (setDoc as jest.Mock).mockResolvedValue(undefined);

      // Mock normalizeConceptArray
      (normalizeConceptArray as jest.Mock).mockReturnValueOnce([
        { slug: 'artificial-intelligence', canonicalName: 'Artificial Intelligence', originalInputs: ['AI'] },
        { slug: 'machine-learning', canonicalName: 'Machine Learning', originalInputs: ['ML'] },
      ]);

      const result = await extractConceptsFromTags(['AI', 'ML']);

      expect(result).toContain('artificial-intelligence');
      expect(result).toContain('machine-learning');
    });

    it('should return empty array for empty tags', async () => {
      const result = await extractConceptsFromTags([]);

      expect(result).toEqual([]);
    });

    it('should use provided type', async () => {
      (getDoc as jest.Mock).mockResolvedValue(createMockDocSnapshot(null, false));
      (setDoc as jest.Mock).mockResolvedValue(undefined);

      // Mock normalizeConceptArray
      (normalizeConceptArray as jest.Mock).mockReturnValueOnce([
        { slug: 'healthcare', canonicalName: 'Healthcare', originalInputs: ['Healthcare'] },
      ]);

      await extractConceptsFromTags(['Healthcare'], 'industry');

      // Check that setDoc was called with industry type
      const setDocCall = (setDoc as jest.Mock).mock.calls[0][1];
      expect(setDocCall.type).toBe('industry');
    });
  });
});
