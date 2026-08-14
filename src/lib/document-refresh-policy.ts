/**
 * @file lib/document-refresh-policy.ts
 * @description Pure policy helpers for the URL-document refresh concurrency guard.
 *
 * The `refreshInProgress` flag is set by the Inngest refresh job
 * (`startDocumentRefresh`) and cleared by `completeDocumentRefresh` /
 * `failDocumentRefresh` / the job's `onFailure` handler. If the worker dies
 * between those two points (process kill, dev-server restart), the flag is
 * stuck `true` forever and every subsequent refresh request is rejected with
 * 409 "already in progress" — the exact failure observed on /library/documents.
 *
 * Root-cause fix: the guard is time-bounded. A refresh only counts as active
 * while the document's `updatedAt` is within {@link REFRESH_STALE_MS} — every
 * write the refresh job makes (including setting the flag itself) bumps
 * `updatedAt`, so a live refresh always has a fresh timestamp. The job runs
 * with a 2-minute fetch timeout and 3 retries, so 15 minutes comfortably
 * covers the worst-case legitimate run; anything older is a crashed run whose
 * flag self-heals on the next request.
 *
 * This module is deliberately dependency-free (no Firebase SDKs) so it can be
 * shared by the API route (admin SDK side), the Inngest admin helper, and the
 * client UI (spinner state) without violating the client/server boundary.
 */

import type { Document } from '@/lib/types';

/**
 * How long a `refreshInProgress: true` flag is trusted before it is treated
 * as a leftover from a crashed run. Worst-case legitimate run: 2-minute fetch
 * timeout x 3 retries + backoff << 15 minutes.
 */
export const REFRESH_STALE_MS = 15 * 60 * 1000;

/**
 * Whether a document refresh should be considered actively running.
 *
 * @param document - The document (only the flag + updatedAt are inspected)
 * @param now - Injectable clock for tests (defaults to Date.now())
 * @returns true only if the flag is set AND the document was touched within
 *   the staleness window. A stuck flag from a crashed run returns false so
 *   the next refresh request can proceed and re-arm the guard.
 */
export function isRefreshActive(
  document: Pick<Document, 'refreshInProgress' | 'updatedAt'>,
  now: number = Date.now()
): boolean {
  if (!document.refreshInProgress) return false;
  const lastTouched = document.updatedAt ?? 0;
  return now - lastTouched < REFRESH_STALE_MS;
}
