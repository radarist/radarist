/**
 * @file signals-admin.ts
 * @description Narrow admin-SDK helpers for the small set of signal
 * reads that run on the server side (Inngest workers + API routes).
 *
 * Why this exists: `src/lib/signals-core.ts` is a client-SDK module
 * (it uses `firebase/firestore` + `@/lib/firebase`). Inngest workers
 * and API routes that statically reach into it fail with
 * `code: 'unavailable'` because the client SDK has no persistent
 * connection in a stateless server context — the same failure mode
 * observed in the four Inngest functions already
 * migrated to the narrow-admin-helper pattern.
 *
 * On 2026-05-14 the daily-pipeline Inngest function hit this when
 * `computeTrends` called `getSignalsByStatus('Validated')`. This
 * file exposes the read alone so the pipeline can keep working
 * without dragging the whole `signals` service module across the
 * client/server boundary.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { adminDeleteLinksForEntity } from '@/lib/entity-document-link-admin';
import { adminDeleteRelationsForEntity } from '@/lib/relations-cascade-admin';
import { prepareEntityDeletions } from '@/lib/entity-bulk-delete';
import { sanitizeForFirestore } from '@/lib/firestore-sanitize';
import { adminCreateEntity } from '@/lib/entity-factory-admin';
import { createLogger } from '@/lib/logger';
import type { Signal, SignalStatus } from '@/lib/types';

const log = createLogger('signals-admin');

/**
 * Fetch signals with the given status. Mirrors
 * `getSignalsByStatus` from `signals-core.ts`: no `orderBy` clause
 * (so we don't require a composite index), in-memory sort by
 * `detectedAt` newest-first, optional `maxResults` cap.
 */
export async function adminGetSignalsByStatus(status: SignalStatus, maxResults?: number): Promise<Signal[]> {
  try {
    const snap = await db.collection('signals').where('status', '==', status).get();
    let signals = snap.docs.map((doc) => doc.data() as Signal);
    signals.sort((a, b) => b.detectedAt - a.detectedAt);
    if (maxResults) signals = signals.slice(0, maxResults);
    return signals;
  } catch (error) {
    log.error('Error fetching signals by status (admin)', error instanceof Error ? error : new Error(String(error)), {
      status,
    });
    throw new Error(`Failed to fetch signals by status ${status}`);
  }
}

/**
 * Admin-SDK equivalent of `signals-core.createSignal`. Same validation +
 * uniqueness semantics (delegates to adminCreateEntity('signal', …)), so it is
 * safe to call from server routes / AI-tool executors against production.
 * Re-throws DuplicateEntityError unchanged. Graph (Neo4j) sync fires via
 * adminCreateEntity's post-commit `app/unified-entity.sync.requested` event.
 */
export async function adminCreateSignal(
  signal: Omit<Signal, 'id' | 'slug' | 'reviewedAt' | 'processedAt'>
): Promise<Signal> {
  if (!signal.title || !signal.source) {
    throw new Error('Signal title and source are required');
  }
  if (!signal.url && !signal.metadata?.agentId) {
    throw new Error('Signal URL is required for non-agent signals');
  }
  if (signal.relevanceScore < 0 || signal.relevanceScore > 100) {
    throw new Error('Relevance score must be between 0 and 100');
  }
  if (signal.alignmentScore < 0 || signal.alignmentScore > 100) {
    throw new Error('Alignment score must be between 0 and 100');
  }

  const result = await adminCreateEntity<typeof signal>('signal', signal);
  return result.entity as Signal;
}

// ============================================================================
// READS
// ============================================================================

/**
 * Admin-SDK equivalent of `signals-core.getSignals`. Reads every doc in the
 * `signals` collection ordered by `detectedAt` newest-first. Same return
 * shape (`Signal[]`) and same generic-Error-on-failure semantics so server
 * callers (`/api/search`, the `listSignals` / `entity-creation` AI tools)
 * get a drop-in replacement for the client path.
 */
export async function adminGetSignals(): Promise<Signal[]> {
  try {
    const snap = await db.collection('signals').orderBy('detectedAt', 'desc').get();
    return snap.docs.map((doc) => doc.data() as Signal);
  } catch (error) {
    log.error('Error fetching signals (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to fetch signals');
  }
}

/**
 * Admin-SDK equivalent of `signals-core.getSignalById`. Returns the signal or
 * `null` when no doc exists, throwing a generic Error only on query failure —
 * identical to the client path the `getSignalDetails` AI tool relies on.
 */
export async function adminGetSignalById(id: string): Promise<Signal | null> {
  try {
    const snap = await db.collection('signals').doc(id).get();
    if (snap.exists) {
      return snap.data() as Signal;
    }
    return null;
  } catch (error) {
    log.error('Error fetching signal (admin)', error instanceof Error ? error : new Error(String(error)), { id });
    throw new Error(`Failed to fetch signal ${id}`);
  }
}

// ── Signal-feedback reads for the AI tool (P2) ──────────────────────────────
// Admin-SDK ONLY: the client-SDK analytics in signals/feedback.ts would a540 when
// reached from the server-side AI executor. Reads are BOUNDED (a scan cap) since the
// signals collection has no per-row index on feedback and we're inside the free-tier
// read budget — this is ad-hoc (chat-triggered), never per-cron.

const FEEDBACK_SCAN_CAP = 1000;

export interface SourceFeedbackBreakdown {
  source: string;
  total: number;
  upvotes: number;
  downvotes: number;
  /** 0–100; 0 when no votes (never divides by zero). */
  approvalRate: number;
}

/** Per-source 👍/👎 breakdown — the "you reject 80% from source X" display insight. */
export async function getSourceFeedbackBreakdown(
  scanCap: number = FEEDBACK_SCAN_CAP
): Promise<SourceFeedbackBreakdown[]> {
  try {
    const snap = await db.collection('signals').where('feedback.vote', 'in', ['up', 'down']).limit(scanCap).get();
    const bySource = new Map<string, { up: number; down: number }>();
    for (const doc of snap.docs) {
      const s = doc.data() as Signal;
      const src = s.source || 'unknown';
      const cur = bySource.get(src) ?? { up: 0, down: 0 };
      if (s.feedback?.vote === 'up') cur.up += 1;
      else if (s.feedback?.vote === 'down') cur.down += 1;
      bySource.set(src, cur);
    }
    return [...bySource.entries()]
      .map(([source, v]) => {
        const total = v.up + v.down;
        return {
          source,
          total,
          upvotes: v.up,
          downvotes: v.down,
          approvalRate: total > 0 ? Math.round((v.up / total) * 100) : 0,
        };
      })
      .sort((a, b) => b.total - a.total);
  } catch (error) {
    log.error('getSourceFeedbackBreakdown failed', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to read source feedback breakdown');
  }
}

/** Overall voted-signal stats (admin twin of feedback.ts getFeedbackStats). */
export async function adminGetFeedbackStats(
  scanCap: number = FEEDBACK_SCAN_CAP
): Promise<{ total: number; upvotes: number; downvotes: number; approvalRate: number }> {
  const snap = await db.collection('signals').where('feedback.vote', 'in', ['up', 'down']).limit(scanCap).get();
  let up = 0;
  let down = 0;
  for (const doc of snap.docs) {
    const v = (doc.data() as Signal).feedback?.vote;
    if (v === 'up') up += 1;
    else if (v === 'down') down += 1;
  }
  const total = up + down;
  return { total, upvotes: up, downvotes: down, approvalRate: total > 0 ? Math.round((up / total) * 100) : 0 };
}

/** Down-voted signals with their rejection reason (admin twin). */
export async function adminGetSignalsWithNegativeFeedback(
  maxResults: number = 20
): Promise<Array<{ id: string; title: string; source: string; reason?: string }>> {
  const snap = await db.collection('signals').where('feedback.vote', '==', 'down').limit(maxResults).get();
  return snap.docs.map((doc) => {
    const s = doc.data() as Signal;
    return { id: doc.id, title: s.title, source: s.source, reason: s.feedback?.reason };
  });
}

/**
 * Admin-SDK equivalent of `signals-core.getRecentSignals`. Fetches signals
 * detected within the last `days` (default 7), filtered with a single
 * `where('detectedAt','>=')` clause (no composite index needed) and sorted
 * in-memory newest-first — exactly matching the client path the `/api/ai/greeting`
 * route uses.
 */
export async function adminGetRecentSignals(days: number = 7): Promise<Signal[]> {
  try {
    const cutoffDate = Date.now() - days * 24 * 60 * 60 * 1000;
    const snap = await db.collection('signals').where('detectedAt', '>=', cutoffDate).get();
    const signals = snap.docs.map((doc) => doc.data() as Signal);
    signals.sort((a, b) => b.detectedAt - a.detectedAt);
    return signals;
  } catch (error) {
    log.error('Error fetching recent signals (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to fetch recent signals');
  }
}

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Admin-SDK equivalent of `signals-core.updateSignal`. Mirrors the client
 * contract exactly:
 *  - throws `Signal <id> not found` when the doc is missing (existence check
 *    before write),
 *  - strips `undefined` fields via the server-safe shared sanitizer, matching
 *    the client path's cleanup behavior without importing the client SDK,
 *  - fires the SAME post-commit Neo4j sync event the client path fires via
 *    `triggerEntitySync('signal', id, 'update', …)` — here as a best-effort
 *    `app/unified-entity.sync.requested` Inngest send so graph sync survives
 *    the client/server boundary.
 *
 * Wraps any failure in a generic Error matching the client message format.
 */
export async function adminUpdateSignal(
  id: string,
  updates: Partial<Omit<Signal, 'id' | 'detectedAt'>>
): Promise<void> {
  try {
    const ref = db.collection('signals').doc(id);

    const snap = await ref.get();
    if (!snap.exists) {
      throw new Error(`Signal ${id} not found`);
    }

    const cleanedUpdates = sanitizeForFirestore(updates);
    await ref.update(cleanedUpdates);

    log.info('Successfully updated signal (admin)', { id });

    // Best-effort graph sync — the client path's triggerEntitySync emits the
    // same unified-entity sync event; mutation must never fail because of it.
    try {
      const { inngest } = await import('@/lib/inngest/client');
      await inngest.send({
        name: 'app/unified-entity.sync.requested',
        data: { entityId: id, entityType: 'signal', operation: 'update' },
      });
    } catch (err) {
      log.warn('Failed to trigger Neo4j sync for update (admin)', { id, error: String(err) });
    }
  } catch (error) {
    log.error('Error updating signal (admin)', error instanceof Error ? error : new Error(String(error)), { id });
    throw new Error(`Failed to update signal ${id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Admin twin of `markSignalAsImported` (`signals-approval.ts`). Marks a signal
 * `Imported` and records the entity it became, so it leaves the triage queue and
 * carries a provenance back-pointer. Used by the assistant's `importSignalToRadar`
 * tool (#93) — a server-side executor that cannot use the client-SDK path.
 *
 * @param signalId - the signal to mark
 * @param importedType - what the signal became (technology / company / useCase)
 * @param importedId - the created entity's id (for technology: the placement id)
 */
export async function adminMarkSignalAsImported(
  signalId: string,
  importedType: 'technology' | 'company' | 'useCase',
  importedId: string
): Promise<void> {
  await adminUpdateSignal(signalId, {
    status: 'Imported',
    processedAt: Date.now(),
    importedAs: { type: importedType, id: importedId },
  });
  log.info('Marked signal as imported (admin)', { signalId, importedType, importedId });
}

/**
 * Best-effort interest-steering hook shared by `adminApproveSignal` / `adminRejectSignal`
 * (T27). The LIVE admin approve/reject services (the ones the AI chat executors actually call)
 * previously skipped the feedback posterior entirely — only the thumbs UI's `submitSignalFeedback`
 * recorded it. Dynamically imports `@/lib/signals/feedback` (not a static top-level import —
 * that module statically imports FROM this one, so a static reverse import would be circular)
 * and calls the SAME `steerSignalInterest` helper the thumbs path uses.
 *
 * Takes the already-fetched `signal` (the caller's pre-write `currentSignal` snapshot) rather
 * than re-fetching by id (B1 fix). This matters now that the caller also stamps `feedback.vote`
 * in the SAME write as the status change: a re-fetch performed AFTER that write would read back
 * the vote we just stamped as the "prior" vote, and `steerSignalInterest`'s
 * `priorVote === vote` idempotency guard would then treat this very steering call as a
 * same-direction re-vote and silently skip the posterior it's supposed to record. Passing the
 * pre-write snapshot sidesteps the race entirely.
 *
 * Never throws — logged and swallowed so a steering failure can never fail the approve/reject.
 */
async function steerAdminSignalFeedback(
  signal: Signal,
  vote: 'up' | 'down',
  feedbackUserId: string,
  reason: string | undefined,
  logContext: string
): Promise<void> {
  try {
    const { steerSignalInterest } = await import('@/lib/signals/feedback');
    await steerSignalInterest(signal, vote, feedbackUserId, reason);
  } catch (steerErr) {
    log.warn(`${logContext}: interest-steering failed (non-fatal)`, {
      signalId: signal.id,
      error: steerErr instanceof Error ? steerErr.message : String(steerErr),
    });
  }
}

/**
 * Admin-SDK equivalent of `signals-approval.approveSignal`. Sets status
 * `Approved` + `reviewedAt`, appending `reviewNotes` to `validationNotes`
 * exactly as the client path does, then delegates the write (and graph sync)
 * to `adminUpdateSignal`. Same thrown-Error semantics for the AI
 * `approveSignalForImport` / `bulkApproveSignals` tools.
 *
 * `options.feedbackUserId` (T27): when supplied, best-effort folds this approve into the SAME
 * interest posterior a thumbs-up records (`steerSignalInterest`) — so an AI-executor approval
 * teaches the discovery selector too, not just a human click in the triage UI. Omitted (no
 * identity available, e.g. an unauthenticated agent principal) → no posterior write; the
 * approval itself always succeeds either way.
 *
 * Idempotence guard (T27 fix): reads the signal's CURRENT status before steering. If already
 * 'Approved', skips the steering call entirely to prevent double-counting the posterior.
 *
 * B1 fix (cross-path posterior double-count): this admin path and the thumbs path
 * (`steerSignalInterest`'s guard in `signals/feedback.ts`) used to guard on DIFFERENT
 * idempotency keys — `status` here, `feedback.vote` there — so neither cross-wrote the other's
 * key. An AI-approve (with `feedbackUserId` → posterior recorded) followed by the SAME user
 * thumbs-up-voting the same signal would read `feedback.vote === undefined`, miss the thumbs
 * guard, and record the posterior a second time. Fixed by unifying on `feedback.vote` as the
 * ONE shared key: when steering actually fires below, this ALSO stamps `feedback.vote` on the
 * signal doc in the exact shape `submitSignalFeedback` writes (see `signals/feedback.ts`), so a
 * later thumbs vote reads it as the prior vote and either short-circuits (same direction) or
 * flip-undoes (opposite direction) instead of double-counting.
 */
export async function adminApproveSignal(
  signalId: string,
  reviewNotes?: string,
  options?: { feedbackUserId?: string }
): Promise<void> {
  try {
    // Read current signal to check idempotence
    const currentSignal = await adminGetSignalById(signalId);
    if (!currentSignal) {
      throw new Error(`Signal ${signalId} not found`);
    }

    const updates: Partial<Signal> = {
      status: 'Approved',
      reviewedAt: Date.now(),
    };

    if (reviewNotes) {
      updates.validationNotes = updates.validationNotes
        ? `${updates.validationNotes}\n\nReview Notes: ${reviewNotes}`
        : `Review Notes: ${reviewNotes}`;
    }

    // Idempotence: only steer (and stamp feedback.vote) if not already approved.
    const willSteer = currentSignal.status !== 'Approved' && Boolean(options?.feedbackUserId);

    // B1 fix: stamp `feedback.vote` in the SAME write as the status change, but ONLY when
    // steering is actually about to fire. An approval with no `feedbackUserId` (unauthenticated
    // agent principal) or one that hits the already-approved guard must leave `feedback.vote`
    // unset — otherwise the user's first REAL thumbs vote would read a synthetic prior vote and
    // wrongly short-circuit as a same-direction re-vote, silently dropping their first vote.
    // `votedBy` is honestly attributed to the acting `feedbackUserId` (never a synthetic value).
    if (willSteer) {
      updates.feedback = {
        vote: 'up',
        votedAt: Date.now(),
        votedBy: options!.feedbackUserId!,
        includedInFeedbackLoop: true,
        ...(reviewNotes && { reason: reviewNotes }),
      };
    }

    await adminUpdateSignal(signalId, updates);
    log.info('Approved signal (admin)', { signalId });

    if (willSteer) {
      // Pass the PRE-write `currentSignal` snapshot, not a re-fetch — see
      // `steerAdminSignalFeedback`'s doc comment for why a re-fetch here would be wrong now that
      // `feedback.vote` is stamped in the write above.
      await steerAdminSignalFeedback(currentSignal, 'up', options!.feedbackUserId!, reviewNotes, 'adminApproveSignal');
    }
  } catch (error) {
    log.error('Error approving signal (admin)', error instanceof Error ? error : new Error(String(error)), {
      signalId,
    });
    throw new Error(`Failed to approve signal ${signalId}`);
  }
}

/**
 * Admin-SDK equivalent of `signals-approval.rejectSignal`. Requires a
 * non-empty `reason` (same guard + error message as the client), sets status
 * `Rejected` + `reviewedAt` + `validationNotes`, delegating the write to
 * `adminUpdateSignal`. Powers the AI `rejectSignalWithReason` /
 * `bulkRejectSignals` tools server-side.
 *
 * `options.feedbackUserId` (T27): same best-effort `steerSignalInterest` fold as
 * `adminApproveSignal`, recording a thumbs-down move instead. See that doc comment.
 *
 * Idempotence guard (T27 fix): reads the signal's CURRENT status before steering. If already
 * 'Rejected', skips the steering call entirely to prevent double-counting the posterior.
 *
 * B1 fix (cross-path posterior double-count): same shared-key fix as `adminApproveSignal` — see
 * its doc comment for the full rationale. When steering fires here, `feedback.vote` is stamped
 * `'down'` in the same write as the status change, so a later thumbs vote on this signal reads
 * it as the prior vote instead of double-counting.
 */
export async function adminRejectSignal(
  signalId: string,
  reason: string,
  options?: { feedbackUserId?: string }
): Promise<void> {
  try {
    if (!reason || reason.trim().length === 0) {
      throw new Error('Rejection reason is required');
    }

    // Read current signal to check idempotence
    const currentSignal = await adminGetSignalById(signalId);
    if (!currentSignal) {
      throw new Error(`Signal ${signalId} not found`);
    }

    // Idempotence: only steer (and stamp feedback.vote) if not already rejected.
    const willSteer = currentSignal.status !== 'Rejected' && Boolean(options?.feedbackUserId);

    const updates: Partial<Signal> = {
      status: 'Rejected',
      reviewedAt: Date.now(),
      validationNotes: `Rejected: ${reason}`,
    };

    // B1 fix: stamp `feedback.vote` only when steering actually fires — see
    // `adminApproveSignal`'s matching comment for why this must stay conditional. `reason` is a
    // required param here so it's always attached (unlike the approve path's optional notes).
    if (willSteer) {
      updates.feedback = {
        vote: 'down',
        votedAt: Date.now(),
        votedBy: options!.feedbackUserId!,
        includedInFeedbackLoop: true,
        reason,
      };
    }

    await adminUpdateSignal(signalId, updates);

    log.info('Rejected signal (admin)', { signalId });

    if (willSteer) {
      // Pre-write snapshot — see `steerAdminSignalFeedback`'s doc comment.
      await steerAdminSignalFeedback(currentSignal, 'down', options!.feedbackUserId!, reason, 'adminRejectSignal');
    }
  } catch (error) {
    log.error('Error rejecting signal (admin)', error instanceof Error ? error : new Error(String(error)), {
      signalId,
    });
    throw new Error(`Failed to reject signal ${signalId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// ============================================================================
// ARCHIVE / CLEANUP (admin twins of signals-approval + signals-core)
// ============================================================================

/**
 * Admin-SDK equivalent of `signals-approval.getArchivedSignals`. Reads every
 * doc with `status === 'Archived'` (single `where`, no composite index),
 * sorts in-memory by `metadata.archivedAt || detectedAt` newest-first, and
 * applies the optional `maxResults` cap — identical contract to the client
 * path the cleanup job relies on. Wraps any failure in the SAME generic Error.
 */
export async function adminGetArchivedSignals(maxResults?: number): Promise<Signal[]> {
  try {
    const snap = await db.collection('signals').where('status', '==', 'Archived').get();
    let signals = snap.docs.map((doc) => doc.data() as Signal);

    // Sort by archivedAt (newest first), fallback to detectedAt
    signals.sort((a, b) => {
      const aDate = a.metadata?.archivedAt || a.detectedAt;
      const bDate = b.metadata?.archivedAt || b.detectedAt;
      return bDate - aDate;
    });

    if (maxResults) {
      signals = signals.slice(0, maxResults);
    }

    return signals;
  } catch (error) {
    log.error('Error fetching archived signals (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to fetch archived signals');
  }
}

/**
 * Admin-SDK equivalent of `signals-approval.archiveSignals`. Sets each
 * non-archived signal to `status: 'Archived'`, stamps `metadata.archivedAt`,
 * `archiveReason`, and `previousStatus` (so `adminRestoreSignals` can put it
 * back), and routes through `adminUpdateSignal` so every archive also fires the
 * Neo4j sync the client batch path skipped. Already-archived ids are a no-op
 * (not counted, not failed) so the call is idempotent. Per-id failures are
 * collected, never thrown — a bad id can't sink the rest of a bulk archive.
 */
export async function adminArchiveSignals(
  ids: string[],
  reason?: string
): Promise<{ archived: number; failed: string[] }> {
  const failed: string[] = [];
  let archived = 0;

  for (const id of ids) {
    try {
      const signal = await adminGetSignalById(id);
      if (!signal) {
        failed.push(id);
        continue;
      }
      if (signal.status === 'Archived') {
        continue; // idempotent: already archived
      }

      await adminUpdateSignal(id, {
        status: 'Archived' as SignalStatus,
        metadata: {
          ...signal.metadata,
          archivedAt: Date.now(),
          archiveReason: reason || 'Manual archive',
          previousStatus: signal.status,
        },
      });
      archived++;
    } catch (error) {
      log.error('Failed to archive signal (admin)', error instanceof Error ? error : new Error(String(error)), {
        id,
      });
      failed.push(id);
    }
  }

  log.info('Archived signals (admin)', { archived, failed: failed.length });
  return { archived, failed };
}

/**
 * Admin-SDK equivalent of `signals-approval.restoreSignal`, bulk-capable. Puts
 * each archived signal back to `metadata.previousStatus` (falling back to
 * `'Validated'` when the marker is missing), strips the archive bookkeeping
 * keys, and stamps `restoredAt`. Firestore `update()` replaces the whole
 * `metadata` map, so the dropped keys really disappear — matching the client
 * path's semantics. Non-archived or missing ids are reported as `failed` rather
 * than silently skipped, since a restore of a live signal is a real caller bug.
 */
export async function adminRestoreSignals(ids: string[]): Promise<{ restored: number; failed: string[] }> {
  const failed: string[] = [];
  let restored = 0;

  for (const id of ids) {
    try {
      const signal = await adminGetSignalById(id);
      if (!signal || signal.status !== 'Archived') {
        failed.push(id);
        continue;
      }

      const previousStatus = (signal.metadata?.previousStatus as SignalStatus) || 'Validated';
      const {
        archivedAt: _archivedAt,
        archiveReason: _archiveReason,
        previousStatus: _previousStatus,
        ...restMetadata
      } = signal.metadata || {};

      await adminUpdateSignal(id, {
        status: previousStatus,
        metadata: {
          ...restMetadata,
          restoredAt: Date.now(),
        },
      });
      restored++;
    } catch (error) {
      log.error('Failed to restore signal (admin)', error instanceof Error ? error : new Error(String(error)), {
        id,
      });
      failed.push(id);
    }
  }

  log.info('Restored signals (admin)', { restored, failed: failed.length });
  return { restored, failed };
}

/**
 * Admin-SDK equivalent of `signals-core.deleteSignals`. Reproduces the client
 * orchestration faithfully:
 *   1. prepare document-link and relation cleanup with bounded concurrency,
 *      retaining exact IDs whose prerequisite fails,
 *   2. batch-delete only fully prepared signal docs (≤500 per admin batch),
 *   3. fire `triggerEntitySync('signal', id, 'delete')` per deleted id — the
 *      SAME server-safe helper the client path uses (it only dynamically imports
 *      `@/lib/inngest/client`, no client-SDK reach, so it crosses the boundary).
 *
 * The browser-only `emitDataRefresh('signals', 'bulk-delete')` step is a no-op
 * server-side and is intentionally skipped. Same `{ deleted, failed,
 * relationsDeleted }` return shape as the client path.
 */
export async function adminDeleteSignals(
  ids: string[]
): Promise<{ deleted: number; failed: string[]; relationsDeleted: number }> {
  const { triggerEntitySync } = await import('@/lib/entity-sync');

  const failed: string[] = [];
  let deleted = 0;
  let relationsDeleted = 0;

  // Firestore batch writes are limited to 500 operations
  const batchSize = 500;

  for (let i = 0; i < ids.length; i += batchSize) {
    const batchIds = ids.slice(i, i + batchSize);
    const preparation = await prepareEntityDeletions(batchIds, async (id) => {
      await adminDeleteLinksForEntity('signal', id);
      return adminDeleteRelationsForEntity(id);
    });
    for (const { id, error } of preparation.failed) {
      failed.push(id);
      log.warn('Signal cascade cleanup failed; retaining Firestore document', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    relationsDeleted += preparation.prepared.reduce((sum, item) => sum + item.relationsDeleted, 0);

    if (preparation.prepared.length === 0) continue;

    const batch = db.batch();

    for (const { id } of preparation.prepared) {
      batch.delete(db.collection('signals').doc(id));
    }

    try {
      await batch.commit();
      deleted += preparation.prepared.length;

      // Trigger Neo4j sync for each deleted signal
      const syncPromises = preparation.prepared.map(({ id }) =>
        triggerEntitySync('signal', id, 'delete').catch((err) => {
          log.warn('Failed to trigger Neo4j sync for delete (admin)', { id, error: String(err) });
        })
      );
      await Promise.allSettled(syncPromises);
    } catch (error) {
      log.error('Batch delete failed (admin)', error instanceof Error ? error : new Error(String(error)));
      failed.push(...preparation.prepared.map(({ id }) => id));
    }
  }

  // NOTE: client path emits emitDataRefresh('signals', 'bulk-delete') here — a
  // browser-only UI cache hint that is a no-op server-side, so it is skipped.

  log.info('Deleted signals (admin)', { deleted, failed: failed.length, relationsDeleted });
  return { deleted, failed, relationsDeleted };
}

/**
 * Admin-SDK equivalent of `signals-approval.cleanupArchivedSignals`. Computes
 * the cutoff (`now - retentionDays`), fetches archived signals via
 * `adminGetArchivedSignals`, filters those archived before the cutoff
 * (`metadata.archivedAt || detectedAt`), early-returns `{ deleted: 0, failed:
 * [] }` when none qualify, and otherwise delegates the delete to
 * `adminDeleteSignals` — returning the `{ deleted, failed }` shape (the
 * client contract drops `relationsDeleted`). Wraps any failure in the SAME
 * generic Error message format.
 */
export async function adminCleanupArchivedSignals(
  retentionDays: number = 90
): Promise<{ deleted: number; failed: string[] }> {
  try {
    const cutoffDate = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const archivedSignals = await adminGetArchivedSignals();

    // Filter signals archived before cutoff
    const signalsToDelete = archivedSignals.filter((signal) => {
      const archivedAt = signal.metadata?.archivedAt || signal.detectedAt;
      return archivedAt < cutoffDate;
    });

    if (signalsToDelete.length === 0) {
      log.info('No signals older than days to delete (admin)', { retentionDays });
      return { deleted: 0, failed: [] };
    }

    const result = await adminDeleteSignals(signalsToDelete.map((s) => s.id));
    log.info('Deleted old archived signals (admin)', { deleted: result.deleted, retentionDays });
    return { deleted: result.deleted, failed: result.failed };
  } catch (error) {
    log.error('Failed to cleanup archived signals (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to cleanup archived signals: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
