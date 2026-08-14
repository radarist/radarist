/**
 * @file lib/inngest/interrupted-run-recovery.ts
 * @description LOCAL-013 — terminalize job-run records the queue can no longer resume.
 *
 * `job-runs` is an observability record, not a queue. The durable queue is the
 * Inngest dev server's own persisted state; this module never pretends
 * otherwise. What it fixes is a record that *lies*: `recordJobStart` writes
 * `status: 'running'`, and only the middleware's success/failure hooks write a
 * terminal status. When the executor dies mid-run neither hook fires, so the
 * document is stranded at `running` forever and the UI shows in-flight work
 * that no longer exists.
 *
 * The distinguishing question is not "did the process die" — with a persisted
 * queue a killed run is *resumed* and reaches a terminal status normally
 * through the usual hooks. It is "can the queue still resume this run". That is
 * knowable exactly when the runtime starts: either the persisted queue state
 * was carried over from the previous runtime, or it was not.
 *
 * So the contract is deliberately narrow:
 *
 * - queue state carried over → prior work is resumable → change nothing;
 * - queue state absent (reset, discarded, or persistence disabled) → prior
 *   non-terminal work is definitively lost → mark it `interrupted`.
 *
 * A run without a recorded epoch is never touched. Hosted deployments stamp no
 * epoch, and a run that cannot be proven stale must not be terminalized.
 *
 * This is honest recovery, not exactly-once execution. A step whose side effect
 * committed before the kill but whose completion was never recorded will re-run
 * when the queue resumes it; graph writes are idempotent MERGEs, which bounds
 * that without eliminating it. `BUILD-029` owns the durable outbox and
 * idempotent worker claim a real exactly-once contract would need.
 */

import 'server-only';

import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import { ACTIVE_JOB_STATUSES } from '@/lib/event-retention';
import { resolveJobRunDomainFields } from './domain-outcome';

const log = createLogger('inngest/interrupted-run-recovery');

/** Bounded scan ceiling for one recovery pass. */
export const MAX_RECOVERED_RUNS_PER_PASS = 500;

/**
 * What one job-run recovery decision concluded — reported, never guessed.
 *
 * Every non-`interrupted` outcome is a legitimate reason to leave a record
 * exactly as it is.
 */
export type InterruptedRunOutcome =
  'interrupted' | 'already-terminal' | 'resumable' | 'current-epoch' | 'unknown-epoch' | 'not-found';

export interface RuntimeRecoveryContext {
  /** Identity of the runtime performing recovery. */
  currentEpoch: string;
  /**
   * Whether the persisted queue state survived into this runtime. When true,
   * prior-epoch work is still schedulable and must not be terminalized.
   */
  queueStateCarriedOver: boolean;
}

export interface JobRunRecoveryCandidate {
  status: string;
  /** Runtime epoch recorded at job start, if the runtime stamped one. */
  runtimeEpoch?: string;
}

function isActive(status: string): boolean {
  return (ACTIVE_JOB_STATUSES as readonly string[]).includes(status);
}

/**
 * Decide whether one job-run record is provably unresumable.
 *
 * Pure so the policy can be exhaustively tested without Firestore, and so the
 * applier below has no branch of its own to get wrong.
 */
export function decideInterruptedRunRecovery(
  candidate: JobRunRecoveryCandidate,
  context: RuntimeRecoveryContext
): InterruptedRunOutcome {
  if (!isActive(candidate.status)) return 'already-terminal';
  // A run the current runtime started is either executing now or queued; the
  // executor owns it and will terminalize it through the normal hooks.
  if (candidate.runtimeEpoch === context.currentEpoch) return 'current-epoch';
  // Cannot be proven stale — no epoch was ever recorded for this run.
  if (!candidate.runtimeEpoch) return 'unknown-epoch';
  if (context.queueStateCarriedOver) return 'resumable';
  return 'interrupted';
}

/**
 * Terminalize one run whose queue state did not survive.
 *
 * Mirrors `recordJobCancelled`: transactional, idempotent, non-destructive, and
 * it invents nothing. It writes `status`, `completedAt`, and a reason — never a
 * fabricated `output`, and never `completed`.
 *
 * Throws on infrastructure failure so the caller can retry rather than silently
 * reporting success.
 */
export async function recordJobInterrupted(
  runId: string,
  context: RuntimeRecoveryContext
): Promise<InterruptedRunOutcome> {
  const completedAt = Date.now();
  const jobRunRef = db.collection('job-runs').doc(runId);

  const outcome = await db.runTransaction<InterruptedRunOutcome>(async (transaction) => {
    const snapshot = await transaction.get(jobRunRef);
    if (!snapshot.exists) return 'not-found';

    const data = snapshot.data() ?? {};
    // Re-decided inside the transaction against freshly read state, so a run
    // that reached a real terminal status between the scan and this write keeps
    // its authoritative result.
    const decision = decideInterruptedRunRecovery(
      {
        status: typeof data.status === 'string' ? data.status : '',
        runtimeEpoch: typeof data.runtimeEpoch === 'string' ? data.runtimeEpoch : undefined,
      },
      context
    );
    if (decision !== 'interrupted') return decision;

    // OBS-001: stamp the provenance that explains the ABSENT domain outcome.
    // An interrupted runtime proves the transport died; it proves nothing about
    // whether the business work delivered, so no `domainOutcome` is written.
    // Recording `failed` here would be the same conflation in reverse.
    transaction.update(jobRunRef, {
      status: 'interrupted',
      completedAt: Timestamp.fromMillis(completedAt),
      interruptedReason: 'runtime-restarted-without-queue-state',
      recoveredByEpoch: context.currentEpoch,
      domainOutcomeSource: resolveJobRunDomainFields({ transport: 'interrupted' }).domainOutcomeSource,
    });
    return 'interrupted';
  });

  return outcome;
}

export interface InterruptedRunRecoveryReport {
  /** Records examined in this bounded pass. */
  scanned: number;
  interrupted: number;
  /** Left alone because the persisted queue can still resume them. */
  resumable: number;
  /** Left alone because no runtime epoch was ever recorded. */
  unknownEpoch: number;
  /** Left alone because they reached a real terminal status first. */
  alreadyTerminal: number;
  /** True when the scan hit its ceiling and more candidates may remain. */
  truncated: boolean;
  errors: string[];
}

/**
 * Recover every provably unresumable run in one bounded pass.
 *
 * Idempotent: a second pass re-reads runs already marked `interrupted`, sees a
 * terminal status, and returns without writing.
 */
export async function recoverInterruptedJobRuns(
  context: RuntimeRecoveryContext,
  limit: number = MAX_RECOVERED_RUNS_PER_PASS
): Promise<InterruptedRunRecoveryReport> {
  const report: InterruptedRunRecoveryReport = {
    scanned: 0,
    interrupted: 0,
    resumable: 0,
    unknownEpoch: 0,
    alreadyTerminal: 0,
    truncated: false,
    errors: [],
  };

  // Carried-over queue state makes every prior run resumable, so the pass has
  // no work to do and does not read Firestore at all.
  if (context.queueStateCarriedOver) return report;

  const bounded = Math.min(Math.max(limit, 0), MAX_RECOVERED_RUNS_PER_PASS);
  if (bounded === 0) return report;

  const snapshot = await db
    .collection('job-runs')
    .where('status', 'in', [...ACTIVE_JOB_STATUSES])
    .orderBy(FieldPath.documentId())
    .limit(bounded + 1)
    .get();

  const candidates = snapshot.docs.slice(0, bounded);
  report.truncated = snapshot.size > bounded;

  for (const candidate of candidates) {
    report.scanned++;
    try {
      const outcome = await recordJobInterrupted(candidate.id, context);
      if (outcome === 'interrupted') report.interrupted++;
      else if (outcome === 'resumable') report.resumable++;
      else if (outcome === 'unknown-epoch') report.unknownEpoch++;
      else if (outcome === 'already-terminal') report.alreadyTerminal++;
    } catch (error) {
      if (report.errors.length < 50) {
        report.errors.push(`${candidate.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  log.info('Interrupted job-run recovery completed', {
    epoch: context.currentEpoch,
    scanned: report.scanned,
    interrupted: report.interrupted,
    unknownEpoch: report.unknownEpoch,
    truncated: report.truncated,
    errorCount: report.errors.length,
  });
  return report;
}
