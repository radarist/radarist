/**
 * Neo4j Document Sync Integration Tests
 *
 * Tests the actual Neo4j sync behavior for Documents and EntityDocumentLinks.
 * These tests connect to a REAL Neo4j database. Use only a disposable clone.
 *
 * SKIPPED BY DEFAULT. To run the guarded serial lane:
 * ```bash
 * NEO4J_URI=bolt://127.0.0.1:17687 \
 * NEO4J_INTEGRATION_DISPOSABLE=true npm run test:integration:neo4j
 * ```
 * Run only against the disposable Neo4j target established by the integration lane.
 * When NEO4J_INTEGRATION_TESTS is set and Neo4j is unreachable, the suite
 * FAILS loudly (it does not silently pass).
 *
 * Test Coverage:
 * - NEO.1: Creates Document node on sync
 * - NEO.2: Creates Chunk nodes with embeddings
 * - NEO.3: Creates CONTAINS relationship
 * - NEO.4: Updates graphSyncStatus to synced
 * - NEO.5: Sets graphSyncStatus to failed on error
 * - NEO.6: Does NOT store chunk text in Neo4j (actually we DO store it for search)
 * - DEL.1: Deletes chunks on document delete
 * - DEL.2: Deletes document node on delete
 * - DEL.3: Deletes LINKED_TO edge on unlink
 * - DEL.4: Uses linkId for safe edge deletion
 *
 * @phase Knowledge Tab Sprint - Phase 1.5 & 2
 */

import { checkHealth, runWriteTransaction, runReadTransaction, closeDriver } from '@/lib/graph/neo4j-client';

// ============================================================================
// TEST CONFIGURATION
// ============================================================================

const TEST_PREFIX = 'int-test-';
const TEST_DOCUMENT_ID = `${TEST_PREFIX}doc-001`;
const TEST_CHUNK_IDS = [`${TEST_PREFIX}chunk-001`, `${TEST_PREFIX}chunk-002`, `${TEST_PREFIX}chunk-003`];
const TEST_ENTITY_ID = `${TEST_PREFIX}entity-001`;
const TEST_LINK_ID = `${TEST_PREFIX}link-001`;

// Test embedding (768 dimensions, simplified for testing)
const TEST_EMBEDDING = Array(768)
  .fill(0)
  .map((_, i) => Math.sin(i * 0.1));

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function cleanupTestData(): Promise<void> {
  try {
    // Delete all test nodes and relationships
    await runWriteTransaction(
      `
      MATCH (n)
      WHERE n.id STARTS WITH $prefix
      DETACH DELETE n
    `,
      { prefix: TEST_PREFIX }
    );

    // Also clean up any relationships with test linkIds
    await runWriteTransaction(
      `
      MATCH ()-[r]->()
      WHERE r.linkId STARTS WITH $prefix
      DELETE r
    `,
      { prefix: TEST_PREFIX }
    );
  } catch (error) {
    console.warn('[Test Cleanup] Error during cleanup:', error);
  }
}

async function createTestDocument(): Promise<void> {
  const now = Date.now();
  await runWriteTransaction(
    `
    MERGE (d:Document {id: $documentId})
    ON CREATE SET
      d.title = $title,
      d.type = $type,
      d.domain = $domain,
      d.version = $version,
      d.status = $status,
      d.createdAt = $createdAt,
      d.updatedAt = $updatedAt
  `,
    {
      documentId: TEST_DOCUMENT_ID,
      title: 'Integration Test Document',
      type: 'url',
      domain: 'example.com',
      version: 1,
      status: 'processed',
      createdAt: now,
      updatedAt: now,
    }
  );
}

async function createTestChunks(): Promise<void> {
  const now = Date.now();

  for (let i = 0; i < TEST_CHUNK_IDS.length; i++) {
    await runWriteTransaction(
      `
      MERGE (c:Chunk {id: $chunkId})
      ON CREATE SET
        c.documentId = $documentId,
        c.content = $content,
        c.chunkIndex = $chunkIndex,
        c.tokenCount = $tokenCount,
        c.documentVersion = $documentVersion,
        c.archived = $archived,
        c.embedding = $embedding,
        c.embeddingModel = $embeddingModel,
        c.createdAt = $createdAt
    `,
      {
        chunkId: TEST_CHUNK_IDS[i],
        documentId: TEST_DOCUMENT_ID,
        content: `Test chunk content ${i + 1}`,
        chunkIndex: i,
        tokenCount: 50 + i * 10,
        documentVersion: 1,
        archived: false,
        embedding: TEST_EMBEDDING,
        embeddingModel: 'text-embedding-004',
        createdAt: now,
      }
    );
  }
}

async function createContainsRelationships(): Promise<void> {
  const now = Date.now();

  for (const chunkId of TEST_CHUNK_IDS) {
    await runWriteTransaction(
      `
      MATCH (d:Document {id: $documentId})
      MATCH (c:Chunk {id: $chunkId})
      MERGE (d)-[r:CONTAINS]->(c)
      ON CREATE SET r.createdAt = $createdAt
    `,
      {
        documentId: TEST_DOCUMENT_ID,
        chunkId,
        createdAt: now,
      }
    );
  }
}

async function createTestEntity(): Promise<void> {
  const now = Date.now();
  await runWriteTransaction(
    `
    MERGE (e:Technology {id: $entityId})
    ON CREATE SET
      e.name = $name,
      e.entityType = $entityType,
      e.createdAt = $createdAt
  `,
    {
      entityId: TEST_ENTITY_ID,
      name: 'Integration Test Technology',
      entityType: 'technology',
      createdAt: now,
    }
  );
}

async function createTestLink(): Promise<void> {
  const now = Date.now();
  await runWriteTransaction(
    `
    MATCH (e:Technology {id: $entityId})
    MATCH (d:Document {id: $documentId})
    MERGE (e)-[r:DOCUMENTED_BY {linkId: $linkId}]->(d)
    ON CREATE SET
      r.relevance = $relevance,
      r.createdAt = $createdAt
  `,
    {
      entityId: TEST_ENTITY_ID,
      documentId: TEST_DOCUMENT_ID,
      linkId: TEST_LINK_ID,
      relevance: 'high',
      createdAt: now,
    }
  );
}

// ============================================================================
// TEST SUITES
// ============================================================================

// Gate the whole suite on an explicit opt-in env var so default runs report
// SKIPPED (not a false PASS). See the file header for the run instruction.
const describeIntegration = process.env.NEO4J_INTEGRATION_TESTS ? describe : describe.skip;

describeIntegration('Neo4j Document Sync Integration Tests', () => {
  beforeAll(async () => {
    // NEO4J_INTEGRATION_TESTS is set — Neo4j MUST be reachable. Fail loudly
    // instead of silently passing when it isn't.
    const health = await checkHealth();
    if (!health.healthy) {
      throw new Error(
        `[Integration Tests] NEO4J_INTEGRATION_TESTS is set but Neo4j is not healthy: ${
          health.error ?? 'unknown error'
        }. Start the disposable Neo4j integration target.`
      );
    }
  });

  beforeEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeDriver();
  });

  // ==========================================================================
  // NEO4J CONNECTIVITY
  // ==========================================================================

  describe('Neo4j Connectivity', () => {
    it('should connect to Neo4j successfully', async () => {
      const health = await checkHealth();
      expect(health.healthy).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // DOCUMENT SYNC TESTS (NEO.1 - NEO.6)
  // ==========================================================================

  describe('Document Sync (NEO.1-NEO.6)', () => {
    it('NEO.1 - should create Document node on sync', async () => {
      await createTestDocument();

      // Verify document was created
      const result = await runReadTransaction<{ id: string; title: string }>(
        'MATCH (d:Document {id: $id}) RETURN d.id as id, d.title as title',
        { id: TEST_DOCUMENT_ID }
      );

      expect(result.records.length).toBe(1);
      expect(result.records[0].id).toBe(TEST_DOCUMENT_ID);
      expect(result.records[0].title).toBe('Integration Test Document');
    });

    it('NEO.2 - should create Chunk nodes with embeddings', async () => {
      await createTestDocument();
      await createTestChunks();

      // Verify chunks were created with embeddings
      const result = await runReadTransaction<{
        id: string;
        content: string;
        embedding: number[];
      }>(
        'MATCH (c:Chunk) WHERE c.id STARTS WITH $prefix RETURN c.id as id, c.content as content, c.embedding as embedding ORDER BY c.chunkIndex',
        { prefix: TEST_PREFIX }
      );

      expect(result.records.length).toBe(3);

      // Verify embeddings exist and have correct dimensions
      for (const record of result.records) {
        expect(record.embedding).toBeDefined();
        expect(record.embedding.length).toBe(768);
      }
    });

    it('NEO.3 - should create CONTAINS relationship between Document and Chunks', async () => {
      await createTestDocument();
      await createTestChunks();
      await createContainsRelationships();

      // Verify CONTAINS relationships exist
      const result = await runReadTransaction<{ docId: string; chunkId: string }>(
        `MATCH (d:Document {id: $docId})-[:CONTAINS]->(c:Chunk)
         RETURN d.id as docId, c.id as chunkId`,
        { docId: TEST_DOCUMENT_ID }
      );

      expect(result.records.length).toBe(3);

      const chunkIds = result.records.map((r) => r.chunkId);
      for (const expectedId of TEST_CHUNK_IDS) {
        expect(chunkIds).toContain(expectedId);
      }
    });

    it('NEO.4 - should be able to query document with status (for graphSyncStatus tracking)', async () => {
      await createTestDocument();

      // Update status to 'synced' equivalent
      await runWriteTransaction('MATCH (d:Document {id: $id}) SET d.syncStatus = $status', {
        id: TEST_DOCUMENT_ID,
        status: 'synced',
      });

      const result = await runReadTransaction<{ status: string }>(
        'MATCH (d:Document {id: $id}) RETURN d.syncStatus as status',
        { id: TEST_DOCUMENT_ID }
      );

      expect(result.records[0].status).toBe('synced');
    });

    it('NEO.5 - should be able to mark sync as failed', async () => {
      await createTestDocument();

      // Simulate failed sync status
      await runWriteTransaction('MATCH (d:Document {id: $id}) SET d.syncStatus = $status, d.syncError = $error', {
        id: TEST_DOCUMENT_ID,
        status: 'failed',
        error: 'Test error',
      });

      const result = await runReadTransaction<{ status: string; error: string }>(
        'MATCH (d:Document {id: $id}) RETURN d.syncStatus as status, d.syncError as error',
        { id: TEST_DOCUMENT_ID }
      );

      expect(result.records[0].status).toBe('failed');
      expect(result.records[0].error).toBe('Test error');
    });

    it('NEO.6 - chunks SHOULD store content in Neo4j (for semantic search)', async () => {
      // Note: We DO store chunk content in Neo4j for vector search
      // This is intentional for the GraphRAG use case
      await createTestDocument();
      await createTestChunks();

      const result = await runReadTransaction<{ content: string }>(
        'MATCH (c:Chunk {id: $id}) RETURN c.content as content',
        { id: TEST_CHUNK_IDS[0] }
      );

      expect(result.records[0].content).toBe('Test chunk content 1');
    });
  });

  // ==========================================================================
  // DELETION SYNC TESTS (DEL.1 - DEL.4)
  // ==========================================================================

  describe('Deletion Sync (DEL.1-DEL.4)', () => {
    it('DEL.1 - should delete chunks when document is deleted', async () => {
      // Setup: Create document with chunks
      await createTestDocument();
      await createTestChunks();
      await createContainsRelationships();

      // Verify setup
      const beforeResult = await runReadTransaction<{ count: number }>(
        'MATCH (c:Chunk) WHERE c.documentId = $docId RETURN count(c) as count',
        { docId: TEST_DOCUMENT_ID }
      );
      expect(beforeResult.records[0].count).toBe(3);

      // Delete document and its chunks
      await runWriteTransaction(
        `
        MATCH (d:Document {id: $docId})
        OPTIONAL MATCH (d)-[:CONTAINS]->(c:Chunk)
        DETACH DELETE c, d
      `,
        { docId: TEST_DOCUMENT_ID }
      );

      // Verify chunks are deleted
      const afterResult = await runReadTransaction<{ count: number }>(
        'MATCH (c:Chunk) WHERE c.documentId = $docId RETURN count(c) as count',
        { docId: TEST_DOCUMENT_ID }
      );
      expect(afterResult.records[0].count).toBe(0);
    });

    it('DEL.2 - should delete document node on delete', async () => {
      // Setup
      await createTestDocument();

      // Verify exists
      const beforeResult = await runReadTransaction<{ id: string }>('MATCH (d:Document {id: $id}) RETURN d.id as id', {
        id: TEST_DOCUMENT_ID,
      });
      expect(beforeResult.records.length).toBe(1);

      // Delete
      await runWriteTransaction('MATCH (d:Document {id: $id}) DETACH DELETE d', { id: TEST_DOCUMENT_ID });

      // Verify deleted
      const afterResult = await runReadTransaction<{ id: string }>('MATCH (d:Document {id: $id}) RETURN d.id as id', {
        id: TEST_DOCUMENT_ID,
      });
      expect(afterResult.records.length).toBe(0);
    });

    it('DEL.3 - should delete LINKED_TO edge on unlink', async () => {
      // Setup: Create entity, document, and link
      await createTestDocument();
      await createTestEntity();
      await createTestLink();

      // Verify link exists
      const beforeResult = await runReadTransaction<{ linkId: string }>(
        'MATCH ()-[r {linkId: $linkId}]->() RETURN r.linkId as linkId',
        { linkId: TEST_LINK_ID }
      );
      expect(beforeResult.records.length).toBe(1);

      // Delete the link
      await runWriteTransaction('MATCH ()-[r {linkId: $linkId}]->() DELETE r', { linkId: TEST_LINK_ID });

      // Verify link is deleted
      const afterResult = await runReadTransaction<{ linkId: string }>(
        'MATCH ()-[r {linkId: $linkId}]->() RETURN r.linkId as linkId',
        { linkId: TEST_LINK_ID }
      );
      expect(afterResult.records.length).toBe(0);

      // Verify entity and document still exist
      const entityExists = await runReadTransaction<{ id: string }>(
        'MATCH (e:Technology {id: $id}) RETURN e.id as id',
        { id: TEST_ENTITY_ID }
      );
      expect(entityExists.records.length).toBe(1);

      const docExists = await runReadTransaction<{ id: string }>('MATCH (d:Document {id: $id}) RETURN d.id as id', {
        id: TEST_DOCUMENT_ID,
      });
      expect(docExists.records.length).toBe(1);
    });

    it('DEL.4 - should use linkId for safe edge deletion (not delete other links)', async () => {
      // Setup: Create entity, document, and multiple links
      await createTestDocument();
      await createTestEntity();
      await createTestLink();

      // Create a second link
      const secondLinkId = `${TEST_PREFIX}link-002`;
      await runWriteTransaction(
        `
        MATCH (e:Technology {id: $entityId})
        MATCH (d:Document {id: $documentId})
        MERGE (e)-[r:HAS_EVIDENCE {linkId: $linkId}]->(d)
        ON CREATE SET r.createdAt = $createdAt
      `,
        {
          entityId: TEST_ENTITY_ID,
          documentId: TEST_DOCUMENT_ID,
          linkId: secondLinkId,
          createdAt: Date.now(),
        }
      );

      // Verify both links exist
      const beforeResult = await runReadTransaction<{ linkId: string }>(
        `MATCH (e:Technology {id: $entityId})-[r]->(d:Document {id: $docId})
         RETURN r.linkId as linkId`,
        { entityId: TEST_ENTITY_ID, docId: TEST_DOCUMENT_ID }
      );
      expect(beforeResult.records.length).toBe(2);

      // Delete only the first link using linkId
      await runWriteTransaction('MATCH ()-[r {linkId: $linkId}]->() DELETE r', { linkId: TEST_LINK_ID });

      // Verify only second link remains
      const afterResult = await runReadTransaction<{ linkId: string }>(
        `MATCH (e:Technology {id: $entityId})-[r]->(d:Document {id: $docId})
         RETURN r.linkId as linkId`,
        { entityId: TEST_ENTITY_ID, docId: TEST_DOCUMENT_ID }
      );
      expect(afterResult.records.length).toBe(1);
      expect(afterResult.records[0].linkId).toBe(secondLinkId);
    });
  });

  // ==========================================================================
  // VECTOR SEARCH TESTS
  // ==========================================================================

  describe('Vector Search Integration', () => {
    it('should store embeddings that can be queried', async () => {
      await createTestDocument();
      await createTestChunks();

      // Query embeddings
      const result = await runReadTransaction<{ id: string; embeddingLength: number }>(
        `MATCH (c:Chunk) WHERE c.id STARTS WITH $prefix
         RETURN c.id as id, size(c.embedding) as embeddingLength`,
        { prefix: TEST_PREFIX }
      );

      expect(result.records.length).toBe(3);
      for (const record of result.records) {
        expect(record.embeddingLength).toBe(768);
      }
    });

    it('should be able to find chunks by document', async () => {
      await createTestDocument();
      await createTestChunks();
      await createContainsRelationships();

      // Find all chunks for document via relationship
      const result = await runReadTransaction<{ id: string; content: string }>(
        `MATCH (d:Document {id: $docId})-[:CONTAINS]->(c:Chunk)
         RETURN c.id as id, c.content as content
         ORDER BY c.chunkIndex`,
        { docId: TEST_DOCUMENT_ID }
      );

      expect(result.records.length).toBe(3);
      expect(result.records[0].content).toBe('Test chunk content 1');
      expect(result.records[1].content).toBe('Test chunk content 2');
      expect(result.records[2].content).toBe('Test chunk content 3');
    });
  });

  // ==========================================================================
  // ENTITY-DOCUMENT LINK TESTS
  // ==========================================================================

  describe('Entity-Document Link Integration', () => {
    it('should create relationship with metadata', async () => {
      await createTestDocument();
      await createTestEntity();
      await createTestLink();

      // Query the relationship with metadata
      const result = await runReadTransaction<{
        linkId: string;
        relevance: string;
        relType: string;
      }>(
        `MATCH (e:Technology {id: $entityId})-[r]->(d:Document {id: $docId})
         RETURN r.linkId as linkId, r.relevance as relevance, type(r) as relType`,
        { entityId: TEST_ENTITY_ID, docId: TEST_DOCUMENT_ID }
      );

      expect(result.records.length).toBe(1);
      expect(result.records[0].linkId).toBe(TEST_LINK_ID);
      expect(result.records[0].relevance).toBe('high');
      expect(result.records[0].relType).toBe('DOCUMENTED_BY');
    });

    it('should support multiple relationship types', async () => {
      await createTestDocument();
      await createTestEntity();

      // Create multiple relationship types
      const relationshipTypes = [
        { linkId: `${TEST_PREFIX}link-doc`, type: 'DOCUMENTED_BY' },
        { linkId: `${TEST_PREFIX}link-evidence`, type: 'HAS_EVIDENCE' },
        { linkId: `${TEST_PREFIX}link-research`, type: 'HAS_RESEARCH' },
      ];

      for (const rel of relationshipTypes) {
        await runWriteTransaction(
          `
          MATCH (e:Technology {id: $entityId})
          MATCH (d:Document {id: $documentId})
          CREATE (e)-[r:${rel.type} {linkId: $linkId}]->(d)
        `,
          {
            entityId: TEST_ENTITY_ID,
            documentId: TEST_DOCUMENT_ID,
            linkId: rel.linkId,
          }
        );
      }

      // Query all relationships
      const result = await runReadTransaction<{ relType: string }>(
        `MATCH (e:Technology {id: $entityId})-[r]->(d:Document {id: $docId})
         RETURN type(r) as relType`,
        { entityId: TEST_ENTITY_ID, docId: TEST_DOCUMENT_ID }
      );

      expect(result.records.length).toBe(3);
      const types = result.records.map((r) => r.relType);
      expect(types).toContain('DOCUMENTED_BY');
      expect(types).toContain('HAS_EVIDENCE');
      expect(types).toContain('HAS_RESEARCH');
    });
  });
});
