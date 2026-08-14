/**
 * @file lib/document-reprocess.ts
 * @description The ONE type-correct "make this document processed" operation.
 *
 * UX-036 root cause: processing a document was split across three call sites
 * that each knew only half the story.
 *
 *   - `/api/documents/process` always ran the FILE path. A URL document has
 *     `storageUrl: ''`, so it downloads nothing, marks the document failed,
 *     and answers 422 after Retry resets the document to `uploaded`.
 *   - `/api/documents/reprocess-url` held the only URL-aware implementation
 *     (TDM gate + re-fetch + content processing) and had ZERO callers.
 *   - The `process-document` Inngest job took the URL path only when the
 *     EVENT carried `content`, so any sender that did not pre-fetch (i.e. a
 *     retry) fell through to the failing file path.
 *
 * This module owns the decision instead. It inspects the document, picks the
 * correct source of content (stored bytes vs. source URL), applies the TDM
 * gate on every real re-fetch, and returns a typed outcome that every caller
 * maps to its own transport. Adding a caller can no longer re-introduce the
 * half-story.
 */

import 'server-only';

import { adminGetDocumentById, adminUpdateDocument } from '@/lib/document-admin';
import { processDocument, processDocumentFromContent, type ProcessingOptions } from '@/lib/document-processing-service';
import { isProcessingActive } from '@/lib/document-processing-policy';
import { checkTdmPolicy } from '@/lib/tdm-policy';
import { fetchUrlContentReceipted } from '@/lib/firecrawl-fetch';
import { createLogger } from '@/lib/logger';
import type { Document } from '@/lib/types';

const log = createLogger('document-reprocess');

// ============================================================================
// TYPES
// ============================================================================

/** Where the processed text came from. */
export type DocumentContentSource = 'stored-file' | 'source-url' | 'supplied-content';

export type DocumentReprocessFailureCode =
  /** No such document. */
  | 'not-found'
  /** A live claimed run already owns this document — see `refuseWhenLive`. */
  | 'already-running'
  /** The document has neither stored bytes nor a source URL to work from. */
  | 'no-source'
  /** The site reserved this content from text/data mining. */
  | 'tdm-blocked'
  /** The source URL could not be fetched. */
  | 'fetch-failed'
  /** Content was obtained but extraction/chunking failed. */
  | 'processing-failed';

export interface DocumentReprocessSuccess {
  ok: true;
  documentId: string;
  source: DocumentContentSource;
  chunkCount: number;
  textLength: number;
  pageCount?: number;
}

export interface DocumentReprocessFailure {
  ok: false;
  documentId: string;
  code: DocumentReprocessFailureCode;
  error: string;
  /** Processing stage, when the failure came from the processing pipeline. */
  stage?: string;
  /** The HTTP status an API caller should answer with. */
  httpStatus: number;
}

export type DocumentReprocessOutcome = DocumentReprocessSuccess | DocumentReprocessFailure;

export interface DocumentReprocessOptions extends ProcessingOptions {
  /** Receipt owner for any provider call (`user:<uid>` / `agent:<name>`). */
  owner: string;
  /** Correlation id threaded into the provider receipt. */
  correlationId: string;
  /**
   * Pre-fetched content. When present it is processed as-is and NO fetch (and
   * therefore no TDM check) happens — the caller already did both. The URL
   * refresh job uses this so a single fetch feeds both change detection and
   * chunking.
   */
  content?: string;
  /**
   * Refuse when a live claimed processing run already owns the document.
   *
   * UX-036: this operation is called both by the Inngest worker that OWNS the
   * claim (`/api/documents/retry` stamps the document `processing` before
   * dispatching) and by `/api/documents/process`, which runs the pipeline
   * inline in an HTTP request. The claim owner must obviously proceed — it
   * would otherwise refuse its own run — so the guard is opt-in and set only by
   * callers that do not hold the claim.
   *
   * Keyed on the TIME-BOUNDED `isProcessingActive`, never the raw status, so a
   * `processing` flag left behind by a dead worker cannot lock the endpoint out
   * permanently.
   */
  refuseWhenLive?: boolean;
}

const HTTP_STATUS_BY_CODE: Record<DocumentReprocessFailureCode, number> = {
  'not-found': 404,
  'already-running': 409,
  'no-source': 400,
  'tdm-blocked': 403,
  'fetch-failed': 400,
  'processing-failed': 422,
};

// ============================================================================
// SOURCE SELECTION
// ============================================================================

/**
 * Whether a document must be processed from its SOURCE URL rather than from
 * stored bytes.
 *
 * Driven by the absence of stored bytes, not by `type` alone: a `url` document
 * that later gained a stored file (deep-research artifacts do this) must use
 * the file, and a mistyped document with no bytes but a recorded URL must
 * still be recoverable.
 */
export function requiresSourceUrlFetch(document: Pick<Document, 'type' | 'storageUrl' | 'originalUrl'>): boolean {
  const hasStoredFile = !!document.storageUrl?.trim();
  if (hasStoredFile) return false;
  return !!document.originalUrl?.trim();
}

function failure(
  documentId: string,
  code: DocumentReprocessFailureCode,
  error: string,
  stage?: string
): DocumentReprocessFailure {
  return { ok: false, documentId, code, error, stage, httpStatus: HTTP_STATUS_BY_CODE[code] };
}

// ============================================================================
// OPERATION
// ============================================================================

/**
 * Run the type-correct processing pass for a document.
 *
 * Order of decision:
 *   1. supplied `content`      → process it directly (caller already fetched)
 *   2. no stored bytes + URL   → TDM gate, re-fetch, process the fetched text
 *   3. stored bytes            → download + extract + chunk
 *   4. neither                 → `no-source`, WITHOUT writing a status
 *
 * For 1-3 the terminal document state (`processed` / `failed` / `blocked` plus
 * the reason) is persisted before returning, so no caller can leave a document
 * claiming to be mid-flight. Case 4 is different on purpose: it is a refusal of
 * the request, not a fact about the document, and writing `failed` there would
 * destroy an in-flight artifact whose own pipeline has not produced its file
 * yet. Callers must not enqueue for such a document in the first place — see
 * `hasReprocessableSource` in `document-processing-policy.ts`.
 */
export async function reprocessDocumentContent(
  documentId: string,
  options: DocumentReprocessOptions
): Promise<DocumentReprocessOutcome> {
  const document = await adminGetDocumentById(documentId);
  if (!document) {
    return failure(documentId, 'not-found', `Document ${documentId} not found`);
  }

  // Refuse BEFORE any write when another live run already owns this document.
  // Every path here passes `replaceExisting`, so two concurrent runs would
  // delete and recreate the same chunks and race to stamp the terminal status.
  if (options.refuseWhenLive && isProcessingActive(document)) {
    return failure(
      documentId,
      'already-running',
      'Processing is already running for this document. Wait for the current run to finish.'
    );
  }

  const processingOptions: ProcessingOptions = {
    chunkSize: options.chunkSize,
    chunkOverlap: options.chunkOverlap,
    replaceExisting: options.replaceExisting,
  };

  // ---- 1. Caller-supplied content -----------------------------------------
  if (options.content !== undefined) {
    const result = await processDocumentFromContent(documentId, options.content, processingOptions);
    return result.success
      ? {
          ok: true,
          documentId,
          source: 'supplied-content',
          chunkCount: result.chunkCount,
          textLength: result.textLength,
        }
      : failure(documentId, 'processing-failed', result.error, result.stage);
  }

  // ---- 2. Source-URL documents --------------------------------------------
  if (requiresSourceUrlFetch(document)) {
    const sourceUrl = document.originalUrl!.trim();

    // AUDIT-007 — the same TDM gate as first ingest and the scheduled refresh.
    // A site can reserve its rights AFTER we first ingested a page, so every
    // real re-fetch needs a real check rather than a grandfather clause.
    // `blocked`, not `failed`: a rights reservation is a deliberate permanent
    // decision, and the reason has to survive so the UI can say why.
    const tdm = await checkTdmPolicy(sourceUrl);
    if (!tdm.allowed) {
      const reason = tdm.reason ?? 'TDM opt-out';
      log.info('Reprocess refused by TDM policy', { documentId, reason });
      await adminUpdateDocument(documentId, { status: 'blocked', fetchError: reason, errorMessage: reason });
      return failure(documentId, 'tdm-blocked', reason);
    }

    const fetchResult = await fetchUrlContentReceipted(sourceUrl, {
      owner: options.owner,
      correlationId: options.correlationId,
    });

    if (!fetchResult.success || !fetchResult.content) {
      const reason = `Failed to fetch URL content: ${fetchResult.error ?? 'no content returned'}`;
      // Persist the REASON, not just the status — the detail sheet's failure
      // panel is gated on `errorMessage` and used to stay permanently empty.
      await adminUpdateDocument(documentId, {
        status: 'failed',
        errorMessage: reason,
        fetchError: fetchResult.error ?? 'no content returned',
      });
      return failure(documentId, 'fetch-failed', reason);
    }

    const result = await processDocumentFromContent(documentId, fetchResult.content, processingOptions);
    return result.success
      ? {
          ok: true,
          documentId,
          source: 'source-url',
          chunkCount: result.chunkCount,
          textLength: result.textLength,
        }
      : failure(documentId, 'processing-failed', result.error, result.stage);
  }

  // ---- 3/4. Stored-bytes documents ----------------------------------------
  if (!document.storageUrl?.trim()) {
    // Deliberately does NOT write a terminal status. "We were asked to
    // reprocess something with no source" is a refusal of the REQUEST, not a
    // fact about the document: a deep-research artifact sits in `processing`
    // with no bytes and no URL for minutes while its own pipeline works, and
    // marking it `failed` here would destroy healthy in-flight work. Callers
    // surface the refusal; the document is left exactly as it was found.
    const reason =
      'This document has no stored file and no source URL, so there is nothing to process. Re-upload the file or add a source URL.';
    return failure(documentId, 'no-source', reason);
  }

  const result = await processDocument(documentId, processingOptions);
  return result.success
    ? {
        ok: true,
        documentId,
        source: 'stored-file',
        chunkCount: result.chunkCount,
        textLength: result.textLength,
        pageCount: result.pageCount,
      }
    : failure(documentId, 'processing-failed', result.error, result.stage);
}

/**
 * Run {@link reprocessDocumentContent} over several documents, sequentially.
 *
 * Exists so the batch branch of `/api/documents/process` gets the SAME
 * source selection as the single-document branch. It previously called
 * `processDocuments`, which loops over the unconditional stored-file path — so
 * a URL document in a batch still failed with a download error even after the
 * single-document branch was fixed.
 *
 * Sequential on purpose: each item may perform a network fetch, and the
 * pre-existing batch helper was sequential for the same reason.
 */
export async function reprocessDocuments(
  documentIds: readonly string[],
  options: DocumentReprocessOptions
): Promise<DocumentReprocessOutcome[]> {
  const outcomes: DocumentReprocessOutcome[] = [];
  for (const documentId of documentIds) {
    outcomes.push(
      await reprocessDocumentContent(documentId, {
        ...options,
        correlationId: `${options.correlationId}-${documentId}`,
      })
    );
  }
  const successful = outcomes.filter((outcome) => outcome.ok).length;
  log.info('Batch reprocess complete', { successful, total: documentIds.length });
  return outcomes;
}
