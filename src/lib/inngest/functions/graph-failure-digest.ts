/**
 * @file inngest/functions/graph-failure-digest.ts
 * @description P3-B failure digest — daily cron that makes background-job
 * failures visible within 24h.
 *
 * Reads the `job-runs` Firestore records written by the job-run-tracking
 * middleware (see `../middleware/job-run-tracking.ts`) for the last 24h and
 * surfaces:
 *   - functions with failed/retrying runs (with sample error messages)
 *   - functions whose runs were 100% skipped (`output.skipped === true` on
 *     every run — the "cron is green but does nothing" failure mode)
 *
 * Output channels: a structured log line (warn when dirty, info when clean)
 * plus the structured return value — which the middleware itself records to
 * `job-runs`, so the digest history is queryable in Firestore and visible in
 * the Inngest dashboard. The user-facing digests module (`@/lib/digests`) is
 * deliberately NOT used: its `Digest` shape is per-user notification-bell
 * content (signals/connections/insights), not operator telemetry.
 *
 * Trigger: daily cron at 06:45 UTC (after the nightly graph crons at
 * 00:00–06:00 so their runs land inside the window) + on-demand event.
 */
import { inngest } from '../client';
import { createLogger } from '@/lib/logger';
import { parseRelationDeleteOutboxRecord, RELATION_SYNC_OUTBOX_COLLECTION } from '@/lib/relation-sync-outbox';

const log = createLogger('inngest/graph-failure-digest');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SAMPLE_ERRORS = 3;
const MAX_SAMPLE_EXHAUSTED_DELETES = 10;

interface FunctionFailureSummary {
  functionId: string;
  totalRuns: number;
  failedRuns: number;
  sampleErrors: string[];
}

interface FunctionSkipSummary {
  functionId: string;
  totalRuns: number;
}

/**
 * GRAPH-059 — one relation whose Neo4j teardown exhausted its replay budget.
 *
 * A `job-runs` scan cannot see this: the replayer succeeds when it gives up, so
 * the terminal state lives only on the marker. Unlike a failing run it also does
 * not expire out of the 24h window — the marker sits there until an operator
 * repairs it — so the census is a point-in-time read of the whole collection.
 */
interface ExhaustedRelationDeleteSummary {
  relationId: string;
  attempt: number;
  exhaustedAt: number | null;
  lastError: string | null;
}

export interface GraphFailureDigest {
  windowHours: number;
  totalRuns: number;
  failures: FunctionFailureSummary[];
  fullySkipped: FunctionSkipSummary[];
  /** Total exhausted relation delete markers outstanding right now. */
  exhaustedRelationDeleteCount: number;
  /** Bounded sample of those markers, newest terminal transition first. */
  exhaustedRelationDeletes: ExhaustedRelationDeleteSummary[];
  /**
   * Functions whose runs were 100% skipped because ambient maintenance is
   * paused (OPS-001). Surfaced for visibility but NOT treated as a problem — a
   * paused window is intentional, so these never make the digest "unclean".
   */
  maintenancePaused: FunctionSkipSummary[];
  clean: boolean;
  generatedAt: number;
}

export const graphFailureDigestJob = inngest.createFunction(
  {
    id: 'graph-failure-digest',
    name: 'Graph Failure Digest (Daily)',
    retries: 1,
    onFailure: async ({ error }) => {
      log.error(
        'graph-failure-digest failed permanently — job failures are currently NOT being surfaced',
        error instanceof Error ? error : new Error(String(error))
      );
    },
  },
  // Daily at 06:45 UTC + on-demand via event.
  [{ event: 'app/schedule.graph-failure-digest.requested' }, { cron: 'TZ=UTC 45 6 * * *' }],
  async ({ step }) => {
    const digest = await step.run('collect-job-run-stats', async (): Promise<GraphFailureDigest> => {
      // Admin SDK only — client SDK in the Inngest runtime throws
      // `code: 'unavailable'` (no persistent connection).
      const { db } = await import('@/lib/firebase-admin');
      const { Timestamp } = await import('firebase-admin/firestore');

      const since = Date.now() - WINDOW_MS;
      const [snap, exhaustedSnap] = await Promise.all([
        db.collection('job-runs').where('startedAt', '>=', Timestamp.fromMillis(since)).get(),
        db.collection(RELATION_SYNC_OUTBOX_COLLECTION).where('status', '==', 'exhausted').get(),
      ]);

      interface Acc {
        totalRuns: number;
        failedRuns: number;
        skippedRuns: number;
        pausedRuns: number;
        sampleErrors: string[];
      }
      const byFunction = new Map<string, Acc>();

      for (const doc of snap.docs) {
        const data = doc.data() as {
          functionId?: string;
          status?: string;
          output?: { skipped?: unknown; reason?: unknown };
          error?: { message?: string };
        };
        const functionId = data.functionId ?? 'unknown';
        let acc = byFunction.get(functionId);
        if (!acc) {
          acc = { totalRuns: 0, failedRuns: 0, skippedRuns: 0, pausedRuns: 0, sampleErrors: [] };
          byFunction.set(functionId, acc);
        }
        acc.totalRuns++;
        if (data.status === 'failed' || data.status === 'retrying') {
          acc.failedRuns++;
          if (data.error?.message && acc.sampleErrors.length < MAX_SAMPLE_ERRORS) {
            acc.sampleErrors.push(data.error.message);
          }
        }
        if (data.output?.skipped === true) {
          acc.skippedRuns++;
          // OPS-001: an intentional maintenance-pause skip is not an anomaly.
          if (data.output?.reason === 'maintenance-paused') {
            acc.pausedRuns++;
          }
        }
      }

      const failures: FunctionFailureSummary[] = [];
      const fullySkipped: FunctionSkipSummary[] = [];
      const maintenancePaused: FunctionSkipSummary[] = [];
      for (const [functionId, acc] of byFunction) {
        if (acc.failedRuns > 0) {
          failures.push({
            functionId,
            totalRuns: acc.totalRuns,
            failedRuns: acc.failedRuns,
            sampleErrors: acc.sampleErrors,
          });
        }
        if (acc.totalRuns > 0 && acc.skippedRuns === acc.totalRuns) {
          // Wholly maintenance-paused = intentional (surface, don't alarm);
          // otherwise a 100%-skip is the anomaly the digest exists to catch.
          if (acc.pausedRuns === acc.totalRuns) {
            maintenancePaused.push({ functionId, totalRuns: acc.totalRuns });
          } else {
            fullySkipped.push({ functionId, totalRuns: acc.totalRuns });
          }
        }
      }
      failures.sort((a, b) => b.failedRuns - a.failedRuns);
      fullySkipped.sort((a, b) => b.totalRuns - a.totalRuns);
      maintenancePaused.sort((a, b) => b.totalRuns - a.totalRuns);

      // A marker the strict reader rejects is still an outstanding terminal
      // marker; counting the raw query and sampling only the parseable ones
      // keeps a malformed document from silently shrinking the census.
      const exhaustedRelationDeletes: ExhaustedRelationDeleteSummary[] = [];
      for (const doc of exhaustedSnap.docs) {
        const record = parseRelationDeleteOutboxRecord(doc.id, doc.data());
        if (!record || record.status !== 'exhausted') continue;
        exhaustedRelationDeletes.push({
          relationId: record.relationId,
          attempt: record.attempt,
          exhaustedAt: record.exhaustedAt,
          lastError: record.lastError,
        });
      }
      exhaustedRelationDeletes.sort((a, b) => (b.exhaustedAt ?? 0) - (a.exhaustedAt ?? 0));

      return {
        windowHours: WINDOW_MS / 3_600_000,
        totalRuns: snap.size,
        failures,
        fullySkipped,
        maintenancePaused,
        exhaustedRelationDeleteCount: exhaustedSnap.size,
        exhaustedRelationDeletes: exhaustedRelationDeletes.slice(0, MAX_SAMPLE_EXHAUSTED_DELETES),
        clean: failures.length === 0 && fullySkipped.length === 0 && exhaustedSnap.size === 0,
        generatedAt: Date.now(),
      };
    });

    // The one structured log line operators grep for.
    if (!digest.clean) {
      log.warn('graph-failure-digest: failures, 100%-skipped functions, or exhausted graph deletes', {
        totalRuns: digest.totalRuns,
        failingFunctions: digest.failures.length,
        fullySkippedFunctions: digest.fullySkipped.length,
        failures: digest.failures,
        fullySkipped: digest.fullySkipped,
        // GRAPH-059: a terminal delete marker does not expire out of the
        // window, so it keeps the digest unclean until an operator repairs it.
        exhaustedRelationDeleteCount: digest.exhaustedRelationDeleteCount,
        exhaustedRelationDeletes: digest.exhaustedRelationDeletes,
        // Intentional maintenance pauses, reported for context but not the cause of the warn.
        maintenancePausedFunctions: digest.maintenancePaused.length,
      });
    } else {
      log.info('graph-failure-digest: clean 24h window', {
        totalRuns: digest.totalRuns,
        maintenancePausedFunctions: digest.maintenancePaused.length,
      });
    }

    return digest;
  }
);
