/**
 * Unit Tests for Proposed Relations Module
 *
 * Tests:
 * - generateProposalKey function (pure, no Firestore)
 * - isSymmetricRelation function (pure, no Firestore)
 * - sanitizeText function (pure, no Firestore)
 * - validateProposalSize function (pure, no Firestore)
 * - createMinimalSnapshot function (pure, no Firestore)
 * - Firestore CRUD operations (mocked)
 * - Triage operations (approve, reject, dismiss, revert)
 * - Bulk operations (bulkApprove, bulkReject, bulkDelete)
 * - Cleanup operations
 *
 * @jest-environment node
 */

// ============================================================================
// MOCKS - must be defined before imports
// ============================================================================

const mockCollection = jest.fn();
const mockDoc = jest.fn();
const mockGetDocs = jest.fn();
const mockGetDoc = jest.fn();
const mockSetDoc = jest.fn();
const mockUpdateDoc = jest.fn();
const mockDeleteDoc = jest.fn();
const mockQuery = jest.fn();
const mockWhere = jest.fn();
const mockOrderBy = jest.fn();
const mockLimit = jest.fn();
const mockStartAfter = jest.fn();
const mockGetCountFromServer = jest.fn();
const mockRunTransaction = jest.fn();

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: (...args: unknown[]) => mockCollection(...args),
  doc: (...args: unknown[]) => mockDoc(...args),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  getDoc: (...args: unknown[]) => mockGetDoc(...args),
  setDoc: (...args: unknown[]) => mockSetDoc(...args),
  updateDoc: (...args: unknown[]) => mockUpdateDoc(...args),
  deleteDoc: (...args: unknown[]) => mockDeleteDoc(...args),
  query: (...args: unknown[]) => mockQuery(...args),
  where: (...args: unknown[]) => mockWhere(...args),
  orderBy: (...args: unknown[]) => mockOrderBy(...args),
  limit: (...args: unknown[]) => mockLimit(...args),
  startAfter: (...args: unknown[]) => mockStartAfter(...args),
  getCountFromServer: (...args: unknown[]) => mockGetCountFromServer(...args),
  runTransaction: (...args: unknown[]) => mockRunTransaction(...args),
}));

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

import { describe, it, expect } from '@jest/globals';
import {
  generateProposalKey,
  isSymmetricRelation,
  sanitizeText,
  validateProposalSize,
  createMinimalSnapshot,
  getProposedRelations,
  getProposedRelationById,
  getProposedRelationByKey,
  getPendingProposedRelationsCount,
  getProposedRelationsByEntity,
  getProposedRelationsPaginated,
  createProposedRelationIfNotExists,
  createProposedRelation,
  updateProposedRelation,
  approveProposedRelation,
  rejectProposedRelation,
  dismissProposedRelation,
  revertProposedRelation,
  markProposedRelationAsRemoved,
  bulkApproveProposedRelations,
  bulkRejectProposedRelations,
  bulkDeleteProposedRelations,
  deleteProposedRelation,
  getPendingProposalsBetween,
  cleanupOldRejectedProposals,
  cleanupOrphanedProposals,
} from '../proposed-relations';
import type { RelationType, ProposedRelation, CreateProposedRelationInput } from '../types';
import { PROPOSED_RELATION_LIMITS as LIMITS } from '../types';
import {
  generateLegacyProposalKey,
  generateProposalKeyCandidates,
  ProposalIdentityConflictError,
} from '../proposed-relation-key';

// ============================================================================
// generateProposalKey TESTS
// ============================================================================

describe('Proposed Relations - generateProposalKey()', () => {
  describe('Deterministic Key Generation', () => {
    it('should generate same key for same inputs', () => {
      const key1 = generateProposalKey('tech-1', 'tech-2', 'uses');
      const key2 = generateProposalKey('tech-1', 'tech-2', 'uses');

      expect(key1).toBe(key2);
    });

    it('should generate different keys for different source IDs', () => {
      const key1 = generateProposalKey('tech-1', 'tech-2', 'uses');
      const key2 = generateProposalKey('tech-3', 'tech-2', 'uses');

      expect(key1).not.toBe(key2);
    });

    it('should generate different keys for different target IDs', () => {
      const key1 = generateProposalKey('tech-1', 'tech-2', 'uses');
      const key2 = generateProposalKey('tech-1', 'tech-3', 'uses');

      expect(key1).not.toBe(key2);
    });

    it('should generate different keys for different relation types', () => {
      const key1 = generateProposalKey('tech-1', 'tech-2', 'uses');
      const key2 = generateProposalKey('tech-1', 'tech-2', 'enables');

      expect(key1).not.toBe(key2);
    });
  });

  describe('Key Format', () => {
    it('should generate 32-character hash key', () => {
      const key = generateProposalKey('tech-1', 'tech-2', 'uses');

      expect(key.length).toBe(32);
    });

    it('should generate hexadecimal key', () => {
      const key = generateProposalKey('company-1', 'tech-1', 'vendor');

      expect(key).toMatch(/^[a-f0-9]{32}$/);
    });
  });

  describe('Symmetric Relation Handling', () => {
    it('should generate same key for symmetric relation regardless of order - partner', () => {
      const key1 = generateProposalKey('company-a', 'company-b', 'partner');
      const key2 = generateProposalKey('company-b', 'company-a', 'partner');

      expect(key1).toBe(key2);
    });

    it('should generate same key for symmetric relation regardless of order - competitor', () => {
      const key1 = generateProposalKey('company-1', 'company-2', 'competitor');
      const key2 = generateProposalKey('company-2', 'company-1', 'competitor');

      expect(key1).toBe(key2);
    });

    it('should generate same key for symmetric relation regardless of order - competes_with', () => {
      const key1 = generateProposalKey('tech-x', 'tech-y', 'competes_with');
      const key2 = generateProposalKey('tech-y', 'tech-x', 'competes_with');

      expect(key1).toBe(key2);
    });

    it.each(['parallels', 'complements', 'conflicts_with'] as const)(
      'should generate one key for both directions of %s',
      (relationType) => {
        expect(generateProposalKey('entity-a', 'entity-b', relationType)).toBe(
          generateProposalKey('entity-b', 'entity-a', relationType)
        );
      }
    );
  });

  describe('Directional Relation Handling', () => {
    it('should generate different keys for directional relation based on order - uses', () => {
      const key1 = generateProposalKey('tech-1', 'tech-2', 'uses');
      const key2 = generateProposalKey('tech-2', 'tech-1', 'uses');

      expect(key1).not.toBe(key2);
    });

    it('should generate different keys for directional relation based on order - vendor', () => {
      const key1 = generateProposalKey('company-1', 'tech-1', 'vendor');
      const key2 = generateProposalKey('tech-1', 'company-1', 'vendor');

      expect(key1).not.toBe(key2);
    });

    it('should generate different keys for directional relation based on order - parent', () => {
      const key1 = generateProposalKey('org-1', 'org-2', 'parent');
      const key2 = generateProposalKey('org-2', 'org-1', 'parent');

      expect(key1).not.toBe(key2);
    });
  });

  describe('Edge Cases', () => {
    it('separates colon-bearing tuples that collided in the legacy preimage', () => {
      expect(generateProposalKey('a', 'b:c', 'uses')).not.toBe(
        generateProposalKey('a:b', 'c', 'uses')
      );
      expect(generateLegacyProposalKey('a', 'b:c', 'uses')).toBe(
        generateLegacyProposalKey('a:b', 'c', 'uses')
      );
    });

    it('should handle empty IDs', () => {
      const key = generateProposalKey('', '', 'custom');

      expect(key.length).toBe(32);
      expect(key).toMatch(/^[a-f0-9]{32}$/);
    });

    it('should handle very long IDs', () => {
      const longId1 = 'a'.repeat(1000);
      const longId2 = 'b'.repeat(1000);
      const key = generateProposalKey(longId1, longId2, 'uses');

      expect(key.length).toBe(32);
    });

    it('should handle special characters in IDs', () => {
      const key = generateProposalKey('tech/1', 'tech/2', 'uses');

      expect(key.length).toBe(32);
      expect(key).toMatch(/^[a-f0-9]{32}$/);
    });
  });
});

// ============================================================================
// isSymmetricRelation TESTS
// ============================================================================

describe('Proposed Relations - isSymmetricRelation()', () => {
  describe('Symmetric Relations', () => {
    it('should identify competes_with as symmetric', () => {
      expect(isSymmetricRelation('competes_with')).toBe(true);
    });

    it('should identify partner as symmetric', () => {
      expect(isSymmetricRelation('partner')).toBe(true);
    });

    it('should identify competitor as symmetric', () => {
      expect(isSymmetricRelation('competitor')).toBe(true);
    });

    it.each(['parallels', 'complements', 'conflicts_with'] as const)(
      'should identify %s as symmetric',
      (relationType) => {
        expect(isSymmetricRelation(relationType)).toBe(true);
      }
    );
  });

  describe('Directional Relations', () => {
    it('should identify uses as directional', () => {
      expect(isSymmetricRelation('uses')).toBe(false);
    });

    it('should identify enables as directional', () => {
      expect(isSymmetricRelation('enables')).toBe(false);
    });

    it('should identify vendor as directional', () => {
      expect(isSymmetricRelation('vendor')).toBe(false);
    });

    it('should identify user as directional', () => {
      expect(isSymmetricRelation('user')).toBe(false);
    });

    it('should identify parent as directional', () => {
      expect(isSymmetricRelation('parent')).toBe(false);
    });

    it('should identify child as directional', () => {
      expect(isSymmetricRelation('child')).toBe(false);
    });
  });

  describe('New Universal Relations Types', () => {
    const newTypes: RelationType[] = [
      'mentions',
      'documented_in',
      'source',
      'reveals',
      'experiences',
      'invests_in',
      'demonstrates',
      'implements',
      'informed_by',
      'about',
    ];

    newTypes.forEach((relType) => {
      it(`should identify ${relType} as directional`, () => {
        expect(isSymmetricRelation(relType)).toBe(false);
      });
    });
  });
});

// ============================================================================
// sanitizeText TESTS
// ============================================================================

describe('Proposed Relations - sanitizeText()', () => {
  describe('Email PII Removal', () => {
    it('should remove email addresses', () => {
      const text = 'Contact john.doe@example.com for more info';
      const sanitized = sanitizeText(text, 500);

      expect(sanitized).not.toContain('john.doe@example.com');
      expect(sanitized).toContain('[EMAIL]');
    });

    it('should remove multiple email addresses', () => {
      const text = 'Email alice@test.com or bob@example.org';
      const sanitized = sanitizeText(text, 500);

      expect(sanitized).not.toContain('alice@test.com');
      expect(sanitized).not.toContain('bob@example.org');
      expect((sanitized.match(/\[EMAIL\]/g) || []).length).toBe(2);
    });

    it('should handle various email formats', () => {
      const text = 'user.name+tag@subdomain.example.com';
      const sanitized = sanitizeText(text, 500);

      expect(sanitized).toContain('[EMAIL]');
    });
  });

  describe('Phone Number PII Removal', () => {
    it('should remove phone numbers with dashes', () => {
      const text = 'Call 555-123-4567 for support';
      const sanitized = sanitizeText(text, 500);

      expect(sanitized).not.toContain('555-123-4567');
      expect(sanitized).toContain('[PHONE]');
    });

    it('should remove phone numbers with dots', () => {
      const text = 'Call 555.123.4567 for support';
      const sanitized = sanitizeText(text, 500);

      expect(sanitized).not.toContain('555.123.4567');
      expect(sanitized).toContain('[PHONE]');
    });

    it('should remove phone numbers without separators', () => {
      const text = 'Call 5551234567 for support';
      const sanitized = sanitizeText(text, 500);

      expect(sanitized).not.toContain('5551234567');
      expect(sanitized).toContain('[PHONE]');
    });
  });

  describe('SSN PII Removal', () => {
    it('should remove SSN format numbers', () => {
      const text = 'SSN: 123-45-6789';
      const sanitized = sanitizeText(text, 500);

      expect(sanitized).not.toContain('123-45-6789');
      expect(sanitized).toContain('[SSN]');
    });
  });

  describe('Credit Card PII Removal', () => {
    it('should remove credit card numbers with spaces', () => {
      const text = 'Card: 1234 5678 9012 3456';
      const sanitized = sanitizeText(text, 500);

      expect(sanitized).not.toContain('1234 5678 9012 3456');
      expect(sanitized).toContain('[CARD]');
    });

    it('should remove credit card numbers with dashes', () => {
      const text = 'Card: 1234-5678-9012-3456';
      const sanitized = sanitizeText(text, 500);

      expect(sanitized).not.toContain('1234-5678-9012-3456');
      expect(sanitized).toContain('[CARD]');
    });
  });

  describe('Length Truncation', () => {
    it('should truncate text to max length', () => {
      const text = 'a'.repeat(1000);
      const sanitized = sanitizeText(text, 500);

      expect(sanitized.length).toBe(500);
    });

    it('should not truncate text within max length', () => {
      const text = 'Short text';
      const sanitized = sanitizeText(text, 500);

      expect(sanitized).toBe(text);
    });

    it('should sanitize PII before truncating', () => {
      // PII in the middle, with clear word boundaries
      const text = 'Contact ' + 'john@test.com' + ' for ' + 'a'.repeat(500);
      const sanitized = sanitizeText(text, 100);

      // Email should be replaced with [EMAIL] first
      expect(sanitized).not.toContain('john@test.com');
      expect(sanitized).toContain('[EMAIL]');
      // Then truncated to max length
      expect(sanitized.length).toBe(100);
    });
  });

  describe('Combined PII Removal', () => {
    it('should remove multiple types of PII', () => {
      const text = 'Contact john@test.com at 555-123-4567';
      const sanitized = sanitizeText(text, 500);

      expect(sanitized).not.toContain('john@test.com');
      expect(sanitized).not.toContain('555-123-4567');
      expect(sanitized).toContain('[EMAIL]');
      expect(sanitized).toContain('[PHONE]');
    });
  });

  describe('Text Without PII', () => {
    it('should preserve text without PII', () => {
      const text = 'This is a normal technology description without any personal info';
      const sanitized = sanitizeText(text, 500);

      expect(sanitized).toBe(text);
    });
  });
});

// ============================================================================
// validateProposalSize TESTS
// ============================================================================

describe('Proposed Relations - validateProposalSize()', () => {
  /**
   * Creates a minimal valid proposal for testing
   */
  function createTestProposal(overrides?: Partial<ProposedRelation>): ProposedRelation {
    const now = Date.now();
    return {
      id: 'test-proposal-id',
      sourceType: 'technology',
      sourceId: 'tech-1',
      sourceSnapshot: {
        type: 'technology',
        id: 'tech-1',
        name: 'TensorFlow',
        snapshotAt: now,
      },
      targetType: 'technology',
      targetId: 'tech-2',
      targetSnapshot: {
        type: 'technology',
        id: 'tech-2',
        name: 'Python',
        snapshotAt: now,
      },
      relationType: 'uses',
      confidence: 85,
      reasoning: 'TensorFlow uses Python as its primary interface language.',
      evidence: [],
      status: 'pending',
      discoveredBy: 'linker-agent',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  describe('Valid Proposals', () => {
    it('should not throw for small proposals', () => {
      const proposal = createTestProposal();

      expect(() => validateProposalSize(proposal)).not.toThrow();
    });

    it('should not throw for proposals at limit', () => {
      // Create a proposal that's close to but under the limit
      const proposal = createTestProposal({
        reasoning: 'x'.repeat(900),
      });

      expect(() => validateProposalSize(proposal)).not.toThrow();
    });
  });

  describe('Oversized Proposals', () => {
    it('should throw for proposals exceeding size limit (100KB)', () => {
      // Create a proposal that definitely exceeds 100KB (100,000 bytes)
      // Each character in JSON is roughly 1 byte, plus escaping overhead
      const proposal = createTestProposal({
        reasoning: 'x'.repeat(110000), // 110KB in reasoning alone
      });

      expect(() => validateProposalSize(proposal)).toThrow(/exceeds size limit/);
    });

    it('should include size information in error message', () => {
      const proposal = createTestProposal({
        reasoning: 'x'.repeat(120000), // Definitely over 100KB
      });

      try {
        validateProposalSize(proposal);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect((error as Error).message).toContain(String(LIMITS.PROPOSAL_MAX_SIZE));
      }
    });
  });
});

// ============================================================================
// createMinimalSnapshot TESTS
// ============================================================================

describe('Proposed Relations - createMinimalSnapshot()', () => {
  describe('Basic Snapshot Creation', () => {
    it('should create snapshot with required fields', () => {
      const snapshot = createMinimalSnapshot('technology', 'tech-1', 'TensorFlow');

      expect(snapshot.type).toBe('technology');
      expect(snapshot.id).toBe('tech-1');
      expect(snapshot.name).toBe('TensorFlow');
      expect(snapshot.snapshotAt).toBeDefined();
      expect(snapshot.snapshotAt).toBeGreaterThan(0);
    });

    it('should include optional description when provided', () => {
      const snapshot = createMinimalSnapshot('company', 'company-1', 'Acme Corp', 'Leading technology company');

      expect(snapshot.description).toBe('Leading technology company');
    });

    it('should include optional status when provided', () => {
      const snapshot = createMinimalSnapshot('technology', 'tech-1', 'TensorFlow', 'ML framework', 'active');

      expect(snapshot.status).toBe('active');
    });
  });

  describe('Name Truncation', () => {
    it('should truncate long names to limit', () => {
      const longName = 'A'.repeat(200);
      const snapshot = createMinimalSnapshot('technology', 'tech-1', longName);

      expect(snapshot.name.length).toBeLessThanOrEqual(LIMITS.SNAPSHOT_NAME_MAX);
    });
  });

  describe('Description Truncation', () => {
    it('should truncate long descriptions to limit', () => {
      const longDesc = 'B'.repeat(1000);
      const snapshot = createMinimalSnapshot('company', 'company-1', 'Test', longDesc);

      expect(snapshot.description?.length).toBeLessThanOrEqual(LIMITS.SNAPSHOT_DESCRIPTION_MAX);
    });
  });

  describe('PII Sanitization', () => {
    it('should sanitize PII from name', () => {
      const snapshot = createMinimalSnapshot('company', 'company-1', 'Contact john@example.com');

      expect(snapshot.name).not.toContain('john@example.com');
      expect(snapshot.name).toContain('[EMAIL]');
    });

    it('should sanitize PII from description', () => {
      const snapshot = createMinimalSnapshot('company', 'company-1', 'Test Company', 'Call us at 555-123-4567');

      expect(snapshot.description).not.toContain('555-123-4567');
      expect(snapshot.description).toContain('[PHONE]');
    });
  });

  describe('Timestamp', () => {
    it('should set snapshotAt to current time', () => {
      const before = Date.now();
      const snapshot = createMinimalSnapshot('technology', 'tech-1', 'Test');
      const after = Date.now();

      expect(snapshot.snapshotAt).toBeGreaterThanOrEqual(before);
      expect(snapshot.snapshotAt).toBeLessThanOrEqual(after);
    });
  });
});

// ============================================================================
// INTEGRATION SCENARIOS (Pure Logic Tests)
// ============================================================================

describe('Proposed Relations - Integration Scenarios', () => {
  describe('Idempotency Key Generation', () => {
    it('should prevent duplicate proposals for same entities and relation', () => {
      const key1 = generateProposalKey('tech-1', 'tech-2', 'uses');
      const key2 = generateProposalKey('tech-1', 'tech-2', 'uses');

      // Same key means idempotent - second write would be a no-op
      expect(key1).toBe(key2);
    });

    it('should allow different relations between same entities', () => {
      const keyUses = generateProposalKey('tech-1', 'tech-2', 'uses');
      const keyEnables = generateProposalKey('tech-1', 'tech-2', 'enables');

      // Different keys means both can be proposed
      expect(keyUses).not.toBe(keyEnables);
    });
  });

  describe('Symmetric Relation Deduplication', () => {
    it('should deduplicate A→B and B→A for partner relation', () => {
      const keyAB = generateProposalKey('company-a', 'company-b', 'partner');
      const keyBA = generateProposalKey('company-b', 'company-a', 'partner');

      // Same key prevents duplicate proposals
      expect(keyAB).toBe(keyBA);
    });

    it('should not deduplicate A→B and B→A for directional relations', () => {
      const keyAB = generateProposalKey('tech-a', 'tech-b', 'uses');
      const keyBA = generateProposalKey('tech-b', 'tech-a', 'uses');

      // Different keys allow both directions
      expect(keyAB).not.toBe(keyBA);
    });
  });

  describe('Snapshot Safety', () => {
    it('should create safe snapshots for proposals', () => {
      const unsafeName = 'Company (contact: john@test.com, phone: 555-123-4567)';
      const unsafeDesc = 'Founded by Jane Doe (SSN: 123-45-6789)';

      const snapshot = createMinimalSnapshot('company', 'company-1', unsafeName, unsafeDesc);

      // Should be sanitized
      expect(snapshot.name).not.toContain('john@test.com');
      expect(snapshot.name).not.toContain('555-123-4567');
      expect(snapshot.description).not.toContain('123-45-6789');

      // Should be truncated
      expect(snapshot.name.length).toBeLessThanOrEqual(LIMITS.SNAPSHOT_NAME_MAX);
      expect(snapshot.description?.length).toBeLessThanOrEqual(LIMITS.SNAPSHOT_DESCRIPTION_MAX);
    });
  });
});

// ============================================================================
// FIRESTORE CRUD TESTS
// ============================================================================

function createTestProposalInput(overrides?: Partial<CreateProposedRelationInput>): CreateProposedRelationInput {
  const now = Date.now();
  return {
    sourceType: 'technology',
    sourceId: 'tech-1',
    sourceSnapshot: {
      type: 'technology',
      id: 'tech-1',
      name: 'TensorFlow',
      snapshotAt: now,
    },
    targetType: 'company',
    targetId: 'company-1',
    targetSnapshot: {
      type: 'company',
      id: 'company-1',
      name: 'Google',
      snapshotAt: now,
    },
    relationType: 'vendor',
    confidence: 85,
    reasoning: 'TensorFlow is developed by Google.',
    evidence: [],
    discoveredBy: 'linker-agent',
    ...overrides,
  } as CreateProposedRelationInput;
}

function createTestProposalDoc(overrides?: Partial<ProposedRelation>): ProposedRelation {
  const now = Date.now();
  return {
    id: 'test-proposal-id',
    sourceType: 'technology',
    sourceId: 'tech-1',
    sourceSnapshot: {
      type: 'technology',
      id: 'tech-1',
      name: 'TensorFlow',
      snapshotAt: now,
    },
    targetType: 'company',
    targetId: 'company-1',
    targetSnapshot: {
      type: 'company',
      id: 'company-1',
      name: 'Google',
      snapshotAt: now,
    },
    relationType: 'vendor',
    confidence: 85,
    reasoning: 'TensorFlow is developed by Google.',
    evidence: [],
    status: 'pending',
    discoveredBy: 'linker-agent',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mockDocSnapshot(data: ProposedRelation | null) {
  return {
    exists: () => data !== null,
    data: () => data,
    id: data?.id ?? 'mock-id',
    ref: { path: `proposedRelations/${data?.id ?? 'mock-id'}` },
  };
}

function mockQuerySnapshot(docs: ProposedRelation[]) {
  return {
    docs: docs.map((d) => ({
      data: () => d,
      id: d.id,
      ref: { path: `proposedRelations/${d.id}` },
    })),
    size: docs.length,
    empty: docs.length === 0,
  };
}

describe('Proposed Relations - Firestore CRUD', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDoc.mockReset();
    mockGetDoc.mockReset();
    mockRunTransaction.mockReset();
    mockDoc.mockImplementation((_db: unknown, collectionName: string, id: string) => ({
      collectionName,
      id,
    }));
    mockRunTransaction.mockImplementation(
      async (
        _db: unknown,
        operation: (transaction: {
          get: (ref: unknown) => Promise<unknown>;
          set: (ref: unknown, data: unknown) => void;
          delete: (ref: unknown) => void;
        }) => unknown
      ) =>
        operation({
          get: (ref) => mockGetDoc(ref),
          set: (ref, data) => void mockSetDoc(ref, data),
          delete: (ref) => void mockDeleteDoc(ref),
        })
    );
  });

  // ==========================================================================
  // READ OPERATIONS
  // ==========================================================================

  describe('getProposedRelations()', () => {
    it('should return all proposals without filters', async () => {
      const proposals = [createTestProposalDoc({ id: 'p1' }), createTestProposalDoc({ id: 'p2' })];
      mockGetDocs.mockResolvedValue(mockQuerySnapshot(proposals));

      const result = await getProposedRelations();

      expect(result).toHaveLength(2);
      expect(mockQuery).toHaveBeenCalled();
    });

    it('should apply status filter (single)', async () => {
      mockGetDocs.mockResolvedValue(mockQuerySnapshot([]));

      await getProposedRelations({ status: 'pending' });

      expect(mockWhere).toHaveBeenCalledWith('status', '==', 'pending');
    });

    it('should apply status filter (array)', async () => {
      mockGetDocs.mockResolvedValue(mockQuerySnapshot([]));

      await getProposedRelations({ status: ['pending', 'approved'] });

      expect(mockWhere).toHaveBeenCalledWith('status', 'in', ['pending', 'approved']);
    });

    it('should apply sourceType filter', async () => {
      mockGetDocs.mockResolvedValue(mockQuerySnapshot([]));

      await getProposedRelations({ sourceType: 'technology' });

      expect(mockWhere).toHaveBeenCalledWith('sourceType', '==', 'technology');
    });

    it('should apply relationType filter', async () => {
      mockGetDocs.mockResolvedValue(mockQuerySnapshot([]));

      await getProposedRelations({ relationType: 'uses' });

      expect(mockWhere).toHaveBeenCalledWith('relationType', '==', 'uses');
    });

    it('should apply minConfidence filter', async () => {
      mockGetDocs.mockResolvedValue(mockQuerySnapshot([]));

      await getProposedRelations({ minConfidence: 70 });

      expect(mockWhere).toHaveBeenCalledWith('confidence', '>=', 70);
    });

    it('should apply runId filter', async () => {
      mockGetDocs.mockResolvedValue(mockQuerySnapshot([]));

      await getProposedRelations({ runId: 'run-123' });

      expect(mockWhere).toHaveBeenCalledWith('runId', '==', 'run-123');
    });

    it('should apply createdAfter filter', async () => {
      mockGetDocs.mockResolvedValue(mockQuerySnapshot([]));

      await getProposedRelations({ createdAfter: 1700000000000 });

      expect(mockWhere).toHaveBeenCalledWith('createdAt', '>=', 1700000000000);
    });
  });

  describe('getProposedRelationById()', () => {
    it('should return proposal when found', async () => {
      const proposal = createTestProposalDoc({ id: 'existing-id' });
      mockGetDoc.mockResolvedValue(mockDocSnapshot(proposal));

      const result = await getProposedRelationById('existing-id');

      expect(result).toBeDefined();
      expect(result!.id).toBe('existing-id');
    });

    it('should return null when not found', async () => {
      mockGetDoc.mockResolvedValue(mockDocSnapshot(null));

      const result = await getProposedRelationById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getProposedRelationByKey()', () => {
    it('should look up by composite key', async () => {
      const proposal = createTestProposalDoc();
      mockGetDoc.mockResolvedValue(mockDocSnapshot(proposal));

      const result = await getProposedRelationByKey('tech-1', 'company-1', 'vendor');

      expect(result).toBeDefined();
      expect(mockDoc).toHaveBeenCalled();
    });

    it('fails closed when a v2 proposal conflicts with a reverse legacy archive', async () => {
      const currentKey = generateProposalKey('signal-a', 'signal-b', 'parallels');
      const candidates = generateProposalKeyCandidates('signal-a', 'signal-b', 'parallels');
      const current = createTestProposalDoc({
        id: currentKey,
        sourceType: 'signal',
        sourceId: 'signal-a',
        targetType: 'signal',
        targetId: 'signal-b',
        relationType: 'parallels',
        status: 'pending',
      });
      const legacy = createTestProposalDoc({
        id: candidates[2],
        sourceType: 'signal',
        sourceId: 'signal-b',
        targetType: 'signal',
        targetId: 'signal-a',
        relationType: 'parallels',
        status: 'approved',
      });
      mockGetDoc
        .mockResolvedValueOnce(mockDocSnapshot(current))
        .mockResolvedValueOnce(mockDocSnapshot(null))
        .mockResolvedValueOnce(mockDocSnapshot(legacy));

      await expect(
        getProposedRelationByKey('signal-a', 'signal-b', 'parallels')
      ).rejects.toBeInstanceOf(ProposalIdentityConflictError);
    });
  });

  describe('getPendingProposedRelationsCount()', () => {
    it('should return count of pending proposals', async () => {
      mockGetCountFromServer.mockResolvedValue({
        data: () => ({ count: 42 }),
      });

      const count = await getPendingProposedRelationsCount();

      expect(count).toBe(42);
      expect(mockWhere).toHaveBeenCalledWith('status', '==', 'pending');
    });
  });

  describe('getProposedRelationsByEntity()', () => {
    it('should query both source and target directions', async () => {
      const proposal1 = createTestProposalDoc({ id: 'p1', sourceId: 'entity-1' });
      const proposal2 = createTestProposalDoc({ id: 'p2', targetId: 'entity-1' });

      mockGetDocs
        .mockResolvedValueOnce(mockQuerySnapshot([proposal1]))
        .mockResolvedValueOnce(mockQuerySnapshot([proposal2]));

      const result = await getProposedRelationsByEntity('entity-1');

      expect(result).toHaveLength(2);
      // Verify both directions were queried
      expect(mockWhere).toHaveBeenCalledWith('sourceId', '==', 'entity-1');
      expect(mockWhere).toHaveBeenCalledWith('targetId', '==', 'entity-1');
    });

    it('should deduplicate results from both queries', async () => {
      const proposal = createTestProposalDoc({ id: 'p1' });

      // Same proposal found in both source and target queries
      mockGetDocs
        .mockResolvedValueOnce(mockQuerySnapshot([proposal]))
        .mockResolvedValueOnce(mockQuerySnapshot([proposal]));

      const result = await getProposedRelationsByEntity('entity-1');

      expect(result).toHaveLength(1);
    });

    it('should sort by createdAt descending', async () => {
      const older = createTestProposalDoc({ id: 'p1', createdAt: 1000 });
      const newer = createTestProposalDoc({ id: 'p2', createdAt: 2000 });

      mockGetDocs.mockResolvedValueOnce(mockQuerySnapshot([older])).mockResolvedValueOnce(mockQuerySnapshot([newer]));

      const result = await getProposedRelationsByEntity('entity-1');

      expect(result[0].createdAt).toBeGreaterThanOrEqual(result[result.length - 1].createdAt);
    });
  });

  describe('getProposedRelationsPaginated()', () => {
    it('should return paginated results with nextCursor', async () => {
      const proposals = Array.from({ length: 21 }, (_, i) => createTestProposalDoc({ id: `p${i}` }));
      mockGetDocs.mockResolvedValue(mockQuerySnapshot(proposals));

      const result = await getProposedRelationsPaginated({}, { limit: 20 });

      expect(result.items).toHaveLength(20);
      expect(result.nextCursor).not.toBeNull();
    });

    it('should return null nextCursor when no more pages', async () => {
      const proposals = [createTestProposalDoc({ id: 'p1' })];
      mockGetDocs.mockResolvedValue(mockQuerySnapshot(proposals));

      const result = await getProposedRelationsPaginated({}, { limit: 20 });

      expect(result.items).toHaveLength(1);
      expect(result.nextCursor).toBeNull();
    });

    it('should handle cursor-based pagination', async () => {
      mockGetDoc.mockResolvedValue(mockDocSnapshot(createTestProposalDoc({ id: 'cursor-id' })));
      mockGetDocs.mockResolvedValue(mockQuerySnapshot([]));

      await getProposedRelationsPaginated({}, { cursor: 'cursor-id' });

      expect(mockGetDoc).toHaveBeenCalled();
      expect(mockStartAfter).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // WRITE OPERATIONS
  // ==========================================================================

  describe('createProposedRelationIfNotExists()', () => {
    it('should create a new proposal when none exists', async () => {
      mockGetDoc.mockResolvedValue(mockDocSnapshot(null));
      mockSetDoc.mockResolvedValue(undefined);

      const input = createTestProposalInput();
      const result = await createProposedRelationIfNotExists(input);

      expect(result.created).toBe(true);
      expect(result.proposal.status).toBe('pending');
      expect(mockSetDoc).toHaveBeenCalled();
    });

    it('should not create when proposal already pending', async () => {
      const existing = createTestProposalDoc({ status: 'pending' });
      mockGetDoc
        .mockResolvedValueOnce(mockDocSnapshot(existing))
        .mockResolvedValueOnce(mockDocSnapshot(null));

      const input = createTestProposalInput();
      const result = await createProposedRelationIfNotExists(input);

      expect(result.created).toBe(false);
      expect(result.reason).toBe('already_pending');
      expect(mockSetDoc).not.toHaveBeenCalled();
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('fails closed when directional legacy archives disagree after a symmetry rollout', async () => {
      const input = createTestProposalInput({
        sourceType: 'signal',
        sourceId: 'signal-a',
        sourceSnapshot: { type: 'signal', id: 'signal-a', name: 'A', snapshotAt: 1 },
        targetType: 'signal',
        targetId: 'signal-b',
        targetSnapshot: { type: 'signal', id: 'signal-b', name: 'B', snapshotAt: 1 },
        relationType: 'parallels',
      });
      const candidates = generateProposalKeyCandidates(
        input.sourceId,
        input.targetId,
        input.relationType
      );
      const expiredForward = createTestProposalDoc({
        id: candidates[1],
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceSnapshot: input.sourceSnapshot,
        targetType: input.targetType,
        targetId: input.targetId,
        targetSnapshot: input.targetSnapshot,
        relationType: input.relationType,
        status: 'rejected',
        updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
      });
      const pendingReverse = createTestProposalDoc({
        id: candidates[2],
        sourceType: input.targetType,
        sourceId: input.targetId,
        sourceSnapshot: input.targetSnapshot,
        targetType: input.sourceType,
        targetId: input.sourceId,
        targetSnapshot: input.sourceSnapshot,
        relationType: input.relationType,
        status: 'pending',
      });
      mockGetDoc
        .mockResolvedValueOnce(mockDocSnapshot(null))
        .mockResolvedValueOnce(mockDocSnapshot(expiredForward))
        .mockResolvedValueOnce(mockDocSnapshot(pendingReverse));

      await expect(createProposedRelationIfNotExists(input)).rejects.toEqual(
        expect.objectContaining({
          name: ProposalIdentityConflictError.name,
          proposalIds: [candidates[1], candidates[2]].sort(),
        })
      );
      expect(mockSetDoc).not.toHaveBeenCalled();
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('atomically converges equivalent directional legacy archives onto v2', async () => {
      const input = createTestProposalInput({
        sourceType: 'signal',
        sourceId: 'signal-a',
        sourceSnapshot: { type: 'signal', id: 'signal-a', name: 'A', snapshotAt: 1 },
        targetType: 'signal',
        targetId: 'signal-b',
        targetSnapshot: { type: 'signal', id: 'signal-b', name: 'B', snapshotAt: 1 },
        relationType: 'parallels',
      });
      const candidates = generateProposalKeyCandidates(
        input.sourceId,
        input.targetId,
        input.relationType
      );
      const forward = createTestProposalDoc({
        id: candidates[1],
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceSnapshot: input.sourceSnapshot,
        targetType: input.targetType,
        targetId: input.targetId,
        targetSnapshot: input.targetSnapshot,
        relationType: input.relationType,
      });
      const reverse = createTestProposalDoc({
        ...forward,
        id: candidates[2],
        sourceType: forward.targetType,
        sourceId: forward.targetId,
        sourceSnapshot: forward.targetSnapshot,
        targetType: forward.sourceType,
        targetId: forward.sourceId,
        targetSnapshot: forward.sourceSnapshot,
      });
      mockGetDoc
        .mockResolvedValueOnce(mockDocSnapshot(null))
        .mockResolvedValueOnce(mockDocSnapshot(forward))
        .mockResolvedValueOnce(mockDocSnapshot(reverse));

      const result = await createProposedRelationIfNotExists(input);

      expect(result).toMatchObject({
        created: false,
        proposal: { id: candidates[0], status: 'pending' },
        reason: 'already_pending',
      });
      expect(mockSetDoc).toHaveBeenCalledTimes(1);
      expect(mockDeleteDoc).toHaveBeenCalledTimes(2);
    });

    it('finds a reverse legacy proposal before writing the new symmetric identity', async () => {
      const input = createTestProposalInput({
        sourceType: 'signal',
        sourceId: 'signal-b',
        sourceSnapshot: { type: 'signal', id: 'signal-b', name: 'B', snapshotAt: 1 },
        targetType: 'signal',
        targetId: 'signal-a',
        targetSnapshot: { type: 'signal', id: 'signal-a', name: 'A', snapshotAt: 1 },
        relationType: 'parallels',
      });
      const candidates = generateProposalKeyCandidates(
        input.sourceId,
        input.targetId,
        input.relationType
      );
      const existing = createTestProposalDoc({
        id: candidates[2],
        sourceType: 'signal',
        sourceId: 'signal-a',
        targetType: 'signal',
        targetId: 'signal-b',
        relationType: 'parallels',
        status: 'pending',
      });
      mockGetDoc
        .mockResolvedValueOnce(mockDocSnapshot(null))
        .mockResolvedValueOnce(mockDocSnapshot(null))
        .mockResolvedValueOnce(mockDocSnapshot(existing));

      await expect(createProposedRelationIfNotExists(input)).resolves.toEqual({
        created: false,
        proposal: {
          ...existing,
          id: generateProposalKey(input.sourceId, input.targetId, input.relationType),
        },
        reason: 'already_pending',
      });
      expect(mockSetDoc).toHaveBeenCalledTimes(1);
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    });

    it('ignores a different triple that collides under the legacy colon preimage', async () => {
      const input = createTestProposalInput({
        sourceId: 'a',
        sourceSnapshot: { type: 'technology', id: 'a', name: 'A', snapshotAt: 1 },
        targetId: 'b:c',
        targetSnapshot: { type: 'company', id: 'b:c', name: 'B:C', snapshotAt: 1 },
        relationType: 'uses',
      });
      const unrelated = createTestProposalDoc({
        id: generateLegacyProposalKey('a:b', 'c', 'uses'),
        sourceId: 'a:b',
        targetId: 'c',
        relationType: 'uses',
        status: 'pending',
      });
      mockGetDoc
        .mockResolvedValueOnce(mockDocSnapshot(null))
        .mockResolvedValueOnce(mockDocSnapshot(unrelated));
      mockSetDoc.mockResolvedValue(undefined);

      const result = await createProposedRelationIfNotExists(input);

      expect(result.created).toBe(true);
      expect(result.proposal.id).toBe(
        generateProposalKey(input.sourceId, input.targetId, input.relationType)
      );
      expect(mockSetDoc).toHaveBeenCalledTimes(1);
    });

    it('atomically moves an expired rejected legacy proposal to its v2 identity', async () => {
      const input = createTestProposalInput();
      const currentKey = generateProposalKey(
        input.sourceId,
        input.targetId,
        input.relationType
      );
      const legacyKey = generateLegacyProposalKey(
        input.sourceId,
        input.targetId,
        input.relationType
      );
      const expired = createTestProposalDoc({
        id: legacyKey,
        status: 'rejected',
        updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
      });
      mockGetDoc
        .mockResolvedValueOnce(mockDocSnapshot(null))
        .mockResolvedValueOnce(mockDocSnapshot(expired));
      const txGet = jest
        .fn()
        .mockResolvedValueOnce(mockDocSnapshot(null))
        .mockResolvedValueOnce(mockDocSnapshot(expired));
      const txSet = jest.fn();
      const txDelete = jest.fn();
      mockRunTransaction.mockImplementationOnce(
        async (
          _db: unknown,
          operation: (transaction: {
            get: typeof txGet;
            set: typeof txSet;
            delete: typeof txDelete;
          }) => unknown
        ) => operation({ get: txGet, set: txSet, delete: txDelete })
      );

      const result = await createProposedRelationIfNotExists(input);

      expect(result.created).toBe(true);
      expect(result.proposal.id).toBe(currentKey);
      expect(txSet).toHaveBeenCalledTimes(1);
      expect(txDelete).toHaveBeenCalledTimes(1);
      expect(mockSetDoc).not.toHaveBeenCalled();
    });

    it('removes the legacy archive when a concurrent v2 proposal wins migration', async () => {
      const input = createTestProposalInput();
      const currentKey = generateProposalKey(
        input.sourceId,
        input.targetId,
        input.relationType
      );
      const legacyKey = generateLegacyProposalKey(
        input.sourceId,
        input.targetId,
        input.relationType
      );
      const expired = createTestProposalDoc({
        id: legacyKey,
        status: 'rejected',
        updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
      });
      const concurrent = createTestProposalDoc({
        id: currentKey,
        status: 'pending',
      });
      mockGetDoc
        .mockResolvedValueOnce(mockDocSnapshot(null))
        .mockResolvedValueOnce(mockDocSnapshot(expired));
      const txGet = jest
        .fn()
        .mockResolvedValueOnce(mockDocSnapshot(concurrent))
        .mockResolvedValueOnce(mockDocSnapshot(expired));
      const txSet = jest.fn();
      const txDelete = jest.fn();
      mockRunTransaction.mockImplementationOnce(
        async (
          _db: unknown,
          operation: (transaction: {
            get: typeof txGet;
            set: typeof txSet;
            delete: typeof txDelete;
          }) => unknown
        ) => operation({ get: txGet, set: txSet, delete: txDelete })
      );

      await expect(createProposedRelationIfNotExists(input)).resolves.toEqual({
        created: false,
        proposal: concurrent,
        reason: 'already_pending',
      });
      expect(txSet).not.toHaveBeenCalled();
      expect(txDelete).toHaveBeenCalledTimes(1);
    });

    it('preserves a newer rejection-retention timestamp while converging equivalent archives', async () => {
      const input = createTestProposalInput();
      const [currentKey, legacyKey] = generateProposalKeyCandidates(
        input.sourceId,
        input.targetId,
        input.relationType
      );
      const oldUpdatedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
      const recentUpdatedAt = Date.now() - 60 * 60 * 1000;
      const current = createTestProposalDoc({
        id: currentKey,
        status: 'rejected',
        createdAt: 200,
        updatedAt: oldUpdatedAt,
      });
      const legacy = {
        ...current,
        id: legacyKey,
        createdAt: 100,
        updatedAt: recentUpdatedAt,
      };
      mockGetDoc
        .mockResolvedValueOnce(mockDocSnapshot(current))
        .mockResolvedValueOnce(mockDocSnapshot(legacy));

      const result = await createProposedRelationIfNotExists(input);

      expect(result).toMatchObject({
        created: false,
        reason: 'recently_rejected',
        proposal: {
          id: currentKey,
          status: 'rejected',
          createdAt: 100,
          updatedAt: recentUpdatedAt,
        },
      });
      expect(mockSetDoc).toHaveBeenCalledWith(
        expect.objectContaining({ id: currentKey }),
        expect.objectContaining({ createdAt: 100, updatedAt: recentUpdatedAt })
      );
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    });

    it('should not create when recently rejected', async () => {
      const existing = createTestProposalDoc({
        status: 'rejected',
        updatedAt: Date.now() - 1000 * 60 * 60, // 1 hour ago (within 30 days)
      });
      mockGetDoc.mockResolvedValue(mockDocSnapshot(existing));

      const input = createTestProposalInput();
      const result = await createProposedRelationIfNotExists(input);

      expect(result.created).toBe(false);
      expect(result.reason).toBe('recently_rejected');
    });

    it('should not create when dismissed', async () => {
      const existing = createTestProposalDoc({ status: 'dismissed' });
      mockGetDoc.mockResolvedValue(mockDocSnapshot(existing));

      const input = createTestProposalInput();
      const result = await createProposedRelationIfNotExists(input);

      expect(result.created).toBe(false);
      expect(result.reason).toBe('dismissed');
    });

    it('should not recreate a relation explicitly removed by the user', async () => {
      const existing = createTestProposalDoc({ status: 'removed' });
      mockGetDoc.mockResolvedValue(mockDocSnapshot(existing));

      const result = await createProposedRelationIfNotExists(createTestProposalInput());

      expect(result.created).toBe(false);
      expect(result.reason).toBe('removed');
      expect(result.proposal.status).toBe('removed');
    });

    it('should not create when already approved', async () => {
      const existing = createTestProposalDoc({ status: 'approved' });
      mockGetDoc.mockResolvedValue(mockDocSnapshot(existing));

      const input = createTestProposalInput();
      const result = await createProposedRelationIfNotExists(input);

      expect(result.created).toBe(false);
      expect(result.reason).toBe('already_approved');
    });

    it('should truncate evidence array to limit', async () => {
      mockGetDoc.mockResolvedValue(mockDocSnapshot(null));
      mockSetDoc.mockResolvedValue(undefined);

      const manyEvidence = Array.from({ length: 20 }, (_, i) => ({
        type: 'web_ref' as const,
        snippet: `Evidence ${i}`,
        capturedAt: Date.now(),
      }));

      const input = createTestProposalInput({
        evidence: manyEvidence,
      } as unknown as Partial<CreateProposedRelationInput>);
      const result = await createProposedRelationIfNotExists(input);

      expect(result.created).toBe(true);
      expect(result.proposal.evidence.length).toBeLessThanOrEqual(LIMITS.EVIDENCE_ARRAY_MAX);
    });
  });

  describe('createProposedRelation()', () => {
    it('should delegate to createProposedRelationIfNotExists', async () => {
      mockGetDoc.mockResolvedValue(mockDocSnapshot(null));
      mockSetDoc.mockResolvedValue(undefined);

      const input = createTestProposalInput();
      const result = await createProposedRelation(input);

      expect(result).toBeDefined();
      expect(result.status).toBe('pending');
    });
  });

  describe('updateProposedRelation()', () => {
    it('should update existing proposal', async () => {
      const existing = createTestProposalDoc({ id: 'update-me' });
      mockGetDoc.mockResolvedValue(mockDocSnapshot(existing));
      mockUpdateDoc.mockResolvedValue(undefined);

      const result = await updateProposedRelation('update-me', {
        status: 'approved',
      });

      expect(result.status).toBe('approved');
      expect(mockUpdateDoc).toHaveBeenCalled();
    });

    it('should throw for non-existent proposal', async () => {
      mockGetDoc.mockResolvedValue(mockDocSnapshot(null));

      await expect(updateProposedRelation('nonexistent', { status: 'approved' })).rejects.toThrow(
        'Proposed relation not found'
      );
    });
  });

  // ==========================================================================
  // TRIAGE OPERATIONS
  // ==========================================================================

  describe('approveProposedRelation()', () => {
    it('should approve a pending proposal', async () => {
      const pending = createTestProposalDoc({ id: 'approve-me', status: 'pending' });
      // getDoc called: 1) getProposedRelationById, 2) updateProposedRelation,
      // plus potentially more from Task 0.2b atomic relation creation (best-effort)
      mockGetDoc.mockResolvedValue(mockDocSnapshot(pending));
      mockUpdateDoc.mockResolvedValue(undefined);

      const result = await approveProposedRelation('approve-me', 'user-1');

      expect(result.status).toBe('approved');
    });

    it('should be idempotent for already approved proposals', async () => {
      const approved = createTestProposalDoc({ id: 'already-approved', status: 'approved' });
      mockGetDoc.mockResolvedValue(mockDocSnapshot(approved));

      const result = await approveProposedRelation('already-approved', 'user-1');

      expect(result.status).toBe('approved');
      expect(mockUpdateDoc).not.toHaveBeenCalled();
    });

    it('should throw for rejected proposals', async () => {
      const rejected = createTestProposalDoc({ id: 'rejected-one', status: 'rejected' });
      mockGetDoc.mockResolvedValue(mockDocSnapshot(rejected));

      await expect(approveProposedRelation('rejected-one', 'user-1')).rejects.toThrow('Proposal is not pending');
    });

    it('should throw for non-existent proposals', async () => {
      mockGetDoc.mockResolvedValue(mockDocSnapshot(null));

      await expect(approveProposedRelation('missing', 'user-1')).rejects.toThrow('Proposed relation not found');
    });
  });

  describe('rejectProposedRelation()', () => {
    it('should reject a pending proposal', async () => {
      const pending = createTestProposalDoc({ id: 'reject-me', status: 'pending' });
      mockGetDoc.mockResolvedValueOnce(mockDocSnapshot(pending)).mockResolvedValueOnce(mockDocSnapshot(pending));
      mockUpdateDoc.mockResolvedValue(undefined);

      const result = await rejectProposedRelation('reject-me', 'user-1', 'Not relevant');

      expect(result.status).toBe('rejected');
    });

    it('should be idempotent for already rejected proposals', async () => {
      const rejected = createTestProposalDoc({ id: 'already-rejected', status: 'rejected' });
      mockGetDoc.mockResolvedValue(mockDocSnapshot(rejected));

      const result = await rejectProposedRelation('already-rejected', 'user-1');

      expect(result.status).toBe('rejected');
      expect(mockUpdateDoc).not.toHaveBeenCalled();
    });

    it('should throw for non-pending proposals', async () => {
      const approved = createTestProposalDoc({ id: 'approved-one', status: 'approved' });
      mockGetDoc.mockResolvedValue(mockDocSnapshot(approved));

      await expect(rejectProposedRelation('approved-one', 'user-1')).rejects.toThrow('Proposal is not pending');
    });
  });

  describe('dismissProposedRelation()', () => {
    it('should dismiss a proposal', async () => {
      const pending = createTestProposalDoc({ id: 'dismiss-me', status: 'pending' });
      mockGetDoc.mockResolvedValueOnce(mockDocSnapshot(pending)).mockResolvedValueOnce(mockDocSnapshot(pending));
      mockUpdateDoc.mockResolvedValue(undefined);

      const result = await dismissProposedRelation('dismiss-me', 'user-1');

      expect(result.status).toBe('dismissed');
    });

    it('should throw for non-existent proposals', async () => {
      mockGetDoc.mockResolvedValue(mockDocSnapshot(null));

      await expect(dismissProposedRelation('missing', 'user-1')).rejects.toThrow('Proposed relation not found');
    });
  });

  describe('revertProposedRelation()', () => {
    it('should revert rejected proposal to pending', async () => {
      const rejected = createTestProposalDoc({ id: 'revert-me', status: 'rejected' });
      mockGetDoc.mockResolvedValueOnce(mockDocSnapshot(rejected)).mockResolvedValueOnce(mockDocSnapshot(rejected));
      mockUpdateDoc.mockResolvedValue(undefined);

      const result = await revertProposedRelation('revert-me', 'user-1');

      expect(result.status).toBe('pending');
    });

    it('should revert dismissed proposal to pending', async () => {
      const dismissed = createTestProposalDoc({ id: 'revert-dismissed', status: 'dismissed' });
      mockGetDoc.mockResolvedValueOnce(mockDocSnapshot(dismissed)).mockResolvedValueOnce(mockDocSnapshot(dismissed));
      mockUpdateDoc.mockResolvedValue(undefined);

      const result = await revertProposedRelation('revert-dismissed', 'user-1');

      expect(result.status).toBe('pending');
    });

    it('should throw for pending proposals', async () => {
      const pending = createTestProposalDoc({ id: 'pending-one', status: 'pending' });
      mockGetDoc.mockResolvedValue(mockDocSnapshot(pending));

      await expect(revertProposedRelation('pending-one', 'user-1')).rejects.toThrow(
        'Cannot revert proposal with status: pending'
      );
    });

    it('should throw for approved proposals', async () => {
      const approved = createTestProposalDoc({ id: 'approved-one', status: 'approved' });
      mockGetDoc.mockResolvedValue(mockDocSnapshot(approved));

      await expect(revertProposedRelation('approved-one', 'user-1')).rejects.toThrow(
        'Cannot revert proposal with status: approved'
      );
    });
  });

  describe('markProposedRelationAsRemoved()', () => {
    it('should mark approved proposal as removed', async () => {
      const approved = createTestProposalDoc({ id: 'remove-me', status: 'approved' });
      mockGetDoc.mockResolvedValueOnce(mockDocSnapshot(approved)).mockResolvedValueOnce(mockDocSnapshot(approved));
      mockUpdateDoc.mockResolvedValue(undefined);

      const result = await markProposedRelationAsRemoved('remove-me', 'user-1');

      expect(result.status).toBe('removed');
    });

    it('should throw for non-approved proposals', async () => {
      const pending = createTestProposalDoc({ id: 'pending-one', status: 'pending' });
      mockGetDoc.mockResolvedValue(mockDocSnapshot(pending));

      await expect(markProposedRelationAsRemoved('pending-one', 'user-1')).rejects.toThrow('Cannot mark as removed');
    });
  });

  // ==========================================================================
  // BULK OPERATIONS
  // ==========================================================================

  describe('bulkApproveProposedRelations()', () => {
    it('should approve multiple proposals', async () => {
      const pending1 = createTestProposalDoc({ id: 'b1', status: 'pending' });
      const _pending2 = createTestProposalDoc({ id: 'b2', status: 'pending' });
      mockGetDoc.mockImplementation((..._args: unknown[]) => {
        // Alternate returning pending docs for approve then for update
        return Promise.resolve(mockDocSnapshot(pending1));
      });
      mockUpdateDoc.mockResolvedValue(undefined);

      const result = await bulkApproveProposedRelations(['b1', 'b2'], 'user-1');

      expect(result.approved).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should track failures in bulk approve', async () => {
      mockGetDoc.mockResolvedValue(mockDocSnapshot(null)); // Not found

      const result = await bulkApproveProposedRelations(['missing-1', 'missing-2'], 'user-1');

      expect(result.failed).toBe(2);
      expect(result.errors.length).toBe(2);
    });
  });

  describe('bulkRejectProposedRelations()', () => {
    it('should reject multiple proposals', async () => {
      const pending = createTestProposalDoc({ id: 'br1', status: 'pending' });
      mockGetDoc.mockResolvedValue(mockDocSnapshot(pending));
      mockUpdateDoc.mockResolvedValue(undefined);

      const result = await bulkRejectProposedRelations(['br1', 'br2'], 'user-1');

      expect(result.rejected).toBe(2);
      expect(result.failed).toBe(0);
    });
  });

  describe('bulkDeleteProposedRelations()', () => {
    it('should delete multiple proposals', async () => {
      mockDeleteDoc.mockResolvedValue(undefined);

      const result = await bulkDeleteProposedRelations(['d1', 'd2', 'd3']);

      expect(result.deleted).toBe(3);
      expect(result.failed).toBe(0);
    });

    it('should track failures in bulk delete', async () => {
      mockDeleteDoc.mockRejectedValue(new Error('Delete failed'));

      const result = await bulkDeleteProposedRelations(['d1']);

      expect(result.failed).toBe(1);
      expect(result.errors.length).toBe(1);
    });
  });

  // ==========================================================================
  // CLEANUP OPERATIONS
  // ==========================================================================

  describe('deleteProposedRelation()', () => {
    it('should delete a proposal', async () => {
      mockDeleteDoc.mockResolvedValue(undefined);

      await deleteProposedRelation('to-delete');

      expect(mockDeleteDoc).toHaveBeenCalled();
    });
  });

  describe('getPendingProposalsBetween()', () => {
    it('should find proposals between two entities in both directions', async () => {
      const proposal1 = createTestProposalDoc({ id: 'between-1' });
      const proposal2 = createTestProposalDoc({ id: 'between-2' });

      mockGetDocs
        .mockResolvedValueOnce(mockQuerySnapshot([proposal1]))
        .mockResolvedValueOnce(mockQuerySnapshot([proposal2]));

      const result = await getPendingProposalsBetween('entity-a', 'entity-b');

      expect(result).toHaveLength(2);
    });

    it('should return empty when no pending proposals exist between entities', async () => {
      mockGetDocs.mockResolvedValueOnce(mockQuerySnapshot([])).mockResolvedValueOnce(mockQuerySnapshot([]));

      const result = await getPendingProposalsBetween('entity-a', 'entity-b');

      expect(result).toHaveLength(0);
    });
  });

  describe('cleanupOldRejectedProposals()', () => {
    it('should delete old rejected proposals', async () => {
      const oldRejected = createTestProposalDoc({ id: 'old-rej', status: 'rejected' });
      mockGetDocs.mockResolvedValue({
        docs: [
          {
            data: () => oldRejected,
            id: 'old-rej',
            ref: { path: 'proposedRelations/old-rej' },
          },
        ],
        size: 1,
        empty: false,
      });
      mockDeleteDoc.mockResolvedValue(undefined);

      const count = await cleanupOldRejectedProposals();

      expect(count).toBe(1);
      expect(mockDeleteDoc).toHaveBeenCalled();
    });

    it('should return 0 when no old rejected proposals', async () => {
      mockGetDocs.mockResolvedValue({
        docs: [],
        size: 0,
        empty: true,
      });

      const count = await cleanupOldRejectedProposals();

      expect(count).toBe(0);
    });
  });

  describe('cleanupOrphanedProposals()', () => {
    it('should clean up proposals with missing entities', async () => {
      const orphanedProposal = createTestProposalDoc({
        id: 'orphan-1',
        status: 'pending',
        sourceType: 'company',
        sourceId: 'missing-company',
      });

      // getProposedRelations (pending) returns the orphan
      mockGetDocs.mockResolvedValue(mockQuerySnapshot([orphanedProposal]));

      // checkEntityExists - source entity doesn't exist
      mockGetDoc.mockResolvedValue(mockDocSnapshot(null));
      mockDeleteDoc.mockResolvedValue(undefined);

      const result = await cleanupOrphanedProposals();

      expect(result.checked).toBe(1);
      expect(result.orphaned).toBe(1);
      expect(result.deleted).toBe(1);
    });

    it('should not delete proposals where both entities exist', async () => {
      const validProposal = createTestProposalDoc({
        id: 'valid-1',
        status: 'pending',
      });

      mockGetDocs.mockResolvedValue(mockQuerySnapshot([validProposal]));

      // Both entities exist
      mockGetDoc.mockResolvedValue({
        exists: () => true,
        data: () => ({ id: 'existing' }),
      });

      const result = await cleanupOrphanedProposals();

      expect(result.checked).toBe(1);
      expect(result.orphaned).toBe(0);
      expect(result.deleted).toBe(0);
    });
  });
});
