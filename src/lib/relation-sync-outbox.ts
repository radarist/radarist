/**
 * @file lib/relation-sync-outbox.ts
 * @description Durable delete marker for a relation whose Neo4j teardown was
 * not confirmed, plus the bounded retry policy the replayer applies to it.
 *
 * GRAPH-059 — a marker used to live in exactly one state (`pending`) with an
 * `attempt` counter that only ever went up, so a permanently failing delete was
 * re-dispatched every five minutes forever: a retry storm that never converged
 * and never became visible to anyone. The policy now terminates.
 *
 * Three properties the replayer depends on, all decided here so they can be
 * proven without Firestore:
 *
 *   1. **Bounded.** `MAX_RELATION_DELETE_ATTEMPTS` dispatches, then the marker
 *      moves to the terminal `exhausted` state.
 *   2. **Exhausts exactly once.** The replayer's load query selects
 *      `status == 'pending'`, so the pending -> exhausted transition is the last
 *      time a marker is ever claimed. Re-running the replayer cannot re-exhaust
 *      it, re-log it, or re-dispatch it.
 *   3. **Still convergent.** `exhausted` stops the *replayer*, not the repair.
 *      A successful delete deletes the marker whatever its status, and the
 *      Firestore/Neo4j reconciler still removes the stale projection — so a
 *      transient outage that outlives the retry budget converges through
 *      reconciliation instead of through an unbounded retry loop.
 */

import { parseCorrelationId, resolveCorrelationId } from '@/lib/observability/correlation';
import { MAX_OUTBOX_ERROR_LENGTH, normalizeOutboxError } from '@/lib/outbox-error';

export const RELATION_SYNC_OUTBOX_COLLECTION = 'relationSyncOutbox';
export const RELATION_DELETE_REPLAY_DELAY_MS = 5 * 60 * 1000;

/**
 * Dispatch budget for one delete marker. At the five-minute replay cadence this
 * is an hour of retries — long enough to ride out a Neo4j restart or a graph
 * kill-switch window, short enough that a permanently broken marker becomes an
 * operator-visible fact inside the same working hour instead of retrying for
 * the lifetime of the deployment.
 */
export const MAX_RELATION_DELETE_ATTEMPTS = 12;

export type RelationDeleteOutboxStatus = 'pending' | 'exhausted';

export interface RelationDeleteOutboxRecord {
  relationId: string;
  deleteToken: string;
  /** Stable mutation token; absent on delete markers created before OBS-003. */
  correlationId?: string;
  operation: 'delete';
  status: RelationDeleteOutboxStatus;
  attempt: number;
  nextAttemptAt: number;
  /**
   * Why the marker is still outstanding, bounded by `MAX_OUTBOX_ERROR_LENGTH`.
   * Null when nothing has reported a reason yet — the replayer only learns that
   * a dispatch failed, not why the graph write did.
   */
  lastError: string | null;
  /** When the retry budget ran out. Null while the marker is still `pending`. */
  exhaustedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export function buildRelationDeleteOutboxRecord(
  relationId: string,
  deleteToken: string,
  timestamp = Date.now(),
  correlationId?: string
): RelationDeleteOutboxRecord {
  const validatedCorrelationId = correlationId === undefined ? undefined : resolveCorrelationId(correlationId);
  return {
    relationId,
    deleteToken,
    ...(validatedCorrelationId ? { correlationId: validatedCorrelationId } : {}),
    operation: 'delete',
    status: 'pending',
    attempt: 0,
    nextAttemptAt: timestamp + RELATION_DELETE_REPLAY_DELAY_MS,
    lastError: null,
    exhaustedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createRelationDeleteToken(relationId: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${relationId}:${Date.now()}:${random}`;
}

export function relationDeleteSyncEventId(deleteToken: string, attempt: number): string {
  return `relation-delete:${deleteToken}:${attempt}`;
}

/**
 * One claimed replay decision, expressed as the exact field patch to persist.
 *
 * Returning the patch rather than a whole record keeps the replayer's Firestore
 * update minimal (it must not rewrite `deleteToken` or `createdAt` under a
 * concurrent replacement) while keeping the policy itself pure and provable.
 */
export type RelationDeleteReplayDecision =
  | {
      kind: 'dispatch';
      attempt: number;
      updates: { attempt: number; nextAttemptAt: number; updatedAt: number };
    }
  | {
      kind: 'exhausted';
      attempt: number;
      updates: {
        status: 'exhausted';
        exhaustedAt: number;
        updatedAt: number;
        lastError: string | null;
      };
    };

/**
 * Decide what happens to a due marker that has just been claimed.
 *
 * An already-`exhausted` marker is never claimed (the replayer filters it out),
 * so this deliberately does not model that input: reaching the bound is the
 * single transition into the terminal state, which is what makes "exhausts
 * exactly once" a property of the data rather than of the caller's discipline.
 */
export function planRelationDeleteReplay(
  record: Pick<RelationDeleteOutboxRecord, 'attempt' | 'lastError'>,
  options: { now: number; delayMs?: number; maxAttempts?: number; lastError?: unknown } = { now: Date.now() }
): RelationDeleteReplayDecision {
  const now = options.now;
  const delayMs = options.delayMs ?? RELATION_DELETE_REPLAY_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? MAX_RELATION_DELETE_ATTEMPTS;
  const attempt = record.attempt + 1;

  if (attempt > maxAttempts) {
    return {
      kind: 'exhausted',
      attempt: record.attempt,
      updates: {
        status: 'exhausted',
        exhaustedAt: now,
        updatedAt: now,
        lastError:
          normalizeOutboxError(options.lastError) ??
          record.lastError ??
          `Relation delete was not confirmed after ${maxAttempts} replay attempts`,
      },
    };
  }

  return {
    kind: 'dispatch',
    attempt,
    updates: { attempt, nextAttemptAt: now + delayMs, updatedAt: now },
  };
}

function isBoundedTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Strict reader. Returns a fully normalized record so downstream callers never
 * have to distinguish a marker written before GRAPH-059 (no `status` beyond
 * `pending`, no `lastError`/`exhaustedAt`) from one written after it. A
 * malformed marker is `null` and is never coerced into something usable.
 */
export function parseRelationDeleteOutboxRecord(documentId: string, value: unknown): RelationDeleteOutboxRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const status = record.status === undefined ? 'pending' : record.status;
  const lastError = record.lastError === undefined ? null : record.lastError;
  const exhaustedAt = record.exhaustedAt === undefined ? null : record.exhaustedAt;

  if (
    record.relationId !== documentId ||
    typeof record.deleteToken !== 'string' ||
    record.deleteToken.length === 0 ||
    (record.correlationId !== undefined && !parseCorrelationId(record.correlationId)) ||
    record.operation !== 'delete' ||
    (status !== 'pending' && status !== 'exhausted') ||
    typeof record.attempt !== 'number' ||
    !Number.isInteger(record.attempt) ||
    record.attempt < 0 ||
    record.attempt > MAX_RELATION_DELETE_ATTEMPTS ||
    !isBoundedTimestamp(record.nextAttemptAt) ||
    (lastError !== null && (typeof lastError !== 'string' || lastError.length > MAX_OUTBOX_ERROR_LENGTH)) ||
    (exhaustedAt !== null && !isBoundedTimestamp(exhaustedAt)) ||
    // A terminal marker must carry the instant it terminated, and a pending one
    // must not claim to have terminated — otherwise "exhausted exactly once"
    // cannot be read back off the document.
    (status === 'exhausted') !== (exhaustedAt !== null) ||
    !isBoundedTimestamp(record.createdAt) ||
    !isBoundedTimestamp(record.updatedAt)
  ) {
    return null;
  }

  return {
    relationId: record.relationId,
    deleteToken: record.deleteToken,
    ...(record.correlationId !== undefined ? { correlationId: record.correlationId as string } : {}),
    operation: 'delete',
    status,
    attempt: record.attempt,
    nextAttemptAt: record.nextAttemptAt,
    lastError,
    exhaustedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
