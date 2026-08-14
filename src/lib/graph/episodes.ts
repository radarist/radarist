/**
 * @file Episode service for Neo4j temporal graph memory.
 *
 * Episodes group proactive AgentObservation and mission Observation nodes into
 * temporal research sessions. Each Episode represents "one mission by one agent".
 *
 * @phase Phase 2: Episode Graph
 */

import { createHash } from 'node:crypto';
import neo4j from 'neo4j-driver';
import { runWriteTransaction, runReadTransaction } from './neo4j-client';
import { limitSchema } from './validation';
import { episodeMemoryLane } from './memory-liveness';
import type { DomainOutcome } from '@/lib/observability/terminal-outcome';

const EPISODE_ID_NAMESPACE = 'radarist.episode.v1';
const MISSION_RESULT_FINALIZATION_VERSION = 'mission-result-v1';

export interface CreateEpisodeParams {
  agentName: string;
  missionId: string;
  userId: string;
  summary: string;
}

interface EpisodeIdentityRecord {
  existingCount: number;
  id: string | null;
  agentName: string | null;
  missionId: string | null;
  userId: string | null;
  memoryLane?: string | null;
  correlationId?: string | null;
}

export class EpisodeIdentityConflictError extends Error {
  constructor(missionId: string, reason: string) {
    super(`Episode identity conflict for mission ${missionId}: ${reason}`);
    this.name = 'EpisodeIdentityConflictError';
  }
}

export class EpisodeTerminalStateConflictError extends Error {
  constructor(episodeId: string, expectedStatus: 'completed' | 'failed') {
    super(`Episode ${episodeId} is missing or conflicts with terminal status ${expectedStatus}`);
    this.name = 'EpisodeTerminalStateConflictError';
  }
}

/** Derive one durable Episode identity for one mission/sweep lifecycle. */
export function createEpisodeId(missionId: string): string {
  if (missionId.trim().length === 0) {
    throw new Error('Episode missionId must not be empty');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([EPISODE_ID_NAMESPACE, missionId]))
    .digest('hex');
  return `ep-mission-v1-${digest}`;
}

async function readUniqueEpisodeIdentity(missionId: string): Promise<EpisodeIdentityRecord | null> {
  const result = await runReadTransaction<EpisodeIdentityRecord>(
    `MATCH (e:Episode {missionId: $missionId})
     WITH collect(e) AS episodes
     RETURN size(episodes) AS existingCount,
            CASE WHEN size(episodes) = 1 THEN head(episodes).id ELSE null END AS id,
            CASE WHEN size(episodes) = 1 THEN head(episodes).agentName ELSE null END AS agentName,
            CASE WHEN size(episodes) = 1 THEN head(episodes).missionId ELSE null END AS missionId,
            CASE WHEN size(episodes) = 1 THEN head(episodes).userId ELSE null END AS userId,
            CASE WHEN size(episodes) = 1 THEN head(episodes).memoryLane ELSE null END AS memoryLane,
            CASE WHEN size(episodes) = 1 THEN head(episodes).correlationId ELSE null END AS correlationId`,
    { missionId }
  );
  const record = result.records[0];
  if (!record || record.existingCount === 0) return null;
  if (record.existingCount !== 1 || !record.id) {
    throw new EpisodeIdentityConflictError(missionId, `${record.existingCount} Episode nodes already exist`);
  }
  return record;
}

function validateEpisodeIdentity(record: EpisodeIdentityRecord, params: CreateEpisodeParams): string {
  if (record.existingCount > 1 || !record.id) {
    throw new EpisodeIdentityConflictError(params.missionId, `${record.existingCount} Episode nodes already exist`);
  }
  if (
    record.missionId !== params.missionId ||
    record.userId !== params.userId ||
    record.agentName !== params.agentName
  ) {
    throw new EpisodeIdentityConflictError(params.missionId, 'stored mission, user, or agent does not match');
  }
  const expectedMemoryLane = episodeMemoryLane(params.agentName);
  if (
    (record.memoryLane != null && record.memoryLane !== expectedMemoryLane) ||
    (record.correlationId != null && record.correlationId !== params.missionId)
  ) {
    throw new EpisodeIdentityConflictError(params.missionId, 'stored memory provenance does not match');
  }
  return record.id;
}

async function convergeEpisodeEdges(id: string, params: CreateEpisodeParams): Promise<void> {
  try {
    const { ensureEdgesForNode } = await import('@/lib/graph/ensure-edges');
    await ensureEdgesForNode(id, 'Episode', { userId: params.userId, missionId: params.missionId });
  } catch {
    /* best-effort */
  }
}

/**
 * Create or recover the unique Episode for a mission lifecycle.
 *
 * A sole pre-upgrade random-id Episode is adopted. New lifecycles use a
 * deterministic id protected by the existing `episode_id` uniqueness
 * constraint, so concurrent calls and ambiguous acknowledgements converge.
 */
export async function createEpisode(params: CreateEpisodeParams): Promise<{ id: string }> {
  const deterministicId = createEpisodeId(params.missionId);
  const memoryLane = episodeMemoryLane(params.agentName);
  let id: string;

  try {
    const result = await runWriteTransaction<EpisodeIdentityRecord>(
      `OPTIONAL MATCH (existing:Episode {missionId: $missionId})
       WITH collect(existing) AS existingEpisodes
       CALL {
         WITH existingEpisodes
         WITH existingEpisodes WHERE size(existingEpisodes) = 0
         MERGE (e:Episode {id: $id})
         ON CREATE SET e.agentName = $agentName,
                       e.missionId = $missionId,
                       e.userId = $userId,
                       e.summary = $summary,
                       e.startedAt = datetime(),
                       e.observationCount = 0,
                       e.status = 'active',
                       e.memoryLane = $memoryLane,
                       e.correlationId = $missionId
         RETURN e
         UNION
         WITH existingEpisodes
         WITH existingEpisodes WHERE size(existingEpisodes) = 1
         RETURN head(existingEpisodes) AS e
         UNION
         WITH existingEpisodes
         WITH existingEpisodes WHERE size(existingEpisodes) > 1
         RETURN null AS e
       }
       FOREACH (_ IN CASE
         WHEN e IS NOT NULL
           AND e.agentName = $agentName
           AND e.missionId = $missionId
           AND e.userId = $userId
           AND (e.memoryLane IS NULL OR e.memoryLane = $memoryLane)
           AND (e.correlationId IS NULL OR e.correlationId = $missionId)
         THEN [1] ELSE [] END |
         SET e.memoryLane = $memoryLane, e.correlationId = $missionId
       )
       RETURN size(existingEpisodes) AS existingCount,
              e.id AS id, e.agentName AS agentName, e.missionId AS missionId,
              e.userId AS userId, e.memoryLane AS memoryLane,
              e.correlationId AS correlationId`,
      { id: deterministicId, memoryLane, ...params }
    );
    const record = result.records[0];
    if (!record) {
      throw new EpisodeIdentityConflictError(params.missionId, 'write returned no identity record');
    }
    id = validateEpisodeIdentity(record, params);
  } catch (writeError) {
    if (writeError instanceof EpisodeIdentityConflictError) throw writeError;

    // A database commit can succeed even when its acknowledgement is lost.
    // Recover only one exact identity; all ambiguous/mismatched states fail.
    let recovered: EpisodeIdentityRecord | null;
    try {
      recovered = await readUniqueEpisodeIdentity(params.missionId);
      if (!recovered) throw writeError;
      id = validateEpisodeIdentity(recovered, params);
    } catch (recoveryError) {
      if (recoveryError instanceof EpisodeIdentityConflictError) throw recoveryError;
      throw writeError;
    }
  }

  await convergeEpisodeEdges(id, params);
  return { id };
}

/**
 * Get an Episode by ID.
 *
 * Returns the flattened Episode node properties (with `_labels` from Neo4j).
 * Neo4j datetime fields (startedAt, endedAt) are converted to JS Date objects
 * by the neo4j-client driver.
 */
export async function getEpisode(episodeId: string): Promise<Record<string, unknown> | null> {
  const result = await runReadTransaction<{ e: Record<string, unknown> }>(
    `MATCH (e:Episode {id: $episodeId}) RETURN e`,
    { episodeId }
  );
  if (result.records.length === 0) return null;
  // Unwrap the `e` key from the Neo4j record
  return result.records[0].e ?? result.records[0];
}

/**
 * Resolve the Episode id for a mission. Missions create their Episode with an
 * internal `ep-` id, so callers that only know the missionId (e.g. the
 * record-observation Inngest handler) resolve through this lookup — backed by
 * the `episode_mission` index on `(:Episode).missionId`.
 *
 * Ambiguous legacy duplicates fail closed instead of choosing an arbitrary
 * "newest" Episode and splitting mission lineage.
 */
export async function getEpisodeIdByMissionId(missionId: string): Promise<string | null> {
  const episode = await readUniqueEpisodeIdentity(missionId);
  return episode?.id ?? null;
}

/**
 * Link an observation to an Episode via CONTAINS edge.
 *
 * Matches BOTH observation labels: `:AgentObservation` (sweep insight
 * observations, `proactive-insights.ts`) and `:Observation` (mission source
 * observations, `observations.ts`) — H13: the original AgentObservation-only
 * MATCH silently no-opped for every mission observation.
 *
 * `observationCount` increments ON CREATE only, so retried calls (Inngest
 * re-runs) never double-count.
 */
export async function addObservationToEpisode(episodeId: string, observationId: string): Promise<void> {
  await runWriteTransaction(
    `MATCH (e:Episode {id: $episodeId})
     SET e.__radaristObservationLinkLock = randomUUID()
     REMOVE e.__radaristObservationLinkLock
     WITH e
     MATCH (o) WHERE o.id = $observationId AND (o:AgentObservation OR o:Observation)
     MERGE (e)-[c:CONTAINS]->(o)
     ON CREATE SET e.observationCount = coalesce(e.observationCount, 0) + 1`,
    { episodeId, observationId }
  );
}

/**
 * An Episode plus the observations it CONTAINS. `episode` and each entry of
 * `observations` are flattened node properties (with `_labels`).
 */
export interface EpisodeWithObservations {
  episode: Record<string, unknown>;
  observations: Array<Record<string, unknown>>;
}

/**
 * Get an Episode together with its CONTAINS-linked observations.
 *
 * Used by the MCP `getMissionResults` tool so "what did this mission
 * discover?" returns the actual observation records instead of an empty
 * Episode shell.
 */
export async function getEpisodeWithObservations(episodeId: string): Promise<EpisodeWithObservations | null> {
  const result = await runReadTransaction<{
    episode: Record<string, unknown>;
    observations: Array<Record<string, unknown>>;
  }>(
    `MATCH (e:Episode {id: $episodeId})
     OPTIONAL MATCH (e)-[:CONTAINS]->(o)
     RETURN e AS episode, collect(o) AS observations`,
    { episodeId }
  );
  if (result.records.length === 0) return null;
  const record = result.records[0];
  return {
    episode: record.episode,
    observations: record.observations ?? [],
  };
}

/**
 * Mark an Episode as completed with optional updated summary.
 */
export async function completeEpisode(episodeId: string, summary?: string): Promise<void> {
  const result = await runWriteTransaction<{ status: string }>(
    `MATCH (e:Episode {id: $episodeId})
     SET e.__radaristEpisodeTerminalLock = randomUUID()
     REMOVE e.__radaristEpisodeTerminalLock
     WITH e
     WHERE e.status = 'active'
        OR (e.status = 'completed' AND ($hasSummary = false OR e.summary = $summary))
     FOREACH (_ IN CASE WHEN e.status = 'active' THEN [1] ELSE [] END |
       SET e.status = 'completed',
           e.endedAt = datetime(),
           e.summary = CASE WHEN $hasSummary THEN $summary ELSE e.summary END
     )
     RETURN e.status AS status`,
    { episodeId, hasSummary: summary !== undefined, summary: summary ?? null }
  );
  if (result.records[0]?.status !== 'completed') {
    throw new EpisodeTerminalStateConflictError(episodeId, 'completed');
  }
}

/**
 * Mark an Episode as failed.
 */
export async function failEpisode(episodeId: string): Promise<void> {
  const result = await runWriteTransaction<{ status: string }>(
    `MATCH (e:Episode {id: $episodeId})
     SET e.__radaristEpisodeTerminalLock = randomUUID()
     REMOVE e.__radaristEpisodeTerminalLock
     WITH e
     WHERE e.status IN ['active', 'failed']
     FOREACH (_ IN CASE WHEN e.status = 'active' THEN [1] ELSE [] END |
       SET e.status = 'failed', e.endedAt = datetime()
     )
     RETURN e.status AS status`,
    { episodeId }
  );
  if (result.records[0]?.status !== 'failed') {
    throw new EpisodeTerminalStateConflictError(episodeId, 'failed');
  }
}

/**
 * Finalize a mission Episode from the canonical mission result.
 *
 * `complete-episode` historically ran before mission quality and revision
 * selection. An in-flight execution can therefore arrive here with an
 * already-terminal, unmarked Episode containing the preliminary summary. The
 * version marker permits exactly one correction of that legacy state when its
 * identity, terminal status, and preliminary summary all match the expected
 * historical write. Once marked, only an identical status and summary replay
 * is accepted and `endedAt` is never rewritten.
 */
export interface FinalizeMissionEpisodeParams {
  episodeId: string;
  missionId: string;
  userId: string;
  agentName: string;
  status: 'completed' | 'failed';
  summary: string;
  /** Exact summary the historical pre-quality terminal step would have stored. */
  legacySummary: string;
  /**
   * GRAPH-030 — the canonical business outcome, stamped alongside the coarser
   * Episode `status`. The Episode vocabulary cannot distinguish a clean delivery
   * from a checkpoint-recovered partial (both are `completed`), which is exactly
   * the distinction cross-store parity has to assert. Optional so legacy callers
   * keep working; when absent the finer value is simply not recorded, never
   * guessed from `status`.
   */
  missionOutcome?: DomainOutcome;
}

export async function finalizeMissionEpisode(params: FinalizeMissionEpisodeParams): Promise<void> {
  const { episodeId, missionId, userId, agentName, status, summary, legacySummary } = params;
  const missionOutcome = params.missionOutcome ?? null;
  const result = await runWriteTransaction<{
    status: string;
    summary: string;
    finalizationVersion: string;
    endedAt: string;
  }>(
    `MATCH (e:Episode {
       id: $episodeId,
       missionId: $missionId,
       userId: $userId,
       agentName: $agentName
     })
     SET e.__radaristEpisodeTerminalLock = randomUUID()
     REMOVE e.__radaristEpisodeTerminalLock
     WITH e
     WHERE e.status = 'active'
        OR (e.status = $status
            AND e.missionResultFinalizationVersion IS NULL
            AND e.summary = $legacySummary)
        OR (e.status = $status
            AND e.missionResultFinalizationVersion = $finalizationVersion
            AND e.summary = $summary
            AND e.endedAt IS NOT NULL)
     FOREACH (_ IN CASE
       WHEN e.status = 'active' OR e.missionResultFinalizationVersion IS NULL THEN [1]
       ELSE []
     END |
       SET e.status = $status,
           e.summary = $summary,
           e.endedAt = datetime(),
           e.missionResultFinalizationVersion = $finalizationVersion
     )
     FOREACH (_ IN CASE WHEN $missionOutcome IS NULL THEN [] ELSE [1] END |
       // GRAPH-030: stamped unconditionally (not only on the transition) so a
       // replay of an already-finalized Episode still converges on the canonical
       // outcome instead of leaving the finer value absent forever.
       SET e.missionOutcome = $missionOutcome
     )
     RETURN e.status AS status,
            e.summary AS summary,
            e.missionResultFinalizationVersion AS finalizationVersion,
            toString(e.endedAt) AS endedAt`,
    {
      episodeId,
      missionId,
      userId,
      agentName,
      status,
      summary,
      legacySummary,
      missionOutcome,
      finalizationVersion: MISSION_RESULT_FINALIZATION_VERSION,
    }
  );
  const terminal = result.records[0];
  if (
    terminal?.status !== status ||
    terminal.summary !== summary ||
    terminal.finalizationVersion !== MISSION_RESULT_FINALIZATION_VERSION ||
    typeof terminal.endedAt !== 'string' ||
    terminal.endedAt.length === 0
  ) {
    throw new EpisodeTerminalStateConflictError(episodeId, status);
  }
}

/**
 * Close Episodes that never completed. Any Episode with endedAt IS NULL and
 * startedAt older than minAgeHours is marked status='abandoned', endedAt=now().
 *
 * Happens when a mission crashes, the Inngest step dies mid-flight, or the
 * agent gets stuck. Without cleanup these accumulate in the graph health
 * check as "zombie episodes".
 *
 * @param minAgeHours — only abandon Episodes older than this (default 6h)
 * @returns number of Episodes abandoned
 */
export async function abandonStaleEpisodes(minAgeHours = 6): Promise<number> {
  const result = await runWriteTransaction<{ n: number }>(
    `MATCH (e:Episode)
     WHERE e.startedAt < datetime() - duration({hours: $minAgeHours})
       AND e.endedAt IS NULL
       AND e.status = 'active'
     SET e.__radaristEpisodeTerminalLock = randomUUID()
     REMOVE e.__radaristEpisodeTerminalLock
     WITH e
     WHERE e.startedAt < datetime() - duration({hours: $minAgeHours})
       AND e.endedAt IS NULL
       AND e.status = 'active'
     SET e.status = 'abandoned', e.endedAt = datetime()
     RETURN count(e) AS n`,
    { minAgeHours }
  );
  return result.records[0]?.n ?? 0;
}

// ============================================================================
// Task 3.9: Query Functions for Memory Unification
// ============================================================================

/**
 * System principals that own automated episodes (sweeps run as
 * 'system-sweep', discovery cycles as 'system-discovery'). Readers on
 * agent/MCP surfaces include these so "what happened in the last sweep?"
 * is answerable; user-personal surfaces stay strictly caller-scoped.
 *
 * Re-exported from the canonical module (ARUN-005) — a second hand-rolled
 * list here had already drifted (it was missing 'system').
 */
export { SYSTEM_PRINCIPALS } from '@/lib/system-principals';
import { SYSTEM_PRINCIPALS } from '@/lib/system-principals';

export interface EpisodeFilter {
  userId?: string;
  agentName?: string;
  since?: Date;
  limit?: number;
  /**
   * When true AND `userId` is set, episodes owned by {@link SYSTEM_PRINCIPALS}
   * are returned alongside the caller's own (M14). Defaults to false — the
   * safe, strictly user-scoped behavior for user-personal surfaces.
   */
  includeSystem?: boolean;
}

export interface EpisodeSummary {
  id: string;
  agentName: string;
  missionId: string;
  userId: string;
  summary: string;
  status: string;
  observationCount: number;
  startedAt: string;
  endedAt?: string;
}

/**
 * Query episodes with optional filters.
 * Used by chat to answer "what did Scout find yesterday?" etc.
 */
export async function queryEpisodes(filter: EpisodeFilter): Promise<EpisodeSummary[]> {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filter.userId) {
    if (filter.includeSystem) {
      // Agent/MCP surfaces: sweep/discovery episodes are stamped with system
      // principals, not the caller's userId — include them (M14).
      conditions.push('e.userId IN $userIds');
      params.userIds = [filter.userId, ...SYSTEM_PRINCIPALS];
    } else {
      conditions.push('e.userId = $userId');
      params.userId = filter.userId;
    }
  }
  if (filter.agentName) {
    conditions.push('e.agentName = $agentName');
    params.agentName = filter.agentName;
  }
  if (filter.since) {
    conditions.push('e.startedAt >= datetime($since)');
    params.since = filter.since.toISOString();
  }

  // safe: closed-set — `conditions[]` is built only from the typed
  // EpisodeFilter fields above (userId / agentName / since), each pushing
  // a literal Cypher fragment with $-bound params. No caller-controlled
  // string ever reaches whereClause.
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  // Coerce + clamp limit (rejects "10; DROP" / oversize / NaN) and parameterize.
  params.limit = neo4j.int(limitSchema.parse(filter.limit ?? 20));

  const result = await runReadTransaction<EpisodeSummary>(
    `MATCH (e:Episode) ${whereClause}
     RETURN e.id AS id, e.agentName AS agentName, e.missionId AS missionId,
            e.userId AS userId, e.summary AS summary, e.status AS status,
            e.observationCount AS observationCount,
            toString(e.startedAt) AS startedAt, toString(e.endedAt) AS endedAt
     ORDER BY e.startedAt DESC
     LIMIT $limit`,
    params
  );

  return result.records;
}
