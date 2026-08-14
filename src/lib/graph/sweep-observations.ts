/** Atomic, replay-safe persistence for observations owned by a sweep Episode. */

import neo4j from 'neo4j-driver';
import { runReadTransaction, runWriteTransaction } from './neo4j-client';
import { createSweepObservationId } from './observation-identity';
import type { AgentObservation } from './proactive-insights';
import { PROACTIVE_SWEEP_MEMORY_LANE } from './memory-liveness';

export interface SweepObservationInput {
  sweepId: string;
  episodeId: string;
  gapIndex: number;
  title: string;
  summary: string;
  confidence: number;
  entityId: string;
  entityName: string;
  entityType: string;
  timestamp: string;
}

export type SweepObservationSkipReason = 'target-unavailable';

export type SweepObservationWriteResult =
  | { status: 'recorded'; observation: AgentObservation }
  | { status: 'skipped'; observationId: string; reason: SweepObservationSkipReason };

type SweepObservationRecord = AgentObservation;

interface SweepObservationDiagnostic {
  episodeCount: number;
  targetCount: number;
  observationCount: number;
}

interface CommittedSweepObservationRecord extends SweepObservationRecord {
  sweepId: string;
  gapIndex: number;
  memoryLane: string;
  correlationId: string;
  provenanceKind: string;
  ownerIds: string[];
  targetIds: string[];
}

export class SweepObservationIdentityConflictError extends Error {
  readonly observationId: string;

  constructor(observationId: string) {
    super(`Sweep observation identity conflict: ${observationId}`);
    this.name = 'SweepObservationIdentityConflictError';
    this.observationId = observationId;
  }
}

export class SweepObservationEpisodeUnavailableError extends Error {
  constructor(episodeId: string, sweepId: string) {
    super(`Sweep Episode is missing, mismatched, or ambiguous: ${episodeId} (${sweepId})`);
    this.name = 'SweepObservationEpisodeUnavailableError';
  }
}

async function inspectSweepObservation(
  input: SweepObservationInput,
  observationId: string
): Promise<SweepObservationDiagnostic> {
  const result = await runReadTransaction<SweepObservationDiagnostic>(
    `OPTIONAL MATCH (episode:Episode {
       id: $episodeId, missionId: $sweepId, agentName: 'sweep-cycle', status: 'active'
     })
     WITH collect(episode) AS episodes
     OPTIONAL MATCH (target:Entity {id: $entityId})
     WITH episodes, collect(target) AS targets
     OPTIONAL MATCH (observation:AgentObservation {id: $observationId})
     RETURN size(episodes) AS episodeCount,
            size(targets) AS targetCount,
            count(observation) AS observationCount`,
    { ...input, observationId }
  );
  return result.records[0] ?? { episodeCount: 0, targetCount: 0, observationCount: 0 };
}

/**
 * Recover an exact committed write after its Episode has terminalized.
 * This path is read-only: it never reopens the Episode, changes provenance,
 * or repairs topology after the owning lifecycle has closed.
 */
async function recoverCommittedSweepObservation(
  input: SweepObservationInput,
  observationId: string
): Promise<AgentObservation | null> {
  const result = await runReadTransaction<CommittedSweepObservationRecord>(
    `MATCH (episode:Episode {
       id: $episodeId, missionId: $sweepId, agentName: 'sweep-cycle'
     })
     MATCH (observation:AgentObservation {id: $observationId})
     OPTIONAL MATCH (observation)-[:ABOUT]->(target)
     WITH episode, observation, collect(DISTINCT target.id) AS targetIds
     OPTIONAL MATCH (owner:Episode)-[:CONTAINS]->(observation)
     RETURN observation.id AS id,
            observation.agentType AS agentType,
            observation.observationType AS observationType,
            observation.sweepId AS sweepId,
            observation.gapIndex AS gapIndex,
            observation.title AS title,
            observation.summary AS summary,
            coalesce(observation.assertedConfidence, observation.confidence) AS confidence,
            observation.entityId AS entityId,
            observation.entityName AS entityName,
            observation.entityType AS entityType,
            observation.timestamp AS timestamp,
            observation.memoryLane AS memoryLane,
            observation.correlationId AS correlationId,
            observation.provenanceKind AS provenanceKind,
            targetIds,
            collect(DISTINCT owner.id) AS ownerIds`,
    { ...input, observationId }
  );
  const record = result.records[0];
  if (
    !record ||
    record.agentType !== 'sweep-cycle' ||
    record.observationType !== 'discovery' ||
    record.sweepId !== input.sweepId ||
    record.gapIndex !== input.gapIndex ||
    record.title !== input.title ||
    record.summary !== input.summary ||
    record.confidence !== input.confidence ||
    record.entityId !== input.entityId ||
    record.entityName !== input.entityName ||
    record.entityType !== input.entityType ||
    record.timestamp !== input.timestamp ||
    record.memoryLane !== PROACTIVE_SWEEP_MEMORY_LANE ||
    record.correlationId !== input.sweepId ||
    record.provenanceKind !== 'sweep-gap' ||
    record.targetIds.length !== 1 ||
    record.targetIds[0] !== input.entityId ||
    record.ownerIds.length !== 1 ||
    record.ownerIds[0] !== input.episodeId
  ) {
    return null;
  }

  return {
    id: record.id,
    agentType: record.agentType,
    observationType: record.observationType,
    title: record.title,
    summary: record.summary,
    confidence: record.confidence,
    entityId: record.entityId,
    entityName: record.entityName,
    entityType: record.entityType,
    timestamp: record.timestamp,
  };
}

/**
 * Create one sweep observation and both graph edges in one transaction.
 *
 * Existing payload or topology conflicts fail without mutation. Missing or
 * non-unique endpoints are explicit non-writing skips; transport/database
 * failures escape so the owning Inngest step can retry.
 */
export async function recordSweepObservation(input: SweepObservationInput): Promise<SweepObservationWriteResult> {
  const observationId = createSweepObservationId(input);
  const result = await runWriteTransaction<SweepObservationRecord>(
    `OPTIONAL MATCH (episode:Episode {
       id: $episodeId, missionId: $sweepId, agentName: 'sweep-cycle', status: 'active'
     })
     WITH collect(episode) AS episodes
     OPTIONAL MATCH (target:Entity {id: $entityId})
     WITH episodes, collect(target) AS targets
     WHERE size(episodes) = 1 AND size(targets) = 1
     WITH head(episodes) AS episode, head(targets) AS target
     MERGE (observation:AgentObservation {id: $observationId})
     ON CREATE SET observation.agentType = 'sweep-cycle',
                   observation.observationType = 'discovery',
                   observation.sweepId = $sweepId,
                   observation.gapIndex = $gapIndex,
                   observation.title = $title,
                   observation.summary = $summary,
                   observation.confidence = $confidence,
                   observation.entityId = $entityId,
                   observation.entityName = $entityName,
                   observation.entityType = $entityType,
                   observation.timestamp = $timestamp,
                   observation.memoryLane = $memoryLane,
                   observation.correlationId = $sweepId,
                   observation.provenanceKind = 'sweep-gap'
     WITH episode, target, observation
     WHERE observation.agentType = 'sweep-cycle'
       AND observation.observationType = 'discovery'
       AND observation.sweepId = $sweepId
       AND observation.gapIndex = $gapIndex
       AND observation.title = $title
       AND observation.summary = $summary
       AND observation.confidence = $confidence
       AND observation.entityId = $entityId
       AND observation.entityName = $entityName
       AND observation.entityType = $entityType
       AND (observation.memoryLane IS NULL OR observation.memoryLane = $memoryLane)
       AND (observation.correlationId IS NULL OR observation.correlationId = $sweepId)
       AND (observation.provenanceKind IS NULL OR observation.provenanceKind = 'sweep-gap')
     OPTIONAL MATCH (observation)-[:ABOUT]->(existingTarget)
     WITH episode, target, observation, collect(existingTarget) AS existingTargets
     WHERE size(existingTargets) = 0 OR (size(existingTargets) = 1 AND head(existingTargets) = target)
     OPTIONAL MATCH (existingEpisode:Episode)-[:CONTAINS]->(observation)
     WITH episode, target, observation, collect(existingEpisode) AS existingEpisodes
     WHERE size(existingEpisodes) = 0 OR (size(existingEpisodes) = 1 AND head(existingEpisodes) = episode)
     SET episode.__radaristSweepObservationLock = randomUUID()
     REMOVE episode.__radaristSweepObservationLock
     SET observation.memoryLane = $memoryLane,
         observation.correlationId = $sweepId,
         observation.provenanceKind = 'sweep-gap'
     MERGE (observation)-[:ABOUT]->(target)
     MERGE (episode)-[contains:CONTAINS]->(observation)
     ON CREATE SET episode.observationCount = coalesce(episode.observationCount, 0) + 1
     RETURN observation.id AS id,
            observation.agentType AS agentType,
            observation.observationType AS observationType,
            observation.title AS title,
            observation.summary AS summary,
            $confidence AS confidence,
            observation.entityId AS entityId,
            observation.entityName AS entityName,
            observation.entityType AS entityType,
            observation.timestamp AS timestamp`,
    { ...input, gapIndex: neo4j.int(input.gapIndex), observationId, memoryLane: PROACTIVE_SWEEP_MEMORY_LANE }
  );

  const observation = result.records[0];
  if (observation) return { status: 'recorded', observation };

  const committed = await recoverCommittedSweepObservation(input, observationId);
  if (committed) return { status: 'recorded', observation: committed };

  const diagnostic = await inspectSweepObservation(input, observationId);
  if (diagnostic.episodeCount !== 1) {
    throw new SweepObservationEpisodeUnavailableError(input.episodeId, input.sweepId);
  }
  if (diagnostic.targetCount !== 1) {
    return { status: 'skipped', observationId, reason: 'target-unavailable' };
  }
  if (diagnostic.observationCount === 1) {
    throw new SweepObservationIdentityConflictError(observationId);
  }
  throw new Error(`Sweep observation did not converge: ${observationId}`);
}
