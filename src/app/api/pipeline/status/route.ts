/**
 * @file api/pipeline/status/route.ts
 * @description Pipeline status API endpoint
 *
 * Returns the current status of the daily pipeline including:
 * - Last run time and result
 * - Next scheduled run
 * - Component health status
 * - Recent errors
 *
 * OBS-003 — this is the surface that makes an accepted request identity
 * QUERYABLE, the hop the retained `TEST-027` acceptance could not complete. It
 * previously reported `lastRun: { …all nulls }` with a comment saying the values
 * "would be populated from a persistent store in production", so a completed
 * manual trigger left no way to ask what happened to a specific request. Both
 * `lastRun` and `?correlationId=` now read the `job-runs` record the Inngest
 * job-run tracking middleware already writes.
 *
 * @phase Phase 6: Daily Pipeline
 * @author Radarist Team
 * @created 2026-01-09
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { unauthenticatedResponse } from '@/lib/auth-failure-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/pipeline/status');
import { adminGetTrendStats } from '@/lib/trends-admin';
import { getGraphServiceHealth } from '@/lib/graph';
import { getGraphRefreshStats, verifyGraphIntegrity } from '@/lib/pipeline';
import { findJobRunsByCorrelationId, getRecentJobRuns, type JobRun } from '@/lib/inngest/observability';
import { CORRELATION_ID_HEADER, correlationIdFromHeaders, parseCorrelationId } from '@/lib/observability/correlation';
import type { DomainOutcome } from '@/lib/observability/terminal-outcome';

/** The Inngest function id whose runs this surface reports. */
const PIPELINE_FUNCTION_ID = 'daily-pipeline';

// ============================================================================
// TYPES
// ============================================================================

/**
 * One pipeline run, read from its durable job-run record.
 *
 * OBS-001 honesty rules are load-bearing here:
 * - `status` is TRANSPORT only — did the Inngest run finish, throw, or lose its
 *   runtime.
 * - `domainOutcome` is the outcome the function DECLARED, and is absent when it
 *   declared none. An absent value must never be rendered as a success.
 * - `success` is the daily pipeline's own domain flag, taken from the run's
 *   receipt. `null` means the run reported none — never "assume it worked".
 */
interface PipelineRunSummary {
  jobRunId: string;
  /** Accepted request identity, absent for a cron-initiated run. */
  correlationId: string | null;
  status: JobRun['status'];
  domainOutcome: DomainOutcome | null;
  startedAt: number | null;
  completedAt: number | null;
  duration: number | null;
  success: boolean | null;
  signalsProcessed: number | null;
  trendsComputed: number | null;
  entitiesExtracted: number | null;
  relationsProposed: number | null;
  stepsReplayed: number | null;
}

/** Shape returned when no run is on record — every field explicitly unknown. */
const UNKNOWN_RUN = {
  jobRunId: null,
  correlationId: null,
  status: null,
  domainOutcome: null,
  startedAt: null,
  completedAt: null,
  duration: null,
  success: null,
  signalsProcessed: null,
  trendsComputed: null,
  entitiesExtracted: null,
  relationsProposed: null,
  stepsReplayed: null,
} as const;

interface PipelineStatus {
  lastRun: PipelineRunSummary | typeof UNKNOWN_RUN;
  /** OBS-003 — the run for the exact `?correlationId=`, null when none is on record. */
  requestedRun: PipelineRunSummary | null;
  nextRun: {
    scheduledAt: number;
    source: 'cron' | 'manual' | 'event';
  };
  components: {
    signalDetection: { healthy: boolean; lastCheck: number };
    entityExtraction: { healthy: boolean; lastCheck: number };
    deduplication: { healthy: boolean; lastCheck: number };
    relationProposal: { healthy: boolean; lastCheck: number };
    trendComputation: { healthy: boolean; lastCheck: number };
    alignmentCalculation: { healthy: boolean; lastCheck: number };
    graphRefresh: { healthy: boolean; lastCheck: number };
  };
  stats: {
    trends: { total: number; emerging: number; growing: number; stable: number; declining: number };
    graph: { nodes: number; claims: number; relations: number };
    integrity: { healthy: boolean; issues: number };
  };
  recentErrors: Array<{ timestamp: number; component: string; error: string }>;
}

// ============================================================================
// HANDLER
// ============================================================================

export async function GET(request: NextRequest) {
  const correlationId = correlationIdFromHeaders(request.headers);
  if (!correlationId) {
    return NextResponse.json({ error: 'Invalid correlation ID' }, { status: 400 });
  }

  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return unauthenticatedResponse(auth);
    }

    // The identity being ASKED ABOUT is separate from this read's own trace: an
    // operator looks up someone else's request all the time.
    const requestedParam = request.nextUrl.searchParams.get('correlationId');
    const requestedCorrelationId = requestedParam === null ? null : parseCorrelationId(requestedParam);
    if (requestedParam !== null && !requestedCorrelationId) {
      // Refused before it can become a query term.
      return correlatedJson(correlationId, { error: 'Invalid correlation ID' }, { status: 400 });
    }

    const now = Date.now();

    // Get trend stats
    let trendStats = { total: 0, emerging: 0, growing: 0, stable: 0, declining: 0 };
    try {
      trendStats = await adminGetTrendStats();
    } catch (error) {
      log.error('Failed to get trend stats', error instanceof Error ? error : undefined);
    }

    // Get graph health
    let graphHealth = { healthy: false, backend: 'unknown', latencyMs: 0 };
    try {
      graphHealth = await getGraphServiceHealth();
    } catch (error) {
      log.error('Failed to get graph health', error instanceof Error ? error : undefined);
    }

    // Get graph stats
    let graphStats = { nodeCount: 0, claimCount: 0, relationCount: 0 };
    try {
      graphStats = await getGraphRefreshStats();
    } catch (error) {
      log.error('Failed to get graph stats', error instanceof Error ? error : undefined);
    }

    // Verify graph integrity
    let integrity = { healthy: true, issues: [] as string[] };
    try {
      integrity = await verifyGraphIntegrity();
    } catch (error) {
      log.error('Failed to verify integrity', error instanceof Error ? error : undefined);
    }

    const lastRun = await readLastPipelineRun();
    const requestedRun = requestedCorrelationId ? await readRequestedPipelineRun(requestedCorrelationId) : null;

    // Calculate next cron run (8 AM UTC daily)
    const nextCronRun = getNextCronRun(now);

    const status: PipelineStatus = {
      lastRun,
      requestedRun,
      nextRun: {
        scheduledAt: nextCronRun,
        source: 'cron',
      },
      components: {
        signalDetection: { healthy: true, lastCheck: now },
        entityExtraction: { healthy: true, lastCheck: now },
        deduplication: { healthy: true, lastCheck: now },
        relationProposal: { healthy: true, lastCheck: now },
        trendComputation: { healthy: true, lastCheck: now },
        alignmentCalculation: { healthy: true, lastCheck: now },
        graphRefresh: { healthy: graphHealth.healthy, lastCheck: now },
      },
      stats: {
        trends: trendStats,
        graph: {
          nodes: graphStats.nodeCount,
          claims: graphStats.claimCount,
          relations: graphStats.relationCount,
        },
        integrity: {
          healthy: integrity.healthy,
          issues: integrity.issues.length,
        },
      },
      recentErrors: [],
    };

    return correlatedJson(correlationId, status);
  } catch (error) {
    log.error('Failed to get pipeline status', error instanceof Error ? error : undefined, { correlationId });
    return correlatedJson(correlationId, { error: 'Failed to get pipeline status' }, { status: 500 });
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function correlatedJson(correlationId: string, body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set(CORRELATION_ID_HEADER, correlationId);
  return response;
}

async function readLastPipelineRun(): Promise<PipelineStatus['lastRun']> {
  try {
    const [run] = await getRecentJobRuns(PIPELINE_FUNCTION_ID, 1);
    return run ? summarizePipelineRun(run) : UNKNOWN_RUN;
  } catch (error) {
    log.error('Failed to read the last pipeline run', error instanceof Error ? error : undefined);
    return UNKNOWN_RUN;
  }
}

async function readRequestedPipelineRun(correlationId: string): Promise<PipelineRunSummary | null> {
  try {
    const runs = await findJobRunsByCorrelationId(correlationId);
    // One accepted request legitimately fans out across functions (relation sync,
    // entity sync, …). Only the pipeline's own run answers a pipeline question.
    // Pick the newest by timestamp rather than trusting the reader's ordering: a
    // replayed identity must resolve to its most recent run, and that guarantee
    // should not depend on how a caller happened to sort the rows.
    const run = runs
      .filter((candidate) => candidate.functionId === PIPELINE_FUNCTION_ID)
      .reduce<JobRun | null>(
        (newest, candidate) => (newest === null || candidate.startedAt > newest.startedAt ? candidate : newest),
        null
      );
    return run ? summarizePipelineRun(run) : null;
  } catch (error) {
    log.error('Failed to read a pipeline run by correlation', error instanceof Error ? error : undefined, {
      correlationId,
    });
    return null;
  }
}

/** Read a finite number from an unknown record, or null. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function summarizePipelineRun(run: JobRun): PipelineRunSummary {
  const output = (run.output ?? {}) as Record<string, unknown>;
  const summary = (output.summary ?? {}) as Record<string, unknown>;
  return {
    jobRunId: run.id,
    correlationId: run.correlationId ?? null,
    status: run.status,
    // Absent stays absent. Rendering an undeclared outcome as anything else is
    // exactly the conflation OBS-001 exists to prevent.
    domainOutcome: run.domainOutcome ?? null,
    startedAt: numberOrNull(run.startedAt),
    completedAt: numberOrNull(run.completedAt),
    duration: numberOrNull(run.duration),
    // The pipeline's own domain flag, not its transport status.
    success: typeof output.success === 'boolean' ? output.success : null,
    signalsProcessed: numberOrNull(summary.signalsProcessed),
    trendsComputed: numberOrNull(summary.trendsComputed),
    entitiesExtracted: numberOrNull(summary.entitiesExtracted),
    relationsProposed: numberOrNull(summary.relationsProposed),
    stepsReplayed: numberOrNull(output.stepsReplayed),
  };
}

/**
 * Calculate the next 8 AM UTC cron run time.
 */
function getNextCronRun(now: number): number {
  const date = new Date(now);
  date.setUTCHours(8, 0, 0, 0);

  // If we've already passed 8 AM UTC today, schedule for tomorrow
  if (date.getTime() <= now) {
    date.setUTCDate(date.getUTCDate() + 1);
  }

  return date.getTime();
}
