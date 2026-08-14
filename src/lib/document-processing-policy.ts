/**
 * @file lib/document-processing-policy.ts
 * @description Pure policy helpers for the document PROCESSING lifecycle —
 * the accepted → running → terminal contract behind Retry / Process.
 *
 * Sibling of `document-refresh-policy.ts`, which owns the same shape for the
 * URL-refresh flag. Both exist for the same reason: a boolean/enum written by
 * a worker is only trustworthy while the worker is alive. If the process dies
 * between "accepted" and "terminal" (dev-server restart, container kill), a
 * document is stuck in `processing` forever and the UI offers no way out —
 * exactly the state UX-036 observed after Retry claimed work was queued.
 *
 * Root-cause shape: an ACCEPTED processing run is time-bounded. The enqueue
 * path stamps {@link Document.processingRequestedAt} at the moment the queue
 * acknowledges the event; past {@link PROCESSING_STALE_MS} that run is treated
 * as STALLED, the badge says so, and Retry becomes available again instead of
 * the row sitting on a permanent spinner.
 *
 * Liveness reads ONLY that stamp — never `updatedAt`, which any unrelated write
 * bumps — and a `processing` document with no stamp is reported as ACTIVE
 * rather than stalled. Both rules exist because the recovery action is
 * destructive: keying on `updatedAt` let an unrelated edit resurrect a dead
 * run, and calling an unstamped run stalled would have offered Retry on a live
 * deep-research document (created `processing`, silent for up to 15 minutes
 * while it polls) and killed it.
 *
 * Deliberately dependency-free (no Firebase SDKs, no React) so the API route
 * (admin SDK), the Inngest worker, and the client UI can all share one
 * definition of "is this document actually being processed right now".
 */

import type { Document } from '@/lib/types';

/**
 * How long an ACCEPTED processing run is trusted before it is treated as a
 * leftover from a crashed worker.
 *
 * Worst case for a legitimate run: the process-document job has a 5-minute
 * budget and 3 retries with backoff. 15 minutes covers that comfortably and
 * matches {@link import('./document-refresh-policy').REFRESH_STALE_MS} so the
 * two lifecycles never disagree about the same document.
 */
export const PROCESSING_STALE_MS = 15 * 60 * 1000;

/**
 * A terminal transition does not immediately erase the identity of the
 * request that produced it. Keep a short server-side deduplication window so
 * two concurrent HTTP requests cannot both enqueue when the first worker
 * finishes (or fails) before the second transaction acquires its snapshot.
 */
export const PROCESSING_REQUEST_DEDUPE_MS = 5 * 1000;

/** The only statuses a user may re-enqueue from. */
const RETRYABLE_STATUSES = new Set<Document['status']>(['uploaded', 'failed', 'blocked']);

/** The document fields the processing policy inspects. */
export type ProcessingPolicyInput = Pick<Document, 'status'> &
  Partial<Pick<Document, 'updatedAt' | 'processingRequestedAt'>>;

/**
 * The instant this document's processing run was ACCEPTED by the queue, or
 * `null` when no accepted run is recorded.
 *
 * Deliberately NOT `updatedAt`. `updatedAt` advances on every write to the
 * document — linking an entity, renaming it, a graph-sync stamp — none of
 * which say anything about whether a worker is alive. Keying liveness on it
 * meant an unrelated edit could resurrect a dead run and hide the recovery
 * action.
 */
function acceptedAt(document: ProcessingPolicyInput): number | null {
  const stamped = document.processingRequestedAt ?? 0;
  return stamped > 0 ? stamped : null;
}

/**
 * Whether processing should be considered actively running.
 *
 * A `processing` document with NO accepted-run stamp is reported as active.
 * That is the deliberate safe answer: the stamp is written only by this
 * product's enqueue path, so its absence means the run belongs to a different
 * pipeline (deep research creates its document `processing` and writes nothing
 * for up to 15 minutes while it polls) or predates the stamp. We have no
 * evidence such a run is dead, and the recovery action is destructive — so we
 * never claim it is.
 *
 * @param document - Only `status` and `processingRequestedAt` are read.
 * @param now - Injectable clock for tests (defaults to `Date.now()`).
 */
export function isProcessingActive(document: ProcessingPolicyInput, now: number = Date.now()): boolean {
  if (document.status !== 'processing') return false;
  const accepted = acceptedAt(document);
  if (accepted === null) return true;
  return now - accepted < PROCESSING_STALE_MS;
}

/**
 * Whether a `processing` status is a leftover from a run that never reported
 * a terminal outcome. Distinct from `failed`: we do not know that the work
 * failed, only that nothing has reported back inside the window — so the UI
 * must say "stalled", never "failed" and never "still running".
 *
 * @param document - Only `status`, `updatedAt` and `processingRequestedAt` are read.
 * @param now - Injectable clock for tests (defaults to `Date.now()`).
 */
export function isProcessingStalled(document: ProcessingPolicyInput, now: number = Date.now()): boolean {
  return document.status === 'processing' && !isProcessingActive(document, now);
}

/**
 * Whether this document can be reprocessed AT ALL — i.e. whether a source of
 * content exists to reprocess FROM.
 *
 * A document with neither stored bytes nor a source URL (a deep-research
 * artifact still being generated, a build-mission report before its file is
 * written) cannot be reprocessed by any path. Offering Retry for it would
 * enqueue work whose only possible outcome is marking a document failed that
 * nothing is actually wrong with.
 */
export function hasReprocessableSource(
  document: Pick<Document, 'storageUrl' | 'originalUrl'>
): boolean {
  return !!document.storageUrl?.trim() || !!document.originalUrl?.trim();
}

/**
 * Whether the user may enqueue (re)processing for this document right now.
 *
 * A terminal-ish status is retryable. A `processing` status is retryable only
 * once its ACCEPTED run has gone stale — otherwise a second click would
 * double-enqueue a run that is still alive.
 *
 * Callers that can see the document's sources should also require
 * {@link hasReprocessableSource}; this predicate answers only the lifecycle
 * half of the question so it stays usable where only a status is available.
 *
 * @param document - Only `status` and `processingRequestedAt` are read.
 * @param now - Injectable clock for tests (defaults to `Date.now()`).
 */
export function canRequestProcessing(document: ProcessingPolicyInput, now: number = Date.now()): boolean {
  if (RETRYABLE_STATUSES.has(document.status)) {
    const accepted = acceptedAt(document);
    return accepted === null || now - accepted >= PROCESSING_REQUEST_DEDUPE_MS;
  }
  return isProcessingStalled(document, now);
}

/** Visual/semantic tone for a processing state. */
export type ProcessingTone = 'pending' | 'running' | 'stalled' | 'done' | 'error' | 'blocked';

/**
 * The one user-facing label describing where a document sits in the
 * processing lifecycle. Consumed by `components/library/documents/badges.tsx`
 * (the table row and the grid card) and by the detail sheet, so three surfaces
 * cannot describe the same row differently.
 *
 * @param document - Only `status`, `updatedAt` and `processingRequestedAt` are read.
 * @param now - Injectable clock for tests (defaults to `Date.now()`).
 */
export function describeProcessingState(
  document: ProcessingPolicyInput,
  now: number = Date.now()
): { label: string; tone: ProcessingTone } {
  switch (document.status) {
    case 'uploaded':
      return { label: 'Pending', tone: 'pending' };
    case 'processing':
      return isProcessingActive(document, now)
        ? { label: 'Processing', tone: 'running' }
        : { label: 'Stalled', tone: 'stalled' };
    case 'processed':
      return { label: 'Processed', tone: 'done' };
    case 'failed':
      return { label: 'Failed', tone: 'error' };
    case 'blocked':
      return { label: 'Blocked', tone: 'blocked' };
  }
}
