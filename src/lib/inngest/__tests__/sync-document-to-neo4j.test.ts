/**
 * Tests for sync-document-to-neo4j.ts
 *
 * Focus (graph-foundation H7):
 * - Embedding-failure guard: a chunk whose embedding generation failed must
 *   NOT have `c.embedding` included in its Neo4j SET (writing [] would
 *   overwrite a previously-good vector), and the run must NOT report
 *   success:true — the chunk counts as an embedding failure.
 * - Write-back: freshly generated embeddings are persisted back to the
 *   Firestore chunk (adminUpdateChunkEmbedding) so the next sync skips
 *   regeneration (incremental re-embed).
 * - Incremental skip: chunks that already carry a non-empty embedding in
 *   Firestore are not re-embedded.
 */

// Mock logger
jest.mock('@/lib/logger', () => {
  const _mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { createLogger: jest.fn(() => _mockLogger) };
});

// Mock firebase-admin (handler dynamic-imports it to load the Document doc)
const mockDocumentFixture: { current: unknown } = { current: null };
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(async () => ({
          exists: mockDocumentFixture.current !== null,
          data: () => mockDocumentFixture.current,
        })),
      })),
    })),
  },
}));

// Mock the graph module
jest.mock('@/lib/graph', () => ({
  checkHealth: jest.fn(),
  deleteEntityFromGraph: jest.fn(),
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
  linkChunkMentions: jest.fn(),
  // GRAPH-064: mention trust is re-derived for the whole document on every
  // sync. The derivation itself is pure and covered by mention-trust.test.ts;
  // this suite only needs the graph write stubbed out.
  applyMentionTrustForDocument: jest.fn(async (documentId: string) => ({
    documentId,
    edgesUpdated: 0,
    trust: {
      claimStatus: 'unverified',
      confidence: 50,
      aiSuggested: false,
      sourceProvenance: 'unknown',
      sourceReviewState: 'unreviewed',
    },
  })),
  deriveDocumentContentProvenance: jest.fn(() => 'unknown'),
  deriveMentionSourceReviewState: jest.fn(() => 'unreviewed'),
}));

// Mock the chunk admin service (Firestore reads + embedding write-back)
jest.mock('@/lib/document-chunk-admin', () => ({
  adminGetChunksForDocument: jest.fn(),
  adminUpdateChunkEmbedding: jest.fn(),
}));

// Mock the AI client (embedding generation)
jest.mock('@/lib/ai/client', () => ({
  generateEmbeddings: jest.fn(),
}));

jest.mock('@/lib/ai/constants', () => ({
  DEFAULT_EMBEDDING_MODEL: 'gemini-embedding-001',
  TaskType: { RETRIEVAL_DOCUMENT: 'RETRIEVAL_DOCUMENT' },
}));

// Mock the inngest client (same harness as the other sync tests)
jest.mock('../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => {
      return {
        config,
        trigger,
        handler,
        async execute(eventData: Record<string, unknown>) {
          const steps: Record<string, unknown> = {};
          const step = {
            run: async <T>(name: string, fn: () => Promise<T>) => {
              const result = await fn();
              steps[name] = result;
              return result;
            },
          };
          const result = await handler({ event: { data: eventData }, step });
          return { result, steps };
        },
      };
    }),
    send: jest.fn().mockResolvedValue({ ids: [] }),
  },
}));

import {
  checkHealth,
  deleteEntityFromGraph,
  runWriteTransaction,
  runReadTransaction,
  linkChunkMentions,
} from '@/lib/graph';
import { adminGetChunksForDocument, adminUpdateChunkEmbedding } from '@/lib/document-chunk-admin';
import { generateEmbeddings } from '@/lib/ai/client';
import { syncDocumentToNeo4jJob } from '../functions/sync-document-to-neo4j';

type ExecutableJob = {
  config: { id: string };
  trigger: { event?: string };
  execute: (data: Record<string, unknown>) => Promise<{
    result: Record<string, unknown>;
    steps: Record<string, unknown>;
  }>;
};

function createMockResult<T>(records: T[]) {
  return {
    records,
    summary: {
      counters: { relationshipsCreated: 0, nodesCreated: 0, nodesDeleted: 0, propertiesSet: 0 },
    },
  };
}

function baseChunk(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    documentId: 'doc-1',
    content: `content of ${id}`,
    metadata: { startChar: 0, endChar: 10 },
    chunkIndex: 0,
    tokenCount: 12,
    createdAt: 1700000000000,
    ...overrides,
  };
}

/** Find the Neo4j write call that upserted the given chunk. */
function findChunkUpsertCall(chunkId: string): [string, Record<string, unknown>] | undefined {
  return (runWriteTransaction as jest.Mock).mock.calls.find(
    ([, params]) => (params as Record<string, unknown>)?.chunkId === chunkId
  ) as [string, Record<string, unknown>] | undefined;
}

describe('sync-document-to-neo4j (H7 embedding safety)', () => {
  const job = syncDocumentToNeo4jJob as unknown as ExecutableJob;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDocumentFixture.current = {
      title: 'Doc One',
      type: 'url',
      version: 1,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    };
    (checkHealth as jest.Mock).mockResolvedValue({ healthy: true });
    (runWriteTransaction as jest.Mock).mockResolvedValue(createMockResult([{ deleted: 0 }]));
    (runReadTransaction as jest.Mock).mockResolvedValue(createMockResult([]));
    (deleteEntityFromGraph as jest.Mock).mockResolvedValue({
      assertionsDeleted: 0,
      evidenceDeleted: 0,
      projectionsDeleted: 0,
      chunksDeleted: 0,
      endpointsDeleted: 1,
    });
    (linkChunkMentions as jest.Mock).mockResolvedValue(undefined);
    (adminUpdateChunkEmbedding as jest.Mock).mockResolvedValue(undefined);
  });

  it('atomically deletes the document, chunks, and endpoint-backed assertions', async () => {
    mockDocumentFixture.current = null;
    (deleteEntityFromGraph as jest.Mock).mockResolvedValueOnce({
      assertionsDeleted: 2,
      evidenceDeleted: 2,
      projectionsDeleted: 1,
      chunksDeleted: 3,
      endpointsDeleted: 1,
    });

    const { result } = await job.execute({ operation: 'delete', documentId: 'doc-1' });

    expect(deleteEntityFromGraph).toHaveBeenCalledWith('doc-1', 'document');
    expect(result).toMatchObject({ success: true, operation: 'deleted', chunksDeleted: 3 });
  });

  it('refuses an early delete delivery while the Firestore source still exists', async () => {
    await expect(job.execute({ operation: 'delete', documentId: 'doc-1' })).rejects.toThrow(
      'Refusing Document graph deletion while Firestore source exists: doc-1'
    );

    expect(deleteEntityFromGraph).not.toHaveBeenCalled();
  });

  it('labels the document as Entity so session tracking can resolve it by id', async () => {
    (adminGetChunksForDocument as jest.Mock).mockResolvedValue([]);

    const { result } = await job.execute({ operation: 'update', documentId: 'doc-1' });

    expect(result.success).toBe(true);
    const documentUpsert = (runWriteTransaction as jest.Mock).mock.calls.find(
      ([, params]) => (params as Record<string, unknown>)?.documentId === 'doc-1'
    );
    expect(documentUpsert).toBeDefined();
    expect(documentUpsert[0]).toContain('MERGE (d:Document {id: $documentId})');
    expect(documentUpsert[0]).toContain('SET d:Entity');
  });

  it('never SETs an empty embedding when generation fails, and reports the chunk as failed (not success:true)', async () => {
    (adminGetChunksForDocument as jest.Mock).mockResolvedValue([baseChunk('chunk-1')]);
    (generateEmbeddings as jest.Mock).mockResolvedValue({
      embeddings: new Map<number, number[]>(),
      failures: new Map<number, string>([[0, 'quota exceeded']]),
    });

    const { result } = await job.execute({ operation: 'update', documentId: 'doc-1' });

    // The chunk is still synced (content/index updated) …
    const upsert = findChunkUpsertCall('chunk-1');
    expect(upsert).toBeDefined();
    const [cypher, params] = upsert!;
    // … but the SET must not touch the embedding properties.
    expect(params).not.toHaveProperty('embedding');
    expect(cypher).not.toContain('c.embedding');
    expect(cypher).not.toContain('c.embeddedAt');
    expect(cypher).not.toContain('c.embeddingModel');

    // Run summary: embedding failure surfaced, not swallowed under success:true.
    expect(result.chunksEmbeddingFailed).toBe(1);
    expect(result.success).toBe(false);
    // H7 makes embeddings optional enrichment. The required Document/Chunk/
    // CONTAINS topology is complete, so it must receive a fingerprint and not
    // replay forever in a keyless local workspace.
    expect(runWriteTransaction).toHaveBeenCalledWith(
      expect.stringContaining('SET d.sourceFingerprint = $sourceFingerprint'),
      expect.objectContaining({ documentId: 'doc-1', sourceFingerprint: expect.any(String) })
    );
    // No write-back of a bad vector either.
    expect(adminUpdateChunkEmbedding).not.toHaveBeenCalled();
  });

  it('P3-B: a failed chunk upsert is counted and flips success to false (was warn-and-continue masked)', async () => {
    (adminGetChunksForDocument as jest.Mock).mockResolvedValue([
      baseChunk('chunk-1'),
      baseChunk('chunk-2', { chunkIndex: 1 }),
    ]);
    (generateEmbeddings as jest.Mock).mockResolvedValue({
      embeddings: new Map<number, number[]>([
        [0, [0.1, 0.2]],
        [1, [0.3, 0.4]],
      ]),
      failures: new Map<number, string>(),
    });
    // Fail ONLY chunk-1's Neo4j upsert; everything else succeeds.
    (runWriteTransaction as jest.Mock).mockImplementation(async (_cypher: string, params: Record<string, unknown>) => {
      if (params?.chunkId === 'chunk-1') throw new Error('neo4j write timeout');
      return createMockResult([{ deleted: 0 }]);
    });

    const { result } = await job.execute({ operation: 'update', documentId: 'doc-1' });

    // The run completes and the healthy chunk is synced …
    expect(result.chunksCreated).toBe(1);
    // … but the failed write is counted, not masked under success:true.
    expect(result.chunksFailed).toBe(1);
    expect(result.success).toBe(false);
    expect(runWriteTransaction).not.toHaveBeenCalledWith(
      expect.stringContaining('SET d.sourceFingerprint = $sourceFingerprint'),
      expect.anything()
    );
  });

  it('persists freshly generated embeddings back to the Firestore chunk (incremental re-embed wiring)', async () => {
    const vector = new Array(768).fill(0.03);
    (adminGetChunksForDocument as jest.Mock).mockResolvedValue([baseChunk('chunk-1')]);
    (generateEmbeddings as jest.Mock).mockResolvedValue({
      embeddings: new Map<number, number[]>([[0, vector]]),
      failures: new Map<number, string>(),
    });

    const { result } = await job.execute({ operation: 'update', documentId: 'doc-1' });

    expect(result.success).toBe(true);
    expect(result.embeddingsGenerated).toBe(1);
    expect(result.chunksEmbeddingFailed ?? 0).toBe(0);

    // Neo4j SET carries the vector.
    const upsert = findChunkUpsertCall('chunk-1');
    expect(upsert).toBeDefined();
    expect(upsert![1].embedding).toHaveLength(768);

    // Write-back to Firestore so the next sync skips regeneration.
    expect(adminUpdateChunkEmbedding).toHaveBeenCalledWith('chunk-1', vector, 'gemini-embedding-001');
  });

  it('skips regeneration when the Firestore chunk already carries a non-empty embedding', async () => {
    const existing = new Array(768).fill(0.05);
    (adminGetChunksForDocument as jest.Mock).mockResolvedValue([
      baseChunk('chunk-1', { embedding: existing, embeddingModel: 'gemini-embedding-001', embeddedAt: 1700000000000 }),
    ]);

    const { result } = await job.execute({ operation: 'update', documentId: 'doc-1' });

    expect(result.success).toBe(true);
    expect(generateEmbeddings).not.toHaveBeenCalled();
    expect(adminUpdateChunkEmbedding).not.toHaveBeenCalled();

    const upsert = findChunkUpsertCall('chunk-1');
    expect(upsert).toBeDefined();
    expect(upsert![1].embedding).toHaveLength(768);
  });

  it('treats a Firestore chunk with an EMPTY embedding array as needing regeneration (does not persist [])', async () => {
    const vector = new Array(768).fill(0.07);
    (adminGetChunksForDocument as jest.Mock).mockResolvedValue([baseChunk('chunk-1', { embedding: [] })]);
    (generateEmbeddings as jest.Mock).mockResolvedValue({
      embeddings: new Map<number, number[]>([[0, vector]]),
      failures: new Map<number, string>(),
    });

    const { result } = await job.execute({ operation: 'update', documentId: 'doc-1' });

    expect(result.success).toBe(true);
    // The generated vector — not the stale [] — must reach Neo4j.
    const upsert = findChunkUpsertCall('chunk-1');
    expect(upsert).toBeDefined();
    expect(upsert![1].embedding).toHaveLength(768);
    expect(adminUpdateChunkEmbedding).toHaveBeenCalledWith('chunk-1', vector, 'gemini-embedding-001');
  });

  it('handles mixed success/failure across chunks: only failed chunks skip the embedding SET', async () => {
    const vector = new Array(768).fill(0.09);
    (adminGetChunksForDocument as jest.Mock).mockResolvedValue([
      baseChunk('chunk-ok', { chunkIndex: 0 }),
      baseChunk('chunk-bad', { chunkIndex: 1 }),
    ]);
    (generateEmbeddings as jest.Mock).mockResolvedValue({
      embeddings: new Map<number, number[]>([[0, vector]]),
      failures: new Map<number, string>([[1, 'timeout']]),
    });

    const { result } = await job.execute({ operation: 'update', documentId: 'doc-1' });

    expect(result.chunksCreated).toBe(2);
    expect(result.chunksEmbeddingFailed).toBe(1);
    expect(result.success).toBe(false);

    const okUpsert = findChunkUpsertCall('chunk-ok');
    expect(okUpsert![1].embedding).toHaveLength(768);

    const badUpsert = findChunkUpsertCall('chunk-bad');
    expect(badUpsert![1]).not.toHaveProperty('embedding');

    expect(adminUpdateChunkEmbedding).toHaveBeenCalledTimes(1);
    expect(adminUpdateChunkEmbedding).toHaveBeenCalledWith('chunk-ok', vector, 'gemini-embedding-001');
  });

  it('M5: keeps chunks whose upsert failed THIS run in the stale-chunk delete keep-set (transient failure must not delete healthy chunks)', async () => {
    const vector = new Array(768).fill(0.13);
    (adminGetChunksForDocument as jest.Mock).mockResolvedValue([
      baseChunk('chunk-healthy', { chunkIndex: 0 }),
      baseChunk('chunk-flaky', { chunkIndex: 1 }),
    ]);
    (generateEmbeddings as jest.Mock).mockResolvedValue({
      embeddings: new Map<number, number[]>([
        [0, vector],
        [1, vector],
      ]),
      failures: new Map<number, string>(),
    });
    // chunk-flaky's Neo4j upsert fails transiently this run. It is STILL a
    // current chunk of the document — the delete-old-chunks pass must not
    // treat it as "left the document" and destroy its previously-healthy node.
    (runWriteTransaction as jest.Mock).mockImplementation(async (cypher: string, params: Record<string, unknown>) => {
      if (cypher.includes('MERGE (c:Chunk') && params?.chunkId === 'chunk-flaky') {
        throw new Error('Neo4j transient: connection reset');
      }
      return createMockResult([{ deleted: 0 }]);
    });

    const { result } = await job.execute({ operation: 'update', documentId: 'doc-1' });
    expect(result.chunksCreated).toBe(1); // only the healthy upsert counted

    const deleteCall = (runWriteTransaction as jest.Mock).mock.calls.find(([cypher]) =>
      (cypher as string).includes('$currentChunkIds')
    );
    expect(deleteCall).toBeDefined();
    const keepIds = (deleteCall![1] as { currentChunkIds: string[] }).currentChunkIds;
    expect(keepIds).toContain('chunk-healthy');
    expect(keepIds).toContain('chunk-flaky');
  });

  it('does not fail the run when the Firestore write-back fails (Neo4j already has the vector)', async () => {
    const vector = new Array(768).fill(0.11);
    (adminGetChunksForDocument as jest.Mock).mockResolvedValue([baseChunk('chunk-1')]);
    (generateEmbeddings as jest.Mock).mockResolvedValue({
      embeddings: new Map<number, number[]>([[0, vector]]),
      failures: new Map<number, string>(),
    });
    (adminUpdateChunkEmbedding as jest.Mock).mockRejectedValue(new Error('firestore down'));

    const { result } = await job.execute({ operation: 'update', documentId: 'doc-1' });

    expect(result.success).toBe(true);
    const upsert = findChunkUpsertCall('chunk-1');
    expect(upsert![1].embedding).toHaveLength(768);
  });
});
