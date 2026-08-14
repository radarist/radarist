/**
 * @file lib/inngest/functions/process-document.ts
 * @description Inngest job for processing uploaded documents.
 *
 * This function is triggered when a document is uploaded and needs
 * processing: text extraction, chunking, and status updates.
 *
 * **Execution Flow:**
 * 1. Load document metadata from Firestore
 * 2. Download file from Firebase Storage
 * 3. Extract text based on file type (PDF, DOCX, TXT, MD)
 * 4. Chunk text for embedding preparation
 * 5. Store chunks in Firestore
 * 6. Update document status
 * 7. Trigger Neo4j sync (generates embeddings and syncs to graph)
 *
 * **Trigger:** Event-driven (`app/document.process.requested`)
 * **Timeout:** 5 minutes (PDFs can be large)
 * **Retries:** 3 attempts
 *
 * @phase Phase 2: Evidence Layer
 * @author Radarist Team
 * @created 2026-01-09
 */

import { inngest } from '../client';
import { extractFailureEventData } from '../utils';
import { processDocument } from '@/lib/document-processing-service';
import { reprocessDocumentContent } from '@/lib/document-reprocess';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/process-document');
import { adminGetDocumentById as getDocumentById } from '@/lib/document-admin';

/**
 * Process document function
 *
 * **Trigger:** app/document.process.requested event
 * **Timeout:** 5 minutes
 * **Retries:** 3 attempts
 */
export const processDocumentJob = inngest.createFunction(
  {
    id: 'process-document',
    name: 'Process Document',
    retries: 3,

    /**
     * Failure handler - logs error and sends notification event
     */
    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event
      const documentId = extractFailureEventData<{ documentId?: string }>(event.data).documentId || 'unknown';
      log.error('Final failure for document processing', new Error(error.message), { documentId });

      // Send failure event for monitoring/alerting
      await inngest.send({
        name: 'app/document.process.failed',
        data: {
          documentId,
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  /**
   * Event trigger
   */
  { event: 'app/document.process.requested' },

  /**
   * Main function handler
   */
  async ({ event, step }) => {
    const { documentId, content, options, requestedBy } = event.data;

    try {
      /**
       * Step 1: Verify document exists
       */
      const document = await step.run('verify-document', async () => {
        const doc = await getDocumentById(documentId);
        if (!doc) {
          throw new Error(`Document ${documentId} not found`);
        }
        return doc;
      });

      log.info('Starting document processing', { documentId, title: document.title });

      /**
       * Step 2: Process document
       * For URL documents with content passed directly, use processDocumentFromContent
       * For file documents, download from storage and process
       */
      // UX-036: source selection used to hinge purely on the EVENT payload —
      // `content && options.source === 'url'` took the URL path, everything
      // else took the stored-file path. Any sender that did not pre-fetch (a
      // retry, an ops replay) therefore drove a URL document, whose
      // `storageUrl` is '', straight into the file path and marked it failed.
      // The shared operation inspects the DOCUMENT and picks the right source,
      // re-fetching (TDM-gated) when only a source URL exists.
      const result = await step.run('process-document', async () => {
        const outcome = await reprocessDocumentContent(documentId, {
          chunkSize: options?.chunkSize,
          chunkOverlap: options?.chunkOverlap,
          replaceExisting: options?.replaceExisting ?? true,
          content: content && options?.source === 'url' ? content : undefined,
          owner: typeof requestedBy === 'string' && requestedBy ? requestedBy : 'agent:process-document',
          correlationId: `process-document-${documentId}`,
        });

        return outcome.ok
          ? {
              success: true as const,
              documentId: outcome.documentId,
              textLength: outcome.textLength,
              pageCount: outcome.pageCount,
              chunkCount: outcome.chunkCount,
            }
          : {
              success: false as const,
              documentId: outcome.documentId,
              error: outcome.error,
              stage: outcome.stage ?? outcome.code,
            };
      });

      /**
       * Step 3: Send completion or failure event
       */
      await step.run('send-completion', async () => {
        if (result.success) {
          await inngest.send({
            name: 'app/document.process.completed',
            data: {
              documentId,
              textLength: result.textLength,
              pageCount: result.pageCount,
              chunkCount: result.chunkCount,
              processedAt: Date.now(),
            },
          });
        } else {
          await inngest.send({
            name: 'app/document.process.failed',
            data: {
              documentId,
              error: result.error,
              stage: result.stage,
              failedAt: Date.now(),
            },
          });
        }
      });

      if (!result.success) {
        log.error('Document processing failed', undefined, { documentId, error: result.error, stage: result.stage });
        return {
          success: false,
          documentId,
          error: result.error,
          stage: result.stage,
        };
      }

      /**
       * Step 4: Trigger Neo4j sync to generate embeddings and sync to graph
       * This is a fire-and-forget operation - we don't wait for it to complete
       */
      await step.run('trigger-neo4j-sync', async () => {
        await inngest.send({
          name: 'app/document.sync.requested',
          data: {
            operation: 'update',
            documentId,
          },
        });

        log.info('Triggered Neo4j sync', { documentId });
      });

      log.info('Document processing completed', {
        documentId,
        textLength: result.textLength,
        chunkCount: result.chunkCount,
      });

      return {
        success: true,
        documentId,
        textLength: result.textLength,
        pageCount: result.pageCount,
        chunkCount: result.chunkCount,
      };
    } catch (error) {
      log.error('Document processing error', error instanceof Error ? error : undefined, { documentId });
      throw error; // Re-throw to trigger retry
    }
  }
);

/**
 * Batch process documents function
 *
 * Process multiple documents in sequence to avoid overwhelming the system.
 *
 * **Trigger:** app/document.batch-process.requested event
 * **Timeout:** 30 minutes
 * **Retries:** 2 attempts
 */
export const batchProcessDocumentsJob = inngest.createFunction(
  {
    id: 'batch-process-documents',
    name: 'Batch Process Documents',
    retries: 2,

    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event
      const documentIds = extractFailureEventData<{ documentIds?: string[] }>(event.data).documentIds || [];
      log.error('Batch process documents final failure', new Error(error.message), {
        documentCount: documentIds.length,
      });
    },
  },

  // Manual ops hook — no in-app sender; trigger via Inngest dev UI / API for backfills.
  { event: 'app/document.batch-process.requested' },

  async ({ event, step }) => {
    const { documentIds, options } = event.data;

    if (!documentIds || documentIds.length === 0) {
      return { success: false, error: 'No document IDs provided' };
    }

    const results: Array<{
      documentId: string;
      success: boolean;
      error?: string;
    }> = [];

    /**
     * Process each document sequentially
     * (could be parallelized with step.invoke but sequential is safer for resources)
     */
    for (const documentId of documentIds) {
      const result = await step.run(`process-${documentId}`, async () => {
        try {
          const processResult = await processDocument(documentId, options);

          if (processResult.success) {
            return { documentId, success: true };
          } else {
            return { documentId, success: false, error: processResult.error };
          }
        } catch (error) {
          return {
            documentId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      });

      results.push(result);
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    log.info('Batch process documents completed', { successful, total: documentIds.length, failed });

    return {
      success: failed === 0,
      total: documentIds.length,
      successful,
      failed,
      results,
    };
  }
);
