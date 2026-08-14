/**
 * @file traversal.ts
 * @description High-level graph traversal functions for business logic.
 *
 * This module provides a clean API for common graph operations:
 * - Finding neighbors and connections
 * - Path finding and explanation
 * - Multi-hop traversal with filtering
 *
 * Uses the GraphService abstraction for backend-agnostic operations.
 *
 * @phase Phase 5: GraphRAG Reasoning Engine
 * @author Radarist Team
 * @created 2026-01-09
 */

import type { TransformationEntityType } from '@/lib/types';
import type { GraphNode, GraphPath, NeighborOptions, PathFindingOptions, TraversalOptions } from './interface';
import { getGraphService } from './service-factory';
import { neighborsCache, pathCache, buildNeighborsCacheKey, buildPathCacheKey } from './query-cache';
import { relationTypeToVerbPhrase } from './relation-registry';
import { businessEntityGraphType, filterBusinessEntityNodes, isBusinessEntityNode } from './business-entity-identity';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Result of a connection check with path details.
 */
export interface ConnectionResult {
  /** Whether the nodes are connected */
  connected: boolean;
  /** Path between nodes (if connected) */
  path?: GraphPath;
  /** Distance in hops (if connected) */
  distance?: number;
}

/**
 * Entity with distance information from traversal.
 */
export interface EntityWithDistance {
  /** The entity */
  entity: GraphNode;
  /** Distance from source (in hops) */
  distance: number;
  /** Relation types used to reach this entity */
  viaRelations?: string[];
}

/**
 * Connection explanation for AI/user consumption.
 */
export interface ConnectionExplanation {
  /** Whether a connection exists */
  connected: boolean;
  /** Human-readable explanation */
  explanation: string;
  /** Path nodes with labels */
  pathNodes: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  /** Path relationships */
  pathRelations: Array<{
    type: string;
    from: string;
    to: string;
  }>;
  /** Total path length */
  hops: number;
}

// ============================================================================
// NEIGHBOR OPERATIONS
// ============================================================================

/**
 * Get immediate neighbors of an entity.
 *
 * @example
 * ```typescript
 * const neighbors = await getNeighbors('tech-react', {
 *   entityTypes: ['company', 'useCase'],
 *   limit: 10
 * });
 * ```
 */
export async function getNeighbors(entityId: string, options: NeighborOptions = {}): Promise<GraphNode[]> {
  const cacheKey = buildNeighborsCacheKey(entityId, options);

  return neighborsCache.getOrFetch(cacheKey, async () => {
    const service = await getGraphService();
    // AI-026: the Neo4j backend enforces the identity envelope in Cypher; this
    // guard makes the mock and Firestore-fallback backends answer the same
    // question, so a degraded runtime cannot surface what the primary refuses.
    // A single requested type is additionally label-pinned.
    const requiredType = options.entityTypes?.length === 1 ? options.entityTypes[0] : undefined;
    return filterBusinessEntityNodes(await service.getNeighbors(entityId, options), requiredType);
  }) as Promise<GraphNode[]>;
}

/**
 * Get neighbors of a specific type.
 *
 * @example
 * ```typescript
 * const companies = await getNeighborsByType('tech-react', 'company');
 * ```
 */
export async function getNeighborsByType(
  entityId: string,
  targetType: TransformationEntityType,
  limit = 50
): Promise<GraphNode[]> {
  return getNeighbors(entityId, {
    entityTypes: [targetType],
    limit,
  });
}

/**
 * Get neighbors connected via specific relationship types.
 *
 * @example
 * ```typescript
 * const solvedPainPoints = await getNeighborsByRelation(
 *   'tech-react',
 *   ['SOLVES', 'ADDRESSES']
 * );
 * ```
 */
export async function getNeighborsByRelation(
  entityId: string,
  relationTypes: string[],
  options: { limit?: number; direction?: 'outgoing' | 'incoming' | 'both' } = {}
): Promise<GraphNode[]> {
  return getNeighbors(entityId, {
    relationTypes,
    limit: options.limit ?? 50,
    ...(options.direction ? { direction: options.direction } : {}),
  });
}

// ============================================================================
// MULTI-HOP TRAVERSAL
// ============================================================================

/**
 * Find all entities of a type reachable within N hops.
 *
 * @example
 * ```typescript
 * const orgUnits = await findConnected('tech-react', 'org_unit', {
 *   maxDepth: 3
 * });
 * ```
 */
export async function findConnected(
  entityId: string,
  targetType: TransformationEntityType,
  options: TraversalOptions = {}
): Promise<GraphNode[]> {
  const service = await getGraphService();
  // AI-026: label-pinned to the requested type, so every backend answers the
  // same question the Neo4j Cypher envelope does.
  return filterBusinessEntityNodes(await service.findConnected(entityId, targetType, options), targetType);
}

/**
 * Find all entities of a type with distance information.
 *
 * @example
 * ```typescript
 * const results = await findConnectedWithDistance('tech-react', 'org_unit');
 * results.forEach(r => console.log(`${r.entity.name}: ${r.distance} hops`));
 * ```
 */
export async function findConnectedWithDistance(
  entityId: string,
  targetType: TransformationEntityType,
  options: TraversalOptions = {}
): Promise<EntityWithDistance[]> {
  const service = await getGraphService();
  const startNode = await service.getNode(entityId);
  // AI-026: an internal-memory id is not a traversal origin. Refusing here keeps
  // the Cypher-side envelope and the backend-agnostic guard in agreement instead
  // of returning an empty list for a reason the caller cannot distinguish.
  if (!startNode || !isBusinessEntityNode(startNode)) return [];

  const connected = filterBusinessEntityNodes(await service.findConnected(entityId, targetType, options), targetType);
  const results: EntityWithDistance[] = [];

  // Get distance for each connected node
  for (const node of connected) {
    const path = await service.findPath(entityId, node.id, {
      maxDepth: options.maxDepth || 4,
    });

    results.push({
      entity: node,
      distance: path?.length || 0,
      viaRelations: path?.relations.map((r) => r.type),
    });
  }

  // Sort by distance
  return results.sort((a, b) => a.distance - b.distance);
}

// ============================================================================
// PATH FINDING
// ============================================================================

/**
 * Find the shortest path between two entities.
 *
 * @example
 * ```typescript
 * const path = await findPath('tech-react', 'org-dairy');
 * if (path) {
 *   console.log(`Path length: ${path.length} hops`);
 * }
 * ```
 */
export async function findPath(
  fromId: string,
  toId: string,
  options: PathFindingOptions = {}
): Promise<GraphPath | null> {
  // H9: the full options object participates in the key — filtered and
  // unfiltered lookups must never share a cache entry.
  const cacheKey = buildPathCacheKey(fromId, toId, options);

  return pathCache.getOrFetch(cacheKey, async () => {
    const service = await getGraphService();
    return businessEntityPathOrNull(
      await service.findPath(fromId, toId, {
        maxDepth: options.maxDepth || 6,
        ...options,
      })
    );
  }) as Promise<GraphPath | null>;
}

/**
 * AI-026 — drop a path that hops through anything but business entities.
 *
 * The Neo4j backend already refuses such a path in Cypher; this keeps the mock
 * and Firestore-fallback backends from producing a "connection" the primary
 * would not, and makes the rule visible at the layer every caller uses.
 */
function businessEntityPathOrNull(path: GraphPath | null): GraphPath | null {
  if (!path) return null;
  return path.nodes.every((node) => node && isBusinessEntityNode(node)) ? path : null;
}

/**
 * Find all paths between two entities.
 *
 * @example
 * ```typescript
 * const paths = await findAllPaths('tech-react', 'org-dairy', {
 *   maxDepth: 4,
 *   pathLimit: 5
 * });
 * ```
 */
export async function findAllPaths(
  fromId: string,
  toId: string,
  options: PathFindingOptions = {}
): Promise<GraphPath[]> {
  const service = await getGraphService();
  const paths = await service.findAllPaths(fromId, toId, {
    maxDepth: options.maxDepth || 4,
    pathLimit: options.pathLimit || 10,
    ...options,
  });
  return paths.filter((path): path is GraphPath => businessEntityPathOrNull(path) !== null);
}

/**
 * Check if two entities are connected.
 *
 * @example
 * ```typescript
 * const result = await checkConnection('tech-react', 'org-dairy');
 * if (result.connected) {
 *   console.log(`Connected via ${result.distance} hops`);
 * }
 * ```
 */
export async function checkConnection(fromId: string, toId: string, maxDepth = 6): Promise<ConnectionResult> {
  const service = await getGraphService();
  const path = businessEntityPathOrNull(await service.findPath(fromId, toId, { maxDepth }));

  return {
    connected: path !== null,
    path: path || undefined,
    distance: path?.length,
  };
}

// ============================================================================
// CONNECTION EXPLANATION
// ============================================================================

/**
 * Explain the connection between two entities in natural language.
 * Used by AI tools and for user-facing explanations.
 *
 * @example
 * ```typescript
 * const explanation = await explainConnection('tech-react', 'org-dairy');
 * console.log(explanation.explanation);
 * // "React is connected to Dairy Division through 2 hops:
 * //  React SOLVES UI Performance, which IMPACTS Dairy Division."
 * ```
 */
export async function explainConnection(
  fromId: string,
  toId: string,
  options: PathFindingOptions = {}
): Promise<ConnectionExplanation> {
  const service = await getGraphService();

  // Get both nodes first
  const [fromNode, toNode] = await Promise.all([service.getNode(fromId), service.getNode(toId)]);

  // AI-026: an id that resolves to internal memory is not an entity this
  // explanation can be about. Reported as "cannot find" rather than "not
  // connected" — the latter would imply the endpoint was a real entity.
  if (!fromNode || !toNode || !isBusinessEntityNode(fromNode) || !isBusinessEntityNode(toNode)) {
    return {
      connected: false,
      explanation: `Cannot find one or both entities (${fromId}, ${toId}).`,
      pathNodes: [],
      pathRelations: [],
      hops: 0,
    };
  }

  // Find the path
  const path = await service.findPath(fromId, toId, {
    maxDepth: options.maxDepth || 6,
    ...options,
  });

  if (!path) {
    return {
      connected: false,
      explanation: `No connection found between "${fromNode.properties.name}" and "${toNode.properties.name}" within ${options.maxDepth || 6} hops.`,
      pathNodes: [],
      pathRelations: [],
      hops: 0,
    };
  }

  // Build explanation. AI-026: the reported type comes from the canonical label
  // first, so a node can never be described as the type its `entityType`
  // property merely claims.
  const pathNodes = path.nodes.map((node) => ({
    id: node?.id || 'unknown',
    name: String(node?.properties?.name || node?.id || 'unknown'),
    type: (node && businessEntityGraphType(node)) || 'unknown',
  }));

  const pathRelations = path.relations.map((rel, i) => ({
    type: rel?.type || 'RELATED_TO',
    from: pathNodes[i]?.name || 'unknown',
    to: pathNodes[i + 1]?.name || 'unknown',
  }));

  // Build natural language explanation
  const parts: string[] = [];
  for (let i = 0; i < pathRelations.length; i++) {
    const rel = pathRelations[i];
    const verb = relationToVerb(rel.type);
    if (i === 0) {
      parts.push(`${rel.from} ${verb} ${rel.to}`);
    } else {
      parts.push(`which ${verb} ${rel.to}`);
    }
  }

  const explanation =
    path.length === 1
      ? `"${pathNodes[0].name}" is directly connected to "${pathNodes[pathNodes.length - 1].name}" via ${pathRelations[0].type}.`
      : `"${pathNodes[0].name}" is connected to "${pathNodes[pathNodes.length - 1].name}" through ${path.length} hops: ${parts.join(', ')}.`;

  return {
    connected: true,
    explanation,
    pathNodes,
    pathRelations,
    hops: path.length,
  };
}

// ============================================================================
// BATCH OPERATIONS
// ============================================================================

/**
 * Get multiple entities by IDs.
 *
 * @example
 * ```typescript
 * const entities = await getEntities(['tech-react', 'company-google']);
 * ```
 */
export async function getEntities(ids: string[]): Promise<GraphNode[]> {
  const service = await getGraphService();
  return filterBusinessEntityNodes(await service.getNodes(ids));
}

/**
 * Get a single entity by ID.
 *
 * @example
 * ```typescript
 * const tech = await getEntity('tech-react');
 * ```
 */
export async function getEntity(id: string): Promise<GraphNode | null> {
  const service = await getGraphService();
  const node = await service.getNode(id);
  // AI-026: `getNode` is a raw node fetcher by id with no label constraint — it
  // is the authoritative-ID lane, and every consumer of THIS function (AI tool
  // context, citations, visualization resolution, the observation writer's own
  // entityType derivation) treats what it returns as a business entity. Prove it
  // here rather than at each call site.
  return node && isBusinessEntityNode(node) ? node : null;
}

/**
 * Check multiple connections in parallel.
 *
 * @example
 * ```typescript
 * const results = await checkMultipleConnections('tech-react', [
 *   'org-dairy', 'org-beverage', 'org-snacks'
 * ]);
 * ```
 */
export async function checkMultipleConnections(
  fromId: string,
  toIds: string[],
  maxDepth = 6
): Promise<Map<string, ConnectionResult>> {
  const results = new Map<string, ConnectionResult>();

  await Promise.all(
    toIds.map(async (toId) => {
      const result = await checkConnection(fromId, toId, maxDepth);
      results.set(toId, result);
    })
  );

  return results;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert relation type to natural language verb.
 */
function relationToVerb(relationType: string): string {
  return relationTypeToVerbPhrase(relationType);
}

/**
 * Format a path as a simple string for logging/debugging.
 */
export function formatPath(path: GraphPath): string {
  if (!path || !path.nodes || path.nodes.length === 0) return '(empty path)';

  const parts: string[] = [];
  for (let i = 0; i < path.nodes.length; i++) {
    const node = path.nodes[i];
    const name = String(node?.properties?.name || node?.id || 'unknown');
    parts.push(name);

    if (path.relations && i < path.relations.length) {
      const rel = path.relations[i];
      parts.push(`-[${rel?.type || 'RELATED_TO'}]->`);
    }
  }

  return parts.join(' ');
}

/**
 * Get a summary of the graph service health and backend.
 */
export async function getGraphStatus(): Promise<{
  healthy: boolean;
  backend: string;
  latencyMs: number;
  error?: string;
}> {
  const service = await getGraphService();
  return service.getHealthDetails();
}
