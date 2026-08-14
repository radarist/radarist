/**
 * @file lib/inngest/observability.ts
 * @description Observability utilities for Inngest background jobs
 *
 * Provides structured logging, metrics tracking, and job run history
 * for all Inngest functions.
 *
 * **Features:**
 * - Structured JSON logging with consistent format
 * - Job execution metrics (duration, success/failure)
 * - Error tracking with context
 * - Job run history stored in Firestore (admin SDK)
 * - Dashboard-ready metrics
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import { TERMINAL_JOB_STATUSES } from '@/lib/event-retention';
import { createLogger } from '@/lib/logger';
import { parseCorrelationId, parseMissionId } from '@/lib/observability/correlation';
import {
  DECIDED_DOMAIN_OUTCOMES,
  isDomainOutcome,
  isUnsuccessfulDomainOutcome,
  type DomainOutcome,
} from '@/lib/observability/terminal-outcome';
import { resolveJobRunDomainFields, type DomainOutcomeDeclaration, type DomainOutcomeSource } from './domain-outcome';
import { LOCAL_RUNTIME_EPOCH_ENV, parseRuntimeEpoch } from './runtime-epoch';

const log = createLogger('inngest/observability');

/**
 * Job run status
 */
/**
 * ARUN-023 added `'cancelled'`; LOCAL-013 added `'interrupted'`. When adding
 * another terminal status, also add it to `TERMINAL_JOB_STATUSES` in
 * `@/lib/event-retention` — anything absent from that list is treated as a
 * *protected retention anchor* and can never be reaped.
 *
 * `'interrupted'` means the runtime died while the run was non-terminal AND the
 * persisted queue state did not survive, so it can never resume. It is
 * deliberately distinct from `'failed'` (the function ran and threw) and from
 * `'completed'` (which would be a lie).
 */
export type JobStatus = 'running' | 'completed' | 'failed' | 'retrying' | 'cancelled' | 'interrupted';

/**
 * Job run record stored in Firestore.
 *
 * OBS-001 — this record carries TWO independent terminal facts, and conflating
 * them is the bug the `domainOutcome*` fields exist to close:
 *
 * - `status` is the **transport** lifecycle only: did the Inngest run finish,
 *   throw, get cancelled, or lose its runtime? It is written by the middleware's
 *   `finished` hook, by `recordJobCancelled`, and by interrupted-run recovery,
 *   and it is the field `TERMINAL_JOB_STATUSES`/retention/recovery key on.
 * - `domainOutcome` is the **business** outcome the function itself declared
 *   (see `@/lib/inngest/domain-outcome`). A run is routinely transport-
 *   `completed` with domain `failed`: in the TEST-027 evidence the Creator run
 *   returned cleanly while its canonical Mission and AgentRun were failed and
 *   no Report existed.
 *
 * `domainOutcome` is ABSENT whenever no honest value exists — an undeclared
 * function, or an interrupted runtime whose work is unknowable. Readers must
 * render an absent outcome as "not declared" and must never count it as a
 * success. `domainOutcomeSource` exists precisely so that "the function said it
 * failed" and "the function said nothing" cannot render as the same pill.
 */
export interface JobRun {
  id: string;
  /** Queryable mutation token for cross-store relation lifecycle diagnostics. */
  correlationId?: string;
  /**
   * Queryable mission correlation, lifted from a bounded `input.missionId` at
   * start time. Established on START because the `inngest/function.cancelled`
   * payload never carries the original event (ARUN-023).
   */
  missionId?: string;
  /**
   * LOCAL-013 — identity of the local runtime that started this run. Absent for
   * hosted deployments, which stamp no epoch; a run without one is never
   * terminalized by interrupted-run recovery because it cannot be proven stale.
   */
  runtimeEpoch?: string;
  functionId: string;
  functionName: string;
  /** TRANSPORT lifecycle only — see the interface docblock. */
  status: JobStatus;
  /**
   * OBS-001 — the BUSINESS outcome, declared by the function itself. Absent when
   * undeclared or unknowable; never defaulted to a success-shaped value.
   */
  domainOutcome?: DomainOutcome;
  /** Provenance of `domainOutcome`. Absent on rows written before OBS-001. */
  domainOutcomeSource?: DomainOutcomeSource;
  /** Bounded operator diagnostic explaining the declared outcome. */
  domainOutcomeReason?: string;
  startedAt: number;
  completedAt?: number;
  duration?: number;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  retryCount: number;
  metadata?: Record<string, unknown>;
}

/**
 * Job metrics for dashboard.
 *
 * OBS-001 keeps the transport and domain tallies in separate fields rather than
 * redefining the existing ones. `successCount`/`failureCount` remain the
 * TRANSPORT counts every current reader already understands; the `domain*`
 * counts are the business truth, and `domainUndeclaredCount` is the honest
 * residual — runs whose transport completed but which stated no outcome. A
 * dashboard that shows only the transport pair is not wrong, it is just
 * answering a narrower question, and the undeclared count makes the gap visible
 * instead of silently folding it into success.
 */
export interface JobMetrics {
  functionId: string;
  totalRuns: number;
  /** Transport completions. NOT a delivery count. */
  successCount: number;
  /** Transport failures. */
  failureCount: number;
  /** Business deliveries (declared `success` or `partial`). */
  domainSuccessCount: number;
  /** Declared or entailed non-delivery (`failed`/`preflight-failed`/`provider-fatal`). */
  domainFailureCount: number;
  /** Terminal runs that stated no business outcome — counted as neither. */
  domainUndeclaredCount: number;
  avgDuration: number;
  lastRunAt: number;
  lastStatus: JobStatus;
  /** Business outcome of the most recent run, when one was declared/entailed. */
  lastDomainOutcome?: DomainOutcome;
}

/**
 * Log levels for structured logging
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured log entry
 */
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  functionId: string;
  executionId: string;
  message: string;
  data?: Record<string, unknown>;
  error?: {
    message: string;
    stack?: string;
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Firestore rejects undefined at any depth. Omit undefined object properties
 * and preserve array indexes with null, while leaving SDK values such as
 * Timestamp and DocumentReference instances untouched.
 */
function sanitizeForFirestore(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Array.from({ length: value.length }, (_, index) => {
      const item = value[index];
      return item === undefined ? null : sanitizeForFirestore(item);
    });
  }

  if (!isPlainRecord(value)) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      sanitized[key] = sanitizeForFirestore(item);
    }
  }
  return sanitized;
}

function firestoreWrite(data: Record<string, unknown>): Record<string, unknown> {
  return sanitizeForFirestore(data) as Record<string, unknown>;
}

/**
 * Create a structured logger for a specific Inngest function
 */
export function createJobLogger(functionId: string, executionId: string) {
  const formatLog = (level: LogLevel, message: string, data?: Record<string, unknown>, error?: Error): LogEntry => ({
    timestamp: new Date().toISOString(),
    level,
    functionId,
    executionId,
    message,
    data,
    error: error
      ? {
          message: error.message,
          stack: error.stack,
        }
      : undefined,
  });

  const output = (entry: LogEntry) => {
    const _prefix = `[Inngest:${entry.functionId}]`;
    const logLine = JSON.stringify(entry);

    switch (entry.level) {
      case 'debug':
        log.debug(logLine, { functionId: entry.functionId, executionId: entry.executionId });
        break;
      case 'info':
        log.info(logLine, { functionId: entry.functionId, executionId: entry.executionId });
        break;
      case 'warn':
        log.warn(logLine, { functionId: entry.functionId, executionId: entry.executionId });
        break;
      case 'error':
        log.error(logLine, undefined, { functionId: entry.functionId, executionId: entry.executionId });
        break;
    }
  };

  return {
    debug: (message: string, data?: Record<string, unknown>) => {
      output(formatLog('debug', message, data));
    },
    info: (message: string, data?: Record<string, unknown>) => {
      output(formatLog('info', message, data));
    },
    warn: (message: string, data?: Record<string, unknown>) => {
      output(formatLog('warn', message, data));
    },
    error: (message: string, error?: Error, data?: Record<string, unknown>) => {
      output(formatLog('error', message, data, error));
    },

    /**
     * Log step start
     */
    stepStart: (stepName: string, data?: Record<string, unknown>) => {
      output(formatLog('info', `Step started: ${stepName}`, data));
    },

    /**
     * Log step completion
     */
    stepComplete: (stepName: string, duration: number, data?: Record<string, unknown>) => {
      output(formatLog('info', `Step completed: ${stepName}`, { ...data, durationMs: duration }));
    },

    /**
     * Log step failure
     */
    stepFailed: (stepName: string, error: Error, data?: Record<string, unknown>) => {
      output(formatLog('error', `Step failed: ${stepName}`, data, error));
    },
  };
}

/**
 * Record a job run start in Firestore
 *
 * @param providedRunId - Optional stable document id. The job-run-tracking
 * middleware passes `inngest-<runId>` so every request of a multi-step run
 * (and its completion/failure updates) addresses the same document.
 * @param correlationId - Optional strict `corr_<UUIDv4>` mutation token. An
 * invalid value is discarded rather than persisted as arbitrary user data.
 */
export async function recordJobStart(
  functionId: string,
  functionName: string,
  input?: Record<string, unknown>,
  providedRunId?: string,
  correlationId?: string
): Promise<string> {
  const runId = providedRunId ?? `${functionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const validatedCorrelationId = parseCorrelationId(correlationId) ?? parseCorrelationId(input?.correlationId);
  let validatedInput = input ? { ...input } : undefined;
  if (validatedInput) {
    delete validatedInput.correlationId;
  }
  if (validatedCorrelationId) {
    (validatedInput ??= {}).correlationId = validatedCorrelationId;
  }

  // ARUN-023: lift the bounded mission id to a queryable top-level field, the
  // same treatment correlationId already gets. A cancelled run can then be
  // correlated to its mission without the cancellation event — which carries
  // only function_id and run_id — having to invent anything.
  const validatedMissionId = parseMissionId(input?.missionId);

  const jobRun: JobRun = {
    id: runId,
    correlationId: validatedCorrelationId ?? undefined,
    missionId: validatedMissionId ?? undefined,
    // LOCAL-013: stamped at START for the same reason missionId is — recovery
    // runs after the executor is already gone and can read nothing but this doc.
    runtimeEpoch: parseRuntimeEpoch(process.env[LOCAL_RUNTIME_EPOCH_ENV]),
    functionId,
    functionName,
    status: 'running',
    startedAt: Date.now(),
    input: validatedInput,
    retryCount: 0,
  };

  try {
    log.info('Recording job start', { runId, functionId });
    // Direct admin-SDK write — background job run record, not a user-facing entity (entity-factory not appropriate).
    await db
      .collection('job-runs')
      .doc(runId)
      .set(
        firestoreWrite({
          ...jobRun,
          startedAt: Timestamp.fromMillis(jobRun.startedAt),
        })
      );
    log.info('Job start recorded successfully', { runId });
  } catch (error) {
    log.error('Failed to record job start', error instanceof Error ? error : undefined, { runId });
  }

  return runId;
}

/**
 * Record a job run completion — a statement about the TRANSPORT only.
 *
 * OBS-001: `declaration` is the function's own statement about its BUSINESS
 * outcome, extracted by the middleware from the returned value. When it is
 * absent the row is stamped `domainOutcomeSource: 'undeclared'` and carries NO
 * `domainOutcome`, so nothing downstream can count a transport completion as a
 * delivered result. The stale-clear on `domainOutcome*` matters for the retry
 * path: a run that first failed (entailed `failed`) and later succeeded must not
 * keep the earlier entailment.
 */
export async function recordJobComplete(
  runId: string,
  output?: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  declaration?: DomainOutcomeDeclaration
): Promise<void> {
  const completedAt = Date.now();
  const domain = resolveJobRunDomainFields({ transport: 'completed', declaration });

  try {
    log.info('Recording job completion', { runId, domainOutcome: domain.domainOutcome ?? 'undeclared' });
    const jobRunRef = db.collection('job-runs').doc(runId);

    await jobRunRef.update(
      firestoreWrite({
        status: 'completed',
        completedAt: Timestamp.fromMillis(completedAt),
        output,
        metadata,
        error: FieldValue.delete(),
        domainOutcomeSource: domain.domainOutcomeSource,
        domainOutcome: domain.domainOutcome ?? FieldValue.delete(),
        domainOutcomeReason: domain.domainOutcomeReason ?? FieldValue.delete(),
      })
    );
    log.info('Job completion recorded successfully', { runId });
  } catch (error) {
    log.error('Failed to record job completion', error instanceof Error ? error : undefined, { runId });
  }
}

/**
 * Record a job run failure — transport-level.
 *
 * OBS-001: an *exhausted* failure (`retryCount === 0` on this writer's
 * contract, i.e. the terminal `failed` write) entails a domain failure, because
 * a run that threw its way out demonstrably did not deliver. A `retrying` write
 * is NOT terminal, so it deliberately records no domain outcome — the run may
 * still succeed, and stamping `failed` here would have to be un-stamped later.
 *
 * An explicit `declaration` still wins: a mission that declared `partial` from a
 * recovered checkpoint and then threw during final persistence really does have
 * usable output.
 */
export async function recordJobFailure(
  runId: string,
  error: Error,
  retryCount: number = 0,
  declaration?: DomainOutcomeDeclaration
): Promise<void> {
  const completedAt = Date.now();
  const retrying = retryCount > 0;
  const domain = retrying ? undefined : resolveJobRunDomainFields({ transport: 'failed', declaration });

  try {
    const jobRunRef = db.collection('job-runs').doc(runId);

    await jobRunRef.update(
      firestoreWrite({
        status: retrying ? 'retrying' : 'failed',
        completedAt: Timestamp.fromMillis(completedAt),
        error: {
          message: error.message,
          stack: error.stack,
          code: (error as Error & { code?: string }).code,
        },
        retryCount,
        ...(domain
          ? {
              domainOutcomeSource: domain.domainOutcomeSource,
              domainOutcome: domain.domainOutcome ?? FieldValue.delete(),
              domainOutcomeReason: domain.domainOutcomeReason ?? FieldValue.delete(),
            }
          : {}),
      })
    );
  } catch (err) {
    log.error('Failed to record job failure', err instanceof Error ? err : undefined, { runId });
  }
}

/**
 * What `recordJobDomainOutcome` concluded — reported, never guessed.
 *
 * `preserved-declaration` is a legitimate, expected outcome: the function's own
 * declaration was kept in preference to a later reconciliation.
 */
export type JobRunDomainOutcomeUpdate = 'recorded' | 'unchanged' | 'preserved-declaration' | 'not-found';

/**
 * OBS-001 / GRAPH-030 — refine an already-recorded run's BUSINESS outcome from
 * the canonical persisted state.
 *
 * The middleware's `finished` hook only ever sees the transport result, so a run
 * that threw is recorded as an entailed `failed`. That is true but coarse: the
 * persisted Mission may prove the throw was a *preflight refusal* (nothing
 * spent, nothing partially written) or that a recovered checkpoint means the run
 * was genuinely `partial`. `onFailure` reads that canonical state and calls this
 * to bring the transport record into exact agreement with it.
 *
 * Precedence — deliberately strict, so no writer can quietly outrank a better
 * informed one:
 *   1. the function's OWN declaration (`source: 'declared'`) wins over any later
 *      reconciliation, because the function observed its own work;
 *   2. a reconciliation wins over a transport entailment, because it read the
 *      canonical store rather than inferring from a thrown error;
 *   3. nothing ever overwrites a record that does not exist.
 *
 * Idempotent: re-running with the same outcome reports `unchanged` and performs
 * no second write, so a retried `onFailure` cannot churn the record.
 */
export async function recordJobDomainOutcome(
  runId: string,
  declaration: DomainOutcomeDeclaration
): Promise<JobRunDomainOutcomeUpdate> {
  const jobRunRef = db.collection('job-runs').doc(runId);

  return db.runTransaction<JobRunDomainOutcomeUpdate>(async (transaction) => {
    const snapshot = await transaction.get(jobRunRef);
    if (!snapshot.exists) return 'not-found';

    const data = snapshot.data() ?? {};
    if (data.domainOutcomeSource === 'declared') return 'preserved-declaration';
    if (data.domainOutcome === declaration.outcome && data.domainOutcomeSource === 'reconciled') {
      return 'unchanged';
    }

    transaction.update(
      jobRunRef,
      firestoreWrite({
        domainOutcome: declaration.outcome,
        // A distinct provenance so an operator can tell a post-hoc
        // reconciliation from the function's own statement.
        domainOutcomeSource: 'reconciled',
        domainOutcomeReason: declaration.reason ?? FieldValue.delete(),
      })
    );
    return 'recorded';
  });
}

/**
 * What `recordJobCancelled` actually did — reported, never guessed.
 *
 * `already-terminal` is a legitimate, expected outcome: it means an
 * authoritative completed/failed result was preserved rather than overwritten
 * by a late cancellation signal.
 */
export type JobCancellationOutcome = 'cancelled' | 'already-cancelled' | 'already-terminal' | 'not-found';

/**
 * ARUN-023 — terminalize a run that Inngest cancelled server-side.
 *
 * `cancelOn` is enforced by the Inngest server, which simply stops dispatching
 * step requests. The SDK is never re-entered, so the middleware's `finished`
 * hook — the only writer of a terminal status — is unreachable, and the
 * document is stranded at `running` forever. `onFailure` does not fire either:
 * a cancelled run is not a failed run.
 *
 * Guarantees:
 * - **Idempotent.** Runs inside a transaction and only ever moves
 *   `running`/`retrying` → `cancelled`. A replay re-reads the already-cancelled
 *   document and reports `already-cancelled` without a second write, so the run
 *   keeps exactly one terminal record.
 * - **Non-destructive.** A run that genuinely completed or failed before the
 *   cancellation signal landed keeps that authoritative result.
 * - **Invents nothing.** Sets only `status` and `completedAt`. Mission
 *   correlation was established at start time; tokens, provider and cost are
 *   not fields of this record and are not fabricated here.
 *
 * Throws on infrastructure failure so the calling Inngest function retries,
 * rather than silently reporting success.
 */
export async function recordJobCancelled(runId: string): Promise<JobCancellationOutcome> {
  const completedAt = Date.now();
  const jobRunRef = db.collection('job-runs').doc(runId);

  const outcome = await db.runTransaction<JobCancellationOutcome>(async (transaction) => {
    const snapshot = await transaction.get(jobRunRef);
    if (!snapshot.exists) return 'not-found';

    const status = snapshot.data()?.status;
    if (status === 'cancelled') return 'already-cancelled';
    if (status === 'completed' || status === 'failed') return 'already-terminal';

    // OBS-001: a server-side cancellation never re-enters the SDK, so the
    // function had no opportunity to declare anything. `cancelled` is the honest
    // domain outcome and its provenance says exactly why no declaration exists.
    const domain = resolveJobRunDomainFields({ transport: 'cancelled' });
    transaction.update(
      jobRunRef,
      firestoreWrite({
        status: 'cancelled',
        completedAt: Timestamp.fromMillis(completedAt),
        domainOutcome: domain.domainOutcome,
        domainOutcomeSource: domain.domainOutcomeSource,
      })
    );
    return 'cancelled';
  });

  log.info('Job cancellation recorded', { runId, outcome });
  return outcome;
}

/**
 * Get recent job runs for a function
 */
export async function getRecentJobRuns(functionId: string, limitCount: number = 10): Promise<JobRun[]> {
  try {
    const snapshot = await db
      .collection('job-runs')
      .where('functionId', '==', functionId)
      .orderBy('startedAt', 'desc')
      .limit(limitCount)
      .get();

    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        ...data,
        id: doc.id,
        startedAt: data.startedAt?.toMillis() || 0,
        completedAt: data.completedAt?.toMillis(),
      } as JobRun;
    });
  } catch (error) {
    log.error('Failed to get recent job runs', error instanceof Error ? error : undefined, { functionId });
    return [];
  }
}

/**
 * OBS-003 — every job run that carries an exact request identity.
 *
 * Deliberately a single-field equality query with in-memory ordering, not a
 * `correlationId + startedAt` composite: one accepted request produces a handful
 * of runs at most, and requiring a new composite index would make the queryable
 * path depend on a deployment step rather than on the field the middleware
 * already writes.
 *
 * The identity is validated before it reaches Firestore, so unrecognised caller
 * text can never become a query term. Callers filter by `functionId` themselves —
 * one request legitimately fans out across several functions.
 */
export async function findJobRunsByCorrelationId(correlationId: string, limitCount = 25): Promise<JobRun[]> {
  const validated = parseCorrelationId(correlationId);
  if (!validated) return [];

  try {
    const snapshot = await db
      .collection('job-runs')
      .where('correlationId', '==', validated)
      .limit(limitCount)
      .get();

    return snapshot.docs
      .map((doc) => {
        const data = doc.data();
        return {
          ...data,
          id: doc.id,
          startedAt: data.startedAt?.toMillis() || 0,
          completedAt: data.completedAt?.toMillis(),
        } as JobRun;
      })
      .sort((left, right) => right.startedAt - left.startedAt);
  } catch (error) {
    log.error('Failed to find job runs by correlation ID', error instanceof Error ? error : undefined, {
      correlationId: validated,
    });
    return [];
  }
}

/**
 * Get job metrics for all functions
 */
export async function getJobMetrics(): Promise<Record<string, JobMetrics>> {
  const metrics: Record<string, JobMetrics> = {};

  try {
    // Get all job runs from last 24 hours
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const snapshot = await db
      .collection('job-runs')
      .where('startedAt', '>=', Timestamp.fromMillis(since))
      .orderBy('startedAt', 'desc')
      .get();

    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      const functionId = data.functionId;
      const startedAt = data.startedAt?.toMillis() || 0;
      const completedAt = data.completedAt?.toMillis();
      const duration = completedAt ? completedAt - startedAt : 0;
      const status = data.status as JobStatus;
      const domainOutcome = isDomainOutcome(data.domainOutcome) ? data.domainOutcome : undefined;

      if (!metrics[functionId]) {
        metrics[functionId] = {
          functionId,
          totalRuns: 0,
          successCount: 0,
          failureCount: 0,
          domainSuccessCount: 0,
          domainFailureCount: 0,
          domainUndeclaredCount: 0,
          avgDuration: 0,
          lastRunAt: 0,
          lastStatus: 'running',
        };
      }

      const m = metrics[functionId];
      m.totalRuns++;

      if (status === 'completed') {
        m.successCount++;
        // Update average duration
        m.avgDuration = (m.avgDuration * (m.successCount - 1) + duration) / m.successCount;
      } else if (status === 'failed') {
        m.failureCount++;
      }

      // OBS-001: the domain tally is driven by the declared outcome, never by
      // the transport status. A terminal run with no outcome is counted as
      // undeclared — the one thing it must not be counted as is a delivery.
      if (domainOutcome !== undefined) {
        if (isUnsuccessfulDomainOutcome(domainOutcome)) m.domainFailureCount++;
        else if (DECIDED_DOMAIN_OUTCOMES.includes(domainOutcome)) m.domainSuccessCount++;
      } else if ((TERMINAL_JOB_STATUSES as readonly string[]).includes(status)) {
        m.domainUndeclaredCount++;
      }

      if (startedAt > m.lastRunAt) {
        m.lastRunAt = startedAt;
        m.lastStatus = status;
        m.lastDomainOutcome = domainOutcome;
      }
    });
  } catch (error) {
    log.error('Failed to get job metrics', error instanceof Error ? error : undefined);
  }

  return metrics;
}

/**
 * Helper to wrap a step function with timing and logging
 */
export function instrumentStep<T>(
  logger: ReturnType<typeof createJobLogger>,
  stepName: string,
  fn: () => Promise<T>
): () => Promise<T> {
  return async () => {
    const startTime = Date.now();
    logger.stepStart(stepName);

    try {
      const result = await fn();
      const duration = Date.now() - startTime;
      logger.stepComplete(stepName, duration);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.stepFailed(stepName, err);
      throw error;
    }
  };
}

/**
 * Create an observable job context for Inngest functions
 */
export function createObservableJob(functionId: string, functionName: string) {
  const executionId = `${functionId}-${Date.now()}`;
  const logger = createJobLogger(functionId, executionId);
  let runId: string | null = null;

  return {
    logger,
    executionId,

    /**
     * Start tracking this job run
     */
    async start(input?: Record<string, unknown>): Promise<void> {
      runId = await recordJobStart(functionId, functionName, input);
      logger.info('Job started', { runId, input });
    },

    /**
     * Mark job as completed
     */
    async complete(output?: Record<string, unknown>, metadata?: Record<string, unknown>): Promise<void> {
      if (runId) {
        await recordJobComplete(runId, output, metadata);
        logger.info('Job completed', { runId, output, metadata });
      }
    },

    /**
     * Mark job as failed
     */
    async fail(error: Error, retryCount: number = 0): Promise<void> {
      if (runId) {
        await recordJobFailure(runId, error, retryCount);
        logger.error('Job failed', error, { runId, retryCount });
      }
    },

    /**
     * Wrap a step with instrumentation
     */
    wrapStep<T>(stepName: string, fn: () => Promise<T>): () => Promise<T> {
      return instrumentStep(logger, stepName, fn);
    },
  };
}

/**
 * Curated subset of Inngest functions for observability dashboards.
 *
 * NOT exhaustive — the full registry lives in `functions/index.ts` (57
 * registered functions; re-derive there rather than extending this list
 * blindly). Schedules shown are the defaults; `impulse-sweep-cycle` honors
 * the `SWEEP_CRON` env override (see impulse-sweep-cycle.ts).
 */
export const INNGEST_FUNCTIONS = [
  { id: 'expand-signal', name: 'Expand Signal', trigger: 'event' },
  { id: 'run-evaluation-agent', name: 'Run Evaluation Agent', trigger: 'event' },
  { id: 'refresh-relation-snapshots', name: 'Refresh Relation Snapshots', schedule: '0 0 * * *' },
  { id: 'cleanup-archived-signals', name: 'Cleanup Archived Signals', schedule: '0 2 * * 0' },
  { id: 'run-agent-mission', name: 'Run Agent Mission', trigger: 'event' },
  { id: 'impulse-sweep-cycle', name: 'Impulse Sweep Cycle', schedule: 'TZ=UTC 0 0,6,12,18 * * *' },
] as const;
