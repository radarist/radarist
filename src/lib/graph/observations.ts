/**
 * @file graph/observations.ts
 * @description Neo4j CRUD for :Observation nodes + decay-weighted score aggregator.
 *
 * An Observation is a single (entityId, sourceUrl, verdict, observedAt) record
 * written by an agent mission whenever it references an entity with a source URL.
 * Mission observations use a deterministic mission/entity/source identity so
 * ambiguous event or database acknowledgements cannot create a second vote.
 * The Defense Minister consumes these via getObservationsForEntity() to compute a
 * SmartScore without firing an active web recheck.
 *
 * Decay weights: <30d → 1.0, 30-90d → 0.5, 90-180d → 0.25, >180d → 0.1.
 * Sparse threshold: weighted_total < 1.0 → caller should fall back to active recheck.
 *
 * @phase Smart Defense Minister — Task 1
 */

import neo4j from 'neo4j-driver';
import { runWriteTransaction, runReadTransaction } from './neo4j-client';
import { createLogger } from '@/lib/logger';
import { createMissionObservationId } from './observation-identity';
import type { ObservationAgentType } from './observation-identity';
import type { ObservationVerdict } from '@/lib/scout-bundle-parser';
import {
  MISSION_MEMORY_LANE,
  VERIFICATION_STANDALONE_MEMORY_LANE,
} from './memory-liveness';

const log = createLogger('graph/observations');

// ============================================================================
// TYPES
// ============================================================================

export interface Observation {
  id: string;
  entityId: string; // Subject of the observation
  sourceUrl: string; // The cited evidence URL
  verdict: ObservationVerdict;
  agentType: ObservationAgentType;
  missionId?: string; // Optional — null for backfill / manual entries
  observedAt: string; // ISO 8601
  createdAt: string; // ISO 8601 — write time (may differ from observedAt)
}

export interface ObservationInput {
  id?: string;
  entityId: string;
  sourceUrl: string;
  verdict: Observation['verdict'];
  agentType: Observation['agentType'];
  missionId?: string;
  observedAt?: string; // defaults to now
}

export interface SmartScore {
  score: number; // 0-100
  status: 'verified' | 'unverified' | 'disputed';
  weightedConfirming: number;
  weightedContradicting: number;
  observationCount: number;
}

export type SmartScoreResult =
  | { sparse: true; observationCount: number } // fall back to active recheck
  | { sparse: false; smartScore: SmartScore };

// ============================================================================
// AGGREGATOR (pure — no I/O)
// ============================================================================

const SPARSE_THRESHOLD = 1.0;

function decayWeight(observedAtIso: string): number {
  const ageDays = (Date.now() - new Date(observedAtIso).getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays < 30) return 1.0;
  if (ageDays < 90) return 0.5;
  if (ageDays < 180) return 0.25;
  return 0.1;
}

export function aggregateObservationScore(observations: Observation[]): SmartScoreResult {
  let weightedConfirming = 0;
  let weightedContradicting = 0;

  for (const o of observations) {
    if (o.verdict === 'inconclusive') continue;
    const w = decayWeight(o.observedAt);
    if (o.verdict === 'confirming') weightedConfirming += w;
    else weightedContradicting += w;
  }

  const decisive = weightedConfirming + weightedContradicting;
  if (decisive < SPARSE_THRESHOLD) {
    return { sparse: true, observationCount: observations.length };
  }

  const score = Math.round((weightedConfirming / decisive) * 100);
  const status: SmartScore['status'] = score >= 80 ? 'verified' : score >= 50 ? 'unverified' : 'disputed';

  return {
    sparse: false,
    smartScore: {
      score,
      status,
      weightedConfirming: Math.round(weightedConfirming * 100) / 100,
      weightedContradicting: Math.round(weightedContradicting * 100) / 100,
      observationCount: observations.length,
    },
  };
}

// ============================================================================
// WRITE OPERATIONS
// ============================================================================

export async function recordObservation(input: ObservationInput): Promise<Observation> {
  const deterministicId = input.missionId
    ? createMissionObservationId({
        missionId: input.missionId,
        entityId: input.entityId,
        sourceUrl: input.sourceUrl,
      })
    : undefined;
  if (input.id && deterministicId && input.id !== deterministicId) {
    throw new Error('Mission observation ID does not match its mission/entity/source identity');
  }
  if (input.id && !input.missionId) {
    throw new Error('Caller-supplied Observation IDs require a mission identity');
  }

  const id = deterministicId ?? input.id ?? `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const observedAt = input.observedAt ?? new Date().toISOString();
  const createdAt = new Date().toISOString();
  const memoryLane = input.missionId ? MISSION_MEMORY_LANE : VERIFICATION_STANDALONE_MEMORY_LANE;
  const provenanceKind = input.missionId ? 'mission-source' : 'source-verification';

  const cypher = `
    MATCH (target {id: $entityId})
    WHERE target:Entity OR target:Technology OR target:Company OR
          target:UseCase OR target:PainPoint OR target:Strategy OR
          target:Signal OR target:Prototype OR target:Initiative OR
          target:OrgUnit OR target:Document OR target:RadarPlacement
    WITH collect(DISTINCT target) AS targets
    WHERE size(targets) = 1
    WITH targets[0] AS e
    SET e.__radaristObservationWriteLock = randomUUID()
    REMOVE e.__radaristObservationWriteLock
    WITH e
    OPTIONAL MATCH (candidate:Observation {
      missionId: $missionId,
      entityId: $entityId,
      sourceUrl: $sourceUrl
    })
    WHERE $missionId IS NOT NULL
    WITH e, [candidate IN collect(candidate) WHERE candidate IS NOT NULL] AS logicalMatches
    WITH e, logicalMatches, size(logicalMatches) AS logicalMatchCount,
         CASE WHEN size(logicalMatches) = 1 THEN logicalMatches[0].id ELSE $id END AS persistedId
    WHERE logicalMatchCount <= 1
    MERGE (o:Observation {id: persistedId})
    ON CREATE SET
      o.entityId    = $entityId,
      o.sourceUrl   = $sourceUrl,
      o.verdict     = $verdict,
      o.agentType   = $agentType,
      o.missionId   = $missionId,
      o.observedAt  = $observedAt,
      o.createdAt   = $createdAt,
      o.memoryLane  = $memoryLane,
      o.correlationId = $missionId,
      o.provenanceKind = $provenanceKind
    WITH e, o, logicalMatchCount,
      o.entityId = $entityId AND
      o.sourceUrl = $sourceUrl AND
      o.verdict = $verdict AND
      o.agentType = $agentType AND
      coalesce(o.missionId, '') = coalesce($missionId, '') AND
      (o.memoryLane IS NULL OR o.memoryLane = $memoryLane) AND
      (o.correlationId IS NULL OR o.correlationId = $missionId) AND
      (o.provenanceKind IS NULL OR o.provenanceKind = $provenanceKind) AS payloadMatches
    FOREACH (_ IN CASE WHEN payloadMatches THEN [1] ELSE [] END |
      SET o.memoryLane = $memoryLane,
          o.correlationId = $missionId,
          o.provenanceKind = $provenanceKind
      MERGE (o)-[:OBSERVES]->(e)
    )
    RETURN o.id AS id,
           o.observedAt AS observedAt,
           o.createdAt AS createdAt,
           payloadMatches AS payloadMatches,
           logicalMatchCount AS logicalMatchCount
  `;

  const result = await runWriteTransaction<{
    id: string;
    observedAt: string;
    createdAt: string;
    payloadMatches: boolean;
    logicalMatchCount: number;
  }>(cypher, {
    id,
    entityId: input.entityId,
    sourceUrl: input.sourceUrl,
    verdict: input.verdict,
    agentType: input.agentType,
    missionId: input.missionId ?? null,
    observedAt,
    createdAt,
    memoryLane,
    provenanceKind,
  });

  const persisted = result.records[0];
  if (!persisted) {
    throw new Error(
      `Observation target is missing/non-unique or its legacy mission/entity/source identity is ambiguous: ${input.entityId}`
    );
  }
  if (!persisted.payloadMatches) {
    throw new Error(`Observation identity conflict for id: ${id}`);
  }

  log.info('Observation recorded', {
    id: persisted.id,
    entityId: input.entityId,
    verdict: input.verdict,
    agentType: input.agentType,
    adoptedLegacyId: persisted.id !== id,
  });

  return {
    id: persisted.id,
    entityId: input.entityId,
    sourceUrl: input.sourceUrl,
    verdict: input.verdict,
    agentType: input.agentType,
    missionId: input.missionId,
    observedAt: persisted.observedAt,
    createdAt: persisted.createdAt,
  };
}

// ============================================================================
// READ OPERATIONS
// ============================================================================

export async function getObservationsForEntity(
  entityId: string,
  sinceDays = 365,
  limit?: number
): Promise<Observation[]> {
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const boundedLimit = limit === undefined ? undefined : Math.max(1, Math.min(100, Math.trunc(limit)));

  const cypher = `
    MATCH (o:Observation {entityId: $entityId})
    WHERE o.observedAt >= $cutoff
    RETURN o.id        AS id,
           o.entityId  AS entityId,
           o.sourceUrl AS sourceUrl,
           o.verdict   AS verdict,
           o.agentType AS agentType,
           o.missionId AS missionId,
           o.observedAt AS observedAt,
           o.createdAt  AS createdAt
    ORDER BY o.observedAt DESC
    ${boundedLimit === undefined ? '' : 'LIMIT $limit'}
  `;

  const result = await runReadTransaction(cypher, {
    entityId,
    cutoff,
    // Cypher LIMIT rejects a Bolt Float such as `3.0`. The JavaScript number
    // must cross the driver boundary as an explicit Neo4j Integer.
    ...(boundedLimit === undefined ? {} : { limit: neo4j.int(boundedLimit) }),
  });

  return result.records.map((record) => {
    const r = record as Record<string, unknown>;
    return {
      id: r.id as string,
      entityId: r.entityId as string,
      sourceUrl: r.sourceUrl as string,
      verdict: r.verdict as Observation['verdict'],
      agentType: r.agentType as ObservationAgentType,
      missionId: (r.missionId as string | null) ?? undefined,
      observedAt: r.observedAt as string,
      createdAt: r.createdAt as string,
    };
  });
}
