/**
 * @file app/api/agents/stats/route.ts
 * @description API route to get statistics for default agents
 *
 * Returns last run times and success rates for built-in agents by
 * querying the job-runs collection in Firestore (admin SDK).
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';
import { TERMINAL_JOB_STATUSES } from '@/lib/event-retention';
import {
  isDecidedDomainOutcome,
  isDomainOutcome,
  isUnsuccessfulDomainOutcome,
  type DomainOutcome,
} from '@/lib/observability/terminal-outcome';

const log = createLogger('api/agents/stats');

/**
 * Mapping of agent IDs to their observability function IDs
 * These are the IDs passed to createObservableJob(), not Inngest function IDs
 */
const AGENT_FUNCTION_MAP: Record<string, string[]> = {
  scout: ['impulse-sweep-cycle'],
  evaluation: ['run-evaluation-agent'],
};

/**
 * Agent stats returned by this endpoint.
 *
 * OBS-001 — `successRate` is a statement about DELIVERED WORK, so it is derived
 * from the declared business outcome (`JobRun.domainOutcome`), not from the
 * transport status. Before this, `status === 'completed'` was the numerator, so
 * the exact TEST-027 Creator run — transport-completed, canonical Mission and
 * AgentRun failed, no Report — counted as a success for the agent that failed
 * it.
 *
 * The transport tallies are still reported, under their own names, because they
 * answer a real and different question ("is the queue healthy?"). What no field
 * does any more is let one answer masquerade as the other.
 */
interface AgentStats {
  agentId: string;
  lastRunAt: number | null;
  /** TRANSPORT status of the most recent run. */
  lastRunStatus: 'completed' | 'failed' | 'running' | 'cancelled' | 'interrupted' | null;
  /** BUSINESS outcome of the most recent run, or null when none was declared. */
  lastDomainOutcome: DomainOutcome | null;
  /** Percentage of DECIDED delivery attempts that delivered. */
  successRate: number;
  totalRuns: number;
  /** Runs that delivered (`success` or `partial`). */
  successCount: number;
  /** Runs that attempted delivery and did not deliver. */
  failureCount: number;
  /** Transport completions — reported separately, never used as the numerator. */
  transportCompletedCount: number;
  /** Transport failures. */
  transportFailedCount: number;
  /**
   * Terminal runs that declared no business outcome. These are excluded from
   * BOTH sides of `successRate`; a non-zero value means the rate is computed
   * over a subset, and the operator can see exactly how large that subset is.
   */
  undeclaredOutcomeCount: number;
}

/**
 * GET /api/agents/stats
 *
 * Returns statistics for all default agents
 *
 * Response:
 * ```json
 * {
 *   "stats": {
 *     "scout": { "lastRunAt": 1234567890, "lastRunStatus": "completed", "successRate": 75 },
 *     "evaluation": { "lastRunAt": 1234567890, "lastRunStatus": "completed", "successRate": 100 },
 *     ...
 *   }
 * }
 * ```
 */
export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const stats: Record<string, AgentStats> = {};

    // Fetch stats for each agent in parallel
    await Promise.all(
      Object.entries(AGENT_FUNCTION_MAP).map(async ([agentId, functionIds]) => {
        try {
          // Get runs for all function IDs associated with this agent
          const allRuns: Array<{
            startedAt: number;
            completedAt?: number;
            status: string;
            domainOutcome?: DomainOutcome;
          }> = [];

          await Promise.all(
            functionIds.map(async (functionId) => {
              try {
                // Query without orderBy to avoid index requirement
                // We'll sort in memory instead
                const snapshot = await db.collection('job-runs').where('functionId', '==', functionId).limit(50).get();
                snapshot.docs.forEach((doc) => {
                  const data = doc.data();
                  allRuns.push({
                    startedAt: data.startedAt?.toMillis?.() || data.startedAt || 0,
                    completedAt: data.completedAt?.toMillis?.() || data.completedAt,
                    status: data.status || 'unknown',
                    // Trust only the closed vocabulary; a legacy row without the
                    // field stays undeclared rather than being back-inferred from
                    // its transport status.
                    ...(isDomainOutcome(data.domainOutcome) ? { domainOutcome: data.domainOutcome } : {}),
                  });
                });
              } catch (error) {
                log.error('Error fetching runs for function', error instanceof Error ? error : undefined, {
                  functionId,
                });
              }
            })
          );

          // Sort by startedAt (most recent first)
          allRuns.sort((a, b) => b.startedAt - a.startedAt);

          // Calculate stats
          const totalRuns = allRuns.length;
          const transportCompletedCount = allRuns.filter((r) => r.status === 'completed').length;
          const transportFailedCount = allRuns.filter((r) => r.status === 'failed').length;

          // OBS-001: delivery is counted from the DECLARED business outcome.
          // ARUN-023's rule still holds and now applies on the right axis: only
          // DECIDED delivery attempts enter the rate, so a `cancelled` (a human
          // decision), a `skipped` (an honest no-op), an in-flight run, and an
          // undeclared run all sit outside both numerator and denominator.
          // `totalRuns` and `undeclaredOutcomeCount` keep the excluded rows
          // visible, so a rate over a small subset cannot look authoritative.
          const decidedOutcomes = allRuns
            .map((r) => r.domainOutcome)
            .filter((o): o is DomainOutcome => o !== undefined && isDecidedDomainOutcome(o));
          const successCount = decidedOutcomes.filter((o) => !isUnsuccessfulDomainOutcome(o)).length;
          const failureCount = decidedOutcomes.filter((o) => isUnsuccessfulDomainOutcome(o)).length;
          const undeclaredOutcomeCount = allRuns.filter(
            (r) => r.domainOutcome === undefined && TERMINAL_JOB_STATUSES.includes(r.status as never)
          ).length;
          const decidedRuns = successCount + failureCount;
          const successRate = decidedRuns > 0 ? Math.round((successCount / decidedRuns) * 100) : 0;

          // Get most recent run
          const mostRecent = allRuns[0];

          stats[agentId] = {
            agentId,
            lastRunAt: mostRecent?.startedAt || null,
            lastRunStatus: (mostRecent?.status as AgentStats['lastRunStatus']) || null,
            lastDomainOutcome: mostRecent?.domainOutcome ?? null,
            successRate,
            totalRuns,
            successCount,
            failureCount,
            transportCompletedCount,
            transportFailedCount,
            undeclaredOutcomeCount,
          };
        } catch (error) {
          log.error('Error fetching stats for agent', error instanceof Error ? error : undefined, { agentId });
          // Return default stats on error
          stats[agentId] = {
            agentId,
            lastRunAt: null,
            lastRunStatus: null,
            lastDomainOutcome: null,
            successRate: 0,
            totalRuns: 0,
            successCount: 0,
            failureCount: 0,
            transportCompletedCount: 0,
            transportFailedCount: 0,
            undeclaredOutcomeCount: 0,
          };
        }
      })
    );

    return NextResponse.json({ stats });
  } catch (error) {
    log.error('Error fetching agent stats', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to fetch agent stats', stats: {} }, { status: 500 });
  }
}
