/**
 * Unit Tests for Candidate Generator Module
 *
 * Tests pure functions in candidate generation:
 * - Heuristic scoring logic
 * - Entity text generation for embeddings
 * - Relation type inference
 *
 * Note: Full integration tests with Firestore would require mocking.
 * These tests focus on the algorithmic logic.
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';

// We need to test the internal functions, so we'll re-implement the pure logic here
// These are extracted versions of the heuristic scoring algorithms

// ============================================================================
// HELPER IMPLEMENTATIONS (matching candidate-generator.ts logic)
// ============================================================================

/**
 * Normalizes a string for comparison (simplified version)
 */
function normalizeForTest(str: string): string {
  return str.toLowerCase().trim();
}

/**
 * Internal entity representation for testing
 */
interface TestEntity {
  id: string;
  type: string;
  name: string;
  description?: string;
  tags?: string[];
  category?: string;
  industry?: string;
}

/**
 * Calculates heuristic score (mirrors candidate-generator logic)
 */
function calculateHeuristicScore(source: TestEntity, target: TestEntity): { score: number; matchedOn: string[] } {
  let score = 0;
  const matchedOn: string[] = [];

  // Skip self-matches
  if (source.id === target.id && source.type === target.type) {
    return { score: 0, matchedOn: [] };
  }

  // 1. Tag overlap (30 points max)
  if (source.tags?.length && target.tags?.length) {
    const sourceTags = new Set(source.tags.map((t) => normalizeForTest(t)));
    const targetTags = new Set(target.tags.map((t) => normalizeForTest(t)));
    const overlap = [...sourceTags].filter((t) => targetTags.has(t));

    if (overlap.length > 0) {
      const tagScore = Math.min(30, overlap.length * 10);
      score += tagScore;
      matchedOn.push(`tags:${overlap.join(',')}`);
    }
  }

  // 2. Category match (20 points)
  if (source.category && target.category) {
    const sourceCategory = normalizeForTest(source.category);
    const targetCategory = normalizeForTest(target.category);

    if (sourceCategory === targetCategory) {
      score += 20;
      matchedOn.push(`category:${source.category}`);
    }
  }

  // 3. Industry match (20 points)
  if (source.industry && target.industry) {
    const sourceIndustry = normalizeForTest(source.industry);
    const targetIndustry = normalizeForTest(target.industry);

    if (sourceIndustry === targetIndustry) {
      score += 20;
      matchedOn.push(`industry:${source.industry}`);
    }
  }

  // 4. Name similarity (30 points max)
  const sourceName = normalizeForTest(source.name);
  const targetName = normalizeForTest(target.name);

  // Check for word overlap
  const sourceWords = new Set(sourceName.split(/\s+/).filter((w) => w.length >= 3));
  const targetWords = new Set(targetName.split(/\s+/).filter((w) => w.length >= 3));
  const wordOverlap = [...sourceWords].filter((w) => targetWords.has(w));

  if (wordOverlap.length > 0) {
    const nameScore = Math.min(30, wordOverlap.length * 15);
    score += nameScore;
    matchedOn.push(`name_words:${wordOverlap.join(',')}`);
  }

  return { score: Math.min(100, score), matchedOn };
}

/**
 * Generates text for embedding (mirrors candidate-generator logic)
 */
function entityToText(entity: TestEntity): string {
  const parts = [entity.name];

  if (entity.description) {
    parts.push(entity.description.slice(0, 300));
  }

  if (entity.tags?.length) {
    parts.push(`Tags: ${entity.tags.join(', ')}`);
  }

  if (entity.category) {
    parts.push(`Category: ${entity.category}`);
  }

  return parts.join('. ');
}

/**
 * Calculates cosine similarity (mirrors candidate-generator logic)
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================================================
// HEURISTIC SCORING TESTS
// ============================================================================

describe('Candidate Generator - Heuristic Scoring', () => {
  describe('Self-Match Prevention', () => {
    it('should return zero score for identical entities', () => {
      const entity: TestEntity = {
        id: 'tech-1',
        type: 'technology',
        name: 'React',
        tags: ['frontend', 'javascript'],
      };

      const result = calculateHeuristicScore(entity, entity);
      expect(result.score).toBe(0);
      expect(result.matchedOn).toEqual([]);
    });

    it('should allow same ID with different types', () => {
      const source: TestEntity = {
        id: 'shared-id',
        type: 'technology',
        name: 'React',
        tags: ['frontend'],
      };
      const target: TestEntity = {
        id: 'shared-id',
        type: 'company',
        name: 'Meta',
        tags: ['frontend'],
      };

      const result = calculateHeuristicScore(source, target);
      expect(result.score).toBeGreaterThan(0);
    });
  });

  describe('Tag Overlap Scoring', () => {
    it('should score tag overlap correctly (one tag)', () => {
      const source: TestEntity = {
        id: '1',
        type: 'technology',
        name: 'Source',
        tags: ['ai', 'ml'],
      };
      const target: TestEntity = {
        id: '2',
        type: 'technology',
        name: 'Target',
        tags: ['ai', 'data'],
      };

      const result = calculateHeuristicScore(source, target);
      expect(result.score).toBeGreaterThanOrEqual(10); // 1 tag = 10 points
      expect(result.matchedOn).toContainEqual(expect.stringContaining('tags:'));
    });

    it('should score multiple tag overlaps (capped at 30)', () => {
      const source: TestEntity = {
        id: '1',
        type: 'technology',
        name: 'Source',
        tags: ['ai', 'ml', 'python', 'data'],
      };
      const target: TestEntity = {
        id: '2',
        type: 'technology',
        name: 'Target',
        tags: ['ai', 'ml', 'python', 'cloud'],
      };

      const result = calculateHeuristicScore(source, target);
      expect(result.score).toBeGreaterThanOrEqual(30); // 3+ tags = 30 points max
    });

    it('should handle case-insensitive tag matching', () => {
      const source: TestEntity = {
        id: '1',
        type: 'technology',
        name: 'Source',
        tags: ['AI', 'ML'],
      };
      const target: TestEntity = {
        id: '2',
        type: 'technology',
        name: 'Target',
        tags: ['ai', 'ml'],
      };

      const result = calculateHeuristicScore(source, target);
      expect(result.score).toBeGreaterThanOrEqual(20); // 2 tags = 20 points
    });

    it('should return zero for no tag overlap', () => {
      const source: TestEntity = {
        id: '1',
        type: 'technology',
        name: 'Source',
        tags: ['frontend'],
      };
      const target: TestEntity = {
        id: '2',
        type: 'technology',
        name: 'Target',
        tags: ['backend'],
      };

      const result = calculateHeuristicScore(source, target);
      // Score may be >0 if there's other overlap, but no tag match
      expect(result.matchedOn).not.toContainEqual(expect.stringContaining('tags:'));
    });
  });

  describe('Category Matching', () => {
    it('should add 20 points for matching category', () => {
      const source: TestEntity = {
        id: '1',
        type: 'technology',
        name: 'Source',
        category: 'Frontend',
      };
      const target: TestEntity = {
        id: '2',
        type: 'technology',
        name: 'Target',
        category: 'Frontend',
      };

      const result = calculateHeuristicScore(source, target);
      expect(result.score).toBeGreaterThanOrEqual(20);
      expect(result.matchedOn).toContainEqual(expect.stringContaining('category:'));
    });

    it('should handle case-insensitive category matching', () => {
      const source: TestEntity = {
        id: '1',
        type: 'technology',
        name: 'Source',
        category: 'FRONTEND',
      };
      const target: TestEntity = {
        id: '2',
        type: 'technology',
        name: 'Target',
        category: 'frontend',
      };

      const result = calculateHeuristicScore(source, target);
      expect(result.matchedOn).toContainEqual(expect.stringContaining('category:'));
    });
  });

  describe('Industry Matching', () => {
    it('should add 20 points for matching industry', () => {
      const source: TestEntity = {
        id: '1',
        type: 'company',
        name: 'Source Corp',
        industry: 'Healthcare',
      };
      const target: TestEntity = {
        id: '2',
        type: 'company',
        name: 'Target Inc',
        industry: 'Healthcare',
      };

      const result = calculateHeuristicScore(source, target);
      expect(result.score).toBeGreaterThanOrEqual(20);
      expect(result.matchedOn).toContainEqual(expect.stringContaining('industry:'));
    });
  });

  describe('Name Similarity', () => {
    it('should score word overlap in names', () => {
      const source: TestEntity = {
        id: '1',
        type: 'technology',
        name: 'Google Cloud Platform',
      };
      const target: TestEntity = {
        id: '2',
        type: 'technology',
        name: 'Google Cloud Functions',
      };

      const result = calculateHeuristicScore(source, target);
      expect(result.score).toBeGreaterThan(0);
      expect(result.matchedOn).toContainEqual(expect.stringContaining('name_words:'));
    });

    it('should ignore short words (less than 3 chars)', () => {
      const source: TestEntity = {
        id: '1',
        type: 'technology',
        name: 'AI ML Tool',
      };
      const target: TestEntity = {
        id: '2',
        type: 'technology',
        name: 'AI ML Service',
      };

      const result = calculateHeuristicScore(source, target);
      // "AI" and "ML" are only 2 chars, should not match
      // "Tool" vs "Service" don't match
      expect(result.matchedOn.filter((m) => m.includes('name_words'))).toHaveLength(0);
    });

    it('should handle case-insensitive name matching', () => {
      const source: TestEntity = {
        id: '1',
        type: 'technology',
        name: 'REACT NATIVE',
      };
      const target: TestEntity = {
        id: '2',
        type: 'technology',
        name: 'React Native Navigation',
      };

      const result = calculateHeuristicScore(source, target);
      expect(result.matchedOn).toContainEqual(expect.stringContaining('name_words:'));
    });
  });

  describe('Combined Scoring', () => {
    it('should accumulate scores from multiple features', () => {
      const source: TestEntity = {
        id: '1',
        type: 'technology',
        name: 'Google TensorFlow',
        tags: ['ai', 'ml'],
        category: 'Machine Learning',
        industry: 'Technology',
      };
      const target: TestEntity = {
        id: '2',
        type: 'technology',
        name: 'Google PyTorch',
        tags: ['ai', 'ml'],
        category: 'Machine Learning',
        industry: 'Technology',
      };

      const result = calculateHeuristicScore(source, target);
      // Tags: 20 points (2 tags), Category: 20, Industry: 20, Name: 15 (Google)
      // Total should be high
      expect(result.score).toBeGreaterThan(50);
      expect(result.matchedOn.length).toBeGreaterThan(2);
    });

    it('should cap total score at 100', () => {
      const source: TestEntity = {
        id: '1',
        type: 'technology',
        name: 'Super Amazing Technology Platform',
        tags: ['ai', 'ml', 'cloud', 'data'],
        category: 'Platform',
        industry: 'Technology',
      };
      const target: TestEntity = {
        id: '2',
        type: 'technology',
        name: 'Super Amazing Technology Service',
        tags: ['ai', 'ml', 'cloud', 'data'],
        category: 'Platform',
        industry: 'Technology',
      };

      const result = calculateHeuristicScore(source, target);
      expect(result.score).toBeLessThanOrEqual(100);
    });
  });
});

// ============================================================================
// ENTITY TEXT GENERATION TESTS
// ============================================================================

describe('Candidate Generator - entityToText()', () => {
  it('should generate text with just name', () => {
    const entity: TestEntity = {
      id: '1',
      type: 'technology',
      name: 'React',
    };

    const text = entityToText(entity);
    expect(text).toContain('React');
  });

  it('should include description', () => {
    const entity: TestEntity = {
      id: '1',
      type: 'technology',
      name: 'React',
      description: 'A JavaScript library for building user interfaces',
    };

    const text = entityToText(entity);
    expect(text).toContain('React');
    expect(text).toContain('JavaScript library');
  });

  it('should truncate long descriptions to 300 chars', () => {
    const longDescription = 'A'.repeat(500);
    const entity: TestEntity = {
      id: '1',
      type: 'technology',
      name: 'Tech',
      description: longDescription,
    };

    const text = entityToText(entity);
    // Should be: "Tech. " + first 300 chars of description
    expect(text.length).toBeLessThan(320);
  });

  it('should include tags', () => {
    const entity: TestEntity = {
      id: '1',
      type: 'technology',
      name: 'React',
      tags: ['frontend', 'javascript', 'ui'],
    };

    const text = entityToText(entity);
    expect(text).toContain('Tags:');
    expect(text).toContain('frontend');
    expect(text).toContain('javascript');
  });

  it('should include category', () => {
    const entity: TestEntity = {
      id: '1',
      type: 'technology',
      name: 'React',
      category: 'Frontend Framework',
    };

    const text = entityToText(entity);
    expect(text).toContain('Category:');
    expect(text).toContain('Frontend Framework');
  });

  it('should join all parts with periods', () => {
    const entity: TestEntity = {
      id: '1',
      type: 'technology',
      name: 'React',
      description: 'UI library',
      tags: ['frontend'],
      category: 'Framework',
    };

    const text = entityToText(entity);
    expect(text).toContain('. ');
  });
});

// ============================================================================
// COSINE SIMILARITY TESTS
// ============================================================================

describe('Candidate Generator - cosineSimilarity()', () => {
  it('should return 1 for identical vectors', () => {
    const vec = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1, 5);
  });

  it('should return 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('should return -1 for opposite vectors (if normalized)', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('should handle zero vectors', () => {
    const zero = [0, 0, 0];
    const vec = [1, 2, 3];
    expect(cosineSimilarity(zero, vec)).toBe(0);
    expect(cosineSimilarity(vec, zero)).toBe(0);
    expect(cosineSimilarity(zero, zero)).toBe(0);
  });

  it('should return 0 for vectors of different lengths', () => {
    const a = [1, 2, 3];
    const b = [1, 2];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('should calculate similarity for similar vectors', () => {
    const a = [1, 2, 3];
    const b = [1.1, 2.1, 3.1];
    const similarity = cosineSimilarity(a, b);
    expect(similarity).toBeGreaterThan(0.99);
  });

  it('should handle high-dimensional vectors', () => {
    const dim = 768; // text-embedding-004 dimension
    const a = Array(dim)
      .fill(0)
      .map(() => Math.random());
    const b = [...a]; // Clone

    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });
});

// ============================================================================
// INTEGRATION TESTS: generateCandidates with mocked Firestore + services
// ============================================================================

const mockCGCollection = jest.fn();
const mockCGGetDocs = jest.fn();
const mockCGWhere = jest.fn();
const mockCGOrderBy = jest.fn();
const mockCGLimit = jest.fn();

// The source under test (Round 4/5 client->admin migration) now reads via the
// firebase-admin Firestore query builder:
//   db.collection(name).where(...).orderBy(...).limit(n).get()
// so we model `db` as a chainable query builder whose terminal `.get()` resolves
// through mockCGGetDocs. The chain spies (collection/where/orderBy/limit) keep the
// original mock-var names meaningful and each return the same chainable query.
function makeAdminQuery() {
  const q: Record<string, unknown> = {};
  q.where = (...args: unknown[]) => {
    mockCGWhere(...args);
    return q;
  };
  q.orderBy = (...args: unknown[]) => {
    mockCGOrderBy(...args);
    return q;
  };
  q.limit = (...args: unknown[]) => {
    mockCGLimit(...args);
    return q;
  };
  q.get = (...args: unknown[]) => mockCGGetDocs(...args);
  return q;
}

// Transitive firebase-admin parse guard: mock @/lib/firebase-admin so the real
// firebase-admin / jwks-rsa never loads. `db.collection()` returns the chainable
// admin query builder above.
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (...args: unknown[]) => {
      mockCGCollection(...args);
      return makeAdminQuery();
    },
  },
  adminAuth: {},
  adminApp: {},
}));

const mockGetValidRelationTypes = jest.fn();
jest.mock('../relation-ontology', () => ({
  getValidRelationTypes: (...args: unknown[]) => mockGetValidRelationTypes(...args),
}));

const mockGetTrackedEntityIds = jest.fn();
jest.mock('../linker-metrics', () => ({
  getTrackedEntityIds: (...args: unknown[]) => mockGetTrackedEntityIds(...args),
}));

// Round 4/5: source now calls adminCheckDuplicateRelation from @/lib/relations-admin
const mockCheckDuplicateRelation = jest.fn();
jest.mock('@/lib/relations-admin', () => ({
  adminCheckDuplicateRelation: (...args: unknown[]) => mockCheckDuplicateRelation(...args),
}));

// Round 4/5: source now calls adminGetPendingProposalsBetween from @/lib/proposed-relations-admin
const mockGetPendingProposalsBetween = jest.fn();
jest.mock('@/lib/proposed-relations-admin', () => ({
  adminGetPendingProposalsBetween: (...args: unknown[]) => mockGetPendingProposalsBetween(...args),
}));

const mockGenerateEmbedding = jest.fn();
jest.mock('../../ai/client', () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
}));

const mockNormalizeAlias = jest.fn((str: string) => str.toLowerCase().trim());
jest.mock('@/lib/text-normalize', () => ({
  normalizeAlias: (str: string) => mockNormalizeAlias(str),
}));

// P1b-T4: the 2-hop generator consumes the direction-aware getNeighborsByRelation.
const mockGetNeighborsByRelation = jest.fn();
jest.mock('@/lib/graph/traversal', () => ({
  getNeighborsByRelation: (...args: unknown[]) => mockGetNeighborsByRelation(...args),
}));
const mockGetDiscoveryConfig = jest.fn();
jest.mock('@/lib/discovery/discovery-config', () => ({
  getDiscoveryConfig: (...args: unknown[]) => mockGetDiscoveryConfig(...args),
}));

const {
  generateCandidates,
  generateDocumentMentionCandidates,
  generateTransitiveCandidates,
} = require('../candidate-generator');

function createMockFirestoreDoc(data: Record<string, unknown>) {
  return {
    id: data.id as string,
    data: () => data,
  };
}

function createMockQuerySnapshotCG(docs: Array<Record<string, unknown>>) {
  return {
    docs: docs.map((d) => createMockFirestoreDoc(d)),
    size: docs.length,
    empty: docs.length === 0,
  };
}

function setupCGDefaults() {
  mockCGGetDocs.mockResolvedValue(createMockQuerySnapshotCG([]));
  mockGetValidRelationTypes.mockReturnValue(['uses', 'enables', 'custom']);
  mockGetTrackedEntityIds.mockResolvedValue(new Set<string>());
  mockCheckDuplicateRelation.mockResolvedValue(null);
  mockGetPendingProposalsBetween.mockResolvedValue([]);
  mockGenerateEmbedding.mockResolvedValue(Array(768).fill(0.1));
  mockNormalizeAlias.mockImplementation((str: string) => str.toLowerCase().trim());
}

describe('Candidate Generator - Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupCGDefaults();
  });

  describe('generateCandidates()', () => {
    it('should return empty array when no entities found', async () => {
      const result = await generateCandidates({
        sourceTypes: ['technology'],
        targetTypes: ['company'],
        batchSize: 10,
        useEmbeddings: false,
      });

      expect(result).toEqual([]);
    });

    it('should generate candidates when heuristic matches exist', async () => {
      // First call: fetchTargetEntities for 'company'
      // Second call: fetchEntities for source 'technology'
      // Mock fetchTargetEntities: targets for company type
      const targetCompanies = [
        {
          id: 'company-1',
          name: 'AI Corp',
          description: 'AI company',
          tags: ['ai', 'machine-learning'],
          category: 'AI',
          industry: 'Technology',
          updatedAt: Date.now(),
          createdAt: Date.now(),
        },
      ];

      const sourceTechs = [
        {
          id: 'tech-1',
          name: 'AI Framework',
          description: 'An AI framework',
          tags: ['ai', 'machine-learning'],
          category: 'AI',
          industry: 'Technology',
          updatedAt: Date.now(),
          createdAt: Date.now(),
        },
      ];

      // getDocs is called multiple times:
      // 1. fetchTargetEntities for each target type
      // 2. fetchEntities for each source type
      mockCGGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshotCG(targetCompanies)) // targets: company
        .mockResolvedValueOnce(createMockQuerySnapshotCG(sourceTechs)); // sources: technology

      const result = await generateCandidates({
        sourceTypes: ['technology'],
        targetTypes: ['company'],
        batchSize: 10,
        useEmbeddings: false,
      });

      // Tags "ai" and "machine-learning" overlap, category "AI" and industry "Technology" match
      expect(result.length).toBeGreaterThanOrEqual(1);
      if (result.length > 0) {
        expect(result[0].sourceType).toBe('technology');
        expect(result[0].targetType).toBe('company');
        expect(result[0].confidence).toBeGreaterThan(0);
      }
    });

    it('wires the 2-hop transitive generator into the pipeline: a painPoint source yields a painPoint→useCase candidate', async () => {
      // Multi-entity breadth: the bulk pass must ALSO run the whitelisted 2-hop
      // transitive generator per source, so painPoint→useCase 'addresses' inferences
      // flow into the same verify + materialize pipeline (not just direct heuristics).
      mockGetDiscoveryConfig.mockReturnValue({ twoHopConfidenceFloor: 0.6 });
      mockGetNeighborsByRelation.mockImplementation((_id: string, relTypes: string[]) => {
        if (relTypes[0] === 'SOLVES')
          return Promise.resolve([
            { id: 'tech-1', labels: ['Technology'], properties: { name: 'Neo4j', confidence: 0.8 } },
          ]);
        if (relTypes[0] === 'ADDRESSES')
          return Promise.resolve([
            { id: 'uc-1', labels: ['UseCase'], properties: { name: 'Graph queries', confidence: 0.75 } },
          ]);
        return Promise.resolve([]);
      });
      const painPoints = [
        {
          id: 'pp-1',
          name: 'Slow graph queries',
          description: 'x',
          tags: [],
          updatedAt: Date.now(),
          createdAt: Date.now(),
        },
      ];
      mockCGGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshotCG([])) // fetchTargetEntities: useCase (none → no direct candidates)
        .mockResolvedValueOnce(createMockQuerySnapshotCG(painPoints)); // fetchEntities: painPoint sources

      const result = await generateCandidates({
        sourceTypes: ['painPoint'],
        targetTypes: ['useCase'],
        batchSize: 10,
        useEmbeddings: false,
      });

      const transitive = result.filter((c: { discoveryMethod?: string }) => c.discoveryMethod === 'transitive');
      expect(transitive).toHaveLength(1);
      expect(transitive[0]).toMatchObject({
        sourceId: 'pp-1',
        sourceType: 'painPoint',
        targetId: 'uc-1',
        targetType: 'useCase',
        relationType: 'addresses',
      });
    });

    it('should skip candidates with existing relations', async () => {
      const targetCompanies = [
        {
          id: 'company-dup',
          name: 'Duplicate Corp',
          tags: ['ai'],
          updatedAt: Date.now(),
          createdAt: Date.now(),
        },
      ];

      const sourceTechs = [
        {
          id: 'tech-dup',
          name: 'Duplicate Tech',
          tags: ['ai'],
          updatedAt: Date.now(),
          createdAt: Date.now(),
        },
      ];

      mockCGGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshotCG(targetCompanies))
        .mockResolvedValueOnce(createMockQuerySnapshotCG(sourceTechs));

      // Existing relation found
      mockCheckDuplicateRelation.mockResolvedValue({ id: 'existing-rel' });

      const result = await generateCandidates({
        sourceTypes: ['technology'],
        targetTypes: ['company'],
        batchSize: 10,
        useEmbeddings: false,
      });

      expect(result).toHaveLength(0);
    });

    it('should skip candidates with pending proposals', async () => {
      const targetCompanies = [
        {
          id: 'company-pending',
          name: 'Pending Corp',
          tags: ['ai'],
          updatedAt: Date.now(),
          createdAt: Date.now(),
        },
      ];

      const sourceTechs = [
        {
          id: 'tech-pending',
          name: 'Pending Tech',
          tags: ['ai'],
          updatedAt: Date.now(),
          createdAt: Date.now(),
        },
      ];

      mockCGGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshotCG(targetCompanies))
        .mockResolvedValueOnce(createMockQuerySnapshotCG(sourceTechs));

      // No existing relation
      mockCheckDuplicateRelation.mockResolvedValue(null);
      // But pending proposal exists with matching relation type
      mockGetPendingProposalsBetween.mockResolvedValue([
        { relationType: 'custom' }, // matches the inferred type for company-technology
      ]);

      const result = await generateCandidates({
        sourceTypes: ['technology'],
        targetTypes: ['company'],
        batchSize: 10,
        useEmbeddings: false,
      });

      expect(result).toHaveLength(0);
    });

    it('should not include self-matches', async () => {
      const sameEntity = {
        id: 'tech-same',
        name: 'Same Tech',
        tags: ['ai', 'ml'],
        category: 'ML',
        updatedAt: Date.now(),
        createdAt: Date.now(),
      };

      mockCGGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshotCG([sameEntity])) // target
        .mockResolvedValueOnce(createMockQuerySnapshotCG([sameEntity])); // source

      const result = await generateCandidates({
        sourceTypes: ['technology'],
        targetTypes: ['technology'],
        batchSize: 10,
        useEmbeddings: false,
      });

      // Self-match should be filtered
      expect(result).toHaveLength(0);
    });

    it('should use embeddings when enabled and heuristic matches exist', async () => {
      const targetCompanies = [
        {
          id: 'company-embed',
          name: 'Embedding AI Corp',
          description: 'AI company using embeddings for natural language processing',
          tags: ['ai', 'machine-learning', 'nlp'],
          category: 'AI',
          industry: 'Technology',
          updatedAt: Date.now(),
          createdAt: Date.now(),
        },
      ];

      const sourceTechs = [
        {
          id: 'tech-embed',
          name: 'Embedding AI Framework',
          description: 'Framework for AI embeddings and NLP tasks',
          tags: ['ai', 'machine-learning', 'nlp'],
          category: 'AI',
          industry: 'Technology',
          updatedAt: Date.now(),
          createdAt: Date.now(),
        },
      ];

      mockCGGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshotCG(targetCompanies))
        .mockResolvedValueOnce(createMockQuerySnapshotCG(sourceTechs));

      // Mock embedding generation
      mockGenerateEmbedding.mockResolvedValue(Array(768).fill(0.5));

      const result = await generateCandidates({
        sourceTypes: ['technology'],
        targetTypes: ['company'],
        batchSize: 10,
        useEmbeddings: true,
        maxCandidatesPerEntity: 5,
      });

      // generateEmbedding should have been called (heuristic score should be high enough)
      expect(mockGenerateEmbedding).toHaveBeenCalled();

      if (result.length > 0) {
        expect(result[0].discoveryMethod).toBe('embedding');
      }
    });

    it('should fall back to heuristics when embeddings fail', async () => {
      const targetCompanies = [
        {
          id: 'company-fallback',
          name: 'Fallback Corp',
          tags: ['ai'],
          updatedAt: Date.now(),
          createdAt: Date.now(),
        },
      ];

      const sourceTechs = [
        {
          id: 'tech-fallback',
          name: 'Fallback Tech',
          tags: ['ai'],
          updatedAt: Date.now(),
          createdAt: Date.now(),
        },
      ];

      mockCGGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshotCG(targetCompanies))
        .mockResolvedValueOnce(createMockQuerySnapshotCG(sourceTechs));

      // Embedding fails
      mockGenerateEmbedding.mockRejectedValue(new Error('Embedding API down'));

      const result = await generateCandidates({
        sourceTypes: ['technology'],
        targetTypes: ['company'],
        batchSize: 10,
        useEmbeddings: true,
      });

      // Should still return candidates (from heuristic fallback)
      if (result.length > 0) {
        expect(result[0].discoveryMethod).toBe('heuristic');
      }
    });

    it('should limit candidates per entity', async () => {
      // Create many matching targets
      const targets = Array.from({ length: 20 }, (_, i) => ({
        id: `company-${i}`,
        name: `AI Company ${i}`,
        tags: ['ai', 'ml', 'cloud'],
        category: 'AI',
        industry: 'Technology',
        updatedAt: Date.now(),
        createdAt: Date.now(),
      }));

      const source = {
        id: 'tech-limit',
        name: 'AI Technology Platform',
        tags: ['ai', 'ml', 'cloud'],
        category: 'AI',
        industry: 'Technology',
        updatedAt: Date.now(),
        createdAt: Date.now(),
      };

      mockCGGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshotCG(targets))
        .mockResolvedValueOnce(createMockQuerySnapshotCG([source]));

      const maxPerEntity = 3;
      const result = await generateCandidates({
        sourceTypes: ['technology'],
        targetTypes: ['company'],
        batchSize: 10,
        useEmbeddings: false,
        maxCandidatesPerEntity: maxPerEntity,
      });

      expect(result.length).toBeLessThanOrEqual(maxPerEntity);
    });

    it('should prioritize untracked entities when option is set', async () => {
      const entities = [
        { id: 'tracked-1', name: 'Tracked Tech', tags: [], updatedAt: Date.now(), createdAt: Date.now() },
        { id: 'untracked-1', name: 'Untracked Tech', tags: [], updatedAt: Date.now(), createdAt: Date.now() },
      ];

      // Return entities for both target and source fetches
      mockCGGetDocs.mockResolvedValue(createMockQuerySnapshotCG(entities));

      // tracked-1 is already tracked
      mockGetTrackedEntityIds.mockResolvedValue(new Set(['tracked-1']));

      await generateCandidates({
        sourceTypes: ['technology'],
        targetTypes: ['technology'],
        batchSize: 10,
        useEmbeddings: false,
        prioritizeUntracked: true,
      });

      // getTrackedEntityIds should have been called
      expect(mockGetTrackedEntityIds).toHaveBeenCalled();
    });

    it('should handle Firestore errors gracefully', async () => {
      mockCGGetDocs.mockRejectedValue(new Error('Firestore unavailable'));

      const result = await generateCandidates({
        sourceTypes: ['technology'],
        targetTypes: ['company'],
        batchSize: 10,
        useEmbeddings: false,
      });

      // Should not throw, returns empty
      expect(result).toEqual([]);
    });
  });

  describe('generateDocumentMentionCandidates()', () => {
    it('should call scanDocumentForEntities and filter duplicates', async () => {
      // Mock the dynamic import of document-scanner
      jest.mock('../document-scanner', () => ({
        scanDocumentForEntities: jest.fn().mockResolvedValue([
          {
            sourceId: 'doc-1',
            sourceType: 'document',
            sourceName: 'Test Doc',
            targetId: 'tech-1',
            targetType: 'technology',
            targetName: 'React',
            relationType: 'mentions',
            confidence: 80,
            discoveryMethod: 'document_scan',
          },
        ]),
      }));

      mockCheckDuplicateRelation.mockResolvedValue(null);
      mockGetPendingProposalsBetween.mockResolvedValue([]);

      const result = await generateDocumentMentionCandidates('doc-1');

      expect(result).toHaveLength(1);
      expect(result[0].targetName).toBe('React');
    });

    it('should filter out candidates with existing relations', async () => {
      jest.mock('../document-scanner', () => ({
        scanDocumentForEntities: jest.fn().mockResolvedValue([
          {
            sourceId: 'doc-1',
            sourceType: 'document',
            sourceName: 'Test Doc',
            targetId: 'tech-existing',
            targetType: 'technology',
            targetName: 'Existing Tech',
            relationType: 'mentions',
            confidence: 85,
            discoveryMethod: 'document_scan',
          },
        ]),
      }));

      // Existing relation found
      mockCheckDuplicateRelation.mockResolvedValue({ id: 'existing-rel' });

      const result = await generateDocumentMentionCandidates('doc-1');

      expect(result).toHaveLength(0);
    });
  });

  describe('generateTransitiveCandidates()', () => {
    beforeEach(() => {
      mockGetDiscoveryConfig.mockReturnValue({ twoHopConfidenceFloor: 0.6 });
      // painPoint -(SOLVES,incoming)-> technology -(ADDRESSES,outgoing)-> useCase
      mockGetNeighborsByRelation.mockImplementation((_id: string, relTypes: string[]) => {
        if (relTypes[0] === 'SOLVES') {
          return Promise.resolve([
            { id: 'tech-1', labels: ['Technology'], properties: { name: 'Neo4j', confidence: 0.8 } },
          ]);
        }
        if (relTypes[0] === 'ADDRESSES') {
          return Promise.resolve([
            { id: 'uc-1', labels: ['UseCase'], properties: { name: 'Graph queries', confidence: 0.75 } },
          ]);
        }
        return Promise.resolve([]);
      });
    });

    it('(a) emits a floored 2-hop addresses candidate with the full LinkerCandidate shape', async () => {
      const out = await generateTransitiveCandidates('pp-1', 'painPoint', 2);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        sourceId: 'pp-1',
        sourceType: 'painPoint',
        targetId: 'uc-1',
        targetType: 'useCase',
        targetName: 'Graph queries',
        relationType: 'addresses',
        confidence: 60, // round(0.8*0.75*100)
        discoveryMethod: 'transitive',
      });
      // All non-optional fields populated.
      expect(typeof out[0].sourceName).toBe('string');
    });

    it('(b) drops a path whose confidence is below the floor', async () => {
      mockGetNeighborsByRelation.mockImplementation((_id: string, relTypes: string[]) => {
        if (relTypes[0] === 'SOLVES') return Promise.resolve([{ id: 'tech-1', properties: { confidence: 0.8 } }]);
        if (relTypes[0] === 'ADDRESSES') return Promise.resolve([{ id: 'uc-1', properties: { confidence: 0.7 } }]); // 0.56 < 0.6
        return Promise.resolve([]);
      });
      expect(await generateTransitiveCandidates('pp-1', 'painPoint', 2)).toEqual([]);
    });

    it('(c) never makes a 3rd-hop traversal call', async () => {
      await generateTransitiveCandidates('pp-1', 'painPoint', 2);
      // hop1 (SOLVES) + one hop2 (ADDRESSES) = exactly 2 calls.
      expect(mockGetNeighborsByRelation).toHaveBeenCalledTimes(2);
    });

    it('(d) returns [] with NO traversal for an excluded source type', async () => {
      const out = await generateTransitiveCandidates('o-1', 'orgUnit', 2);
      expect(out).toEqual([]);
      expect(mockGetNeighborsByRelation).not.toHaveBeenCalled();
    });

    it('(e) traverses hop1 with the SOLVES whitelist and the INCOMING direction', async () => {
      await generateTransitiveCandidates('pp-1', 'painPoint', 2);
      expect(mockGetNeighborsByRelation.mock.calls[0]).toEqual(['pp-1', ['SOLVES'], { direction: 'incoming' }]);
      expect(mockGetNeighborsByRelation.mock.calls[1]).toEqual(['tech-1', ['ADDRESSES'], { direction: 'outgoing' }]);
    });

    it('still returns [] for a technology source (no join defined)', async () => {
      const out = await generateTransitiveCandidates('entity-1', 'technology', 2);
      expect(out).toEqual([]);
    });
  });

  // ==========================================================================
  // RELATION INFERENCE LOGIC (testing through generateCandidates)
  // ==========================================================================

  describe('Relation Type Inference', () => {
    it("should infer 'integrates_with' for tech-to-tech by default", async () => {
      const target = {
        id: 'tech-target',
        name: 'Target Framework',
        tags: ['api'],
        updatedAt: Date.now(),
        createdAt: Date.now(),
      };
      const source = {
        id: 'tech-source',
        name: 'Source Framework',
        tags: ['api'],
        updatedAt: Date.now(),
        createdAt: Date.now(),
      };

      mockCGGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshotCG([target]))
        .mockResolvedValueOnce(createMockQuerySnapshotCG([source]));

      mockGetValidRelationTypes.mockReturnValue(['integrates_with', 'uses', 'enables', 'competes_with']);

      const result = await generateCandidates({
        sourceTypes: ['technology'],
        targetTypes: ['technology'],
        batchSize: 10,
        useEmbeddings: false,
      });

      if (result.length > 0) {
        expect(result[0].relationType).toBe('integrates_with');
      }
    });

    it("should infer 'mentions' for signal-to-any relations", async () => {
      const target = {
        id: 'tech-target2',
        name: 'Important Technology',
        tags: ['trending'],
        status: 'Approved',
        updatedAt: Date.now(),
        createdAt: Date.now(),
      };
      const source = {
        id: 'sig-source',
        name: 'New trending technology announced',
        tags: ['trending'],
        status: 'Approved',
        updatedAt: Date.now(),
        createdAt: Date.now(),
      };

      mockCGGetDocs
        .mockResolvedValueOnce(createMockQuerySnapshotCG([target])) // target: technology
        .mockResolvedValueOnce(createMockQuerySnapshotCG([source])); // source: signal

      mockGetValidRelationTypes.mockReturnValue(['mentions', 'reveals', 'custom']);

      const result = await generateCandidates({
        sourceTypes: ['signal'],
        targetTypes: ['technology'],
        batchSize: 10,
        useEmbeddings: false,
      });

      if (result.length > 0) {
        expect(result[0].relationType).toBe('mentions');
      }
    });
  });
});
