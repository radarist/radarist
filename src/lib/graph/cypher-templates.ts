/**
 * @file cypher-templates.ts
 * @description Reusable Cypher query templates for graph operations.
 *
 * This module provides parameterized Cypher queries for:
 * - Node retrieval and search
 * - Path finding (shortest, all paths)
 * - Multi-hop traversal
 * - Business-specific queries (impact, alignment, etc.)
 *
 * @author Radarist Team
 * @created 2026-01-09
 */

import neo4j from 'neo4j-driver';
import { orderBySchema, limitSchema } from './validation';
import { currentEdgePredicate, currentPathPredicate } from './current-edge-filter';

// ============================================================================
// NODE QUERIES
// ============================================================================

/**
 * Get a node by ID.
 * @param id - Node ID
 */
export const GET_NODE_BY_ID = `
  MATCH (n:Entity {id: $id})
  RETURN n
`;

/**
 * Get multiple nodes by IDs.
 * @param ids - Array of node IDs
 */
export const GET_NODES_BY_IDS = `
  MATCH (n:Entity)
  WHERE n.id IN $ids
  RETURN n
`;

/**
 * Search nodes by name (case-insensitive contains).
 * @param query - Search query
 * @param entityTypes - Optional entity type filter
 * @param limit - Max results
 */
export const SEARCH_NODES = `
  MATCH (n:Entity)
  WHERE toLower(n.name) CONTAINS toLower($query)
  AND ($entityTypes IS NULL OR n.entityType IN $entityTypes)
  RETURN n
  ORDER BY n.name
  LIMIT $limit
`;

/**
 * Get all nodes of a specific type.
 * @param entityType - Entity type
 * @param limit - Max results
 */
export const GET_NODES_BY_TYPE = `
  MATCH (n:Entity {entityType: $entityType})
  RETURN n
  ORDER BY n.updatedAt DESC
  LIMIT $limit
`;

// ============================================================================
// NEIGHBOR QUERIES
// ============================================================================

/**
 * Get direct neighbors of a node (1 hop).
 * @param nodeId - Source node ID
 * @param relationTypes - Optional relation type filter
 * @param entityTypes - Optional entity type filter
 * @param limit - Max results
 */
export const GET_NEIGHBORS = `
  MATCH (source:Entity {id: $nodeId})-[r]-(neighbor:Entity)
  WHERE ($relationTypes IS NULL OR type(r) IN $relationTypes)
  AND ($entityTypes IS NULL OR neighbor.entityType IN $entityTypes)
  AND ${currentEdgePredicate('r')}
  RETURN DISTINCT neighbor, type(r) AS relationType, COALESCE(r.effectiveConfidence, r.confidence) AS confidence
  ORDER BY COALESCE(r.effectiveConfidence, r.confidence) DESC, neighbor.name
  LIMIT $limit
`;

/**
 * Get neighbors with relationship details.
 * @param nodeId - Source node ID
 * @param direction - 'outgoing' | 'incoming' | 'both'
 * @param limit - Max results
 */
export const GET_NEIGHBORS_WITH_RELATIONS = `
  MATCH (source:Entity {id: $nodeId})
  OPTIONAL MATCH (source)-[out]->(outNeighbor:Entity)
  WHERE $direction IN ['outgoing', 'both']
  AND ${currentEdgePredicate('out')}
  OPTIONAL MATCH (source)<-[in]-(inNeighbor:Entity)
  WHERE $direction IN ['incoming', 'both']
  AND ${currentEdgePredicate('in')}
  RETURN
    COLLECT(DISTINCT {
      node: outNeighbor,
      relation: out,
      direction: 'outgoing'
    }) + COLLECT(DISTINCT {
      node: inNeighbor,
      relation: in,
      direction: 'incoming'
    }) AS neighbors
  LIMIT $limit
`;

/**
 * Get multi-hop neighbors (up to depth N).
 * @param nodeId - Source node ID
 * @param maxDepth - Maximum depth
 * @param entityTypes - Optional entity type filter
 * @param limit - Max results
 */
export const GET_MULTIHOP_NEIGHBORS = `
  MATCH path = (source:Entity {id: $nodeId})-[*1..$maxDepth]-(target:Entity)
  WHERE source <> target
  AND ($entityTypes IS NULL OR target.entityType IN $entityTypes)
  AND ${currentPathPredicate('path')}
  WITH target, min(length(path)) AS distance
  RETURN target, distance
  ORDER BY distance, target.name
  LIMIT $limit
`;

// ============================================================================
// PATH FINDING QUERIES
// ============================================================================

/**
 * Find the shortest path between two nodes.
 * @param fromId - Source node ID
 * @param toId - Target node ID
 * @param maxDepth - Maximum path length
 */
export const FIND_SHORTEST_PATH = `
  MATCH (start:Entity {id: $fromId}), (end:Entity {id: $toId})
  MATCH path = shortestPath((start)-[*1..$maxDepth]-(end))
  WHERE ${currentPathPredicate('path')}
  RETURN path
`;

/**
 * Find shortest path with relation type filter.
 * @param fromId - Source node ID
 * @param toId - Target node ID
 * @param relationTypes - Allowed relation types
 * @param maxDepth - Maximum path length
 */
export const FIND_SHORTEST_PATH_FILTERED = `
  MATCH (start:Entity {id: $fromId}), (end:Entity {id: $toId})
  MATCH path = shortestPath((start)-[r*1..$maxDepth]-(end))
  WHERE ALL(rel IN relationships(path) WHERE type(rel) IN $relationTypes)
  AND ${currentPathPredicate('path')}
  RETURN path
`;

/**
 * Find all paths between two nodes (up to limit).
 * @param fromId - Source node ID
 * @param toId - Target node ID
 * @param maxDepth - Maximum path length
 * @param pathLimit - Maximum number of paths
 */
export const FIND_ALL_PATHS = `
  MATCH (start:Entity {id: $fromId}), (end:Entity {id: $toId})
  MATCH path = (start)-[*1..$maxDepth]-(end)
  WHERE start <> end
  AND ${currentPathPredicate('path')}
  WITH path, length(path) AS pathLength
  ORDER BY pathLength
  RETURN path
  LIMIT $pathLimit
`;

/**
 * Find weighted shortest path (using confidence as weight).
 * Lower confidence = higher cost, so we want to maximize confidence.
 * @param fromId - Source node ID
 * @param toId - Target node ID
 * @param maxDepth - Maximum path length
 */
export const FIND_WEIGHTED_PATH = `
  MATCH (start:Entity {id: $fromId}), (end:Entity {id: $toId})
  CALL gds.shortestPath.dijkstra.stream({
    sourceNode: start,
    targetNode: end,
    relationshipWeightProperty: 'weight'
  }) YIELD path, totalCost
  RETURN path, totalCost
  LIMIT 1
`;

/**
 * Find path with node labels.
 * Returns detailed path info with all node and relationship data.
 * @param fromId - Source node ID
 * @param toId - Target node ID
 * @param maxDepth - Maximum path length
 */
export const FIND_PATH_DETAILED = `
  MATCH (start:Entity {id: $fromId}), (end:Entity {id: $toId})
  MATCH path = shortestPath((start)-[*1..$maxDepth]-(end))
  WHERE ${currentPathPredicate('path')}
  RETURN
    [n IN nodes(path) | {
      id: n.id,
      name: n.name,
      entityType: n.entityType,
      labels: labels(n)
    }] AS pathNodes,
    [r IN relationships(path) | {
      type: type(r),
      confidence: coalesce(r.effectiveConfidence, r.confidence),
      sourceId: startNode(r).id,
      targetId: endNode(r).id
    }] AS pathRelations,
    length(path) AS pathLength
`;

// ============================================================================
// TRAVERSAL QUERIES
// ============================================================================

/**
 * Find all entities connected to a node of a specific type.
 * @param nodeId - Source node ID
 * @param targetType - Target entity type
 * @param maxDepth - Maximum depth
 * @param limit - Max results
 */
export const FIND_CONNECTED_BY_TYPE = `
  MATCH path = (source:Entity {id: $nodeId})-[*1..$maxDepth]-(target:Entity {entityType: $targetType})
  WHERE source <> target
  AND ${currentPathPredicate('path')}
  WITH target, min(length(path)) AS distance
  RETURN target, distance
  ORDER BY distance, target.name
  LIMIT $limit
`;

/**
 * Find entities connected through specific relation types.
 * @param nodeId - Source node ID
 * @param relationTypes - Allowed relation types
 * @param maxDepth - Maximum depth
 * @param limit - Max results
 */
export const FIND_CONNECTED_VIA_RELATIONS = `
  MATCH path = (source:Entity {id: $nodeId})-[r*1..$maxDepth]-(target:Entity)
  WHERE source <> target
  AND ALL(rel IN relationships(path) WHERE type(rel) IN $relationTypes)
  AND ${currentPathPredicate('path')}
  WITH target, min(length(path)) AS distance,
       [r IN relationships(path) | type(r)] AS relTypes
  RETURN target, distance, relTypes
  ORDER BY distance, target.name
  LIMIT $limit
`;

/**
 * Check if two nodes are connected within N hops.
 * @param fromId - Source node ID
 * @param toId - Target node ID
 * @param maxDepth - Maximum depth
 */
export const ARE_CONNECTED = `
  MATCH (start:Entity {id: $fromId}), (end:Entity {id: $toId})
  RETURN EXISTS {
    MATCH path = (start)-[*1..$maxDepth]-(end)
    WHERE ${currentPathPredicate('path')}
  } AS connected
`;

// ============================================================================
// BUSINESS QUERIES - IMPACT & ALIGNMENT
// ============================================================================

/**
 * Find technologies that solve a pain point.
 * @param painPointId - Pain point ID
 * @param maxDepth - Maximum depth (default 2)
 */
export const FIND_SOLUTIONS_FOR_PAIN_POINT = `
  MATCH (pain:Entity {id: $painPointId, entityType: 'painPoint'})
  MATCH path = (pain)-[:SOLVES*1..$maxDepth]-(tech:Entity {entityType: 'technology'})
  WHERE ${currentPathPredicate('path')}
  WITH tech, min(length(path)) AS distance,
       [r IN relationships(path) | coalesce(r.effectiveConfidence, r.confidence)] AS confidences
  RETURN tech, distance,
         reduce(c = 100, conf IN confidences | c * conf / 100) AS effectiveConfidence
  ORDER BY effectiveConfidence DESC, distance
  LIMIT $limit
`;

/**
 * Find pain points affected by an org unit.
 * @param orgUnitId - Org unit ID
 * @param maxDepth - Maximum depth
 */
export const FIND_PAIN_POINTS_FOR_ORG_UNIT = `
  MATCH (org:Entity {id: $orgUnitId, entityType: 'orgUnit'})
  MATCH path = (org)-[:RELATED_TO*1..$maxDepth]-(pain:Entity {entityType: 'painPoint'})
  WHERE ALL(rel IN relationships(path) WHERE rel.sourceRelationType = 'experiences')
  AND ${currentPathPredicate('path')}
  WITH pain, min(length(path)) AS distance
  RETURN pain, distance
  ORDER BY pain.severity DESC, distance
  LIMIT $limit
`;

/**
 * Find technologies aligned with a strategy.
 * @param strategyId - Strategy ID
 * @param maxDepth - Maximum depth
 */
export const FIND_TECHNOLOGIES_FOR_STRATEGY = `
  MATCH (strategy:Entity {id: $strategyId, entityType: 'strategy'})
  MATCH path = (strategy)-[:ALIGNS_WITH*1..$maxDepth]-(tech:Entity {entityType: 'technology'})
  WHERE ${currentPathPredicate('path')}
  WITH tech, min(length(path)) AS distance,
       [r IN relationships(path) | coalesce(r.effectiveConfidence, r.confidence)] AS confidences
  RETURN tech, distance,
         reduce(c = 100, conf IN confidences | c * conf / 100) AS alignmentScore
  ORDER BY alignmentScore DESC, distance
  LIMIT $limit
`;

/**
 * Find the impact chain: Technology → Use Cases → Org Units.
 * @param techId - Technology ID
 * @param maxDepth - Maximum depth
 */
export const FIND_TECHNOLOGY_IMPACT = `
  MATCH (tech:Entity {id: $techId, entityType: 'technology'})
  OPTIONAL MATCH techToUseCase = (tech)-[:REQUIRES]-(useCase:Entity {entityType: 'useCase'})
  WHERE techToUseCase IS NULL OR ${currentPathPredicate('techToUseCase')}
  OPTIONAL MATCH useCaseToOrg = (useCase)-[:ADDRESSES]-(:Entity {entityType: 'painPoint'})-[:IMPACTS]-(org:Entity {entityType: 'orgUnit'})
  WHERE useCaseToOrg IS NULL OR ${currentPathPredicate('useCaseToOrg')}
  WITH tech,
       COLLECT(DISTINCT {
         useCase: useCase,
         distance: length(techToUseCase)
       }) AS useCases,
       COLLECT(DISTINCT {
         orgUnit: org,
         viaUseCase: useCase.name,
         distance: length(techToUseCase) + length(useCaseToOrg)
       }) AS orgUnits
  RETURN tech, useCases, orgUnits
`;

/**
 * Find initiatives addressing a pain point.
 * @param painPointId - Pain point ID
 */
export const FIND_INITIATIVES_FOR_PAIN_POINT = `
  MATCH (pain:Entity {id: $painPointId, entityType: 'painPoint'})
  MATCH (pain)-[initiativeRel:DRIVES]-(initiative:Entity {entityType: 'initiative'})
  WHERE ${currentEdgePredicate('initiativeRel')}
  RETURN initiative
  ORDER BY initiative.priority DESC, initiative.name
`;

/**
 * Find companies providing technologies for a strategy.
 * @param strategyId - Strategy ID
 * @param maxDepth - Maximum depth
 */
export const FIND_VENDORS_FOR_STRATEGY = `
  MATCH (strategy:Entity {id: $strategyId, entityType: 'strategy'})
  MATCH path = (strategy)-[:ALIGNS_WITH]-(tech:Entity {entityType: 'technology'})-[vendorRel:VENDOR]-(company:Entity {entityType: 'company'})
  WHERE ${currentPathPredicate('path')}
  WITH company, tech, strategy, length(path) AS distance
  RETURN company,
         COLLECT(DISTINCT tech.name) AS technologies,
         min(distance) AS closestDistance
  ORDER BY closestDistance, company.name
  LIMIT $limit
`;

// ============================================================================
// BUSINESS QUERIES - DISCOVERY
// ============================================================================

/**
 * Find potential use cases for a technology.
 * Discovers use cases that similar technologies enable.
 * @param techId - Technology ID
 */
export const DISCOVER_USE_CASES = `
  MATCH (tech:Entity {id: $techId, entityType: 'technology'})
  MATCH (tech)-[similarRel:COMPETES_WITH|RELATED_TO]-(similarTech:Entity {entityType: 'technology'})
  MATCH (similarTech)-[requireRel:REQUIRES]-(useCase:Entity {entityType: 'useCase'})
  WHERE ${currentEdgePredicate('similarRel')}
  AND (type(similarRel) = 'COMPETES_WITH' OR similarRel.sourceRelationType = 'alternative_to')
  AND ${currentEdgePredicate('requireRel')}
  AND NOT EXISTS {
    MATCH (tech)-[existingRel:REQUIRES]-(useCase)
    WHERE ${currentEdgePredicate('existingRel')}
  }
  WITH useCase, COUNT(DISTINCT similarTech) AS supportingTechs
  RETURN useCase, supportingTechs
  ORDER BY supportingTechs DESC
  LIMIT $limit
`;

/**
 * Find gaps: Org units with pain points but no addressing initiatives.
 */
export const FIND_UNADDRESSED_PAIN_POINTS = `
  MATCH (org:Entity {entityType: 'orgUnit'})-[painRel:RELATED_TO]-(pain:Entity {entityType: 'painPoint'})
  WHERE ${currentEdgePredicate('painRel')}
  AND painRel.sourceRelationType = 'experiences'
  AND NOT EXISTS {
    MATCH (pain)-[addressRel:ADDRESSES]-(initiative:Entity {entityType: 'initiative'})
    WHERE ${currentEdgePredicate('addressRel')}
  }
  RETURN org, COLLECT(pain) AS unaddressedPainPoints
  ORDER BY SIZE(COLLECT(pain)) DESC
`;

/**
 * Find technologies without prototypes.
 * Useful for identifying areas needing experimentation.
 */
export const FIND_TECHNOLOGIES_WITHOUT_PROTOTYPES = `
  MATCH (tech:Entity {entityType: 'technology'})
  WHERE NOT EXISTS {
    MATCH (tech)-[prototypeRel:SUPPORTS]-(proto:Entity {entityType: 'prototype'})
    WHERE ${currentEdgePredicate('prototypeRel')}
  }
  RETURN tech
  ORDER BY tech.name
  LIMIT $limit
`;

// ============================================================================
// STATISTICS QUERIES
// ============================================================================

/**
 * Get graph statistics.
 */
export const GET_GRAPH_STATS = `
  MATCH (n:Entity)
  WITH n.entityType AS entityType, COUNT(n) AS count
  RETURN entityType, count
  ORDER BY count DESC
`;

/**
 * Get relationship statistics.
 */
export const GET_RELATIONSHIP_STATS = `
  MATCH ()-[r]->()
  WHERE ${currentEdgePredicate('r')}
  WITH type(r) AS relationType, COUNT(r) AS count
  RETURN relationType, count
  ORDER BY count DESC
`;

/**
 * Get connectivity statistics for a node.
 * @param nodeId - Node ID
 */
export const GET_NODE_CONNECTIVITY = `
  MATCH (n:Entity {id: $nodeId})
  OPTIONAL MATCH (n)-[out]->()
  WHERE ${currentEdgePredicate('out')}
  OPTIONAL MATCH (n)<-[in]-()
  WHERE ${currentEdgePredicate('in')}
  RETURN
    COUNT(DISTINCT out) AS outgoingCount,
    COUNT(DISTINCT in) AS incomingCount,
    COUNT(DISTINCT out) + COUNT(DISTINCT in) AS totalConnections
`;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Build a parameterized Cypher query with optional clauses.
 */
export function buildQuery(
  baseQuery: string,
  options: {
    relationTypes?: string[];
    entityTypes?: string[];
    minConfidence?: number;
    curatedOnly?: boolean;
    limit?: number;
    orderBy?: string;
  }
): { query: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  let whereClause = '';
  const whereParts: string[] = [];

  if (options.relationTypes?.length) {
    whereParts.push('type(r) IN $relationTypes');
    params.relationTypes = options.relationTypes;
  }

  if (options.entityTypes?.length) {
    whereParts.push('target.entityType IN $entityTypes');
    params.entityTypes = options.entityTypes;
  }

  if (options.minConfidence !== undefined) {
    whereParts.push('coalesce(r.effectiveConfidence, r.confidence) >= $minConfidence');
    params.minConfidence = options.minConfidence;
  }

  if (options.curatedOnly) {
    whereParts.push("r.claimStatus = 'curated'");
  }

  if (whereParts.length > 0) {
    whereClause = `WHERE ${whereParts.join(' AND ')}`;
  }

  let query = baseQuery;
  if (whereClause) {
    query = query.replace('RETURN', `${whereClause}\nRETURN`);
  }

  if (options.orderBy) {
    // Whitelist column — Cypher cannot bind ORDER BY columns as parameters.
    const orderByToken = orderBySchema.parse(options.orderBy);
    // B0: the 'r.confidence' enum token maps to the COALESCE expression so
    // ordering honours effectiveConfidence too — the enum value itself is
    // unchanged (API callers keep passing 'r.confidence').
    const orderByExpr =
      orderByToken === 'r.confidence' ? 'coalesce(r.effectiveConfidence, r.confidence)' : orderByToken;
    query += `\nORDER BY ${orderByExpr}`;
  }

  if (options.limit) {
    // Parameterize LIMIT (Cypher supports param binding here) and coerce
    // through limitSchema to reject "10; DROP" / oversize / NaN.
    query += `\nLIMIT $limit`;
    params.limit = neo4j.int(limitSchema.parse(options.limit));
  }

  return { query, params };
}

/**
 * Safe parameter substitution for numeric depth values.
 * Cypher doesn't support parameterized path lengths, so we need to substitute.
 */
export function substituteDepth(query: string, depth: number): string {
  // Validate depth to prevent injection
  const safeDepth = Math.min(Math.max(1, Math.floor(depth)), 10);
  return query.replace(/\$maxDepth/g, String(safeDepth));
}
