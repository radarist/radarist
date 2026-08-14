/**
 * event-retention.ts — pure age/status retention selection for local dev-data
 * cleanup (CLEANUP-001).
 *
 * The local emulator accumulates ~79k `job-runs` and ~78k `agent-events` because
 * terminal rows have no enforced TTL. This module decides — as pure, fully
 * unit-tested functions with NO Firestore access — which rows are eligible for
 * a bounded, operator-approved retention sweep.
 *
 * The load-bearing safety rule: a job-run that is still an ACTIVE or RETRY
 * ANCHOR (`running` / `retrying`) is NEVER eligible, however old it looks — those
 * rows are the durable anchors an in-flight or retrying job depends on. Only
 * terminal (`completed` / `failed`) rows past the conservative age window are
 * eligible. Selection is preview-first (counts before any delete) and batched.
 *
 * This module never deletes anything. Applying a retention plan remains an
 * operator-only action gated on backup and explicit approval because it
 * touches primary historical data.
 */

/**
 * Job-run lifecycle statuses (mirror of observability.ts `JobStatus`).
 *
 * A status absent from `TERMINAL_JOB_STATUSES` is treated as a protected
 * retention anchor by `isJobRunRetentionEligible` and can NEVER be reaped, so
 * `'cancelled'` (ARUN-023) belongs here: a cancelled run is finished, and
 * omitting it would leak an unbounded, permanently-retained row per cancel.
 * `'interrupted'` (LOCAL-013) belongs here for the same reason: a run whose
 * queue state did not survive a restart is finished and will never resume.
 */
export const ACTIVE_JOB_STATUSES = ['running', 'retrying'] as const;
export const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'] as const;

/** Firestore write ceiling is 500; keep a margin for the accounting doc. */
export const RETENTION_BATCH_SIZE = 450;

export interface JobRunRecord {
  id: string;
  status: string;
  /** ms epoch when the run started. */
  startedAt: number;
  /** ms epoch when the run reached a terminal status, if it did. */
  completedAt?: number;
}

export interface AgentEventRecord {
  id: string;
  /** ms epoch when the event was created (`_createdAt`). */
  createdAtMs: number;
}

export interface RetentionPolicy {
  /** Rows older than this many ms are in the age window. */
  olderThanMs: number;
  /** Injected "now" (ms epoch) for deterministic evaluation. */
  now: number;
}

/** True only for terminal job-runs past the age window. Active/retry anchors are never eligible. */
export function isJobRunRetentionEligible(record: JobRunRecord, policy: RetentionPolicy): boolean {
  if (!(TERMINAL_JOB_STATUSES as readonly string[]).includes(record.status)) {
    return false; // running / retrying (or any unknown non-terminal status) — protected anchor
  }
  const effectiveAt = record.completedAt ?? record.startedAt;
  return policy.now - effectiveAt > policy.olderThanMs;
}

export function isAgentEventRetentionEligible(record: AgentEventRecord, policy: RetentionPolicy): boolean {
  // Fail SAFE on a missing/invalid timestamp: a 0/absent `createdAtMs` must NOT be
  // treated as maximally old and deleted (job-runs already fail safe on unknown
  // status; agent-events must match that conservatism).
  if (!Number.isFinite(record.createdAtMs) || record.createdAtMs <= 0) return false;
  return policy.now - record.createdAtMs > policy.olderThanMs;
}

export interface JobRunRetentionSummary {
  total: number;
  eligible: number;
  /** Count of active/retry anchors deliberately retained (visibility, not silence). */
  retainedActiveAnchors: number;
  byStatus: Record<string, number>;
  eligibleIds: string[];
}

export function summarizeJobRunRetention(records: JobRunRecord[], policy: RetentionPolicy): JobRunRetentionSummary {
  const byStatus: Record<string, number> = {};
  const eligibleIds: string[] = [];
  let retainedActiveAnchors = 0;

  for (const r of records) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if ((ACTIVE_JOB_STATUSES as readonly string[]).includes(r.status)) retainedActiveAnchors += 1;
    if (isJobRunRetentionEligible(r, policy)) eligibleIds.push(r.id);
  }

  return { total: records.length, eligible: eligibleIds.length, retainedActiveAnchors, byStatus, eligibleIds };
}

export interface AgentEventRetentionSummary {
  total: number;
  eligible: number;
  eligibleIds: string[];
}

export function summarizeAgentEventRetention(
  records: AgentEventRecord[],
  policy: RetentionPolicy
): AgentEventRetentionSummary {
  const eligibleIds = records.filter((r) => isAgentEventRetentionEligible(r, policy)).map((r) => r.id);
  return { total: records.length, eligible: eligibleIds.length, eligibleIds };
}

/** Split ids into bounded, idempotent batches (≤ Firestore write ceiling). */
export function planRetentionBatches(ids: string[], batchSize: number = RETENTION_BATCH_SIZE): string[][] {
  if (batchSize < 1) throw new Error('planRetentionBatches: batchSize must be >= 1');
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));
  return batches;
}
