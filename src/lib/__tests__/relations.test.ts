/**
 * Unit Tests for Relations Module
 *
 * Tests:
 * - filterRelations function (pure, no Firestore)
 * - Deduplication logic (symmetric + directional relations)
 * - Self-reference detection
 * - Error classes
 * - Firestore CRUD operations (getRelations, getRelationById, createRelation, etc.)
 * - Batch deletion (deleteRelationsForEntity)
 * - Query operations (getRelationsBySource, getRelationsByTarget, etc.)
 *
 * @jest-environment node
 */

import type { Relation, EntityType, EntitySnapshot, RelationType } from '../types';
import {
  isSymmetricRelationType,
  SYMMETRIC_RELATION_TYPES,
} from '../relation-symmetry-contract';
import { buildRelationTripleLockKeyCandidates } from '../relations-triple-key';
import { relationProjectionFingerprint } from '../graph/projection-reconciliation';

// ============================================================================
// MOCKS (hoisted by Jest)
// ============================================================================

jest.mock('@/lib/firebase', () => ({ db: {} }));

const mockBatchDelete = jest.fn();
const mockBatchCommit = jest.fn().mockResolvedValue(undefined);

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(() => 'mock-doc-ref'),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  Timestamp: { now: jest.fn() },
  writeBatch: jest.fn(() => ({ delete: mockBatchDelete, commit: mockBatchCommit })),
  runTransaction: jest.fn(),
}));

jest.mock('@/lib/migration', () => ({
  idResolver: { isNewFormat: jest.fn().mockReturnValue(false), getOldId: jest.fn() },
  safeResolve: jest.fn((id: string) => id),
  needsResolution: jest.fn().mockReturnValue(false),
}));

const mockInngestSend = jest.fn().mockResolvedValue({ ids: ['relation-sync-event'] });

// Mock the Inngest client so create/update/delete fixtures don't leak real
// `app/relation.sync.requested` events to the live dev server. Without this,
// running `npm test` while the dev stack is up sends phantom events for
// fixture IDs (rel-update, rel-src, rel-tgt, rel-1778…) — the sync function
// then throws "Relation not found in Firestore" against the real Firestore.
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: mockInngestSend },
  safeSendEvent: jest.fn().mockResolvedValue(true),
}));

// Import mocked firestore functions
import { getDocs, getDoc, setDoc, updateDoc, runTransaction } from 'firebase/firestore';

const mockGetDocs = getDocs as jest.Mock;
const mockGetDoc = getDoc as jest.Mock;
const mockSetDoc = setDoc as jest.Mock;
const mockUpdateDoc = updateDoc as jest.Mock;
const mockRunTransaction = runTransaction as jest.Mock;

/**
 * Wires the next `runTransaction(db, fn)` call to invoke `fn` with a fake
 * transaction double. Mirrors createRelationWithTripleLock's read sequence:
 * first `tx.get(lockRef)`, then — only when the lock exists — `tx.get(existingRelationRef)`.
 */
function mockTripleLockTransaction(
  opts: {
    lockExists?: boolean;
    lockData?: Record<string, unknown>;
    relationExists?: boolean;
    relationData?: Relation | Record<string, unknown>;
  } = {}
) {
  const txGet = jest.fn();
  txGet.mockResolvedValueOnce({
    exists: () => opts.lockExists ?? false,
    data: () => opts.lockData,
  });
  if (opts.lockExists) {
    txGet.mockResolvedValueOnce({
      exists: () => opts.relationExists ?? false,
      data: () => opts.relationData,
    });
  }
  const txSet = jest.fn();
  mockRunTransaction.mockImplementationOnce(
    async (_db: unknown, fn: (tx: { get: typeof txGet; set: typeof txSet }) => unknown) =>
      fn({ get: txGet, set: txSet })
  );
  return { txGet, txSet };
}

function mockTripleMigrationTransaction(
  existing: Relation,
  opts: {
    oldLockExists?: boolean;
    oldLockOwner?: string;
    newLockExists?: boolean;
    newLockOwner?: string;
    duplicateRelation?: Relation | null;
    queryDuplicates?: Relation[];
  } = {}
) {
  mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => existing });
  mockGetDocs.mockResolvedValueOnce(
    createMockQuerySnapshot(opts.queryDuplicates ?? [])
  );
  const txGet = jest.fn().mockResolvedValueOnce({ exists: () => true, data: () => existing });
  for (const duplicate of opts.queryDuplicates ?? []) {
    txGet.mockResolvedValueOnce({ exists: () => true, data: () => duplicate });
  }
  txGet
    .mockResolvedValueOnce({
      exists: () => opts.oldLockExists ?? true,
      data: () => ({ relationId: opts.oldLockOwner ?? existing.id }),
    })
    .mockResolvedValueOnce({
      exists: () => opts.newLockExists ?? false,
      data: () => ({ relationId: opts.newLockOwner }),
    });
  if (opts.newLockExists && opts.newLockOwner && opts.newLockOwner !== existing.id) {
    txGet.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    txGet.mockResolvedValueOnce({
      exists: () => opts.duplicateRelation != null,
      data: () => opts.duplicateRelation,
    });
  }
  const txSet = jest.fn();
  const txUpdate = jest.fn();
  const txDelete = jest.fn();
  mockRunTransaction.mockImplementationOnce(
    async (
      _db: unknown,
      fn: (tx: { get: typeof txGet; set: typeof txSet; update: typeof txUpdate; delete: typeof txDelete }) => unknown
    ) => fn({ get: txGet, set: txSet, update: txUpdate, delete: txDelete })
  );
  return { txGet, txSet, txUpdate, txDelete };
}

function mockMetadataUpdateTransaction(existing: Relation | null) {
  const txGet = jest.fn().mockResolvedValueOnce({
    exists: () => existing !== null,
    data: () => existing,
  });
  const txUpdate = jest.fn();
  mockRunTransaction.mockImplementationOnce(
    async (_db: unknown, fn: (tx: { get: typeof txGet; update: typeof txUpdate }) => unknown) =>
      fn({ get: txGet, update: txUpdate })
  );
  return { txGet, txUpdate };
}

function mockRelationDeleteTransaction(
  relations: Relation[],
  lockOwners: Record<string, string | undefined> = {}
) {
  const uniqueKeys = [
    ...new Set(
      relations.flatMap((relation) =>
        buildRelationTripleLockKeyCandidates(
          relation.sourceSnapshot.id,
          relation.targetSnapshot.id,
          relation.relationType
        )
      )
    ),
  ];
  const txGet = jest.fn();
  for (const relation of relations) {
    txGet.mockResolvedValueOnce({ exists: () => true, data: () => relation });
  }
  for (const key of uniqueKeys) {
    const owner = lockOwners[key];
    txGet.mockResolvedValueOnce({ exists: () => owner !== undefined, data: () => ({ relationId: owner }) });
  }
  const txDelete = jest.fn();
  const txUpdate = jest.fn();
  const txSet = jest.fn();
  mockRunTransaction.mockImplementationOnce(
    async (
      _db: unknown,
      fn: (tx: { get: typeof txGet; delete: typeof txDelete; update: typeof txUpdate; set: typeof txSet }) => unknown
    ) => fn({ get: txGet, delete: txDelete, update: txUpdate, set: txSet })
  );
  return { txGet, txDelete, txUpdate, txSet };
}

// Import functions AFTER mocks
import {
  filterRelations,
  DuplicateRelationError,
  SelfReferenceError,
  getRelations,
  getRelationById,
  createRelation,
  createRelationFromIds,
  updateRelation,
  deleteRelation,
  deleteRelationBetween,
  deleteRelationsForEntity,
  getRelationsBySource,
  getRelationsByTarget,
  getRelationsForEntity,
  getRelationsForEntities,
  getRelationsByType,
  getAISuggestedRelations,
  getStaleRelations,
  updateSourceSnapshot,
  updateTargetSnapshot,
  checkDuplicateRelation,
  cleanupOrphanedRelations,
} from '../relations';
import { RelationSyncDispatchError } from '../relation-sync-dispatch';
import { isCorrelationId } from '../observability/correlation';

// ============================================================================
// HELPERS
// ============================================================================

function createMockSnapshot(
  type: EntityType,
  id: string,
  name: string,
  overrides?: Partial<EntitySnapshot>
): EntitySnapshot {
  return {
    type,
    id,
    name,
    description: `Description for ${name}`,
    snapshotAt: Date.now(),
    ...overrides,
  };
}

function createMockRelation(overrides?: Partial<Relation>): Relation {
  return {
    id: 'rel-123',
    relationType: 'uses',
    sourceSnapshot: createMockSnapshot('technology', 'tech-1', 'TensorFlow'),
    targetSnapshot: createMockSnapshot('technology', 'tech-2', 'Python'),
    notes: 'TensorFlow uses Python as primary language',
    aiSuggested: false,
    confidence: 95,
    createdAt: Date.now() - 24 * 60 * 60 * 1000,
    updatedAt: Date.now() - 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function createMockQuerySnapshot(docs: Relation[]) {
  return {
    docs: docs.map((d) => ({
      data: () => d,
      id: d.id,
      exists: () => true,
    })),
    size: docs.length,
    empty: docs.length === 0,
  };
}

// ============================================================================
// PURE FUNCTION TESTS
// ============================================================================

describe('Relations Module - filterRelations()', () => {
  const relations: Relation[] = [
    createMockRelation({
      id: 'rel-1',
      relationType: 'uses',
      sourceSnapshot: createMockSnapshot('technology', 'tech-1', 'TensorFlow'),
      targetSnapshot: createMockSnapshot('technology', 'tech-2', 'Python'),
      notes: 'Machine learning framework',
      aiSuggested: false,
      confidence: 95,
    }),
    createMockRelation({
      id: 'rel-2',
      relationType: 'vendor',
      sourceSnapshot: createMockSnapshot('technology', 'tech-3', 'React'),
      targetSnapshot: createMockSnapshot('company', 'company-1', 'Meta'),
      notes: 'Meta develops React',
      aiSuggested: true,
      confidence: 85,
    }),
    createMockRelation({
      id: 'rel-3',
      relationType: 'addresses',
      sourceSnapshot: createMockSnapshot('technology', 'tech-4', 'Docker'),
      targetSnapshot: createMockSnapshot('useCase', 'uc-1', 'Container deployment'),
      notes: 'Docker enables container deployment',
      aiSuggested: true,
      confidence: 70,
    }),
  ];

  describe('Text Search', () => {
    it('should filter by search query in source name', () => {
      const result = filterRelations(relations, { searchQuery: 'tensorflow' });
      expect(result).toHaveLength(1);
      expect(result[0].sourceSnapshot.name).toBe('TensorFlow');
    });

    it('should filter by search query in target name', () => {
      const result = filterRelations(relations, { searchQuery: 'python' });
      expect(result).toHaveLength(1);
      expect(result[0].targetSnapshot.name).toBe('Python');
    });

    it('should search in notes', () => {
      const result = filterRelations(relations, { searchQuery: 'machine learning' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('rel-1');
    });

    it('should be case-insensitive', () => {
      const result = filterRelations(relations, { searchQuery: 'TENSORFLOW' });
      expect(result).toHaveLength(1);
      expect(result[0].sourceSnapshot.name).toBe('TensorFlow');
    });

    it('should return all relations when search query is empty', () => {
      const result = filterRelations(relations, { searchQuery: '' });
      expect(result).toHaveLength(3);
    });
  });

  describe('Relation Type Filtering', () => {
    it('should filter by single relation type', () => {
      const result = filterRelations(relations, { relationType: ['vendor'] });
      expect(result).toHaveLength(1);
      expect(result[0].relationType).toBe('vendor');
    });

    it('should filter by multiple relation types', () => {
      const result = filterRelations(relations, { relationType: ['uses', 'addresses'] });
      expect(result).toHaveLength(2);
      expect(result.some((r) => r.relationType === 'uses')).toBe(true);
      expect(result.some((r) => r.relationType === 'addresses')).toBe(true);
    });

    it('should return all relations when relation type array is empty', () => {
      const result = filterRelations(relations, { relationType: [] });
      expect(result).toHaveLength(3);
    });
  });

  describe('Entity Type Filtering', () => {
    it('should filter by source type', () => {
      const result = filterRelations(relations, { sourceType: ['technology'] });
      expect(result).toHaveLength(3);
    });

    it('should filter by target type - company', () => {
      const result = filterRelations(relations, { targetType: ['company'] });
      expect(result).toHaveLength(1);
      expect(result[0].targetSnapshot.type).toBe('company');
    });

    it('should filter by target type - useCase', () => {
      const result = filterRelations(relations, { targetType: ['useCase'] });
      expect(result).toHaveLength(1);
      expect(result[0].targetSnapshot.type).toBe('useCase');
    });

    it('should filter by multiple target types', () => {
      const result = filterRelations(relations, { targetType: ['company', 'useCase'] });
      expect(result).toHaveLength(2);
    });
  });

  describe('Entity ID Filtering', () => {
    it('should filter by source ID', () => {
      const result = filterRelations(relations, { sourceId: 'tech-1' });
      expect(result).toHaveLength(1);
      expect(result[0].sourceSnapshot.id).toBe('tech-1');
    });

    it('should filter by target ID', () => {
      const result = filterRelations(relations, { targetId: 'company-1' });
      expect(result).toHaveLength(1);
      expect(result[0].targetSnapshot.id).toBe('company-1');
    });

    it('should return empty array for non-existent source ID', () => {
      const result = filterRelations(relations, { sourceId: 'nonexistent' });
      expect(result).toHaveLength(0);
    });
  });

  describe('AI Suggestion Filtering', () => {
    it('should filter by AI-suggested only', () => {
      const result = filterRelations(relations, { aiSuggestedOnly: true });
      expect(result).toHaveLength(2);
      expect(result.every((r) => r.aiSuggested === true)).toBe(true);
    });

    it('should include non-AI-suggested when flag is false', () => {
      const result = filterRelations(relations, { aiSuggestedOnly: false });
      expect(result).toHaveLength(3);
    });
  });

  describe('Confidence Filtering', () => {
    it('should filter by minimum confidence', () => {
      const result = filterRelations(relations, { minConfidence: 90 });
      expect(result).toHaveLength(1);
      expect(result[0].confidence).toBe(95);
    });

    it('should include relations at exact confidence threshold', () => {
      const result = filterRelations(relations, { minConfidence: 85 });
      expect(result).toHaveLength(2);
    });

    it('should return all relations when minConfidence is 0', () => {
      const result = filterRelations(relations, { minConfidence: 0 });
      expect(result).toHaveLength(3);
    });
  });

  describe('Combined Filters', () => {
    it('should combine AI-suggested and confidence filters', () => {
      const result = filterRelations(relations, {
        aiSuggestedOnly: true,
        minConfidence: 80,
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('rel-2');
    });

    it('should combine search and relation type filters', () => {
      const result = filterRelations(relations, {
        searchQuery: 'meta',
        relationType: ['vendor'],
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('rel-2');
    });

    it('should combine source and target type filters', () => {
      const result = filterRelations(relations, {
        sourceType: ['technology'],
        targetType: ['company'],
      });
      expect(result).toHaveLength(1);
      expect(result[0].targetSnapshot.type).toBe('company');
    });

    it('should return all relations when no filters applied', () => {
      const result = filterRelations(relations, {});
      expect(result).toHaveLength(3);
    });
  });

  describe('Edge Cases', () => {
    it('should handle relations with undefined notes', () => {
      const relationsWithUndefinedNotes = [createMockRelation({ id: 'rel-no-notes', notes: undefined })];
      const result = filterRelations(relationsWithUndefinedNotes, { searchQuery: 'test' });
      expect(result).toHaveLength(0);
    });

    it('should handle relations with undefined confidence', () => {
      const relationsWithUndefinedConfidence = [createMockRelation({ id: 'rel-no-conf', confidence: undefined })];
      const result = filterRelations(relationsWithUndefinedConfidence, { minConfidence: 50 });
      expect(result).toHaveLength(0);
    });

    it('should handle empty relations array', () => {
      const result = filterRelations([], { searchQuery: 'test' });
      expect(result).toHaveLength(0);
    });

    it('should preserve original array (immutable)', () => {
      const original = [...relations];
      filterRelations(relations, { searchQuery: 'tensorflow' });
      expect(relations).toHaveLength(original.length);
    });
  });
});

// ============================================================================
// DEDUPLICATION LOGIC TESTS
// ============================================================================

describe('Relations Module - Deduplication Logic', () => {
  const DIRECTIONAL_RELATION_TYPES: RelationType[] = [
    'uses',
    'enables',
    'vendor',
    'user',
    'addresses',
    'requires',
    'aligns_with',
    'supports',
    'owned_by',
    'sponsors',
    'funds',
    'solves',
    'impacts',
    'drives',
  ];

  describe('Symmetric Relation Detection', () => {
    it('should identify competes_with as symmetric', () => {
      expect(isSymmetricRelationType('competes_with')).toBe(true);
    });

    it('should identify partner as symmetric', () => {
      expect(isSymmetricRelationType('partner')).toBe(true);
    });

    it('should identify competitor as symmetric', () => {
      expect(isSymmetricRelationType('competitor')).toBe(true);
    });

    it('should identify uses as directional', () => {
      expect(isSymmetricRelationType('uses')).toBe(false);
    });

    it('should identify vendor as directional', () => {
      expect(isSymmetricRelationType('vendor')).toBe(false);
    });

    it('should identify enables as directional', () => {
      expect(isSymmetricRelationType('enables')).toBe(false);
    });

    it('should identify all directional types correctly', () => {
      DIRECTIONAL_RELATION_TYPES.forEach((relType) => {
        expect(isSymmetricRelationType(relType)).toBe(false);
      });
    });

    it('should identify all symmetric types correctly', () => {
      SYMMETRIC_RELATION_TYPES.forEach((relType) => {
        expect(isSymmetricRelationType(relType)).toBe(true);
      });
    });
  });

  describe('Duplicate Detection Logic', () => {
    function wouldBeDuplicate(
      existingRelations: Array<{
        sourceId: string;
        targetId: string;
        relationType: RelationType;
      }>,
      newSourceId: string,
      newTargetId: string,
      newRelationType: RelationType
    ): boolean {
      const isSymmetric = isSymmetricRelationType(newRelationType);
      const forwardMatch = existingRelations.some(
        (r) => r.sourceId === newSourceId && r.targetId === newTargetId && r.relationType === newRelationType
      );
      if (forwardMatch) return true;
      if (isSymmetric) {
        const reverseMatch = existingRelations.some(
          (r) => r.sourceId === newTargetId && r.targetId === newSourceId && r.relationType === newRelationType
        );
        if (reverseMatch) return true;
      }
      return false;
    }

    it('should detect exact duplicate', () => {
      const existing = [{ sourceId: 'tech-1', targetId: 'tech-2', relationType: 'uses' as RelationType }];
      expect(wouldBeDuplicate(existing, 'tech-1', 'tech-2', 'uses')).toBe(true);
    });

    it('should not detect duplicate for different types', () => {
      const existing = [{ sourceId: 'tech-1', targetId: 'tech-2', relationType: 'uses' as RelationType }];
      expect(wouldBeDuplicate(existing, 'tech-1', 'tech-2', 'enables')).toBe(false);
    });

    it('should detect reverse duplicate for symmetric types', () => {
      const existing = [{ sourceId: 'tech-1', targetId: 'tech-2', relationType: 'competes_with' as RelationType }];
      expect(wouldBeDuplicate(existing, 'tech-2', 'tech-1', 'competes_with')).toBe(true);
    });

    it('should NOT detect reverse for directional types', () => {
      const existing = [{ sourceId: 'tech-1', targetId: 'tech-2', relationType: 'uses' as RelationType }];
      expect(wouldBeDuplicate(existing, 'tech-2', 'tech-1', 'uses')).toBe(false);
    });

    it('should not find duplicate in empty array', () => {
      expect(wouldBeDuplicate([], 'tech-1', 'tech-2', 'uses')).toBe(false);
    });
  });

  describe('Self-Reference Detection', () => {
    function isSelfReference(
      sourceId: string,
      targetId: string,
      sourceType: EntityType,
      targetType: EntityType,
      sourceName: string,
      targetName: string
    ): boolean {
      const normalizedSourceName = sourceName.toLowerCase().trim();
      const normalizedTargetName = targetName.toLowerCase().trim();
      const sameType = sourceType === targetType;
      if (sourceId === targetId) return true;
      if (sameType && normalizedSourceName === normalizedTargetName) return true;
      return false;
    }

    it('should detect self-reference by identical IDs', () => {
      expect(isSelfReference('tech-1', 'tech-1', 'technology', 'technology', 'React', 'React')).toBe(true);
    });

    it('should detect self-reference by same type and name (case-insensitive)', () => {
      expect(isSelfReference('tech-1', 'tech-2', 'technology', 'technology', 'React', 'REACT')).toBe(true);
    });

    it('should NOT detect self-reference for different entities', () => {
      expect(isSelfReference('tech-1', 'tech-2', 'technology', 'technology', 'React', 'Vue')).toBe(false);
    });

    it('should NOT detect self-reference for same name but different types', () => {
      expect(isSelfReference('tech-1', 'company-1', 'technology', 'company', 'React', 'React')).toBe(false);
    });
  });
});

// ============================================================================
// ERROR CLASSES TESTS
// ============================================================================

describe('Relations Module - Error Classes', () => {
  describe('DuplicateRelationError', () => {
    const mockRelation: Relation = createMockRelation({ id: 'rel-123' });

    it('should create error with correct message', () => {
      const error = new DuplicateRelationError(mockRelation);
      expect(error.message).toContain('TensorFlow');
      expect(error.message).toContain('Python');
      expect(error.message).toContain('uses');
      expect(error.message).toContain('already exists');
    });

    it('should have correct error name', () => {
      const error = new DuplicateRelationError(mockRelation);
      expect(error.name).toBe('DuplicateRelationError');
    });

    it('should store the existing relation', () => {
      const error = new DuplicateRelationError(mockRelation);
      expect(error.existingRelation).toBe(mockRelation);
      expect(error.existingRelation.id).toBe('rel-123');
    });

    it('should be instanceof Error', () => {
      const error = new DuplicateRelationError(mockRelation);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('SelfReferenceError', () => {
    it('should create error with correct message', () => {
      const error = new SelfReferenceError('tech-123', 'TensorFlow');
      expect(error.message).toContain('TensorFlow');
      expect(error.message).toContain('tech-123');
      expect(error.message).toContain('self-referencing');
    });

    it('should have correct error name', () => {
      const error = new SelfReferenceError('tech-123', 'TensorFlow');
      expect(error.name).toBe('SelfReferenceError');
    });

    it('should store entity ID and name', () => {
      const error = new SelfReferenceError('tech-123', 'TensorFlow');
      expect(error.entityId).toBe('tech-123');
      expect(error.entityName).toBe('TensorFlow');
    });

    it('should be instanceof Error', () => {
      const error = new SelfReferenceError('tech-123', 'TensorFlow');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('Error differentiation', () => {
    it('should distinguish DuplicateRelationError from SelfReferenceError', () => {
      const dupError = new DuplicateRelationError(createMockRelation());
      const selfError = new SelfReferenceError('tech-1', 'React');
      expect(dupError).toBeInstanceOf(DuplicateRelationError);
      expect(dupError).not.toBeInstanceOf(SelfReferenceError);
      expect(selfError).toBeInstanceOf(SelfReferenceError);
      expect(selfError).not.toBeInstanceOf(DuplicateRelationError);
    });
  });
});

// ============================================================================
// FIRESTORE CRUD TESTS
// ============================================================================

describe('Relations Module - Firestore CRUD', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getRelations()', () => {
    it('should fetch all relations from Firestore', async () => {
      const mockRelations = [createMockRelation({ id: 'rel-1' }), createMockRelation({ id: 'rel-2' })];
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot(mockRelations));

      const result = await getRelations();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('rel-1');
      expect(result[1].id).toBe('rel-2');
      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no relations exist', async () => {
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));

      const result = await getRelations();

      expect(result).toHaveLength(0);
    });

    it('should propagate Firestore errors', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getRelations()).rejects.toThrow('Firestore error');
    });
  });

  describe('getRelationById()', () => {
    it('should fetch a relation by ID', async () => {
      const mockRel = createMockRelation({ id: 'rel-test' });
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => mockRel,
      });

      const result = await getRelationById('rel-test');

      expect(result).toEqual(mockRel);
      expect(result?.id).toBe('rel-test');
    });

    it('should return null when relation does not exist', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => false,
        data: () => null,
      });

      const result = await getRelationById('nonexistent');

      expect(result).toBeNull();
    });

    it('should propagate Firestore errors', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getRelationById('rel-test')).rejects.toThrow('Firestore error');
    });
  });

  describe('checkDuplicateRelation()', () => {
    it('should return existing relation for forward match', async () => {
      const existing = createMockRelation({ id: 'rel-existing' });
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([existing]));

      const result = await checkDuplicateRelation('tech-1', 'tech-2', 'uses');

      expect(result).toEqual(existing);
    });

    it('should return null when no duplicate found for directional type', async () => {
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));

      const result = await checkDuplicateRelation('tech-1', 'tech-2', 'uses');

      expect(result).toBeNull();
    });

    it('should check reverse direction for symmetric types', async () => {
      // Forward: empty
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));
      // Reverse: found
      const existing = createMockRelation({ id: 'rel-reverse', relationType: 'competes_with' });
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([existing]));

      const result = await checkDuplicateRelation('tech-2', 'tech-1', 'competes_with');

      expect(result).toEqual(existing);
      expect(mockGetDocs).toHaveBeenCalledTimes(2);
    });

    it.each(['parallels', 'complements', 'conflicts_with'] as const)(
      'checks the reverse direction for newly aligned %s relations',
      async (relationType) => {
        const existing = createMockRelation({ id: `rel-${relationType}`, relationType });
        mockGetDocs
          .mockResolvedValueOnce(createMockQuerySnapshot([]))
          .mockResolvedValueOnce(createMockQuerySnapshot([existing]));

        await expect(checkDuplicateRelation('entity-a', 'entity-b', relationType)).resolves.toEqual(existing);
        expect(mockGetDocs).toHaveBeenCalledTimes(2);
      }
    );

    it('should not check reverse for directional types', async () => {
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));

      const result = await checkDuplicateRelation('tech-1', 'tech-2', 'uses');

      expect(result).toBeNull();
      // Only one call (forward), no reverse check for directional types
      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should return null for symmetric type when no match in either direction', async () => {
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));

      const result = await checkDuplicateRelation('tech-1', 'tech-2', 'partner');

      expect(result).toBeNull();
      expect(mockGetDocs).toHaveBeenCalledTimes(2);
    });
  });

  describe('createRelation()', () => {
    const validRelationData = {
      relationType: 'uses' as RelationType,
      sourceSnapshot: createMockSnapshot('technology', 'tech-1', 'TensorFlow'),
      targetSnapshot: createMockSnapshot('technology', 'tech-2', 'Python'),
      notes: 'Uses Python',
      confidence: 90,
      aiSuggested: false,
    };

    it('rejects a noncanonical type before any Firestore read or write', async () => {
      await expect(
        createRelation({ ...validRelationData, relationType: 'provides' } as never)
      ).rejects.toThrow('Invalid relationType');

      expect(mockGetDocs).not.toHaveBeenCalled();
      expect(mockRunTransaction).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('should create a new relation successfully', async () => {
      // checkDuplicateRelation fast path: no forward match
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));
      // Transactional triple lock is the authority: no lock exists yet.
      const { txSet } = mockTripleLockTransaction({ lockExists: false });

      const result = await createRelation(validRelationData);

      expect(result.id).toBeDefined();
      expect(result.id).toMatch(/^rel-/);
      expect(result.relationType).toBe('uses');
      expect(result.sourceSnapshot.name).toBe('TensorFlow');
      expect(result.targetSnapshot.name).toBe('Python');
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(isCorrelationId(result.sourceCorrelationId)).toBe(true);
      expect(result.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
      // Both the lock doc and the relation doc are set inside the transaction.
      expect(txSet).toHaveBeenCalledTimes(2);
      expect(txSet).toHaveBeenCalledWith(
        'mock-doc-ref',
        expect.objectContaining({
          id: result.id,
          sourceCorrelationId: result.sourceCorrelationId,
          sourceFingerprint: result.sourceFingerprint,
        })
      );
      expect(mockInngestSend).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            correlationId: result.sourceCorrelationId,
            sourceFingerprint: result.sourceFingerprint,
          }),
        })
      );
      expect(mockSetDoc).not.toHaveBeenCalled();
    });

    it('should throw SelfReferenceError for same source and target ID', async () => {
      const selfRefData = {
        ...validRelationData,
        sourceSnapshot: createMockSnapshot('technology', 'tech-same', 'React'),
        targetSnapshot: createMockSnapshot('technology', 'tech-same', 'React'),
      };

      // Idempotency guard runs first: no existing duplicate found
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));

      await expect(createRelation(selfRefData)).rejects.toThrow(SelfReferenceError);
    });

    it('should throw SelfReferenceError for same type and name', async () => {
      const selfRefData = {
        ...validRelationData,
        sourceSnapshot: createMockSnapshot('technology', 'tech-1', 'React'),
        targetSnapshot: createMockSnapshot('technology', 'tech-2', 'react'),
      };

      // Idempotency guard runs first: no existing duplicate found
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));

      await expect(createRelation(selfRefData)).rejects.toThrow(SelfReferenceError);
    });

    it('should NOT throw SelfReferenceError for same name but different types', async () => {
      const diffTypeData = {
        ...validRelationData,
        sourceSnapshot: createMockSnapshot('technology', 'tech-1', 'React'),
        targetSnapshot: createMockSnapshot('company', 'company-1', 'React'),
      };

      // checkDuplicateRelation fast path: no forward match
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));
      mockTripleLockTransaction({ lockExists: false });

      const result = await createRelation(diffTypeData);
      expect(result).toBeDefined();
    });

    it('transactionally refreshes the source version when a duplicate exists', async () => {
      const queriedExisting = createMockRelation({
        id: 'rel-existing',
        sourceSnapshot: createMockSnapshot('technology', 'tech-1', 'TensorFlow'),
        targetSnapshot: createMockSnapshot('technology', 'tech-2', 'Python'),
        sourceCorrelationId: 'corr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sourceFingerprint: 'a'.repeat(64),
      });
      const transactionCurrent = createMockRelation({
        ...queriedExisting,
        notes: 'concurrent committed note',
        confidence: 72,
        sourceCorrelationId: 'corr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        sourceFingerprint: 'b'.repeat(64),
        updatedAt: queriedExisting.updatedAt + 1,
      });
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([queriedExisting]));
      const { txUpdate } = mockMetadataUpdateTransaction(transactionCurrent);

      const result = await createRelation(validRelationData);

      expect(result.id).toBe('rel-existing');
      expect(result.notes).toBe(transactionCurrent.notes);
      expect(result.confidence).toBe(transactionCurrent.confidence);
      expect(isCorrelationId(result.sourceCorrelationId)).toBe(true);
      expect(result.sourceCorrelationId).not.toBe(transactionCurrent.sourceCorrelationId);
      expect(result.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(result.sourceFingerprint).not.toBe(transactionCurrent.sourceFingerprint);
      expect(result.sourceFingerprint).toBe(relationProjectionFingerprint(result));
      expect(txUpdate).toHaveBeenCalledWith(
        'mock-doc-ref',
        expect.objectContaining({
          sourceCorrelationId: result.sourceCorrelationId,
          sourceFingerprint: result.sourceFingerprint,
        })
      );
      expect(mockSetDoc).not.toHaveBeenCalled();
      expect(mockInngestSend).toHaveBeenCalledTimes(1);
      expect(mockInngestSend).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/relation.sync.requested',
          data: expect.objectContaining({
            operation: 'update',
            relationId: 'rel-existing',
            correlationId: result.sourceCorrelationId,
            sourceFingerprint: result.sourceFingerprint,
            notes: transactionCurrent.notes,
            confidence: transactionCurrent.confidence,
          }),
        })
      );
    });

    it('surfaces an unacknowledged create after commit and converges on idempotent retry', async () => {
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));
      const { txSet } = mockTripleLockTransaction({ lockExists: false });
      mockInngestSend.mockResolvedValueOnce({ ids: [] });

      await expect(createRelation(validRelationData)).rejects.toBeInstanceOf(RelationSyncDispatchError);
      expect(txSet).toHaveBeenCalledTimes(2);

      const committed = txSet.mock.calls
        .map(([, value]) => value as Relation)
        .find((value) => value.id?.startsWith('rel-'))!;
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([committed]));
      const { txUpdate } = mockMetadataUpdateTransaction(committed);
      const result = await createRelation(validRelationData);

      expect(result.id).toBe(committed.id);
      expect(isCorrelationId(result.sourceCorrelationId)).toBe(true);
      expect(result.sourceCorrelationId).not.toBe(committed.sourceCorrelationId);
      expect(result.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(result.sourceFingerprint).toBe(relationProjectionFingerprint(result));
      expect(txUpdate).toHaveBeenCalledWith(
        'mock-doc-ref',
        expect.objectContaining({
          sourceCorrelationId: result.sourceCorrelationId,
          sourceFingerprint: result.sourceFingerprint,
        })
      );
      expect(mockInngestSend).toHaveBeenCalledTimes(2);
      expect(mockInngestSend).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            operation: 'update',
            relationId: committed.id,
            correlationId: result.sourceCorrelationId,
            sourceFingerprint: result.sourceFingerprint,
          }),
        })
      );
    });

    it('concurrent identical creates: second transaction sees the lock and throws DuplicateRelationError with the existing relation', async () => {
      const existing = createMockRelation({
        id: 'rel-race-winner',
        sourceSnapshot: createMockSnapshot('technology', 'tech-1', 'TensorFlow'),
        targetSnapshot: createMockSnapshot('technology', 'tech-2', 'Python'),
      });

      // Fast-path query missed it (classic TOCTOU: both callers' queries ran
      // before either write landed).
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));
      // But by the time THIS transaction runs, a concurrent transaction has
      // already committed the lock + the relation it points to.
      mockTripleLockTransaction({
        lockExists: true,
        lockData: { relationId: 'rel-race-winner' },
        relationExists: true,
        relationData: existing,
      });

      await expect(createRelation(validRelationData)).rejects.toThrow(DuplicateRelationError);

      // Re-run to inspect the error's existingRelation (rejects.toThrow doesn't
      // hand back the rejected value).
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));
      mockTripleLockTransaction({
        lockExists: true,
        lockData: { relationId: 'rel-race-winner' },
        relationExists: true,
        relationData: existing,
      });
      try {
        await createRelation(validRelationData);
        throw new Error('expected createRelation to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(DuplicateRelationError);
        expect((error as InstanceType<typeof DuplicateRelationError>).existingRelation).toEqual(existing);
      }
    });

    it('rejects a concurrent reverse create held by a legacy lock for a newly symmetric type', async () => {
      const input = {
        ...validRelationData,
        relationType: 'parallels' as const,
        sourceSnapshot: createMockSnapshot('signal', 'signal-a', 'Signal A'),
        targetSnapshot: createMockSnapshot('signal', 'signal-b', 'Signal B'),
      };
      const existing = createMockRelation({
        id: 'rel-legacy-reverse',
        relationType: 'parallels',
        sourceSnapshot: input.targetSnapshot,
        targetSnapshot: input.sourceSnapshot,
      });
      mockGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshot([]))
        .mockResolvedValueOnce(createMockQuerySnapshot([]));
      const txGet = jest
        .fn()
        .mockResolvedValueOnce({ exists: () => false })
        .mockResolvedValueOnce({ exists: () => false })
        .mockResolvedValueOnce({
          exists: () => true,
          data: () => ({ relationId: existing.id }),
        })
        .mockResolvedValueOnce({ exists: () => true, data: () => existing });
      const txSet = jest.fn();
      mockRunTransaction.mockImplementationOnce(
        async (
          _db: unknown,
          fn: (tx: { get: typeof txGet; set: typeof txSet }) => unknown
        ) => fn({ get: txGet, set: txSet })
      );

      await expect(createRelation(input)).rejects.toBeInstanceOf(DuplicateRelationError);
      expect(txSet).not.toHaveBeenCalled();
    });

    it('lock takeover: stale lock for a deleted relation does not block re-creation', async () => {
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));
      // The lock doc exists but the relation it points to was deleted since —
      // this must NOT throw; the transaction takes over the stale lock.
      const { txSet } = mockTripleLockTransaction({
        lockExists: true,
        lockData: { relationId: 'rel-deleted-since' },
        relationExists: false,
      });

      const result = await createRelation(validRelationData);

      expect(result.id).toBeDefined();
      expect(result.id).not.toBe('rel-deleted-since');
      // Takeover re-sets both the lock (now pointing at the new id) and the
      // new relation doc.
      expect(txSet).toHaveBeenCalledTimes(2);
    });
  });

  describe('createRelationFromIds()', () => {
    it('rejects a noncanonical type before fetching either endpoint', async () => {
      await expect(
        createRelationFromIds({
          sourceId: 'company-1',
          sourceType: 'company',
          targetId: 'tech-1',
          targetType: 'technology',
          relationType: 'provides',
        } as never)
      ).rejects.toThrow('Invalid relationType');

      expect(mockGetDoc).not.toHaveBeenCalled();
      expect(mockGetDocs).not.toHaveBeenCalled();
      expect(mockRunTransaction).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  describe('updateRelation()', () => {
    it('rejects a noncanonical type before reading the relation', async () => {
      await expect(updateRelation('rel-update', { relationType: 'built_by' } as never)).rejects.toThrow(
        'Invalid relationType'
      );

      expect(mockGetDoc).not.toHaveBeenCalled();
      expect(mockRunTransaction).not.toHaveBeenCalled();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('should update an existing relation', async () => {
      const existing = createMockRelation({ id: 'rel-update' });
      const { txUpdate } = mockMetadataUpdateTransaction(existing);

      const result = await updateRelation('rel-update', { notes: 'Updated' });

      expect(result.notes).toBe('Updated');
      expect(txUpdate).toHaveBeenCalledTimes(1);
      expect(isCorrelationId(result.sourceCorrelationId)).toBe(true);
      expect(result.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(txUpdate).toHaveBeenCalledWith(
        'mock-doc-ref',
        expect.objectContaining({
          sourceCorrelationId: result.sourceCorrelationId,
          sourceFingerprint: result.sourceFingerprint,
        })
      );
      expect(mockInngestSend).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            correlationId: result.sourceCorrelationId,
            sourceFingerprint: result.sourceFingerprint,
          }),
        })
      );
    });

    it('fingerprints the authoritative transaction state and ignores caller-owned source metadata', async () => {
      const existing = createMockRelation({ id: 'rel-concurrent', notes: 'concurrent committed note' });
      const { txUpdate } = mockMetadataUpdateTransaction(existing);

      const result = await updateRelation(
        existing.id,
        {
          confidence: 72,
          sourceCorrelationId: 'corr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          sourceFingerprint: 'a'.repeat(64),
        } as never
      );

      expect(result.notes).toBe('concurrent committed note');
      expect(result.sourceCorrelationId).not.toBe('corr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      expect(result.sourceFingerprint).toBe(relationProjectionFingerprint(result));
      expect(txUpdate).toHaveBeenCalledWith(
        'mock-doc-ref',
        expect.objectContaining({
          confidence: 72,
          sourceCorrelationId: result.sourceCorrelationId,
          sourceFingerprint: result.sourceFingerprint,
        })
      );
    });

    it('surfaces an unacknowledged update after commit and converges on retry', async () => {
      const existing = createMockRelation({ id: 'rel-client-update-retry' });
      const firstTransaction = mockMetadataUpdateTransaction(existing);
      mockInngestSend.mockResolvedValueOnce({ ids: [] });

      await expect(updateRelation(existing.id, { notes: 'first write' })).rejects.toBeInstanceOf(
        RelationSyncDispatchError
      );
      expect(firstTransaction.txUpdate).toHaveBeenCalledTimes(1);

      const secondTransaction = mockMetadataUpdateTransaction({
        ...existing,
        notes: 'first write',
        updatedAt: 2,
      });
      await expect(updateRelation(existing.id, { notes: 'first write' })).resolves.toMatchObject({
        id: existing.id,
        notes: 'first write',
      });
      expect(secondTransaction.txUpdate).toHaveBeenCalledTimes(1);
      expect(mockInngestSend).toHaveBeenCalledTimes(2);
    });

    it('should throw when relation not found', async () => {
      mockMetadataUpdateTransaction(null);

      await expect(updateRelation('nonexistent', { notes: 'test' })).rejects.toThrow(
        'Relation with id nonexistent not found'
      );
    });

    it('should include updatedAt timestamp in updates', async () => {
      const existing = createMockRelation({ id: 'rel-ts' });
      const { txUpdate } = mockMetadataUpdateTransaction(existing);

      const beforeTime = Date.now();
      await updateRelation('rel-ts', { confidence: 99 });

      const updateCall = txUpdate.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(updateCall.confidence).toBe(99);
    });

    it('atomically migrates the triple lock when topology changes', async () => {
      const existing = createMockRelation({ id: 'rel-move' });
      const nextTarget = createMockSnapshot('technology', 'tech-3', 'PyTorch');
      const { txSet, txUpdate, txDelete } = mockTripleMigrationTransaction(existing);

      const result = await updateRelation('rel-move', { targetSnapshot: nextTarget });

      expect(result.targetSnapshot).toEqual(nextTarget);
      expect(txUpdate).toHaveBeenCalledTimes(1);
      expect(txSet).toHaveBeenCalledWith(
        'mock-doc-ref',
        expect.objectContaining({ relationId: 'rel-move', targetId: 'tech-3', relationType: 'uses' })
      );
      expect(txDelete).toHaveBeenCalledTimes(1);
      expect(mockUpdateDoc).not.toHaveBeenCalled();
    });

    it('rejects a topology collision with an existing relation that has no lock', async () => {
      const existing = createMockRelation({ id: 'rel-unlocked-move' });
      const duplicate = createMockRelation({
        id: 'rel-unlocked-existing',
        targetSnapshot: createMockSnapshot('technology', 'tech-3', 'PyTorch'),
      });
      const { txSet, txUpdate, txDelete } = mockTripleMigrationTransaction(existing, {
        queryDuplicates: [duplicate],
        oldLockExists: false,
        newLockExists: false,
      });

      await expect(
        updateRelation(existing.id, { targetSnapshot: duplicate.targetSnapshot })
      ).rejects.toBeInstanceOf(DuplicateRelationError);

      expect(txUpdate).not.toHaveBeenCalled();
      expect(txSet).not.toHaveBeenCalled();
      expect(txDelete).not.toHaveBeenCalled();
    });

    it('fails a colliding topology edit without writing the relation or either lock', async () => {
      const existing = createMockRelation({ id: 'rel-move' });
      const duplicate = createMockRelation({ id: 'rel-winner', targetSnapshot: createMockSnapshot('technology', 'tech-3', 'PyTorch') });
      const nextTarget = duplicate.targetSnapshot;
      const { txSet, txUpdate, txDelete } = mockTripleMigrationTransaction(existing, {
        newLockExists: true,
        newLockOwner: duplicate.id,
        duplicateRelation: duplicate,
      });

      await expect(updateRelation('rel-move', { targetSnapshot: nextTarget })).rejects.toBeInstanceOf(
        DuplicateRelationError
      );

      expect(txUpdate).not.toHaveBeenCalled();
      expect(txSet).not.toHaveBeenCalled();
      expect(txDelete).not.toHaveBeenCalled();
      expect(mockUpdateDoc).not.toHaveBeenCalled();
    });
  });

  describe('updateSourceSnapshot()', () => {
    it('should delegate to updateRelation with sourceSnapshot', async () => {
      const existing = createMockRelation({ id: 'rel-src' });
      const newSnapshot = createMockSnapshot('technology', 'tech-new', 'NewTech');

      const { txUpdate } = mockTripleMigrationTransaction(existing);

      await updateSourceSnapshot('rel-src', newSnapshot);

      expect(txUpdate).toHaveBeenCalledTimes(1);
      const updateCall = txUpdate.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.sourceSnapshot).toEqual(newSnapshot);
    });
  });

  describe('updateTargetSnapshot()', () => {
    it('should delegate to updateRelation with targetSnapshot', async () => {
      const existing = createMockRelation({ id: 'rel-tgt' });
      const newSnapshot = createMockSnapshot('company', 'comp-new', 'NewCo');

      const { txUpdate } = mockTripleMigrationTransaction(existing);

      await updateTargetSnapshot('rel-tgt', newSnapshot);

      expect(txUpdate).toHaveBeenCalledTimes(1);
      const updateCall = txUpdate.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.targetSnapshot).toEqual(newSnapshot);
    });
  });

  describe('deleteRelation()', () => {
    it('should delete a relation by ID', async () => {
      const { txDelete } = mockRelationDeleteTransaction([createMockRelation({ id: 'rel-delete' })]);

      await deleteRelation('rel-delete');

      expect(txDelete).toHaveBeenCalledTimes(1);
    });

    it('stores and dispatches one correlation ID for durable delete replay', async () => {
      const { txSet } = mockRelationDeleteTransaction([createMockRelation({ id: 'rel-correlated-delete' })]);

      await deleteRelation('rel-correlated-delete');

      const deleteEvent = mockInngestSend.mock.calls
        .map(([event]) => event)
        .find((event) => event?.name === 'app/relation.sync.requested' && event.data?.operation === 'delete');
      const correlationId = deleteEvent?.data?.correlationId;
      expect(isCorrelationId(correlationId)).toBe(true);
      expect(txSet).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ correlationId })
      );
    });

    it('should propagate Firestore errors', async () => {
      mockRunTransaction.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(deleteRelation('rel-delete')).rejects.toThrow('Firestore error');
    });

    it('atomically deletes the relation and its owned triple lock', async () => {
      const existing = createMockRelation({
        id: 'rel-lock-cleanup',
        relationType: 'uses',
        sourceSnapshot: createMockSnapshot('technology', 'tech-1', 'TensorFlow'),
        targetSnapshot: createMockSnapshot('technology', 'tech-2', 'Python'),
      });
      const key = buildRelationTripleLockKeyCandidates('tech-1', 'tech-2', 'uses')[0];
      const { txDelete } = mockRelationDeleteTransaction([existing], { [key]: existing.id });

      await deleteRelation('rel-lock-cleanup');

      // One delete for the relation doc, one for the triple lock doc.
      expect(txDelete).toHaveBeenCalledTimes(2);
    });

    it('atomically removes both owned v2 and legacy locks during cutover', async () => {
      const existing = createMockRelation({ id: 'rel-cutover-delete' });
      const [currentKey, legacyKey] = buildRelationTripleLockKeyCandidates(
        existing.sourceSnapshot.id,
        existing.targetSnapshot.id,
        existing.relationType
      );
      const { txDelete } = mockRelationDeleteTransaction([existing], {
        [currentKey]: existing.id,
        [legacyKey]: existing.id,
      });

      await deleteRelation(existing.id);

      expect(txDelete).toHaveBeenCalledTimes(3);
    });

    it('does not delete a lock that has since been taken over by a different relation', async () => {
      const existing = createMockRelation({
        id: 'rel-old-owner',
        relationType: 'uses',
        sourceSnapshot: createMockSnapshot('technology', 'tech-1', 'TensorFlow'),
        targetSnapshot: createMockSnapshot('technology', 'tech-2', 'Python'),
      });
      const { txDelete } = mockRelationDeleteTransaction([existing], {
        [buildRelationTripleLockKeyCandidates('tech-1', 'tech-2', 'uses')[0]]: 'rel-new-owner',
      });

      await deleteRelation('rel-old-owner');

      expect(txDelete).toHaveBeenCalledTimes(1);
    });

    it('does not partially delete the relation when the transactional read fails', async () => {
      mockRunTransaction.mockRejectedValueOnce(new Error('transient read failure'));

      await expect(deleteRelation('rel-lookup-fails')).rejects.toThrow('transient read failure');
    });

    it('surfaces an unacknowledged delete while its durable marker owns graph retry', async () => {
      const existing = createMockRelation({ id: 'rel-client-delete-retry' });
      const { txDelete } = mockRelationDeleteTransaction([existing]);
      mockInngestSend.mockRejectedValueOnce(new Error('Inngest unavailable'));

      await expect(deleteRelation(existing.id)).rejects.toBeInstanceOf(RelationSyncDispatchError);
      expect(txDelete).toHaveBeenCalledTimes(1);

      mockRunTransaction.mockResolvedValueOnce([]);
      await expect(deleteRelation(existing.id)).resolves.toBeUndefined();
      expect(mockInngestSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteRelationBetween()', () => {
    it('should find and delete matching relation', async () => {
      const existing = createMockRelation({ id: 'rel-between' });
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([existing]));
      const { txDelete } = mockRelationDeleteTransaction([existing]);

      const result = await deleteRelationBetween('tech-1', 'tech-2', 'uses');

      expect(result).toBe('rel-between');
      expect(txDelete).toHaveBeenCalledTimes(1);
    });

    it('should return null when no matching relation found', async () => {
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));

      const result = await deleteRelationBetween('tech-1', 'tech-2', 'uses');

      expect(result).toBeNull();
      expect(mockRunTransaction).not.toHaveBeenCalled();
    });
  });

  describe('deleteRelationsForEntity()', () => {
    it('should delete all relations for an entity (source and target)', async () => {
      const sourceRels = [createMockRelation({ id: 'rel-s1' })];
      const targetRels = [createMockRelation({ id: 'rel-t1' })];

      mockGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshot(sourceRels))
        .mockResolvedValueOnce(createMockQuerySnapshot(targetRels));
      const { txDelete } = mockRelationDeleteTransaction([...sourceRels, ...targetRels]);

      const result = await deleteRelationsForEntity('entity-1');

      expect(result).toBe(2);
      expect(txDelete).toHaveBeenCalledTimes(2);
    });

    it('should return 0 when no relations exist for entity', async () => {
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([])).mockResolvedValueOnce(createMockQuerySnapshot([]));

      const result = await deleteRelationsForEntity('entity-1');

      expect(result).toBe(0);
      expect(mockRunTransaction).not.toHaveBeenCalled();
    });

    it('should deduplicate self-referential relations', async () => {
      const selfRef = createMockRelation({ id: 'rel-self' });
      // Same relation appears in both source and target queries
      mockGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshot([selfRef]))
        .mockResolvedValueOnce(createMockQuerySnapshot([selfRef]));
      const { txDelete } = mockRelationDeleteTransaction([selfRef]);

      const result = await deleteRelationsForEntity('entity-1');

      // Should deduplicate to 1
      expect(result).toBe(1);
      expect(txDelete).toHaveBeenCalledTimes(1);
    });

    // B2 — the batch cascade deleted Firestore docs but emitted NO Neo4j delete
    // sync, so the typed edge + any reified :Assertion/:Evidence orphaned. The
    // singular deleteRelation() emits `app/relation.sync.requested`{delete};
    // the bulk path must emit one per deleted relation too.
    it('emits a Neo4j delete sync for every relation it deletes', async () => {
      const { inngest } = jest.requireMock('@/lib/inngest/client');
      const mockSend = inngest.send as jest.Mock;

      mockGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshot([createMockRelation({ id: 'rel-s1' })]))
        .mockResolvedValueOnce(createMockQuerySnapshot([createMockRelation({ id: 'rel-t1' })]));
      mockRelationDeleteTransaction([
        createMockRelation({ id: 'rel-s1' }),
        createMockRelation({ id: 'rel-t1' }),
      ]);

      await deleteRelationsForEntity('entity-1');

      const deletedIds = mockSend.mock.calls
        .map(([evt]: [{ name: string; data: { operation: string; relationId: string } }]) => evt)
        .filter(
          (evt: { name: string; data: { operation: string } }) =>
            evt.name === 'app/relation.sync.requested' && evt.data.operation === 'delete'
        )
        .map((evt: { data: { relationId: string } }) => evt.data.relationId);

      expect(deletedIds).toEqual(expect.arrayContaining(['rel-s1', 'rel-t1']));
      const correlationIds = mockSend.mock.calls
        .map(([event]) => event)
        .filter(
          (event) => event?.name === 'app/relation.sync.requested' && event.data?.operation === 'delete'
        )
        .map((event) => event.data.correlationId);
      expect(correlationIds.every(isCorrelationId)).toBe(true);
      expect(new Set(correlationIds).size).toBe(1);
    });

    it('does not emit sync events when there is nothing to delete', async () => {
      const { inngest } = jest.requireMock('@/lib/inngest/client');
      const mockSend = inngest.send as jest.Mock;

      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([])).mockResolvedValueOnce(createMockQuerySnapshot([]));

      await deleteRelationsForEntity('entity-1');

      const relationEvents = mockSend.mock.calls.filter(
        ([evt]: [{ name: string }]) => evt?.name === 'app/relation.sync.requested'
      );
      expect(relationEvents).toHaveLength(0);
    });
  });
});

// ============================================================================
// QUERY TESTS
// ============================================================================

describe('Relations Module - Query Operations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getRelationsBySource()', () => {
    it('should fetch relations by source ID', async () => {
      const rels = [createMockRelation({ id: 'rel-src-1' })];
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot(rels));

      const result = await getRelationsBySource('tech-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('rel-src-1');
    });

    it('should return empty array when no source relations', async () => {
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));

      const result = await getRelationsBySource('nonexistent');

      expect(result).toHaveLength(0);
    });
  });

  describe('getRelationsByTarget()', () => {
    it('should fetch relations by target ID', async () => {
      const rels = [createMockRelation({ id: 'rel-tgt-1' })];
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot(rels));

      const result = await getRelationsByTarget('tech-2');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('rel-tgt-1');
    });

    it('should return empty array when no target relations', async () => {
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));

      const result = await getRelationsByTarget('nonexistent');

      expect(result).toHaveLength(0);
    });
  });

  describe('getRelationsForEntity()', () => {
    it('should combine source and target relations', async () => {
      const srcRels = [createMockRelation({ id: 'rel-src-1' })];
      const tgtRels = [createMockRelation({ id: 'rel-tgt-1' })];
      mockGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshot(srcRels))
        .mockResolvedValueOnce(createMockQuerySnapshot(tgtRels));

      const result = await getRelationsForEntity('entity-1');

      expect(result).toHaveLength(2);
    });

    it('should deduplicate relations appearing in both source and target', async () => {
      const shared = createMockRelation({ id: 'rel-shared' });
      mockGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshot([shared]))
        .mockResolvedValueOnce(createMockQuerySnapshot([shared]));

      const result = await getRelationsForEntity('entity-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('rel-shared');
    });

    it('should return empty array when no relations', async () => {
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([])).mockResolvedValueOnce(createMockQuerySnapshot([]));

      const result = await getRelationsForEntity('entity-1');

      expect(result).toHaveLength(0);
    });
  });

  describe('getRelationsForEntities() — bulk, batched (no N+1 flood)', () => {
    const snap = (id: string) => createMockSnapshot('technology', id, id);

    it('groups relations by entity (source OR target); every id present', async () => {
      const r1 = createMockRelation({ id: 'r1', sourceSnapshot: snap('a'), targetSnapshot: snap('z') });
      const r2 = createMockRelation({ id: 'r2', sourceSnapshot: snap('b'), targetSnapshot: snap('z') });
      const r3 = createMockRelation({ id: 'r3', sourceSnapshot: snap('z'), targetSnapshot: snap('a') });
      mockGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshot([r1, r2])) // source IN [a,b]
        .mockResolvedValueOnce(createMockQuerySnapshot([r3])); //    target IN [a,b]

      const result = await getRelationsForEntities(['a', 'b']);

      expect(Object.keys(result).sort()).toEqual(['a', 'b']);
      expect(result.a.map((r) => r.id).sort()).toEqual(['r1', 'r3']); // a = source of r1, target of r3
      expect(result.b.map((r) => r.id)).toEqual(['r2']);
    });

    it('returns an empty array for every id that has no relations', async () => {
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([])).mockResolvedValueOnce(createMockQuerySnapshot([]));

      const result = await getRelationsForEntities(['x', 'y']);

      expect(result).toEqual({ x: [], y: [] });
    });

    it('dedupes a self-relation (entity is both source and target)', async () => {
      const self = createMockRelation({ id: 'self', sourceSnapshot: snap('a'), targetSnapshot: snap('a') });
      mockGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshot([self]))
        .mockResolvedValueOnce(createMockQuerySnapshot([self]));

      const result = await getRelationsForEntities(['a']);

      expect(result.a.map((r) => r.id)).toEqual(['self']);
    });

    it('short-circuits empty input without querying', async () => {
      const result = await getRelationsForEntities([]);

      expect(result).toEqual({});
      expect(mockGetDocs).not.toHaveBeenCalled();
    });

    it('batches >30 ids into bounded in-queries (not the old 2N fan-out)', async () => {
      const ids = Array.from({ length: 65 }, (_, i) => `e${i}`); // 3 batches
      mockGetDocs.mockResolvedValue(createMockQuerySnapshot([]));

      await getRelationsForEntities(ids);

      // 3 batches × (source + target) = 6 queries — NOT 130 (2 × 65)
      expect(mockGetDocs).toHaveBeenCalledTimes(6);
    });

    it.each([
      { entityCount: 814, previousQueryCount: 56 },
      { entityCount: 1085, previousQueryCount: 74 },
    ])(
      'loads $entityCount library entities with one collection query instead of $previousQueryCount batched queries',
      async ({ entityCount, previousQueryCount }) => {
        const ids = Array.from({ length: entityCount }, (_, i) => `e${i}`);
        const betweenRequested = createMockRelation({
          id: 'between-requested',
          sourceSnapshot: snap('e0'),
          targetSnapshot: snap('e1'),
        });
        const requestedTarget = createMockRelation({
          id: 'requested-target',
          sourceSnapshot: snap('outside-source'),
          targetSnapshot: snap('e2'),
        });
        const selfRelation = createMockRelation({
          id: 'self-relation',
          sourceSnapshot: snap('e3'),
          targetSnapshot: snap('e3'),
        });
        const unrelated = createMockRelation({
          id: 'unrelated',
          sourceSnapshot: snap('outside-source'),
          targetSnapshot: snap('outside-target'),
        });
        mockGetDocs.mockResolvedValueOnce(
          createMockQuerySnapshot([betweenRequested, requestedTarget, selfRelation, unrelated])
        );

        const result = await getRelationsForEntities(ids);

        expect(previousQueryCount).toBe(Math.ceil(entityCount / 30) * 2);
        expect(mockGetDocs).toHaveBeenCalledTimes(1);
        expect(result.e0.map((relation) => relation.id)).toEqual(['between-requested']);
        expect(result.e1.map((relation) => relation.id)).toEqual(['between-requested']);
        expect(result.e2.map((relation) => relation.id)).toEqual(['requested-target']);
        expect(result.e3.map((relation) => relation.id)).toEqual(['self-relation']);
        expect(result).not.toHaveProperty('outside-source');
        expect(result).not.toHaveProperty('outside-target');
      }
    );

    it('deduplicates repeated entity ids before choosing and executing batches', async () => {
      mockGetDocs.mockResolvedValue(createMockQuerySnapshot([]));

      const result = await getRelationsForEntities(Array.from({ length: 100 }, () => 'same-id'));

      expect(result).toEqual({ 'same-id': [] });
      expect(mockGetDocs).toHaveBeenCalledTimes(2);
    });
  });

  describe('getRelationsByType()', () => {
    it('should fetch relations by type', async () => {
      const rels = [
        createMockRelation({ id: 'rel-v1', relationType: 'vendor' }),
        createMockRelation({ id: 'rel-v2', relationType: 'vendor' }),
      ];
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot(rels));

      const result = await getRelationsByType('vendor');

      expect(result).toHaveLength(2);
    });
  });

  describe('getAISuggestedRelations()', () => {
    it('should fetch AI-suggested relations with default minConfidence', async () => {
      const rels = [createMockRelation({ id: 'rel-ai-1', aiSuggested: true, confidence: 80 })];
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot(rels));

      const result = await getAISuggestedRelations();

      expect(result).toHaveLength(1);
    });

    it('should accept custom minConfidence parameter', async () => {
      const rels = [createMockRelation({ id: 'rel-ai-1', aiSuggested: true, confidence: 90 })];
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot(rels));

      const result = await getAISuggestedRelations(80);

      expect(result).toHaveLength(1);
    });
  });

  describe('getStaleRelations()', () => {
    it('should find relations with stale source snapshots', async () => {
      const staleTime = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
      const staleRel = createMockRelation({
        id: 'rel-stale',
        sourceSnapshot: createMockSnapshot('technology', 'tech-1', 'OldTech', { snapshotAt: staleTime }),
        targetSnapshot: createMockSnapshot('technology', 'tech-2', 'NewTech', { snapshotAt: Date.now() }),
      });
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([staleRel]));

      const result = await getStaleRelations(30);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('rel-stale');
    });

    it('should find relations with stale target snapshots', async () => {
      const staleTime = Date.now() - 60 * 24 * 60 * 60 * 1000;
      const staleRel = createMockRelation({
        id: 'rel-stale-target',
        sourceSnapshot: createMockSnapshot('technology', 'tech-1', 'NewTech', { snapshotAt: Date.now() }),
        targetSnapshot: createMockSnapshot('company', 'comp-1', 'OldCo', { snapshotAt: staleTime }),
      });
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([staleRel]));

      const result = await getStaleRelations(30);

      expect(result).toHaveLength(1);
    });

    it('should return empty array when no stale relations', async () => {
      const freshRel = createMockRelation({
        id: 'rel-fresh',
        sourceSnapshot: createMockSnapshot('technology', 'tech-1', 'Fresh', { snapshotAt: Date.now() }),
        targetSnapshot: createMockSnapshot('technology', 'tech-2', 'AlsoFresh', { snapshotAt: Date.now() }),
      });
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([freshRel]));

      const result = await getStaleRelations(30);

      expect(result).toHaveLength(0);
    });

    it('should use default staleDays of 30', async () => {
      const twentyDaysAgo = Date.now() - 20 * 24 * 60 * 60 * 1000;
      const freshRel = createMockRelation({
        id: 'rel-recent',
        sourceSnapshot: createMockSnapshot('technology', 'tech-1', 'Recent', { snapshotAt: twentyDaysAgo }),
        targetSnapshot: createMockSnapshot('technology', 'tech-2', 'Also', { snapshotAt: Date.now() }),
      });
      mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([freshRel]));

      const result = await getStaleRelations(); // default 30 days

      expect(result).toHaveLength(0);
    });
  });
});

// ============================================================================
// ORPHAN CLEANUP TESTS
// ============================================================================

describe('Relations Module - cleanupOrphanedRelations()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return zero counts for empty relations list', async () => {
    mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([]));

    const result = await cleanupOrphanedRelations();

    expect(result.checked).toBe(0);
    expect(result.orphaned).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it('should skip valid relations where both entities exist', async () => {
    const validRel = createMockRelation({
      id: 'rel-valid',
      sourceSnapshot: createMockSnapshot('company', 'company-1', 'Acme'),
      targetSnapshot: createMockSnapshot('technology', 'tech-1', 'React'),
    });
    // getRelations
    mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([validRel]));
    // Entity existence checks: both exist
    mockGetDoc.mockResolvedValue({ exists: () => true, data: () => ({}) });

    const result = await cleanupOrphanedRelations();

    expect(result.checked).toBe(1);
    expect(result.orphaned).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it('should find orphaned relations with missing source entity', async () => {
    const orphanRel = createMockRelation({
      id: 'rel-orphan-src',
      sourceSnapshot: createMockSnapshot('company', 'deleted-company', 'Deleted Co'),
      targetSnapshot: createMockSnapshot('technology', 'tech-1', 'React'),
    });
    // getRelations
    mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([orphanRel]));
    // Entity existence checks: source missing, target exists
    mockGetDoc.mockImplementation((_ref: unknown) => {
      // We can't easily distinguish refs in this mock, so we track call order
      return Promise.resolve({ exists: () => false, data: () => null });
    });
    mockRelationDeleteTransaction([orphanRel]);

    const result = await cleanupOrphanedRelations();

    expect(result.checked).toBe(1);
    expect(result.orphaned).toBe(1);
    expect(result.deleted).toBe(1);
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/relation.sync.requested',
        data: expect.objectContaining({
          operation: 'delete',
          relationId: 'rel-orphan-src',
          deleteToken: expect.any(String),
        }),
      })
    );
  });

  it('should find orphaned relations with missing target entity', async () => {
    const orphanRel = createMockRelation({
      id: 'rel-orphan-tgt',
      sourceSnapshot: createMockSnapshot('company', 'company-1', 'Acme'),
      targetSnapshot: createMockSnapshot('technology', 'deleted-tech', 'Deleted Tech'),
    });
    // getRelations
    mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([orphanRel]));
    // All entity checks return not found
    mockGetDoc.mockResolvedValue({ exists: () => false, data: () => null });
    mockRelationDeleteTransaction([orphanRel]);

    const result = await cleanupOrphanedRelations();

    expect(result.checked).toBe(1);
    expect(result.orphaned).toBe(1);
    expect(result.deleted).toBe(1);
  });

  it('should handle entity check errors gracefully (assume entity exists)', async () => {
    const rel = createMockRelation({
      id: 'rel-check-error',
      sourceSnapshot: createMockSnapshot('company', 'company-err', 'ErrorCo'),
      targetSnapshot: createMockSnapshot('technology', 'tech-err', 'ErrorTech'),
    });
    // getRelations
    mockGetDocs.mockResolvedValueOnce(createMockQuerySnapshot([rel]));
    // Entity checks throw errors
    mockGetDoc.mockRejectedValue(new Error('Firestore error'));

    const result = await cleanupOrphanedRelations();

    // Should assume entities exist when checks fail (conservative)
    expect(result.checked).toBe(1);
    expect(result.orphaned).toBe(0);
    expect(result.deleted).toBe(0);
  });
});
