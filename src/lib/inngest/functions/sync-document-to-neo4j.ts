/**
 * @file lib/inngest/functions/sync-document-to-neo4j.ts
 * @description Inngest job for syncing Document and Chunk entities to Neo4j
 *
 * This module handles synchronization of documents and their chunks to the Neo4j graph:
 * - Creates Document nodes with metadata
 * - Creates Chunk nodes with embeddings for vector search
 * - Creates relationships: (Document)-[:CONTAINS]->(Chunk)
 * - Creates relationships: (Entity)-[:MENTIONS]->(Document) via EntityDocumentLink
 * - Handles delete cascades to remove orphaned chunks
 *
 * **Execution Flow:**
 * 1. Receive event with document data
 * 2. Check Neo4j health
 * 3. Create/update/delete Document node
 * 4. Sync all chunks with embeddings
 * 5. Create CONTAINS relationships
 * 6. Send completion event
 *
 * **Trigger:** Event-driven (`app/document.sync.requested`)
 * **Timeout:** 2 minutes per document (larger documents may have many chunks)
 * **Retries:** 3 attempts with exponential backoff
 *
 * @phase Knowledge Tab Sprint - Phase 1.5
 * @author Radarist Team
 * @created 2026-01-14
 */

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { toMillis, extractFailureEventData } from '../utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/sync-document-to-neo4j');
import {
  applyMentionTrustForDocument,
  checkHealth,
  deleteEntityFromGraph,
  deriveDocumentContentProvenance,
  deriveMentionSourceReviewState,
  linkChunkMentions,
  runWriteTransaction,
} from '@/lib/graph';
import type { MentionSourceDocument } from '@/lib/graph/mention-trust';
import type { Document } from '@/lib/types';
import {
  adminGetChunksForDocument as getChunksForDocument,
  adminUpdateChunkEmbedding,
} from '@/lib/document-chunk-admin';
import { generateEmbeddings } from '@/lib/ai/client';
import { DEFAULT_EMBEDDING_MODEL, TaskType } from '@/lib/ai/constants';
import type { DocumentChunk } from '@/lib/types';
import { createEntitySourceFingerprint } from '@/lib/entity-source-version';
import { clearConvergedEntityGraphSyncAnchor, readEntityGraphSyncAnchor } from '@/lib/entity-graph-sync-outbox-admin';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface SyncResult {
  documentId: string;
  operation: 'created' | 'updated' | 'deleted';
  chunksCreated?: number;
  chunksUpdated?: number;
  chunksDeleted?: number;
  embeddingsGenerated?: number;
  /**
   * H7: chunks synced WITHOUT an embedding this run (generation failed and no
   * prior vector was available in Firestore). Non-zero ⇒ the run must not
   * report success:true.
   */
  chunksEmbeddingFailed?: number;
  /**
   * P3-B (same model as H7): chunks whose Neo4j upsert threw this run.
   * Non-zero ⇒ the run must not report success:true — previously these were
   * warn-and-continue masked while the run reported blanket success.
   */
  chunksFailed?: number;
  /**
   * GRAPH-064: the trust this run re-derived for the document's chunk mentions,
   * so a run summary shows what the graph was actually allowed to claim.
   */
  mentionTrust?: {
    claimStatus: string;
    confidence: number;
    sourceProvenance: string;
    sourceReviewState: string;
    edgesUpdated: number;
  };
  skipped?: 'source-missing';
  sourceFingerprint?: string;
}

// ============================================================================
// CYPHER QUERIES
// ============================================================================

/**
 * Create or update a Document node
 */
const UPSERT_DOCUMENT = `
  MERGE (d:Document {id: $documentId})
  ON CREATE SET
    d.title = $title,
    d.type = $type,
    d.domain = $domain,
    d.version = $version,
    d.workspaceId = $workspaceId,
    d.linkedEntityCount = $linkedEntityCount,
    d.status = $status,
    d.contentProvenance = $contentProvenance,
    d.contentReviewedAt = $contentReviewedAt,
    d.contentReviewedBy = $contentReviewedBy,
    d.createdAt = $createdAt,
    d.updatedAt = $updatedAt
  ON MATCH SET
    d.title = $title,
    d.type = $type,
    d.domain = $domain,
    d.version = $version,
    d.workspaceId = $workspaceId,
    d.linkedEntityCount = $linkedEntityCount,
    d.status = $status,
    d.contentProvenance = $contentProvenance,
    d.contentReviewedAt = $contentReviewedAt,
    d.contentReviewedBy = $contentReviewedBy,
    d.updatedAt = $updatedAt
  SET d:Entity
  RETURN d
`;

const STAMP_DOCUMENT_SOURCE_FINGERPRINT = `
  MATCH (d:Entity:Document {id: $documentId})
  SET d.sourceFingerprint = $sourceFingerprint
  RETURN d.id AS documentId
`;

/**
 * Create or update a Chunk node with embedding
 */
const UPSERT_CHUNK = `
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
    c.embeddedAt = $embeddedAt,
    c.createdAt = $createdAt
  ON MATCH SET
    c.content = $content,
    c.chunkIndex = $chunkIndex,
    c.tokenCount = $tokenCount,
    c.documentVersion = $documentVersion,
    c.archived = $archived,
    c.embedding = $embedding,
    c.embeddingModel = $embeddingModel,
    c.embeddedAt = $embeddedAt
  RETURN c
`;

/**
 * Create or update a Chunk node WITHOUT touching its embedding properties.
 *
 * H7 guard: used when no embedding is available for the chunk this run
 * (generation failed and Firestore has no prior vector). Neo4j is the
 * authoritative embedding store — an ON MATCH SET of an empty vector would
 * silently destroy a previously-good one, so the embedding/embeddingModel/
 * embeddedAt properties are omitted from BOTH SET branches here.
 */
const UPSERT_CHUNK_WITHOUT_EMBEDDING = `
  MERGE (c:Chunk {id: $chunkId})
  ON CREATE SET
    c.documentId = $documentId,
    c.content = $content,
    c.chunkIndex = $chunkIndex,
    c.tokenCount = $tokenCount,
    c.documentVersion = $documentVersion,
    c.archived = $archived,
    c.createdAt = $createdAt
  ON MATCH SET
    c.content = $content,
    c.chunkIndex = $chunkIndex,
    c.tokenCount = $tokenCount,
    c.documentVersion = $documentVersion,
    c.archived = $archived
  RETURN c
`;

/**
 * Create CONTAINS relationship from Document to Chunk
 */
const CREATE_CONTAINS_RELATIONSHIP = `
  MATCH (d:Document {id: $documentId})
  MATCH (c:Chunk {id: $chunkId})
  MERGE (d)-[r:CONTAINS]->(c)
  ON CREATE SET r.createdAt = $createdAt
  RETURN r
`;

/**
 * Delete chunks that are no longer in the document
 */
const DELETE_OLD_CHUNKS = `
  MATCH (d:Document {id: $documentId})-[:CONTAINS]->(c:Chunk)
  WHERE NOT c.id IN $currentChunkIds
  DETACH DELETE c
  RETURN count(c) as deleted
`;

/**
 * Archive chunks from previous document versions
 */
const _ARCHIVE_OLD_VERSION_CHUNKS = `
  MATCH (d:Document {id: $documentId})-[:CONTAINS]->(c:Chunk)
  WHERE c.documentVersion < $currentVersion
  SET c.archived = true
  RETURN count(c) as archived
`;

// ============================================================================
// SYNC DOCUMENT JOB
// ============================================================================

/**
 * Sync a single Document to Neo4j
 *
 * **Trigger:** app/document.sync.requested event
 * **Timeout:** 2 minutes
 * **Retries:** 3 attempts
 */
export const syncDocumentToNeo4jJob = inngest.createFunction(
  {
    id: 'sync-document-to-neo4j',
    name: 'Sync Document to Neo4j',
    retries: 3,
    throttle: {
      limit: 20,
      period: '1m',
    },
    concurrency: {
      key: 'event.data.documentId',
      limit: 1,
    },

    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event
      const data = extractFailureEventData<{ documentId?: string; operation?: string }>(event.data);
      const documentId = data.documentId || 'unknown';
      log.error('Sync document final failure', new Error(error.message), { documentId });

      await inngest.send({
        name: 'app/document.sync.failed',
        data: {
          documentId,
          operation: data.operation || 'unknown',
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  { event: 'app/document.sync.requested' },

  async ({ event, step }) => {
    const { operation, documentId } = event.data;

    try {
      // Step 1: Check Neo4j health
      await step.run('check-neo4j-health', async () => {
        const health = await checkHealth();
        if (!health.healthy) {
          throw new Error(`Neo4j not healthy: ${health.error}`);
        }
        return health;
      });

      // Step 2: Perform operation
      const result = await step.run('sync-document', async (): Promise<SyncResult> => {
        switch (operation) {
          case 'create':
          case 'update': {
            // Load document from Firestore via admin SDK. Going through
            // `@/lib/document-service` would pull in the client SDK
            // (firebase/firestore), which hangs gRPC streams server-side.
            // Same bug class as the relation sync fix on 2026-05-12.
            const { db: adminDb } = await import('@/lib/firebase-admin');
            const snap = await adminDb.collection('documents').doc(documentId).get();
            if (!snap.exists) {
              // Entity may have been deleted - skip sync gracefully
              log.warn('Document not found in Firestore - skipping sync', { documentId });
              return {
                documentId,
                operation: operation === 'create' ? ('created' as const) : ('updated' as const),
                chunksCreated: 0,
                skipped: 'source-missing' as const,
              };
            }
            const document = snap.data() as Document;
            const authoritativeDocument = document as unknown as Record<string, unknown>;
            const sourceFingerprint = await createEntitySourceFingerprint(
              'document',
              documentId,
              authoritativeDocument
            );
            const graphProjection = {
              node: {
                title: typeof document.title === 'string' ? document.title : '',
                type: typeof document.type === 'string' ? document.type : 'unknown',
                domain: typeof document.domain === 'string' ? document.domain : null,
                version:
                  typeof document.version === 'number' && Number.isFinite(document.version) ? document.version : 1,
                workspaceId: typeof document.workspaceId === 'string' ? document.workspaceId : 'default',
                linkedEntityCount:
                  typeof document.linkedEntityCount === 'number' && Number.isFinite(document.linkedEntityCount)
                    ? document.linkedEntityCount
                    : 0,
                status: typeof document.status === 'string' ? document.status : null,
                createdAt: toMillis(document.createdAt, 0),
                updatedAt: toMillis(document.updatedAt, 0),
                // GRAPH-064: project the two facts that decide what this
                // document's chunk mentions may claim. Derived here, from the
                // authoritative Firestore record, so the graph never has to
                // re-guess a document's provenance.
                contentProvenance: deriveDocumentContentProvenance(document as MentionSourceDocument),
                contentReviewedAt:
                  typeof document.contentReviewedAt === 'number' && document.contentReviewedAt > 0
                    ? document.contentReviewedAt
                    : null,
                contentReviewedBy: typeof document.contentReviewedBy === 'string' ? document.contentReviewedBy : null,
              },
            };
            const now = Date.now();

            // Event payloads are deliberately ignored. A queued update can be
            // older than Firestore; allowing its inline fields to win would
            // overwrite current graph metadata with stale values.
            const docParams = {
              documentId,
              ...graphProjection.node,
              sourceFingerprint,
            };

            // Create/update document node
            await runWriteTransaction(UPSERT_DOCUMENT, docParams);

            // Load chunks from Firestore
            const chunks: DocumentChunk[] = await getChunksForDocument(documentId);

            if (chunks.length === 0) {
              log.info('No chunks found for document', { documentId });
              const deleteResult = await runWriteTransaction<{ deleted: number }>(DELETE_OLD_CHUNKS, {
                documentId,
                currentChunkIds: [],
              });
              await runWriteTransaction(STAMP_DOCUMENT_SOURCE_FINGERPRINT, {
                documentId,
                sourceFingerprint,
              });
              return {
                documentId,
                operation: operation === 'create' ? 'created' : 'updated',
                chunksCreated: 0,
                chunksDeleted: deleteResult.records[0]?.deleted || 0,
                sourceFingerprint,
              };
            }

            // Generate embeddings only for chunks whose Firestore doc doesn't
            // already carry a non-empty vector (incremental re-embed — H7).
            const chunksNeedingEmbeddings = chunks.filter(
              (c: DocumentChunk) => !Array.isArray(c.embedding) || c.embedding.length === 0
            );

            let embeddingsGenerated = 0;
            const embeddingMap = new Map<string, number[]>();

            if (chunksNeedingEmbeddings.length > 0) {
              log.info('Generating embeddings for chunks', { count: chunksNeedingEmbeddings.length });

              const texts = chunksNeedingEmbeddings.map((c: DocumentChunk) => c.content);
              const embeddingResult = await generateEmbeddings(texts, {
                taskType: TaskType.RETRIEVAL_DOCUMENT,
                concurrency: 5,
              });

              // Map embeddings back to chunk IDs and persist them to the
              // Firestore chunk (H7 write-back) so the next sync skips
              // regeneration. Best-effort: Neo4j still gets the vector this
              // run even if the Firestore write fails.
              for (const [index, chunk] of chunksNeedingEmbeddings.entries()) {
                const embedding = embeddingResult.embeddings.get(index);
                if (!embedding || embedding.length === 0) {
                  continue;
                }
                embeddingMap.set(chunk.id, embedding);
                embeddingsGenerated++;
                try {
                  await adminUpdateChunkEmbedding(chunk.id, embedding, chunk.embeddingModel || DEFAULT_EMBEDDING_MODEL);
                } catch (writeBackErr) {
                  log.warn('Failed to write embedding back to Firestore chunk', {
                    chunkId: chunk.id,
                    error: writeBackErr instanceof Error ? writeBackErr.message : String(writeBackErr),
                  });
                }
              }

              // Log any failures
              if (embeddingResult.failures.size > 0) {
                log.warn('Embedding generation failures', { failureCount: embeddingResult.failures.size });
              }
            }

            // Sync chunks to Neo4j
            let chunksCreated = 0;
            let chunksEmbeddingFailed = 0;
            let chunksFailed = 0;

            // M5 keep-set: EVERY chunk currently in Firestore is a current
            // chunk of the document — including ones whose Neo4j upsert
            // fails transiently this run. Deriving the keep-set from
            // successful upserts only meant a transient failure permanently
            // DETACH-DELETEd a previously-healthy chunk node below.
            const currentChunkIds: string[] = chunks.map((c: DocumentChunk) => c.id);

            for (const chunk of chunks) {
              // Use the existing non-empty embedding or the newly generated
              // one. A chunk with an empty [] in Firestore counts as having
              // no embedding (it was queued for regeneration above).
              const existingEmbedding =
                Array.isArray(chunk.embedding) && chunk.embedding.length > 0 ? chunk.embedding : undefined;
              const embedding = existingEmbedding ?? embeddingMap.get(chunk.id);
              const hasEmbedding = !!embedding && embedding.length > 0;

              const baseChunkParams = {
                chunkId: chunk.id,
                documentId: chunk.documentId,
                content: chunk.content,
                chunkIndex: chunk.chunkIndex,
                tokenCount: chunk.tokenCount || null,
                documentVersion: chunk.documentVersion || docParams.version,
                archived: chunk.archived || false,
                createdAt: toMillis(chunk.createdAt, now),
              };

              // H7 guard: when no embedding is available, the SET must not
              // touch c.embedding — an ON MATCH SET of [] would overwrite a
              // previously-good vector in Neo4j (the authoritative store).
              const chunkParams = hasEmbedding
                ? {
                    ...baseChunkParams,
                    embedding,
                    embeddingModel: chunk.embeddingModel || DEFAULT_EMBEDDING_MODEL,
                    // Convert timestamps (handles serialized Firestore timestamps)
                    embeddedAt: chunk.embeddedAt ? toMillis(chunk.embeddedAt) : now,
                  }
                : baseChunkParams;

              if (!hasEmbedding) {
                chunksEmbeddingFailed++;
                log.warn('Chunk synced without embedding — generation failed and no prior vector exists', {
                  chunkId: chunk.id,
                  documentId,
                });
              }

              try {
                await runWriteTransaction(hasEmbedding ? UPSERT_CHUNK : UPSERT_CHUNK_WITHOUT_EMBEDDING, chunkParams);

                // Create CONTAINS relationship
                await runWriteTransaction(CREATE_CONTAINS_RELATIONSHIP, {
                  documentId,
                  chunkId: chunk.id,
                  createdAt: now,
                });

                // Phase 3: link chunk → entity MENTIONS via text-match.
                // Best-effort; never block chunk sync on mention linking.
                try {
                  await linkChunkMentions(chunk.id);
                } catch (linkErr) {
                  log.warn('Failed to link chunk mentions', {
                    chunkId: chunk.id,
                    error: linkErr instanceof Error ? linkErr.message : String(linkErr),
                  });
                }

                chunksCreated++;
              } catch (err) {
                // P3-B: count the failed write — the run must not report
                // blanket success while a chunk is missing from the graph.
                chunksFailed++;
                log.warn('Failed to sync chunk', {
                  chunkId: chunk.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }

            // Delete chunks that genuinely left the document (their id is no
            // longer among the document's Firestore chunks).
            const deleteResult = await runWriteTransaction<{ deleted: number }>(DELETE_OLD_CHUNKS, {
              documentId,
              currentChunkIds,
            });

            const chunksDeleted = deleteResult.records[0]?.deleted || 0;

            // GRAPH-064: re-derive mention trust for the WHOLE document, not
            // only the chunks this run happened to touch. A review (or its
            // withdrawal) changes what every existing mention may claim, and
            // chunks that were already linked are never re-matched. Idempotent:
            // it recomputes the same derivation the writer used.
            const mentionTrust = await applyMentionTrustForDocument(
              documentId,
              graphProjection.node.contentProvenance,
              deriveMentionSourceReviewState(document as MentionSourceDocument)
            );

            // The source fingerprint certifies the required graph topology:
            // Document, Chunk, and CONTAINS writes. Embeddings are an optional
            // enrichment under H7; a keyless or quota-limited local workspace
            // must still converge once every chunk is present. Keep embedding
            // failures in the run telemetry/success result below without
            // turning them into a permanent reconciliation replay loop.
            const completeTopology = chunksFailed === 0;
            if (completeTopology) {
              await runWriteTransaction(STAMP_DOCUMENT_SOURCE_FINGERPRINT, {
                documentId,
                sourceFingerprint,
              });
            }

            return {
              documentId,
              operation: operation === 'create' ? 'created' : 'updated',
              chunksCreated,
              chunksDeleted,
              embeddingsGenerated,
              chunksEmbeddingFailed,
              chunksFailed,
              mentionTrust: {
                claimStatus: mentionTrust.trust.claimStatus,
                confidence: mentionTrust.trust.confidence,
                sourceProvenance: mentionTrust.trust.sourceProvenance,
                sourceReviewState: mentionTrust.trust.sourceReviewState,
                edgesUpdated: mentionTrust.edgesUpdated,
              },
              ...(completeTopology ? { sourceFingerprint } : {}),
            };
          }

          case 'delete': {
            // The API deliberately queues this durable handoff before removing
            // Firestore. A fast worker can therefore arrive first. Refuse the
            // graph delete while the authoritative source still exists so
            // Inngest retries after the parent transaction instead of creating
            // cross-store divergence when that transaction fails.
            const { db: adminDb } = await import('@/lib/firebase-admin');
            const source = await adminDb.collection('documents').doc(documentId).get();
            if (source.exists) {
              throw new Error(`Refusing Document graph deletion while Firestore source exists: ${documentId}`);
            }

            // The helper deletes Document chunks, endpoint-backed Assertions,
            // their Evidence, and claimId projections atomically. It also runs
            // when the Document node is already absent to finish partial deletes.
            const { chunksDeleted } = await deleteEntityFromGraph(documentId, 'document');

            return {
              documentId,
              operation: 'deleted',
              chunksDeleted,
            };
          }

          default:
            throw new Error(`Unknown operation: ${operation}`);
        }
      });

      await step.run('settle-entity-graph-sync-anchor', async () => {
        try {
          const anchor = await readEntityGraphSyncAnchor('document', documentId);
          if (!anchor) return { outcome: 'absent' };
          const { db: adminDb } = await import('@/lib/firebase-admin');
          const currentSnapshot = await adminDb.collection('documents').doc(documentId).get();
          if (!currentSnapshot.exists) {
            return {
              outcome: await clearConvergedEntityGraphSyncAnchor('document', documentId, anchor.generation),
              reason: 'entity-deleted',
            };
          }
          if (!result.sourceFingerprint || (result.chunksFailed ?? 0) > 0) {
            return { outcome: 'no-complete-projection-written' };
          }
          const current = currentSnapshot.data() as Record<string, unknown>;
          const currentFingerprint = await createEntitySourceFingerprint('document', documentId, current);
          if (currentFingerprint !== result.sourceFingerprint) return { outcome: 'source-moved' };
          return {
            outcome: await clearConvergedEntityGraphSyncAnchor('document', documentId, anchor.generation),
          };
        } catch (error) {
          log.warn('Could not settle Document graph sync recovery anchor', {
            documentId,
            error: error instanceof Error ? error.message : String(error),
          });
          return { outcome: 'settle-failed' };
        }
      });

      // Step 3: Send completion event
      await step.run('send-completion', async () => {
        await inngest.send({
          name: 'app/document.sync.completed',
          data: {
            documentId: result.documentId,
            operation: result.operation,
            chunksCreated: result.chunksCreated,
            chunksDeleted: result.chunksDeleted,
            chunksEmbeddingFailed: result.chunksEmbeddingFailed,
            syncedAt: Date.now(),
          },
        });
      });

      const chunksEmbeddingFailed = result.chunksEmbeddingFailed ?? 0;
      const chunksFailed = result.chunksFailed ?? 0;

      log.info('Sync document completed', {
        documentId,
        operation: result.operation,
        chunksCreated: result.chunksCreated || 0,
        embeddingsGenerated: result.embeddingsGenerated || 0,
        chunksEmbeddingFailed,
        chunksFailed,
      });

      return {
        // H7: a run that left chunks without embeddings must not report
        // blanket success — downstream vector search silently misses them.
        // P3-B extends the same rule to chunks whose Neo4j upsert failed.
        success: chunksEmbeddingFailed === 0 && chunksFailed === 0,
        ...result,
      };
    } catch (error) {
      log.error('Sync document failed', error instanceof Error ? error : undefined, { documentId });
      throw error;
    }
  }
);

// ============================================================================
// BATCH SYNC JOB
// ============================================================================

/**
 * Batch sync multiple Documents to Neo4j
 * Used for backfill operations and migrations
 *
 * **Trigger:** app/document.batch-sync.requested event
 * **Timeout:** 30 minutes
 * **Retries:** 2 attempts
 */
export const batchSyncDocumentsJob = inngest.createFunction(
  {
    id: 'batch-sync-documents-to-neo4j',
    name: 'Batch Sync Documents to Neo4j',
    retries: 2,

    onFailure: async ({ error }) => {
      log.error('Batch sync documents final failure', new Error(error.message));
    },
  },

  // Manual ops hook — no in-app sender; trigger via Inngest dev UI / API for backfills.
  { event: 'app/document.batch-sync.requested' },

  async ({ event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('batch-sync-documents-to-neo4j');
    const { documentIds, options } = event.data as {
      documentIds: string[];
      options?: { batchSize?: number; generateEmbeddings?: boolean };
    };

    try {
      // Step 1: Check Neo4j health
      await step.run('check-neo4j-health', async () => {
        const health = await checkHealth();
        if (!health.healthy) {
          throw new Error(`Neo4j not healthy: ${health.error}`);
        }
      });

      // Step 2: Process documents in batches
      const batchSize = options?.batchSize || 10;
      const results = {
        synced: 0,
        failed: 0,
        errors: [] as string[],
      };

      for (let i = 0; i < documentIds.length; i += batchSize) {
        const batch = documentIds.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;

        await step.run(`process-batch-${batchNum}`, async () => {
          for (const documentId of batch) {
            try {
              // Trigger individual sync for each document
              await inngest.send({
                name: 'app/document.sync.requested',
                data: {
                  operation: 'update',
                  documentId,
                },
              });

              results.synced++;
            } catch (error) {
              results.failed++;
              results.errors.push(
                `Failed to queue sync for ${documentId}: ${error instanceof Error ? error.message : 'Unknown error'}`
              );
            }
          }

          return { batchNum, processed: batch.length };
        });
      }

      log.info('Batch sync documents completed', {
        synced: results.synced,
        total: documentIds.length,
        failed: results.failed,
      });

      return {
        success: results.failed === 0,
        ...results,
      };
    } catch (error) {
      log.error('Batch sync documents failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }
);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Trigger a document sync from application code
 */
export async function triggerDocumentSync(
  documentId: string,
  operation: 'create' | 'update' | 'delete'
): Promise<void> {
  await inngest.send({
    name: 'app/document.sync.requested',
    data: {
      documentId,
      operation,
    },
  });
}

// Note: For entity-document link sync, use triggerEntityDocumentLinkSync from
// '@/lib/inngest/functions/sync-entity-document-link-to-neo4j' instead
