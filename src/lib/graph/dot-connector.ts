/**
 * @file dot-connector.ts
 * @description Cross-session dot-connecting service.
 *
 * When an agent creates a new observation, this service checks if the
 * observed entity connects (via graph edges) to entities from the user's
 * past sessions. This enables "you explored X last week, and our agent
 * just found something related" style insights.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { runWriteTransaction, runReadTransaction } from './neo4j-client';
import { CLAIM_RELATION_PREDICATES } from './relation-registry';
import { currentPathPredicate } from './current-edge-filter';
import { getInsightAction } from './insight-actions';
import {
  GROUNDED_COUNTER_EVIDENCE_FLOOR,
  groundGraphPathEvidence,
  type InsightEpistemicKind,
} from './insight-grounding';
import { createLogger } from '@/lib/logger';

const log = createLogger('graph/dot-connector');

// ============================================================================
// TYPES
// ============================================================================

export interface DotConnection {
  /** The new observation's entity */
  observedEntityId: string;
  observedEntityName: string;
  observedEntityType: string;
  /** The user's previously explored entity that connects */
  exploredEntityId: string;
  exploredEntityName: string;
  exploredEntityType: string;
  /** The graph path between them */
  pathLength: number;
  relationshipTypes: string[];
  sourceRelationTypes: string[];
  relationIds: string[];
  assertedBy: string[];
  claimStatuses: string[];
  edgeConfidences: number[];
  pathNodeIds: string[];
  pathNodeNames: string[];
  pathNodeTypes: string[];
  relationshipDirections: Array<'forward' | 'reverse'>;
  evidenceSummary: string;
  epistemicKind: InsightEpistemicKind;
  hasCounterEvidence: boolean;
  /** Computed relevance score (0-1) */
  relevanceScore: number;
  /**
   * Most recent EXPLORED-edge timestamp for the explored-end entity (ISO).
   * Null if no EXPLORED edge ever set `lastViewedAt`/`firstViewedAt`. Used by
   * the Option A detail-page breadcrumb.
   */
  exploredAt: string | null;
}

export interface DotConnectorResult {
  userId: string;
  observationId: string;
  connections: DotConnection[];
  insightsCreated: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default maximum hops for path finding */
const DEFAULT_MAX_HOPS = 2;

/** Minimum relevance score to create a ProactiveInsight */
const RELEVANCE_THRESHOLD = 0.4;

/**
 * Allowlist of Neo4j relationship types that represent a real semantic
 * business connection between entities. Bookkeeping edges (ABOUT, EXPLORED,
 * CONTAINS, OBSERVES, BELONGS_TO, HAS_PREDICATE, ABOUT_SUBJECT,
 * ABOUT_OBJECT, ASSERTED_BY, SUPPORTED_BY, SYNCED_FROM, ORIGINATED_FROM,
 * EXECUTED_DURING, etc.) are intentionally excluded — they exist for graph
 * housekeeping and would produce paths like "A <-ABOUT- Insight -ABOUT-> B"
 * that look like meaningful connections but aren't.
 *
 * DERIVED, not transcribed. The hand-maintained copy this replaces had already
 * drifted: `EVALUATES` was added to `RELATION_PREDICATE_MAP` and never mirrored
 * here, so evaluation edges were invisible to dot-connecting — the exact failure
 * `CLAIM_RELATION_PREDICATES` exists to prevent, repeated one module over.
 */
const SEMANTIC_REL_TYPES: readonly string[] = CLAIM_RELATION_PREDICATES;

/** Pipe-joined for Cypher relationship-type filter syntax: `[r:USES|ENABLES|...]` */
const SEMANTIC_REL_FILTER = SEMANTIC_REL_TYPES.join('|');

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Compute relevance score based on path length.
 *
 * After the 2026-05-12 dot-connector tightening, paths are also restricted
 * to semantic relationship types (see SEMANTIC_REL_TYPES). So a 1-hop path
 * is e.g. `Company-VENDOR-Technology` and a 2-hop path is a real
 * supply-chain or alignment trace. Closer = more relevant; we cap at hops=2
 * because beyond that the "connection" becomes too indirect to claim.
 *
 * 1 hop → 0.9, 2 hops → 0.5, anything longer → 0 (filtered out before this).
 */
function computeRelevanceScore(pathLength: number): number {
  if (pathLength <= 0) return 0;
  if (pathLength === 1) return 0.9;
  if (pathLength === 2) return 0.5;
  return 0;
}

// Action-URL mapping lives in `lib/graph/insight-actions.ts` (Phase 0 step
// 0.4 of the 2026-05-13 briefing-pipeline cleanup) — single source of truth
// across the dot-connector, the legacy `detectInsightsForUser` path, and the
// UI fallback. Imported below.

// ============================================================================
// CYPHER QUERY SHAPES
// ============================================================================

/** Shape returned from the observation lookup query */
interface ObservationRecord {
  entityId: string;
  title: string;
  summary: string;
  type: string;
  agentName: string;
  confidence: number;
}

/** Shape returned from the path finding query */
interface PathRecord {
  observedEntityId: string;
  observedEntityName: string;
  observedEntityType: string;
  exploredEntityId: string;
  exploredEntityName: string;
  exploredEntityType: string;
  pathLength: number;
  relationshipTypes: string[];
  sourceRelationTypes: Array<string | null>;
  relationIds: Array<string | null>;
  assertedBy: Array<string | null>;
  claimStatuses: Array<string | null>;
  edgeConfidences: Array<number | null>;
  pathNodeIds: string[];
  pathNodeNames: string[];
  pathNodeTypes: string[];
  relationshipStartIds: string[];
  relationshipEndIds: string[];
  /**
   * Most recent timestamp on any EXPLORED edge between any of the user's
   * sessions and the explored-end entity. ISO string. Null if neither
   * `lastViewedAt` nor `firstViewedAt` were ever set (legacy edges).
   *
   * Surface for Option A's detail-page "Why am I seeing this?" breadcrumb.
   */
  exploredAt: string | null;
}

function resolvePathDirections(record: PathRecord): Array<'forward' | 'reverse'> | null {
  if (
    !Array.isArray(record.pathNodeIds) ||
    !Array.isArray(record.pathNodeNames) ||
    !Array.isArray(record.pathNodeTypes) ||
    !Array.isArray(record.relationshipStartIds) ||
    !Array.isArray(record.relationshipEndIds)
  ) {
    return null;
  }
  const hopCount = record.relationshipTypes.length;
  if (
    record.pathLength !== hopCount ||
    record.pathNodeIds.length !== hopCount + 1 ||
    record.pathNodeNames.length !== hopCount + 1 ||
    record.pathNodeTypes.length !== hopCount + 1 ||
    record.relationshipStartIds.length !== hopCount ||
    record.relationshipEndIds.length !== hopCount
  ) {
    return null;
  }

  const directions: Array<'forward' | 'reverse'> = [];
  for (let index = 0; index < hopCount; index += 1) {
    const fromId = record.pathNodeIds[index];
    const toId = record.pathNodeIds[index + 1];
    const edgeStartId = record.relationshipStartIds[index];
    const edgeEndId = record.relationshipEndIds[index];
    if (edgeStartId === fromId && edgeEndId === toId) {
      directions.push('forward');
    } else if (edgeStartId === toId && edgeEndId === fromId) {
      directions.push('reverse');
    } else {
      return null;
    }
  }
  return directions;
}

function describeConnectionPath(
  connection: Pick<DotConnection, 'pathNodeNames' | 'pathNodeTypes' | 'sourceRelationTypes' | 'relationshipDirections'>
): string {
  let description = `${connection.pathNodeTypes[0]} "${connection.pathNodeNames[0]}"`;
  for (let index = 0; index < connection.sourceRelationTypes.length; index += 1) {
    const predicate = connection.sourceRelationTypes[index].toUpperCase();
    const next = `${connection.pathNodeTypes[index + 1]} "${connection.pathNodeNames[index + 1]}"`;
    description +=
      connection.relationshipDirections[index] === 'forward'
        ? ` -[${predicate}]-> ${next}`
        : ` <-[${predicate}]- ${next}`;
  }
  return description;
}

// ============================================================================
// FIND DOT CONNECTIONS
// ============================================================================

/**
 * Find graph paths between the observation's entity and entities the user
 * previously explored.
 *
 * Uses Neo4j's shortestPath algorithm to find paths up to maxHops between
 * the observed entity and all entities the user explored in past sessions.
 *
 * @param observationEntityId - The entity ID from the observation
 * @param userId - The user to check explored entities for
 * @param maxHops - Maximum path length (default: 3)
 * @returns Array of dot connections sorted by path length (ascending)
 */
export async function findDotConnections(
  observationEntityId: string,
  userId: string,
  maxHops: number = DEFAULT_MAX_HOPS
): Promise<DotConnection[]> {
  try {
    // Restrict the path to semantic edges only — see SEMANTIC_REL_TYPES for
    // the rationale. Bookkeeping edges (ABOUT, EXPLORED, CONTAINS, OBSERVES,
    // etc.) would produce "connections" that are graph housekeeping artifacts
    // rather than real business relationships. This is the 2026-05-12 fix
    // for the "AI Agents -> Precision Fermentation" hallucinated insight class.
    const result = await runReadTransaction<PathRecord>(
      `MATCH (s:Session { userId: $userId })-[xp:EXPLORED]->(explored)
       WHERE explored.id <> $entityId
       WITH explored, max(coalesce(xp.lastViewedAt, xp.firstViewedAt)) AS exploredAt
       MATCH path = shortestPath((obs_entity { id: $entityId })-[:${SEMANTIC_REL_FILTER}*1..${maxHops}]-(explored))
       WHERE ALL(n IN nodes(path) WHERE n.id IS NOT NULL)
         AND ${currentPathPredicate('path')}
       WITH explored, exploredAt, path, obs_entity,
            length(path) AS pathLen,
            [r IN relationships(path) | type(r)] AS relTypes
       RETURN obs_entity.id AS observedEntityId,
              coalesce(obs_entity.name, obs_entity.title) AS observedEntityName,
              obs_entity.entityType AS observedEntityType,
              explored.id AS exploredEntityId,
              coalesce(explored.name, explored.title) AS exploredEntityName,
              explored.entityType AS exploredEntityType,
              pathLen AS pathLength,
              relTypes AS relationshipTypes,
              [r IN relationships(path) | r.sourceRelationType] AS sourceRelationTypes,
              [r IN relationships(path) | r.relationId] AS relationIds,
              [r IN relationships(path) | r.assertedBy] AS assertedBy,
              [r IN relationships(path) | r.claimStatus] AS claimStatuses,
              [r IN relationships(path) | coalesce(r.effectiveConfidence, r.assertedConfidence, r.confidence)] AS edgeConfidences,
              [n IN nodes(path) | n.id] AS pathNodeIds,
              [n IN nodes(path) | coalesce(n.name, n.title, n.id)] AS pathNodeNames,
              [n IN nodes(path) | coalesce(n.entityType, head(labels(n)), 'entity')] AS pathNodeTypes,
              [r IN relationships(path) | startNode(r).id] AS relationshipStartIds,
              [r IN relationships(path) | endNode(r).id] AS relationshipEndIds,
              exploredAt AS exploredAt
       ORDER BY pathLen ASC
       LIMIT 10`,
      { entityId: observationEntityId, userId }
    );

    return result.records.flatMap((record) => {
      const grounding = groundGraphPathEvidence({
        predicates: record.relationshipTypes,
        sourceRelationTypes: record.sourceRelationTypes,
        relationIds: record.relationIds,
        assertedBy: record.assertedBy,
        claimStatuses: record.claimStatuses,
        edgeConfidences: record.edgeConfidences,
      });
      const relationshipDirections = resolvePathDirections(record);
      if (!grounding.ok || !relationshipDirections) {
        log.warn('Dot connection evidence rejected', {
          observedEntityId: record.observedEntityId,
          exploredEntityId: record.exploredEntityId,
          reason: grounding.ok ? 'Path direction metadata is inconsistent.' : grounding.reason,
        });
        return [];
      }

      const connection: DotConnection = {
        observedEntityId: record.observedEntityId,
        observedEntityName: record.observedEntityName,
        observedEntityType: record.observedEntityType,
        exploredEntityId: record.exploredEntityId,
        exploredEntityName: record.exploredEntityName,
        exploredEntityType: record.exploredEntityType,
        pathLength: record.pathLength,
        relationshipTypes: grounding.predicates,
        sourceRelationTypes: grounding.sourceRelationTypes,
        relationIds: grounding.relationIds,
        assertedBy: grounding.assertedBy,
        claimStatuses: record.claimStatuses as string[],
        edgeConfidences: grounding.edgeConfidences,
        pathNodeIds: record.pathNodeIds,
        pathNodeNames: record.pathNodeNames,
        pathNodeTypes: record.pathNodeTypes,
        relationshipDirections,
        evidenceSummary: '',
        epistemicKind: grounding.epistemicKind,
        hasCounterEvidence: grounding.hasCounterEvidence,
        relevanceScore: Math.min(computeRelevanceScore(record.pathLength), grounding.confidenceCeiling),
        exploredAt: record.exploredAt ?? null,
      };
      connection.evidenceSummary = describeConnectionPath(connection);
      return [connection];
    });
  } catch (error) {
    log.error('Failed to find dot connections', error instanceof Error ? error : new Error(String(error)), {
      observationEntityId,
      userId,
      maxHops,
    });
    throw error;
  }
}

// ============================================================================
// CONNECT DOTS (MAIN ORCHESTRATION)
// ============================================================================

/**
 * Main orchestration function for cross-session dot-connecting.
 *
 * 1. Reads the observation to get its entityId
 * 2. Finds dot connections between the observed entity and explored entities
 * 3. Creates ProactiveInsight nodes for high-relevance connections
 *
 * @param observationId - The AgentObservation node ID
 * @param userId - The user to connect dots for
 * @param maxHops - Maximum path length (default: 3)
 * @returns Result with connections found and insights created
 */
export async function connectDots(
  observationId: string,
  userId: string,
  maxHops: number = DEFAULT_MAX_HOPS
): Promise<DotConnectorResult> {
  try {
    // Step 1: Read the observation to get its entityId
    const obsResult = await runReadTransaction<ObservationRecord>(
      `MATCH (obs:AgentObservation { id: $observationId })
       RETURN obs.entityId AS entityId, obs.title AS title,
              obs.summary AS summary, obs.observationType AS type,
              obs.agentType AS agentName, obs.confidence AS confidence`,
      { observationId }
    );

    if (obsResult.records.length === 0) {
      log.warn('Observation not found for dot-connecting', { observationId });
      return {
        userId,
        observationId,
        connections: [],
        insightsCreated: 0,
      };
    }

    const observation = obsResult.records[0];

    // Step 2: Find dot connections
    const connections = await findDotConnections(observation.entityId, userId, maxHops);

    if (connections.length === 0) {
      log.debug('No dot connections found', { observationId, userId });
      return {
        userId,
        observationId,
        connections: [],
        insightsCreated: 0,
      };
    }

    // Step 3: Create ProactiveInsight nodes for high-relevance connections
    let insightsCreated = 0;

    for (const connection of connections) {
      const persistenceThreshold = connection.hasCounterEvidence
        ? GROUNDED_COUNTER_EVIDENCE_FLOOR
        : RELEVANCE_THRESHOLD;
      if (connection.relevanceScore < persistenceThreshold) {
        continue;
      }

      const insightId = crypto.randomUUID();
      const now = new Date().toISOString();
      const title =
        connection.epistemicKind === 'observation'
          ? `${connection.observedEntityName} connects to ${connection.exploredEntityName}`
          : `Possible connection: ${connection.observedEntityName} and ${connection.exploredEntityName}`;
      const summary =
        connection.epistemicKind === 'observation'
          ? `Observation: the reviewed graph contains this direct edge: ${connection.evidenceSummary}.`
          : `Inference (graph-path hypothesis): ${connection.observedEntityName} and ${connection.exploredEntityName} are connected by this reviewed two-hop path: ${connection.evidenceSummary}. This establishes graph proximity only, not a direct relationship or business action.${connection.hasCounterEvidence ? ' The path includes competition or conflict semantics.' : ''}`;
      const confidenceScore = Math.min(observation.confidence, connection.relevanceScore);
      const { actionUrl, actionLabel } = getInsightAction(connection.observedEntityType, connection.observedEntityId);
      // Stable key for (user, observed\u2192explored) dedupe so a repeat sweep
      // doesn't recreate the same insight every 6 hours.
      const dedupeKey = `${userId}::${connection.observedEntityId}::${connection.exploredEntityId}`;

      try {
        // MERGE on dedupeKey \u2014 first time creates the insight with the
        // immutable bookkeeping (id, userId, observed/explored ids, createdAt);
        // subsequent matches refresh the human-visible fields (title,
        // summary, confidence, action). The user's consumed/dismiss state is
        // PRESERVED on re-match (2.1 label-integrity fix) — dismissing an
        // insight is durable; the sweep no longer resets `consumed = false` to
        // resurface a dismissed link (that turned dismiss into a no-op that the
        // generator overrode every 6 hours).
        await runWriteTransaction(
          // Persist structured path data.
          //   relationshipTypes / pathLength: enables the detail-page "Why
          //   am I seeing this?" breadcrumb to render the semantic chain
          //   without re-parsing the human-readable summary string.
          //   exploredAt: lets the UI say "you explored X 3 days ago" instead
          //   of just "you explored X earlier".
          // All three are set unconditionally (under SET, not ON CREATE/MATCH)
          // so refreshed insights pick up the latest values too.
          `MERGE (pi:ProactiveInsight { dedupeKey: $dedupeKey })
            ON CREATE SET
              pi.id = $id, pi.userId = $userId, pi.type = 'connection',
              pi.observedEntityId = $observedEntityId,
              pi.exploredEntityId = $exploredEntityId,
              pi.createdAt = $now, pi.consumed = false
            ON MATCH SET
              pi.refreshedAt = $now
            SET
              pi.title = $title, pi.summary = $summary,
              pi.agentName = $agentName, pi.confidenceScore = $confidenceScore,
              pi.actionable = true, pi.actionUrl = $actionUrl,
              pi.actionLabel = $actionLabel,
              pi.relationshipTypes = $relationshipTypes,
              pi.sourceRelationTypes = $sourceRelationTypes,
              pi.evidenceRelationIds = $evidenceRelationIds,
              pi.evidenceAssertedBy = $evidenceAssertedBy,
              pi.evidenceClaimStatuses = $evidenceClaimStatuses,
              pi.evidenceEdgeConfidences = $evidenceEdgeConfidences,
              pi.evidenceNodeIds = $evidenceNodeIds,
              pi.relationshipDirections = $relationshipDirections,
              pi.evidenceSummary = $evidenceSummary,
              pi.epistemicKind = $epistemicKind,
              pi.groundingVersion = 'predicate-path-v1',
              pi.hasCounterEvidence = $hasCounterEvidence,
              pi.pathLength = $pathLength,
              pi.exploredAt = $exploredAt
          WITH pi
          MATCH (observed { id: $observedEntityId })
          MATCH (explored { id: $exploredEntityId })
          MERGE (pi)-[:ABOUT]->(observed)
          MERGE (pi)-[:ABOUT]->(explored)`,
          {
            id: insightId,
            userId,
            dedupeKey,
            title,
            summary,
            agentName: observation.agentName,
            confidenceScore,
            actionUrl,
            actionLabel,
            now,
            observedEntityId: connection.observedEntityId,
            exploredEntityId: connection.exploredEntityId,
            relationshipTypes: connection.relationshipTypes,
            sourceRelationTypes: connection.sourceRelationTypes,
            evidenceRelationIds: connection.relationIds,
            evidenceAssertedBy: connection.assertedBy,
            evidenceClaimStatuses: connection.claimStatuses,
            evidenceEdgeConfidences: connection.edgeConfidences,
            evidenceNodeIds: connection.pathNodeIds,
            relationshipDirections: connection.relationshipDirections,
            evidenceSummary: connection.evidenceSummary,
            epistemicKind: connection.epistemicKind,
            hasCounterEvidence: connection.hasCounterEvidence,
            pathLength: connection.pathLength,
            exploredAt: connection.exploredAt,
          }
        );

        insightsCreated++;
      } catch (insightError) {
        log.error(
          'Failed to create dot connection insight',
          insightError instanceof Error ? insightError : new Error(String(insightError)),
          {
            observationId,
            observedEntityId: connection.observedEntityId,
            exploredEntityId: connection.exploredEntityId,
          }
        );
        // Continue processing remaining connections
      }
    }

    log.info('Dot-connecting complete', {
      userId,
      observationId,
      connectionsFound: connections.length,
      insightsCreated,
    });

    return {
      userId,
      observationId,
      connections,
      insightsCreated,
    };
  } catch (error) {
    log.error('Failed to connect dots', error instanceof Error ? error : new Error(String(error)), {
      observationId,
      userId,
    });
    throw error;
  }
}
