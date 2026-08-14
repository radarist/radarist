/**
 * @file api/documents/retry/route.ts
 * @description The ONE acknowledged (re)processing enqueue for a document.
 *
 * UX-036: the visible Retry action was a client-SDK Firestore write that set
 * `status: 'uploaded'` and nothing else, while both call sites toasted
 * "queued for reprocessing". No Inngest event was emitted and no consumer
 * drains `uploaded` documents, so the document sat untouched forever. Retry
 * was, literally, a label change.
 *
 * This route replaces that write with a real enqueue and gives the operator a
 * truthful three-state contract:
 *
 *   accepted  → 202 after the queue acknowledges the event; the document is
 *               stamped `processing` + `processingRequestedAt` so the UI can
 *               show a live run rather than guessing.
 *   running   → `document-processing-policy.ts` bounds that `processing`
 *               status in time, so a worker that dies mid-run reads as
 *               STALLED and Retry becomes available again.
 *   terminal  → the worker persists `processed` or `failed` WITH the reason.
 *
 * Two guards protect that contract:
 *  - a SOURCE precondition, refused before anything is written, so a document
 *    with nothing to reprocess from (a deep-research artifact mid-flight) is
 *    never enqueued and never marked failed for it;
 *  - an ATOMIC claim (`adminClaimDocumentForProcessing`), because a
 *    read-then-check-then-write guard lets two clicks both pass.
 *
 * Failure is exposed, never swallowed: an enqueue the queue rejects restores
 * BOTH the previous status and the previous accepted-run stamp, then answers
 * 502 — rather than leaving a document pretending to be in flight.
 *
 * Type-correctness lives in `document-reprocess.ts`, which the worker calls —
 * this route deliberately does not care whether the document is file-backed
 * or URL-backed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getAuthenticatedUser } from '@/lib/auth-utils';
import { adminClaimDocumentForProcessing, adminGetDocumentById, adminUpdateDocument } from '@/lib/document-admin';
import {
  canRequestProcessing,
  hasReprocessableSource,
  isProcessingActive,
  PROCESSING_REQUEST_DEDUPE_MS,
} from '@/lib/document-processing-policy';
import { inngest } from '@/lib/inngest/client';
import { createLogger } from '@/lib/logger';
import type { DocumentStatus } from '@/lib/types';

const log = createLogger('api/documents/retry');

const QUEUE_REFUSED = 'Could not queue reprocessing — the background job queue did not accept the request.';
const QUEUE_UNACKNOWLEDGED = 'Could not queue reprocessing — the background job queue returned no acknowledgement.';

/**
 * Undo an atomic claim whose dispatch never landed.
 *
 * Restores BOTH the status and the previous accepted-run stamp. Leaving the
 * fresh stamp behind would make a document that was already stalled look live
 * again for a full staleness window — locking the operator out of the very
 * recovery this route exists to provide.
 */
async function releaseClaim(
  documentId: string,
  previousStatus: DocumentStatus,
  previousRequestedAt: number,
  reason: string
): Promise<void> {
  await adminUpdateDocument(documentId, {
    status: previousStatus,
    processingRequestedAt: previousRequestedAt,
    errorMessage: reason,
  }).catch((restoreError: unknown) => {
    // The 502 the caller returns already reports the real failure; log the
    // secondary one so a stuck document is diagnosable.
    log.error(
      'Failed to release the processing claim after a rejected dispatch',
      restoreError instanceof Error ? restoreError : new Error(String(restoreError)),
      { documentId, previousStatus }
    );
  });
}

const retryInputSchema = z.object({
  documentId: z.string().trim().min(1, 'documentId is required'),
});

/**
 * POST /api/documents/retry
 *
 * Body: `{ documentId: string }`
 *
 * Responses:
 * - 202: enqueued — `{ accepted: true, documentId, eventIds, status: 'processing' }`
 * - 401: unauthenticated
 * - 400: malformed body, or nothing to reprocess from (`code: 'no-source'`)
 * - 404: no such document
 * - 409: a live run already holds the document, or its status has nothing to retry
 * - 502: the queue refused the event (document restored to its previous state)
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 });
    }

    const parsed = retryInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' }, { status: 400 });
    }
    const { documentId } = parsed.data;

    const document = await adminGetDocumentById(documentId);
    if (!document) {
      return NextResponse.json({ error: `Document ${documentId} not found` }, { status: 404 });
    }

    // Refuse BEFORE touching the document when there is nothing to reprocess
    // FROM. A deep-research artifact is created `processing` with no stored
    // bytes and no source URL and stays silent for minutes while it polls;
    // enqueueing for it could only ever mark a perfectly healthy in-flight
    // document `failed` with an invented reason.
    if (!hasReprocessableSource(document)) {
      return NextResponse.json(
        {
          error:
            'This document has no stored file and no source URL, so there is nothing to reprocess. ' +
            'Re-upload the file or add a source URL.',
          documentId,
          code: 'no-source',
        },
        { status: 400 }
      );
    }

    const requestedAt = Date.now();

    // Claim ATOMICALLY: the re-read, the policy check and the status write
    // happen in one transaction, so two clicks cannot both pass the guard.
    const claim = await adminClaimDocumentForProcessing(
      documentId,
      (current) => canRequestProcessing(current, requestedAt),
      requestedAt
    );

    if (!claim.claimed) {
      if (claim.reason === 'not-found') {
        return NextResponse.json({ error: `Document ${documentId} not found` }, { status: 404 });
      }
      const running = isProcessingActive(
        {
          status: claim.currentStatus,
          processingRequestedAt: claim.currentRequestedAt,
        },
        requestedAt
      );
      const recentlyRequested =
        claim.currentRequestedAt > 0 &&
        requestedAt - claim.currentRequestedAt < PROCESSING_REQUEST_DEDUPE_MS;
      return NextResponse.json(
        {
          // Say what is actually true: a live run, or simply a status with
          // nothing to retry (a `processed` document is not "already running").
          error:
            running || recentlyRequested
            ? 'A processing request was already accepted recently for this document.'
            : `This document is ${claim.currentStatus} and has nothing to reprocess.`,
          documentId,
          status: claim.currentStatus,
          alreadyRunning: running || recentlyRequested,
        },
        { status: 409 }
      );
    }

    const { previousStatus, previousRequestedAt } = claim;

    let eventIds: string[];
    try {
      const accepted = await inngest.send({
        name: 'app/document.process.requested',
        data: {
          documentId,
          requestedBy: `user:${auth.uid}`,
          trigger: 'retry',
          requestedAt,
        },
      });
      eventIds = accepted.ids;
    } catch (sendError) {
      log.error(
        'Failed to enqueue document reprocessing',
        sendError instanceof Error ? sendError : new Error(String(sendError)),
        { documentId }
      );
      await releaseClaim(documentId, previousStatus, previousRequestedAt, QUEUE_REFUSED);
      return NextResponse.json({ error: QUEUE_REFUSED, documentId }, { status: 502 });
    }

    if (eventIds.length === 0) {
      // Defensive: an empty acknowledgement is not an acceptance.
      log.error('Inngest accepted the reprocess event without returning an id', undefined, { documentId });
      await releaseClaim(documentId, previousStatus, previousRequestedAt, QUEUE_UNACKNOWLEDGED);
      return NextResponse.json({ error: QUEUE_UNACKNOWLEDGED, documentId }, { status: 502 });
    }

    log.info('Queued document reprocessing', { documentId, eventIds, previousStatus });

    return NextResponse.json(
      {
        accepted: true,
        documentId,
        status: 'processing',
        eventIds,
        message: 'Reprocessing queued',
      },
      { status: 202 }
    );
  } catch (error) {
    log.error('POST error', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Internal server error queueing document reprocessing' }, { status: 500 });
  }
}
