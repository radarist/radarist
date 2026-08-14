/** Authoritative graph projection for Initiative strategy and pain-point references. */

export const INITIATIVE_LINK_PROJECTION_OWNER = 'entity-sync:initiative-links:v1';

export interface InitiativeLinkProjectionReceipt {
  missingStrategyIds: string[];
  missingPainPointIds: string[];
  strategiesProjected: number;
  painPointsProjected: number;
  strategyEdgesRemoved: number;
  painPointEdgesRemoved: number;
}

const RECONCILE_INITIATIVE_LINKS = `
  MATCH (initiative:Entity:Initiative {id: $initiativeId})
  OPTIONAL MATCH (initiative)-[staleStrategyEdge:IMPLEMENTS]->(staleStrategy:Strategy)
  WHERE staleStrategyEdge.projectionOwner = $projectionOwner
    AND NOT staleStrategy.id IN $strategyIds
  WITH initiative, collect(staleStrategyEdge) AS staleStrategyEdges
  FOREACH (edge IN staleStrategyEdges | DELETE edge)
  WITH initiative, size(staleStrategyEdges) AS strategyEdgesRemoved

  UNWIND CASE WHEN size($strategyIds) = 0 THEN [null] ELSE $strategyIds END AS strategyId
  OPTIONAL MATCH (strategy:Entity:Strategy {id: strategyId})
  FOREACH (_ IN CASE WHEN strategy IS NULL THEN [] ELSE [1] END |
    MERGE (initiative)-[edge:IMPLEMENTS {projectionOwner: $projectionOwner}]->(strategy)
    ON CREATE SET edge.createdAt = timestamp()
    SET edge.updatedAt = timestamp(), edge.sourceField = 'linkedStrategyIds'
  )
  WITH initiative, strategyEdgesRemoved,
       [id IN collect(CASE WHEN strategy IS NULL THEN strategyId ELSE null END) WHERE id IS NOT NULL]
         AS missingStrategyIds,
       count(strategy) AS strategiesProjected

  OPTIONAL MATCH (stalePainPoint:PainPoint)-[stalePainPointEdge:DRIVES]->(initiative)
  WHERE stalePainPointEdge.projectionOwner = $projectionOwner
    AND NOT stalePainPoint.id IN $painPointIds
  WITH initiative, strategyEdgesRemoved, missingStrategyIds, strategiesProjected,
       collect(stalePainPointEdge) AS stalePainPointEdges
  FOREACH (edge IN stalePainPointEdges | DELETE edge)
  WITH initiative, strategyEdgesRemoved, missingStrategyIds, strategiesProjected,
       size(stalePainPointEdges) AS painPointEdgesRemoved

  UNWIND CASE WHEN size($painPointIds) = 0 THEN [null] ELSE $painPointIds END AS painPointId
  OPTIONAL MATCH (painPoint:Entity:PainPoint {id: painPointId})
  FOREACH (_ IN CASE WHEN painPoint IS NULL THEN [] ELSE [1] END |
    MERGE (painPoint)-[edge:DRIVES {projectionOwner: $projectionOwner}]->(initiative)
    ON CREATE SET edge.createdAt = timestamp()
    SET edge.updatedAt = timestamp(), edge.sourceField = 'linkedPainPointIds'
  )
  WITH strategyEdgesRemoved, missingStrategyIds, strategiesProjected, painPointEdgesRemoved,
       [id IN collect(CASE WHEN painPoint IS NULL THEN painPointId ELSE null END) WHERE id IS NOT NULL]
         AS missingPainPointIds,
       count(painPoint) AS painPointsProjected
  RETURN missingStrategyIds, missingPainPointIds, strategiesProjected, painPointsProjected,
         strategyEdgesRemoved, painPointEdgesRemoved
`;

function normalizeReferenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value
        .filter((candidate): candidate is string => typeof candidate === 'string')
        .map((candidate) => candidate.trim())
        .filter(Boolean)
    ),
  ];
}

export function buildInitiativeLinkProjection(
  initiativeId: string,
  source: Record<string, unknown>
): { query: string; params: Record<string, unknown> } {
  return {
    query: RECONCILE_INITIATIVE_LINKS,
    params: {
      initiativeId,
      strategyIds: normalizeReferenceIds(source.linkedStrategyIds),
      painPointIds: normalizeReferenceIds(source.linkedPainPointIds),
      projectionOwner: INITIATIVE_LINK_PROJECTION_OWNER,
    },
  };
}
