/**
 * @file lib/inngest/functions/refresh-url-document.ts
 * @description Inngest job for refreshing URL document content.
 *
 * This function is triggered to refresh a URL document's content.
 * It checks if the content has changed and if so, archives old chunks
 * and triggers reprocessing.
 *
 * **Execution Flow:**
 * 1. Load document metadata from Firestore
 * 2. Fetch URL content
 * 3. Compute content hash
 * 4. If content changed:
 *    - Archive existing chunks
 *    - Trigger reprocessing
 *    - Increment version
 * 5. Update document status
 *
 * **Trigger:** Event-driven (`app/document.refresh.requested`)
 * **Timeout:** 2 minutes
 * **Retries:** 3 attempts
 *
 * @phase Knowledge Tab Sprint
 * @author Radarist Team
 * @created 2026-01-14
 */

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { SKIP_REASONS } from '../skip-reasons';
import { extractFailureEventData } from '../utils';
// T1.4: replaced static imports of `@/lib/document-service` +
// `@/lib/document-chunk-service` with the narrow admin-SDK helper. Those
// modules statically import `firebase/firestore` + `@/lib/firebase` at load
// time, which fails with `code: 'unavailable'` inside the Inngest worker.
// The helper covers the 7 functions this job uses; the full document-service
// split is Track 2 Tier 2.
import {
  getDocumentById,
  startDocumentRefresh,
  completeDocumentRefresh,
  failDocumentRefresh,
  markDocumentBlocked,
  archiveChunksForDocument,
} from '@/lib/document-refresh-admin';
import { createLogger } from '@/lib/logger';
import { checkTdmPolicy } from '@/lib/tdm-policy';

const log = createLogger('inngest/refresh-url-document');
import * as crypto from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

interface UrlFetchResult {
  success: boolean;
  content?: string;
  title?: string;
  contentHash?: string;
  error?: string;
  blocked?: boolean;
  blockReason?: string;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Compute SHA-256 hash of content for change detection.
 */
function computeContentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Fetch URL content using simple fetch.
 * Returns the text content and computes hash.
 */
async function fetchUrlContent(url: string): Promise<UrlFetchResult> {
  // DSM Directive (EU) 2019/790 Art 4(3): respect machine-readable TDM opt-outs
  // (robots.txt / ai.txt) before fetching content for ingestion.
  const tdm = await checkTdmPolicy(url);
  if (!tdm.allowed) {
    return { success: false, blocked: true, blockReason: tdm.reason ?? 'TDM opt-out' };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
    let response: Response;

    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Radarist/1.0 (Knowledge Tab; Research Bot)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    // Check for blocked responses
    if (response.status === 403) {
      return {
        success: false,
        blocked: true,
        blockReason: 'Access forbidden (403)',
      };
    }

    if (response.status === 401) {
      return {
        success: false,
        blocked: true,
        blockReason: 'Authentication required (401)',
      };
    }

    if (response.status === 451) {
      return {
        success: false,
        blocked: true,
        blockReason: 'Unavailable for legal reasons (451)',
      };
    }

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const contentType = response.headers.get('content-type') || '';

    // Only process HTML/text content
    if (
      !contentType.includes('text/html') &&
      !contentType.includes('text/plain') &&
      !contentType.includes('application/xhtml')
    ) {
      return {
        success: false,
        error: `Unsupported content type: ${contentType}`,
      };
    }

    const html = await response.text();

    // Extract text content from HTML (basic extraction)
    const textContent = extractTextFromHtml(html);
    const title = extractTitleFromHtml(html);
    const contentHash = computeContentHash(textContent);

    return {
      success: true,
      content: textContent,
      title,
      contentHash,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        success: false,
        error: 'Request timeout (30s)',
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown fetch error',
    };
  }
}

/**
 * Extract text content from HTML (basic implementation).
 * Strips tags and normalizes whitespace.
 */
function extractTextFromHtml(html: string): string {
  // Remove script and style elements
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");

  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Extract title from HTML.
 */
function extractTitleFromHtml(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : undefined;
}

// ============================================================================
// INNGEST FUNCTIONS
// ============================================================================

/**
 * Refresh URL document function
 *
 * **Trigger:** app/document.refresh.requested event
 * **Timeout:** 2 minutes
 * **Retries:** 3 attempts
 */
export const refreshUrlDocumentJob = inngest.createFunction(
  {
    id: 'refresh-url-document',
    name: 'Refresh URL Document',
    retries: 3,

    /**
     * Failure handler - logs error and sends notification event
     */
    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event
      const documentId = extractFailureEventData<{ documentId?: string }>(event.data).documentId || 'unknown';
      log.error('Final failure for URL document refresh', new Error(error.message), { documentId });

      // Try to update document status (skip when the id couldn't be recovered)
      if (documentId !== 'unknown') {
        try {
          await failDocumentRefresh(documentId, error.message);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Send failure event for monitoring/alerting
      await inngest.send({
        name: 'app/document.refresh.failed',
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
  { event: 'app/document.refresh.requested' },

  /**
   * Main function handler
   */
  async ({ event, step }) => {
    const { documentId, force = false } = event.data;

    try {
      /**
       * Step 1: Verify document exists and is a URL type
       */
      const document = await step.run('verify-document', async () => {
        const doc = await getDocumentById(documentId);
        if (!doc) {
          throw new Error(`Document ${documentId} not found`);
        }
        if (doc.type !== 'url') {
          throw new Error(`Document ${documentId} is not a URL type`);
        }
        if (!doc.originalUrl) {
          throw new Error(`Document ${documentId} has no original URL`);
        }
        return doc;
      });

      log.info('Starting URL document refresh', { documentId, title: document.title, url: document.originalUrl });

      /**
       * Step 2: Start refresh (sets flag to prevent concurrent refreshes)
       */
      const canRefresh = await step.run('start-refresh', async () => {
        if (!force) {
          return await startDocumentRefresh(documentId);
        }
        // Force refresh - always proceed
        return true;
      });

      if (!canRefresh) {
        log.info('Refresh already in progress', { documentId });
        return {
          success: false,
          documentId,
          skipped: true,
          reason: SKIP_REASONS.REFRESH_IN_PROGRESS,
        };
      }

      /**
       * Step 3: Fetch URL content
       */
      const fetchResult = await step.run('fetch-url', async () => {
        return await fetchUrlContent(document.originalUrl!);
      });

      // Handle blocked URLs
      if (fetchResult.blocked) {
        await step.run('handle-blocked', async () => {
          await markDocumentBlocked(documentId, fetchResult.blockReason || 'Access blocked');
        });

        log.warn('URL blocked', { documentId, reason: fetchResult.blockReason });
        return {
          success: false,
          documentId,
          blocked: true,
          reason: fetchResult.blockReason,
        };
      }

      // Handle fetch errors
      if (!fetchResult.success) {
        await step.run('handle-fetch-error', async () => {
          await failDocumentRefresh(documentId, fetchResult.error || 'Fetch failed');
        });

        log.warn('URL fetch failed', { documentId, error: fetchResult.error });
        return {
          success: false,
          documentId,
          error: fetchResult.error,
        };
      }

      /**
       * Step 4: Check if content has changed
       */
      const contentChanged = document.contentHash !== fetchResult.contentHash;

      if (contentChanged) {
        log.info('Content changed, archiving old chunks', { documentId });

        /**
         * Step 5a: Archive existing chunks (preserve for citation integrity)
         */
        const archivedCount = await step.run('archive-chunks', async () => {
          return await archiveChunksForDocument(documentId);
        });

        log.info('Archived chunks', { documentId, archivedCount });

        /**
         * Step 5b: Complete refresh and trigger reprocessing
         */
        await step.run('complete-refresh', async () => {
          await completeDocumentRefresh(documentId, true, fetchResult.contentHash);
        });

        /**
         * Step 5c: Trigger document reprocessing.
         *
         * URL documents have no stored file (storageUrl is ''), so the
         * process job MUST take the content path (processDocumentFromContent).
         * That path is selected by `content` + `options.source === 'url'` —
         * the same payload shape api/documents/url/route.ts sends on initial
         * ingestion. Omitting them (the old behavior) routed reprocessing
         * down the file-download path, which fails for URL documents and
         * marked them `failed` on every content change.
         */
        await step.run('trigger-reprocessing', async () => {
          await inngest.send({
            name: 'app/document.process.requested',
            data: {
              documentId,
              content: fetchResult.content,
              options: {
                source: 'url',
                replaceExisting: false, // Don't delete archived chunks
              },
            },
          });
        });

        log.info('Triggered reprocessing', { documentId });

        return {
          success: true,
          documentId,
          contentChanged: true,
          archivedChunks: archivedCount,
          newVersion: (document.version || 1) + 1,
        };
      } else {
        /**
         * Step 5: Content unchanged - just update lastFetchedAt
         */
        await step.run('complete-refresh-no-change', async () => {
          await completeDocumentRefresh(documentId, false);
        });

        log.info('No changes detected', { documentId });

        return {
          success: true,
          documentId,
          contentChanged: false,
        };
      }
    } catch (error) {
      log.error('URL document refresh error', error instanceof Error ? error : undefined, { documentId });
      throw error; // Re-throw to trigger retry
    }
  }
);

/**
 * Batch refresh URL documents function
 *
 * Refreshes multiple URL documents, typically triggered by a scheduled job.
 *
 * **Trigger:** app/document.batch-refresh.requested event
 * **Timeout:** 30 minutes
 * **Retries:** 1 attempt (individual refreshes have their own retries)
 */
export const batchRefreshUrlDocumentsJob = inngest.createFunction(
  {
    id: 'batch-refresh-url-documents',
    name: 'Batch Refresh URL Documents',
    retries: 1,

    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event — reading
      // event.data.documentIds directly always yields undefined here.
      const count = extractFailureEventData<{ documentIds?: string[] }>(event.data).documentIds?.length || 0;
      log.error('Batch refresh URL documents final failure', new Error(error.message), { documentCount: count });
    },
  },

  { event: 'app/document.batch-refresh.requested' },

  async ({ event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('batch-refresh-url-documents');
    const { documentIds } = event.data;

    if (!documentIds || documentIds.length === 0) {
      return { success: false, error: 'No document IDs provided' };
    }

    log.info('Starting batch refresh for URL documents', { count: documentIds.length });

    /**
     * Send individual refresh events for each document
     * This allows each refresh to be retried independently
     */
    await step.run('send-refresh-events', async () => {
      const events = documentIds.map((documentId: string) => ({
        name: 'app/document.refresh.requested' as const,
        data: { documentId },
      }));

      await inngest.send(events);
    });

    log.info('Triggered refresh jobs', { count: documentIds.length });

    return {
      success: true,
      triggeredCount: documentIds.length,
    };
  }
);

/**
 * Scheduled refresh of stale URL documents
 *
 * Runs daily to find and refresh URL documents that haven't been
 * fetched in the last 7 days.
 *
 * **Trigger:** Cron schedule (daily at 3 AM UTC)
 * **Timeout:** 5 minutes
 */
export const scheduledUrlRefreshJob = inngest.createFunction(
  {
    id: 'scheduled-url-refresh',
    name: 'Scheduled URL Refresh',
    retries: 2,
  },

  { cron: '0 3 * * *' }, // Daily at 3 AM UTC

  async ({ step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('scheduled-url-refresh');
    const { getDocumentsNeedingRefresh } = await import('@/lib/document-refresh-admin');

    /**
     * Get documents that need refreshing
     */
    const documents = await step.run('get-stale-documents', async () => {
      return await getDocumentsNeedingRefresh(7 * 24 * 60 * 60 * 1000, 50); // 7 days, max 50
    });

    if (documents.length === 0) {
      log.info('No documents need refreshing');
      return { success: true, refreshed: 0 };
    }

    log.info('Found documents to refresh', { count: documents.length });

    /**
     * Trigger batch refresh
     */
    await step.run('trigger-batch-refresh', async () => {
      await inngest.send({
        name: 'app/document.batch-refresh.requested',
        data: {
          documentIds: documents.map((d) => d.id),
        },
      });
    });

    return {
      success: true,
      triggered: documents.length,
    };
  }
);
