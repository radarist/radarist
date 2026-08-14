/**
 * @file lib/mission-lineage-audit-admin.ts
 * @description ARUN-030 — read terminal missions and their lineage out of both
 * stores, and REPORT what is genuinely missing.
 *
 * This is the consumer of `classifyMissionLineage`: it gathers the observations
 * (Firestore Missions + AgentRuns, Neo4j Episodes + AgentReflections) and hands
 * them to the pure classifier. The split is deliberate — the classification rules
 * are the part that must be exhaustively unit-testable, and the gathering is the
 * part that needs live stores.
 *
 * **Report-only, by design.** It writes nothing. The row's requirement is that
 * reconciliation "distinguish truly missing lineage from intentionally non-agent
 * work without fabricating success" — and the failure mode being guarded against
 * is precisely a repair pass that "fixes" absent records by writing them, which
 * would manufacture lineage for work that never happened. Correcting a genuine
 * cross-store DIVERGENCE is a different operation with its own downgrade-only
 * safety rules; that lives in `@/lib/graph/mission-lineage-parity`.
 *
 * A Neo4j outage degrades the audit rather than failing it: without graph
 * observations every mission would look incomplete, so the pass reports
 * `graphAvailable: false` and classifies nothing instead of emitting a wall of
 * false gaps.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import {
  classifyMissionLineage,
  summarizeMissionLineage,
  type MissionLineageReport,
  type ObservedMissionLineage,
} from '@/lib/mission-lineage-reconciliation';

const log = createLogger('mission-lineage-audit');

/** Bounded scan ceiling for one audit pass. Truncation is reported, never silent. */
export const MAX_AUDITED_MISSIONS = 200;

export interface MissionLineageAuditResult extends MissionLineageReport {
  graphAvailable: boolean;
  truncated: boolean;
}

/**
 * Audit the most recent terminal missions for lineage completeness.
 *
 * Never throws: this is an observability pass inside a reconciliation cycle that
 * has real repair work to do, and an audit failure must not abort it.
 */
export async function auditMissionLineage(limit = 50): Promise<MissionLineageAuditResult> {
  const bounded = Math.max(1, Math.min(limit, MAX_AUDITED_MISSIONS));
  const empty: MissionLineageAuditResult = {
    inspected: 0,
    complete: 0,
    exempt: 0,
    incomplete: 0,
    divergent: 0,
    actionable: [],
    graphAvailable: false,
    truncated: false,
  };

  let graphLineage: Map<string, { episodeOutcome?: unknown; reflectionSuccess?: boolean }>;
  try {
    graphLineage = await readGraphLineage();
  } catch (error) {
    // Without graph observations every mission would classify as incomplete.
    // Reporting the outage is honest; emitting hundreds of false gaps is not.
    log.warn('Mission lineage audit skipped — graph observations unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return empty;
  }

  try {
    const snapshot = await db
      .collection('missions')
      .orderBy('completedAt', 'desc')
      .limit(bounded + 1)
      .get();
    const truncated = snapshot.docs.length > bounded;
    const missions = snapshot.docs.slice(0, bounded);

    const observations: ObservedMissionLineage[] = [];
    for (const doc of missions) {
      const mission = doc.data() as Record<string, unknown>;
      const agentRuns = await db.collection('agentRuns').where('missionId', '==', doc.id).limit(1).get();
      const graph = graphLineage.get(doc.id);
      observations.push({
        missionId: doc.id,
        kind: typeof mission.kind === 'string' ? mission.kind : undefined,
        agent: typeof mission.agent === 'string' ? mission.agent : undefined,
        status: typeof mission.status === 'string' ? mission.status : undefined,
        partial: mission.partial === true,
        firestoreAgentRun: !agentRuns.empty,
        neo4jEpisode: graph !== undefined,
        neo4jReflection: graph?.reflectionSuccess !== undefined,
        ...(graph?.episodeOutcome !== undefined ? { episodeOutcome: graph.episodeOutcome } : {}),
        ...(graph?.reflectionSuccess !== undefined ? { reflectionSuccess: graph.reflectionSuccess } : {}),
      });
    }

    const report = summarizeMissionLineage(observations.map(classifyMissionLineage));
    if (truncated) log.warn('Mission lineage audit truncated at the scan ceiling', { ceiling: bounded });
    log.info('Mission lineage audited', {
      inspected: report.inspected,
      complete: report.complete,
      exempt: report.exempt,
      incomplete: report.incomplete,
      divergent: report.divergent,
    });
    return { ...report, graphAvailable: true, truncated };
  } catch (error) {
    log.warn('Mission lineage audit failed (non-blocking)', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...empty, graphAvailable: true };
  }
}

/**
 * One bounded read of every mission's graph lineage.
 *
 * Collected per mission in a single query rather than one query per mission: an
 * audit that issued 200 round trips would be slow enough that someone would
 * eventually shorten the window instead of fixing the gaps it found.
 */
async function readGraphLineage(): Promise<Map<string, { episodeOutcome?: unknown; reflectionSuccess?: boolean }>> {
  const { runReadTransaction } = await import('@/lib/graph/neo4j-client');
  const result = await runReadTransaction<{
    missionId: string;
    episodeOutcome: string | null;
    reflectionSuccess: boolean | null;
  }>(
    `MATCH (e:Episode)
     WHERE e.missionId IS NOT NULL AND e.status IN ['completed', 'failed']
     OPTIONAL MATCH (r:AgentReflection {missionId: e.missionId})
     WITH e.missionId AS missionId,
          e.missionOutcome AS episodeOutcome,
          collect(r) AS reflections
     RETURN missionId,
            episodeOutcome,
            CASE WHEN size(reflections) = 0 THEN null ELSE head(reflections).success END AS reflectionSuccess
     LIMIT 1000`
  );

  const lineage = new Map<string, { episodeOutcome?: unknown; reflectionSuccess?: boolean }>();
  for (const row of result.records) {
    lineage.set(row.missionId, {
      ...(row.episodeOutcome !== null ? { episodeOutcome: row.episodeOutcome } : {}),
      ...(row.reflectionSuccess !== null ? { reflectionSuccess: row.reflectionSuccess } : {}),
    });
  }
  return lineage;
}
