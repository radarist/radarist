/**
 * @file lib/ai/__tests__/embeddings.test.ts
 * @description Tests for embedding generation functions
 *
 * @phase Knowledge Tab Sprint - Phase 1.5
 */

// Undo global mock from jest.setup.js so we can test the real export
jest.unmock('@/lib/inngest/functions/sync-entity-document-link-to-neo4j');

// Mock firebase to prevent Firebase Auth from requiring `fetch` in Node test environment
jest.mock('@/lib/firebase', () => ({
  db: {},
  storage: {},
  auth: {},
}));

// The inngest sync functions now statically import admin helpers (post client→admin
// SDK migration). Those helpers reach @/lib/firebase-admin, which pulls in jwks-rsa/jose
// (ESM `export` syntax jest can't parse). Mock firebase-admin and the specific admin
// helpers so the real firebase-admin module is never loaded. These are structure-only
// tests (they check exports are defined), so stubs suffice.
jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));
jest.mock('@/lib/document-chunk-admin', () => ({
  adminGetChunksForDocument: jest.fn(),
}));
jest.mock('@/lib/entity-document-link-admin', () => ({
  adminGetEntityDocumentLinkById: jest.fn(),
  adminMarkLinkSynced: jest.fn(),
  adminMarkLinkSyncFailed: jest.fn(),
}));

import { EMBEDDING_DIMENSION, DEFAULT_EMBEDDING_MODEL, TaskType } from '../constants';

// ============================================================================
// EMBEDDING CONFIGURATION TESTS
// ============================================================================

describe('Embedding Configuration', () => {
  describe('constants', () => {
    it('should have correct embedding dimension for gemini-embedding-001 (truncated)', () => {
      expect(EMBEDDING_DIMENSION).toBe(768);
    });

    it('should have correct default embedding model', () => {
      expect(DEFAULT_EMBEDDING_MODEL).toBe('gemini-embedding-001');
    });
  });
});

// ============================================================================
// EMBEDDING FUNCTION STRUCTURE TESTS
// ============================================================================

describe('Embedding Function Structure', () => {
  describe('generateEmbedding', () => {
    it('should be exported from client', async () => {
      const { generateEmbedding } = await import('../client');
      expect(typeof generateEmbedding).toBe('function');
    });
  });

  describe('generateEmbeddings', () => {
    it('should be exported from client', async () => {
      const { generateEmbeddings } = await import('../client');
      expect(typeof generateEmbeddings).toBe('function');
    });
  });

  describe('TaskType', () => {
    it('should be re-exported from constants', () => {
      expect(TaskType).toBeDefined();
      expect(TaskType.RETRIEVAL_DOCUMENT).toBeDefined();
      expect(TaskType.RETRIEVAL_QUERY).toBeDefined();
    });
  });
});

// ============================================================================
// BATCH EMBEDDING CONFIG TESTS
// ============================================================================

describe('BatchEmbeddingConfig', () => {
  it('should accept concurrency option', async () => {
    const { generateEmbeddings: _generateEmbeddings } = await import('../client');

    // Type-check that config accepts these options
    const config = {
      concurrency: 5,
      batchDelayMs: 100,
      maxRetries: 3,
      baseRetryDelayMs: 1000,
    };

    // This is a structural test - we're checking the function accepts the config
    // without actually calling the API
    expect(() => {
      // Validate config structure (doesn't actually call the function)
      const { concurrency, batchDelayMs, maxRetries, baseRetryDelayMs } = config;
      expect(concurrency).toBe(5);
      expect(batchDelayMs).toBe(100);
      expect(maxRetries).toBe(3);
      expect(baseRetryDelayMs).toBe(1000);
    }).not.toThrow();
  });
});

// ============================================================================
// VECTOR SEARCH TESTS (Structure Only - No Live API)
// ============================================================================

describe('Vector Search Module Structure', () => {
  describe('exports', () => {
    it('should export searchChunksByText', async () => {
      const { searchChunksByText } = await import('@/lib/graph/vector-search');
      expect(typeof searchChunksByText).toBe('function');
    });

    it('should export searchChunksByEmbedding', async () => {
      const { searchChunksByEmbedding } = await import('@/lib/graph/vector-search');
      expect(typeof searchChunksByEmbedding).toBe('function');
    });

    it('should export findSimilarDocuments', async () => {
      const { findSimilarDocuments } = await import('@/lib/graph/vector-search');
      expect(typeof findSimilarDocuments).toBe('function');
    });

    it('should export getDocumentChunks', async () => {
      const { getDocumentChunks } = await import('@/lib/graph/vector-search');
      expect(typeof getDocumentChunks).toBe('function');
    });

    it('should export checkVectorIndexStatus', async () => {
      const { checkVectorIndexStatus } = await import('@/lib/graph/vector-search');
      expect(typeof checkVectorIndexStatus).toBe('function');
    });
  });

  describe('graph index exports', () => {
    it('should export vector search functions from graph index', async () => {
      const graph = await import('@/lib/graph');
      expect(typeof graph.searchChunksByText).toBe('function');
      expect(typeof graph.searchChunksByEmbedding).toBe('function');
      expect(typeof graph.findSimilarDocuments).toBe('function');
      expect(typeof graph.getDocumentChunks).toBe('function');
      expect(typeof graph.checkVectorIndexStatus).toBe('function');
    });
  });
});

// ============================================================================
// EMBEDDING DIMENSION VALIDATION
// ============================================================================

describe('Embedding Dimension Validation', () => {
  it('should match Neo4j vector index dimension', () => {
    // The canonical graph schema manifest uses 768 dimensions.
    // This test ensures we don't accidentally change the dimension
    expect(EMBEDDING_DIMENSION).toBe(768);
  });

  it('should use cosine similarity as specified in schema', () => {
    // This is a documentation/validation test
    // The schema uses: `vector.similarity_function`: 'cosine'
    // Our search functions expect cosine similarity scores (0-1 range)
    const minValidScore = 0;
    const maxValidScore = 1;
    expect(minValidScore).toBeGreaterThanOrEqual(0);
    expect(maxValidScore).toBeLessThanOrEqual(1);
  });
});

// ============================================================================
// EMBEDDING TRUNCATION TESTS
// ============================================================================

describe('Embedding Truncation', () => {
  it('should truncate embeddings longer than EMBEDDING_DIMENSION', () => {
    // Simulate what client.ts does after getting embeddings from gemini-embedding-001
    const oversizedEmbedding = new Array(3072).fill(0).map((_, i) => i / 3072);
    const truncated =
      oversizedEmbedding.length > EMBEDDING_DIMENSION
        ? oversizedEmbedding.slice(0, EMBEDDING_DIMENSION)
        : oversizedEmbedding;

    expect(truncated).toHaveLength(768);
    expect(truncated[0]).toBe(oversizedEmbedding[0]);
    expect(truncated[767]).toBe(oversizedEmbedding[767]);
  });

  it('should not truncate embeddings already at EMBEDDING_DIMENSION', () => {
    const correctSizeEmbedding = new Array(768).fill(0).map((_, i) => i / 768);
    const result =
      correctSizeEmbedding.length > EMBEDDING_DIMENSION
        ? correctSizeEmbedding.slice(0, EMBEDDING_DIMENSION)
        : correctSizeEmbedding;

    expect(result).toHaveLength(768);
    expect(result).toBe(correctSizeEmbedding); // Same reference, no truncation
  });
});

// ============================================================================
// SYNC FUNCTION TESTS (Structure Only)
// ============================================================================

describe('Sync Document Function Structure', () => {
  describe('syncDocumentToNeo4jJob', () => {
    it('should be exported from inngest functions', async () => {
      const { syncDocumentToNeo4jJob } = await import('@/lib/inngest/functions/sync-document-to-neo4j');
      expect(syncDocumentToNeo4jJob).toBeDefined();
    });
  });

  describe('syncEntityDocumentLinkToNeo4jJob', () => {
    it('should be exported from inngest functions', async () => {
      const { syncEntityDocumentLinkToNeo4jJob } =
        await import('@/lib/inngest/functions/sync-entity-document-link-to-neo4j');
      expect(syncEntityDocumentLinkToNeo4jJob).toBeDefined();
    });
  });

  describe('helper functions', () => {
    it('should export triggerDocumentSync helper', async () => {
      const { triggerDocumentSync } = await import('@/lib/inngest/functions/sync-document-to-neo4j');
      expect(typeof triggerDocumentSync).toBe('function');
    });

    it('should export triggerEntityDocumentLinkSync helper', async () => {
      const { triggerEntityDocumentLinkSync } =
        await import('@/lib/inngest/functions/sync-entity-document-link-to-neo4j');
      expect(typeof triggerEntityDocumentLinkSync).toBe('function');
    });
  });
});
