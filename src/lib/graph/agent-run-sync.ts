/** Replay-safe Neo4j projection of Firestore AgentRun records. */

import { randomUUID } from 'node:crypto';
import { runWriteTransaction } from './neo4j-client';
import { createLogger } from '@/lib/logger';
import {
  AgentRunCorrelationConflictError,
  resolveAgentRunCorrelation,
  type AgentRunCorrelationKind,
} from './agent-run-correlation';
import {
  MISSION_MEMORY_LANE,
  PROACTIVE_SWEEP_MEMORY_LANE,
} from './memory-liveness';

const log = createLogger('graph/agent-run-sync');

export interface AgentRunSyncParams {
  id: string;
  agentName: string;
  action: string;
  status: string;
  userId: string;
  createdAt: string;
  /** AI-029: absent when the run's model had no rate-card entry. */
  costUsd?: number;
  /** Receipt-derived costs are estimates; absent historical numeric costs are settled. */
  costState?: 'estimated' | 'settled';
  duration: number;
  missionId?: string;
  sweepId?: string;
}

export interface ExpectedAgentRunProjection {
  id: string;
  agentName: string;
  action: string;
  status: string;
  userId: string;
  createdAt: string;
  /** AI-029: null when the run's model had no rate-card entry — the graph
   * projection records unknown cost as null, never as 0. */
  costUsd: number | null;
  /** Null when cost is unavailable; legacy numeric Firestore cost resolves settled. */
  costState: 'estimated' | 'settled' | null;
  duration: number;
  correlationId: string | null;
  correlationKind: AgentRunCorrelationKind | 'standalone';
  missionId: string | null;
  sweepId: string | null;
  memoryLane: typeof MISSION_MEMORY_LANE | typeof PROACTIVE_SWEEP_MEMORY_LANE | 'standalone-run';
}

/** Untrusted Neo4j values returned by the bounded reconciliation read. */
export interface AgentRunProjectionNode {
  id?: unknown;
  agentName?: unknown;
  action?: unknown;
  status?: unknown;
  userId?: unknown;
  createdAt?: unknown;
  costUsd?: unknown;
  costState?: unknown;
  duration?: unknown;
  correlationId?: unknown;
  correlationKind?: unknown;
  missionId?: unknown;
  sweepId?: unknown;
  memoryLane?: unknown;
}

/** Minimal Episode identity needed to prove one lifecycle owner. */
export interface AgentRunEpisodeIdentity {
  id?: unknown;
  missionId?: unknown;
  userId?: unknown;
  agentName?: unknown;
  memoryLane?: unknown;
  correlationId?: unknown;
  /** Present for unfiltered EXECUTED_DURING targets returned by strict graph reads. */
  labels?: unknown;
}

export interface AgentRunGraphState {
  run: AgentRunProjectionNode | null;
  owners: AgentRunEpisodeIdentity[];
  candidates: AgentRunEpisodeIdentity[];
}

export type AgentRunProjectionStatus = 'created' | 'healed' | 'unchanged' | 'conflict';

export type AgentRunProjectionReason =
  | 'missing-node'
  | 'missing-edge'
  | 'pre-contract'
  | 'exact'
  | 'dual-ownership'
  | 'missing-episode'
  | 'ambiguous-episode'
  | 'payload-conflict'
  | 'owner-conflict'
  | 'topology-conflict';

export interface AgentRunProjectionResult {
  status: AgentRunProjectionStatus;
  reason: AgentRunProjectionReason;
}

interface AgentRunProjectionAcknowledgement extends AgentRunGraphState {
  wasCreated: boolean;
}

const PAYLOAD_FIELDS = [
  'id',
  'agentName',
  'action',
  'status',
  'userId',
  'createdAt',
  'duration',
] as const satisfies ReadonlyArray<keyof ExpectedAgentRunProjection>;

const OWNERSHIP_FIELDS = [
  'correlationId',
  'correlationKind',
  'missionId',
  'sweepId',
  'memoryLane',
] as const satisfies ReadonlyArray<keyof ExpectedAgentRunProjection>;

export function buildExpectedAgentRunProjection(params: AgentRunSyncParams): ExpectedAgentRunProjection {
  const correlation = resolveAgentRunCorrelation(params);
  const memoryLane =
    correlation?.kind === 'mission'
      ? MISSION_MEMORY_LANE
      : correlation?.kind === 'sweep'
        ? PROACTIVE_SWEEP_MEMORY_LANE
        : 'standalone-run';

  return {
    id: params.id,
    agentName: params.agentName,
    action: params.action,
    status: params.status,
    userId: params.userId,
    createdAt: params.createdAt,
    costUsd: params.costUsd ?? null,
    costState: params.costUsd === undefined ? null : (params.costState ?? 'settled'),
    duration: params.duration,
    correlationId: correlation?.id ?? null,
    correlationKind: correlation?.kind ?? 'standalone',
    missionId: correlation?.kind === 'mission' ? correlation.id : null,
    sweepId: correlation?.kind === 'sweep' ? correlation.id : null,
    memoryLane,
  };
}

function isMissing(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function episodeMatchesExpected(
  episode: AgentRunEpisodeIdentity,
  expected: ExpectedAgentRunProjection
): boolean {
  return (
    typeof episode.id === 'string' &&
    episode.id.trim().length > 0 &&
    episode.missionId === expected.correlationId &&
    episode.userId === expected.userId &&
    episode.agentName === expected.agentName &&
    (isMissing(episode.memoryLane) || episode.memoryLane === expected.memoryLane) &&
    (isMissing(episode.correlationId) || episode.correlationId === expected.correlationId)
  );
}

function hasCompatibleEpisodeLabel(target: AgentRunEpisodeIdentity): boolean {
  // Legacy read-only callers prefilter owners with `:Episode`. The strict
  // readers supply labels so unfiltered relationship targets fail closed.
  return target.labels === undefined ||
    (Array.isArray(target.labels) && target.labels.includes('Episode'));
}

/** Classify a read-only graph snapshot using the same immutable projection contract as the writer. */
export function classifyAgentRunProjection(
  expected: ExpectedAgentRunProjection,
  state: AgentRunGraphState
): AgentRunProjectionResult {
  let expectedOwner: AgentRunEpisodeIdentity | null = null;

  if (expected.correlationId !== null) {
    if (state.candidates.length === 0) {
      return { status: 'conflict', reason: 'missing-episode' };
    }
    if (state.candidates.length !== 1) {
      return { status: 'conflict', reason: 'ambiguous-episode' };
    }
    expectedOwner = state.candidates[0];
    if (!episodeMatchesExpected(expectedOwner, expected)) {
      return { status: 'conflict', reason: 'owner-conflict' };
    }
  }

  if (state.run === null) {
    return { status: 'created', reason: 'missing-node' };
  }

  const actualCostUsd = state.run.costUsd;
  const costUsdMatches = isMissing(expected.costUsd)
    ? isMissing(actualCostUsd)
    : actualCostUsd === expected.costUsd;
  if (
    PAYLOAD_FIELDS.some((field) => state.run?.[field] !== expected[field]) ||
    !costUsdMatches
  ) {
    return { status: 'conflict', reason: 'payload-conflict' };
  }

  // costState was introduced after the projection. A missing value is
  // compatible and healable; an explicit contradictory value is immutable
  // payload conflict. Null expected state is represented by an absent Neo4j
  // property, so a non-null actual is always contradictory.
  const actualCostState = state.run.costState;
  if (!isMissing(actualCostState) && actualCostState !== expected.costState) {
    return { status: 'conflict', reason: 'payload-conflict' };
  }

  if (
    OWNERSHIP_FIELDS.some((field) => {
      const actual = state.run?.[field];
      return !isMissing(actual) && actual !== expected[field];
    })
  ) {
    return { status: 'conflict', reason: 'owner-conflict' };
  }

  if (expectedOwner === null) {
    if (state.owners.length !== 0) {
      return { status: 'conflict', reason: 'topology-conflict' };
    }
  } else if (
    state.owners.length > 1 ||
    (state.owners.length === 1 &&
      (!hasCompatibleEpisodeLabel(state.owners[0]) ||
        state.owners[0].id !== expectedOwner.id ||
        !episodeMatchesExpected(state.owners[0], expected)))
  ) {
    return { status: 'conflict', reason: 'topology-conflict' };
  }

  const ownershipComplete = OWNERSHIP_FIELDS.every((field) => {
    const actual = state.run?.[field];
    const wanted = expected[field];
    return isMissing(wanted) ? isMissing(actual) : actual === wanted;
  });
  const costStateComplete = isMissing(expected.costState)
    ? isMissing(actualCostState)
    : actualCostState === expected.costState;
  if (!ownershipComplete || !costStateComplete) {
    return { status: 'healed', reason: 'pre-contract' };
  }

  if (expectedOwner !== null && state.owners.length === 0) {
    return { status: 'healed', reason: 'missing-edge' };
  }

  return { status: 'unchanged', reason: 'exact' };
}

/**
 * Strictly project one AgentRun and its optional Episode lineage.
 *
 * Business conflicts are returned without mutation. Transport/query failures
 * reject so reconciliation can retry and report them instead of losing them.
 */
export async function projectAgentRunToNeo4j(
  params: AgentRunSyncParams
): Promise<AgentRunProjectionResult> {
  let expected: ExpectedAgentRunProjection;
  try {
    expected = buildExpectedAgentRunProjection(params);
  } catch (error) {
    if (error instanceof AgentRunCorrelationConflictError) {
      return { status: 'conflict', reason: 'dual-ownership' };
    }
    throw error;
  }

  const projectionToken = randomUUID();
  const result = await runWriteTransaction<AgentRunProjectionAcknowledgement>(
    `OPTIONAL MATCH (candidate:Episode)
     WHERE $correlationId IS NOT NULL
       AND candidate.missionId = $correlationId
       AND candidate.userId = $userId
       AND candidate.agentName = $agentName
     WITH [candidate IN collect(candidate) WHERE candidate IS NOT NULL] AS candidates
     WITH candidates,
          coalesce($correlationId IS NULL OR (
            size(candidates) = 1
            AND candidates[0].id IS NOT NULL
            AND candidates[0].id = toString(candidates[0].id)
            AND trim(toString(candidates[0].id)) <> ''
            AND candidates[0].missionId = $correlationId
            AND candidates[0].userId = $userId
            AND candidates[0].agentName = $agentName
            AND (candidates[0].memoryLane IS NULL OR candidates[0].memoryLane = $memoryLane)
            AND (candidates[0].correlationId IS NULL OR candidates[0].correlationId = $correlationId)
          ), false) AS candidateEligible
     CALL {
       WITH candidates, candidateEligible
       WITH candidates, candidateEligible WHERE candidateEligible
       MERGE (run:AgentRun {id: $id})
       ON CREATE SET run.agentName = $agentName,
                     run.action = $action,
                     run.status = $status,
                     run.userId = $userId,
                     run.createdAt = $createdAt,
                     run.costUsd = $costUsd,
                     run.costState = $costState,
                     run.duration = $duration,
                     run.__radaristProjectionToken = $projectionToken
       RETURN run
       UNION
       WITH candidates, candidateEligible
       WITH candidates, candidateEligible WHERE NOT candidateEligible
       RETURN null AS run
     }
     OPTIONAL MATCH (run)-[existingEdge:EXECUTED_DURING]->(existingOwner)
     WITH candidates, run,
          [owner IN collect(existingOwner) WHERE owner IS NOT NULL] AS existingOwners,
          properties(run) AS beforeRun,
          coalesce(run.__radaristProjectionToken = $projectionToken, false) AS wasCreated
     WITH candidates, run, existingOwners, beforeRun, wasCreated,
          coalesce(
            run.id = $id
            AND run.agentName = $agentName
            AND run.action = $action
            AND run.status = $status
            AND run.userId = $userId
            AND run.createdAt = $createdAt
            AND (
              ($costUsd IS NULL AND run.costUsd IS NULL)
              OR run.costUsd = $costUsd
            )
            AND (run.costState IS NULL OR run.costState = $costState)
            AND run.duration = $duration,
            false
          ) AS payloadMatches,
          coalesce(
            (run.correlationId IS NULL OR run.correlationId = $correlationId)
            AND (run.correlationKind IS NULL OR run.correlationKind = $correlationKind)
            AND (run.missionId IS NULL OR run.missionId = $missionId)
            AND (run.sweepId IS NULL OR run.sweepId = $sweepId)
            AND (run.memoryLane IS NULL OR run.memoryLane = $memoryLane),
            false
          ) AS ownershipCompatible,
          coalesce(
            (($correlationId IS NULL AND run.correlationId IS NULL)
              OR run.correlationId = $correlationId)
            AND run.correlationKind = $correlationKind
            AND (($missionId IS NULL AND run.missionId IS NULL) OR run.missionId = $missionId)
            AND (($sweepId IS NULL AND run.sweepId IS NULL) OR run.sweepId = $sweepId)
            AND run.memoryLane = $memoryLane,
            false
          ) AS ownershipComplete,
          coalesce(
            (($costState IS NULL AND run.costState IS NULL)
              OR run.costState = $costState),
            false
          ) AS costStateComplete,
          size(existingOwners) = 0 OR (
            $correlationId IS NOT NULL
            AND size(candidates) = 1
            AND size(existingOwners) = 1
            AND 'Episode' IN labels(existingOwners[0])
            AND existingOwners[0] = candidates[0]
          ) AS topologyCompatible
     WITH candidates, run, existingOwners, beforeRun, wasCreated,
          payloadMatches AND ownershipCompatible AND topologyCompatible AS mutationAllowed,
          $correlationId IS NULL OR (
            size(candidates) = 1
            AND size(existingOwners) = 1
            AND 'Episode' IN labels(existingOwners[0])
            AND existingOwners[0] = candidates[0]
          ) AS lineageComplete,
          ownershipComplete,
          costStateComplete
     WITH candidates, run, existingOwners, beforeRun, wasCreated,
          mutationAllowed AND (
            wasCreated OR NOT ownershipComplete OR NOT costStateComplete OR NOT lineageComplete
          )
            AS shouldMutate
     FOREACH (_ IN CASE WHEN shouldMutate THEN [1] ELSE [] END |
       SET run.costState = $costState,
           run.correlationId = $correlationId,
           run.correlationKind = $correlationKind,
           run.missionId = $missionId,
           run.sweepId = $sweepId,
           run.memoryLane = $memoryLane
       REMOVE run.__radaristProjectionToken
     )
     FOREACH (candidate IN CASE
       WHEN shouldMutate AND $correlationId IS NOT NULL THEN candidates ELSE [] END |
       MERGE (run)-[:EXECUTED_DURING]->(candidate)
     )
     RETURN beforeRun AS run,
            [owner IN existingOwners | owner {
              .id, .missionId, .userId, .agentName,
              .memoryLane, .correlationId,
              labels: labels(owner)
            }] AS owners,
            [candidate IN candidates | candidate {
              .id, .missionId, .userId, .agentName,
              .memoryLane, .correlationId
            }] AS candidates,
            wasCreated`,
    {
      ...expected,
      projectionToken,
    }
  );

  const acknowledgement = result.records[0];
  if (
    !acknowledgement ||
    typeof acknowledgement.wasCreated !== 'boolean' ||
    !Array.isArray(acknowledgement.owners) ||
    !Array.isArray(acknowledgement.candidates)
  ) {
    throw new Error(`AgentRun ${params.id} projection returned an invalid acknowledgement`);
  }

  const classified = classifyAgentRunProjection(expected, acknowledgement);
  if (acknowledgement.wasCreated && classified.status !== 'conflict') {
    return { status: 'created', reason: 'missing-node' };
  }
  return classified;
}

/** Preserve the ordinary Firestore writer's nonblocking graph side effect. */
export async function syncAgentRunToNeo4j(params: AgentRunSyncParams): Promise<void> {
  try {
    const result = await projectAgentRunToNeo4j(params);
    if (result.status === 'conflict') {
      log.warn('AgentRun graph projection rejected a conflicting replay', {
        id: params.id,
        reason: result.reason,
      });
      return;
    }

    log.debug('AgentRun synced to Neo4j', {
      id: params.id,
      status: result.status,
      reason: result.reason,
    });
  } catch (error) {
    log.warn('Failed to sync AgentRun to Neo4j (non-blocking)', {
      id: params.id,
      error: String(error),
    });
  }
}
