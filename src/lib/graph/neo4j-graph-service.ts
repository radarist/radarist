/**
 * @file neo4j-graph-service.ts
 * @description Neo4j implementation of the IGraphService interface.
 *
 * This module wraps the low-level neo4j-client with the GraphService abstraction,
 * providing a clean API for graph operations.
 *
 * @phase Phase 5: GraphRAG Reasoning Engine
 * @author Radarist Team
 * @created 2026-01-09
 */

import neo4j from 'neo4j-driver';
import type { TransformationEntityType } from '@/lib/types';
import {
  getDriver,
  closeDriver,
  runQuery,
  runReadTransaction,
  runWriteTransaction,
  checkHealth as checkNeo4jHealth,
} from './neo4j-client';
import { buildRelationDefaults } from './relation-defaults';
import { expandEntityTypes } from './entity-type-vocab';
import {
  businessEntityIdentityCypher,
  businessEntityIdentityParams,
  businessEntityTypeScopeCypher,
  graphLabelsForEntityTypes,
} from './business-entity-identity';
import { relationTypeCypherSchema, labelSchema, depthSchema, limitSchema } from './validation';
import type {
  IGraphService,
  GraphNode,
  GraphRelation,
  GraphPath,
  GraphQueryResult,
  NeighborOptions,
  PathFindingOptions,
  TraversalOptions,
} from './interface';
import { createLogger } from '@/lib/logger';

const log = createLogger('graph/neo4j-service');

/**
 * Validate a caller's `nodeLabels` filter, or `null` when there is nothing to
 * filter on. Labels cannot be parameter-bound in Cypher, so every value is
 * shape-checked before it reaches a query string — same posture as
 * `relationTypeCypherSchema` for relationship types.
 */
function parseNodeLabels(nodeLabels: readonly string[] | undefined): string[] | null {
  if (!nodeLabels?.length) return null;
  return nodeLabels.map((label) => labelSchema.parse(label));
}

/**
 * Require EVERY node on `pathVariable` to carry one of `labels`.
 *
 * Restricting only the endpoints would still admit a path that hops through a
 * bookkeeping node, which is the whole point of the filter (GRAPH-062).
 */
function nodeLabelPathCondition(pathVariable: string, labels: readonly string[]): string {
  const labelList = labels.map((label) => `'${label}'`).join(', ');
  return `ALL(node IN nodes(${pathVariable}) WHERE ANY(label IN labels(node) WHERE label IN [${labelList}]))`;
}

/**
 * AI-026 — every node on `pathVariable` must be a business entity.
 *
 * This service is the one place where BOTH filtering styles used to be absent:
 * `findConnected`/`getNeighbors` decided entity type from the `entityType`
 * PROPERTY alone, and `findPath`/`findAllPaths` constrained nothing unless a
 * caller opted in with `nodeLabels`. An `:AgentObservation` carries the
 * `entityType` of the entity it is ABOUT, so a property-only filter answered
 * "yes, this is a Technology" about an observation — and an untyped `[*1..d]`
 * pattern reached it over the bare `ABOUT` edge, which carries no
 * `t_invalidated` or `claimStatus` and therefore passes every temporal filter.
 *
 * Applied to EVERY node rather than the endpoints, for the same reason
 * `nodeLabelPathCondition` is (GRAPH-062): a hop through a bookkeeping node
 * cannot produce a business fact, and an `:Assertion` hop in particular just
 * duplicates the typed edge the Relation contract already materializes — or, for
 * an unmaterialized claim, asserts a connection the materialization gate
 * deliberately withheld.
 *
 * `businessEntityIdentityParams()` must be bound by the caller.
 */
function businessEntityPathCondition(pathVariable: string): string {
  return `ALL(identityNode IN nodes(${pathVariable}) WHERE ${businessEntityIdentityCypher('identityNode')})`;
}

// ============================================================================
// NEO4J GRAPH SERVICE
// ============================================================================

/**
 * Neo4j implementation of IGraphService.
 * Production-ready graph service using Neo4j as the backend.
 */
export class Neo4jGraphService implements IGraphService {
  private connected = false;

  // ==========================================================================
  // CONNECTION MANAGEMENT
  // ==========================================================================

  async connect(): Promise<void> {
    try {
      // Initialize driver (singleton)
      getDriver();
      // Verify connection
      const health = await checkNeo4jHealth();
      if (!health.healthy) {
        throw new Error(`Neo4j connection failed: ${health.error}`);
      }
      this.connected = true;
      log.info('Connected successfully');
    } catch (error) {
      this.connected = false;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await closeDriver();
    this.connected = false;
    log.info('Disconnected');
  }

  async isHealthy(): Promise<boolean> {
    const health = await checkNeo4jHealth();
    return health.healthy;
  }

  async getHealthDetails(): Promise<{
    healthy: boolean;
    latencyMs: number;
    error?: string;
    backend: string;
  }> {
    const health = await checkNeo4jHealth();
    return {
      ...health,
      backend: 'neo4j',
    };
  }

  // ==========================================================================
  // READ OPERATIONS
  // ==========================================================================

  async query(queryString: string, params: Record<string, unknown> = {}): Promise<GraphQueryResult> {
    const start = Date.now();
    const result = await runQuery(queryString, params);
    return {
      records: result.records,
      summary: result.summary.counters,
      executionTimeMs: Date.now() - start,
    };
  }

  async getNode(id: string): Promise<GraphNode | null> {
    const cypher = `
      MATCH (n {id: $id})
      RETURN n, labels(n) AS labels
    `;
    const result = await runReadTransaction<{ n: Record<string, unknown>; labels: string[] }>(cypher, { id });

    if (result.records.length === 0) {
      return null;
    }

    const record = result.records[0];
    return {
      id,
      labels: record.labels,
      properties: record.n,
    };
  }

  async getNodes(ids: string[]): Promise<GraphNode[]> {
    if (ids.length === 0) return [];

    const cypher = `
      MATCH (n)
      WHERE n.id IN $ids
      RETURN n, labels(n) AS labels
    `;
    const result = await runReadTransaction<{ n: Record<string, unknown>; labels: string[] }>(cypher, { ids });

    return result.records.map((r) => ({
      id: r.n.id as string,
      labels: r.labels,
      properties: r.n,
    }));
  }

  async getNeighbors(nodeId: string, options: NeighborOptions = {}): Promise<GraphNode[]> {
    const {
      depth = 1,
      relationTypes,
      entityTypes,
      nodeLabels,
      limit: rawLimit = 100,
      includeRelations: _includeRelations = false,
      direction = 'both',
      includeHistory = false,
    } = options;

    // Coerce + clamp limit (rejects "10; DROP" injection, NaN, oversize)
    const limit = limitSchema.parse(rawLimit);
    // Coerce + clamp path-length quantifier
    const safeDepth = depthSchema.parse(depth);

    // Build relationship pattern — every relation type is whitelisted
    // against the RelationType union before interpolation.
    const safeRelTypes = relationTypes?.map((t) => relationTypeCypherSchema.parse(t));
    const relPattern = safeRelTypes?.length ? `[:${safeRelTypes.join('|')}*1..${safeDepth}]` : `[*1..${safeDepth}]`;

    // Directed pattern (default 'both' = undirected, byte-identical to prior behavior).
    // 'outgoing' = (source)-[rel]->(neighbor); 'incoming' = (source)<-[rel]-(neighbor).
    const leftArrow = direction === 'incoming' ? '<-' : '-';
    const rightArrow = direction === 'outgoing' ? '->' : '-';

    // AI-026: a requested entity type is proven by the neighbor's canonical
    // LABEL. `expandEntityTypes` still supplies the camelCase/snake_case
    // vocabulary (H2), but only so the property can stand in for an endpoint
    // placeholder that carries no canonical label at all — never for a node that
    // merely copied the property.
    const targetTypes = entityTypes?.length ? expandEntityTypes(entityTypes) : null;
    const entityTypeFilter = targetTypes ? `AND ${businessEntityTypeScopeCypher('neighbor')}` : '';

    // H1: F1-superseded edges (t_invalidated set) are history, not current
    // facts — exclude them unless the caller explicitly opts in.
    const temporalFilter = includeHistory
      ? ''
      : "AND ALL(rel IN relationships(p) WHERE rel.t_invalidated IS NULL AND coalesce(rel.claimStatus, 'curated') <> 'rejected')";

    const safeNodeLabels = parseNodeLabels(nodeLabels);
    const nodeLabelFilter = safeNodeLabels ? `AND ${nodeLabelPathCondition('p', safeNodeLabels)}` : '';

    const cypher = `
      MATCH p = (source {id: $nodeId})${leftArrow}${relPattern}${rightArrow}(neighbor)
      WHERE source <> neighbor
        AND ${businessEntityPathCondition('p')}
        ${temporalFilter}
        ${entityTypeFilter}
        ${nodeLabelFilter}
      RETURN DISTINCT neighbor, labels(neighbor) AS labels
      LIMIT $limit
    `;

    const result = await runReadTransaction<{ neighbor: Record<string, unknown>; labels: string[] }>(cypher, {
      nodeId,
      targetTypes,
      targetLabels: targetTypes ? graphLabelsForEntityTypes(targetTypes) : [],
      limit: neo4j.int(limit),
      ...businessEntityIdentityParams(),
    });

    return result.records.map((r) => ({
      id: r.neighbor.id as string,
      labels: r.labels,
      properties: r.neighbor,
    }));
  }

  async findPath(fromId: string, toId: string, options: PathFindingOptions = {}): Promise<GraphPath | null> {
    const {
      maxDepth = 6,
      relationTypes,
      nodeLabels,
      curatedOnly = false,
      minConfidence,
      includeHistory = false,
    } = options;

    const safeMaxDepth = depthSchema.parse(maxDepth);
    const safeRelTypes = relationTypes?.map((t) => relationTypeCypherSchema.parse(t));
    // Build relationship pattern
    const relPattern = safeRelTypes?.length ? `[:${safeRelTypes.join('|')}*..${safeMaxDepth}]` : `[*..${safeMaxDepth}]`;

    // Build WHERE clause
    const whereConditions: string[] = [businessEntityPathCondition('p')];
    const safeNodeLabels = parseNodeLabels(nodeLabels);
    if (safeNodeLabels) {
      whereConditions.push(nodeLabelPathCondition('p', safeNodeLabels));
    }
    // H1: exclude F1-superseded edges by default so invalidated facts never
    // resurface as a current path.
    if (!includeHistory) {
      whereConditions.push(
        `ALL(r IN relationships(p) WHERE r.t_invalidated IS NULL AND coalesce(r.claimStatus, 'curated') <> 'rejected')`
      );
    }
    if (curatedOnly) {
      // Writers set claimStatus (never r.status); NULL-safe for legacy edges
      // written before the claimStatus contract.
      whereConditions.push(`ALL(r IN relationships(p) WHERE r.claimStatus = 'curated' OR r.claimStatus IS NULL)`);
    }
    if (minConfidence !== undefined) {
      whereConditions.push(
        `ALL(r IN relationships(p) WHERE COALESCE(r.effectiveConfidence, r.confidence, 100) >= $minConfidence)`
      );
    }
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const cypher = `
      MATCH p = shortestPath((from {id: $fromId})-${relPattern}-(to {id: $toId}))
      ${whereClause}
      RETURN p,
             [n IN nodes(p) | {id: n.id, labels: labels(n), properties: properties(n)}] AS pathNodes,
             [r IN relationships(p) | {id: elementId(r), type: type(r), sourceId: startNode(r).id, targetId: endNode(r).id, properties: properties(r)}] AS pathRels
      LIMIT 1
    `;

    const result = await runReadTransaction<{
      pathNodes: Array<{ id: string; labels: string[]; properties: Record<string, unknown> }>;
      pathRels: Array<{
        id: string;
        type: string;
        sourceId: string;
        targetId: string;
        properties: Record<string, unknown>;
      }>;
    }>(cypher, { fromId, toId, minConfidence, ...businessEntityIdentityParams() });

    if (result.records.length === 0) {
      return null;
    }

    const record = result.records[0];
    return {
      nodes: record.pathNodes.map((n) => ({
        id: n.id,
        labels: n.labels,
        properties: n.properties,
      })),
      relations: record.pathRels.map((r) => ({
        id: r.id,
        type: r.type,
        sourceId: r.sourceId,
        targetId: r.targetId,
        properties: r.properties,
      })),
      length: record.pathRels.length,
    };
  }

  async findAllPaths(fromId: string, toId: string, options: PathFindingOptions = {}): Promise<GraphPath[]> {
    const { maxDepth = 4, relationTypes, nodeLabels, pathLimit = 10, includeHistory = false } = options;

    const safeMaxDepth = depthSchema.parse(maxDepth);
    const safeRelTypes = relationTypes?.map((t) => relationTypeCypherSchema.parse(t));
    const relPattern = safeRelTypes?.length ? `[:${safeRelTypes.join('|')}*..${safeMaxDepth}]` : `[*..${safeMaxDepth}]`;

    const allPathsConditions: string[] = [businessEntityPathCondition('p')];
    const safeNodeLabels = parseNodeLabels(nodeLabels);
    if (safeNodeLabels) {
      allPathsConditions.push(nodeLabelPathCondition('p', safeNodeLabels));
    }
    // H1: exclude F1-superseded edges by default.
    if (!includeHistory) {
      allPathsConditions.push(
        `ALL(r IN relationships(p) WHERE r.t_invalidated IS NULL AND coalesce(r.claimStatus, 'curated') <> 'rejected')`
      );
    }
    const whereClause = allPathsConditions.length > 0 ? `WHERE ${allPathsConditions.join(' AND ')}` : '';

    const cypher = `
      MATCH p = (from {id: $fromId})-${relPattern}-(to {id: $toId})
      ${whereClause}
      RETURN p,
             [n IN nodes(p) | {id: n.id, labels: labels(n), properties: properties(n)}] AS pathNodes,
             [r IN relationships(p) | {id: elementId(r), type: type(r), sourceId: startNode(r).id, targetId: endNode(r).id, properties: properties(r)}] AS pathRels
      LIMIT $pathLimit
    `;

    const result = await runReadTransaction<{
      pathNodes: Array<{ id: string; labels: string[]; properties: Record<string, unknown> }>;
      pathRels: Array<{
        id: string;
        type: string;
        sourceId: string;
        targetId: string;
        properties: Record<string, unknown>;
      }>;
    }>(cypher, { fromId, toId, pathLimit: neo4j.int(pathLimit), ...businessEntityIdentityParams() });

    return result.records.map((record) => ({
      nodes: record.pathNodes.map((n) => ({
        id: n.id,
        labels: n.labels,
        properties: n.properties,
      })),
      relations: record.pathRels.map((r) => ({
        id: r.id,
        type: r.type,
        sourceId: r.sourceId,
        targetId: r.targetId,
        properties: r.properties,
      })),
      length: record.pathRels.length,
    }));
  }

  async findConnected(
    nodeId: string,
    targetType: TransformationEntityType,
    options: TraversalOptions = {}
  ): Promise<GraphNode[]> {
    const {
      maxDepth = 4,
      relationTypes,
      nodeLabels,
      curatedOnly = false,
      minConfidence,
      includeHistory = false,
    } = options;

    const safeMaxDepth = depthSchema.parse(maxDepth);
    const safeRelTypes = relationTypes?.map((t) => relationTypeCypherSchema.parse(t));
    const relPattern = safeRelTypes?.length ? `[:${safeRelTypes.join('|')}*..${safeMaxDepth}]` : `[*..${safeMaxDepth}]`;

    // AI-026: the requested type is proven by `target`'s canonical LABEL; the
    // `entityType` property (in both the camelCase writer vocabulary and the
    // legacy snake_case one, H2) may only stand in for an endpoint placeholder
    // that carries no canonical label at all. Every node on the path must itself
    // be a business entity, which is what closes the
    // `PainPoint -[SOLVES]- Technology <-[:ABOUT]- AgentObservation` route that
    // satisfied the old property-only predicate.
    const whereConditions = [
      businessEntityPathCondition('path'),
      businessEntityTypeScopeCypher('target'),
      `source <> target`,
    ];
    const safeNodeLabels = parseNodeLabels(nodeLabels);
    if (safeNodeLabels) {
      whereConditions.push(nodeLabelPathCondition('path', safeNodeLabels));
    }
    // H1: exclude F1-superseded edges by default.
    if (!includeHistory) {
      whereConditions.push(
        `ALL(r IN relationships(path) WHERE r.t_invalidated IS NULL AND coalesce(r.claimStatus, 'curated') <> 'rejected')`
      );
    }
    if (curatedOnly) {
      // Writers set claimStatus (never r.status); NULL-safe for legacy edges.
      whereConditions.push(`ALL(r IN relationships(path) WHERE r.claimStatus = 'curated' OR r.claimStatus IS NULL)`);
    }
    if (minConfidence !== undefined) {
      whereConditions.push(
        `ALL(r IN relationships(path) WHERE COALESCE(r.effectiveConfidence, r.confidence, 100) >= $minConfidence)`
      );
    }

    const cypher = `
      MATCH path = (source {id: $nodeId})-${relPattern}-(target)
      WHERE ${whereConditions.join(' AND ')}
      RETURN DISTINCT target, labels(target) AS labels
      LIMIT 100
    `;

    const targetTypes = expandEntityTypes([targetType]);
    const result = await runReadTransaction<{ target: Record<string, unknown>; labels: string[] }>(cypher, {
      nodeId,
      targetTypes,
      targetLabels: graphLabelsForEntityTypes(targetTypes),
      minConfidence,
      ...businessEntityIdentityParams(),
    });

    return result.records.map((r) => ({
      id: r.target.id as string,
      labels: r.labels,
      properties: r.target,
    }));
  }

  async areConnected(fromId: string, toId: string, maxDepth = 6): Promise<boolean> {
    const safeMaxDepth = depthSchema.parse(maxDepth);
    const cypher = `
      MATCH (from {id: $fromId}), (to {id: $toId})
      RETURN EXISTS {
        MATCH p = (from)-[*1..${safeMaxDepth}]-(to)
        WHERE ALL(r IN relationships(p) WHERE
          r.t_invalidated IS NULL AND coalesce(r.claimStatus, 'curated') <> 'rejected'
        )
        AND ${businessEntityPathCondition('p')}
      } AS connected
    `;
    const result = await runReadTransaction<{ connected: boolean }>(cypher, {
      fromId,
      toId,
      ...businessEntityIdentityParams(),
    });
    return result.records.length > 0 && result.records[0].connected;
  }

  // ==========================================================================
  // WRITE OPERATIONS
  // ==========================================================================

  async createNode(labels: string[], properties: Record<string, unknown>): Promise<GraphNode> {
    // Whitelist label syntax — Cypher cannot bind labels as parameters.
    const labelsStr = labels.map((l) => `:${labelSchema.parse(l)}`).join('');
    const cypher = `
      CREATE (n${labelsStr})
      SET n = $properties
      RETURN n, labels(n) AS labels
    `;
    const result = await runWriteTransaction<{ n: Record<string, unknown>; labels: string[] }>(cypher, { properties });

    const record = result.records[0];
    return {
      id: record.n.id as string,
      labels: record.labels,
      properties: record.n,
    };
  }

  async updateNode(id: string, properties: Record<string, unknown>): Promise<GraphNode | null> {
    const cypher = `
      MATCH (n {id: $id})
      SET n += $properties
      RETURN n, labels(n) AS labels
    `;
    const result = await runWriteTransaction<{ n: Record<string, unknown>; labels: string[] }>(cypher, {
      id,
      properties,
    });

    if (result.records.length === 0) {
      return null;
    }

    const record = result.records[0];
    return {
      id,
      labels: record.labels,
      properties: record.n,
    };
  }

  async deleteNode(id: string): Promise<boolean> {
    // Keep the cardinality guard and dependent cleanup in one transaction so
    // they share one transactional decision. This does not replace schema
    // uniqueness for callers that permit concurrent node creation.
    const cypher = `
      MATCH (endpoint {id: $id})
      WITH collect(endpoint) AS endpointMatches
      WHERE size(endpointMatches) = 1
      WITH head(endpointMatches) AS endpoint

      OPTIONAL MATCH (claim)
      WHERE (claim:Assertion OR claim:Claim)
        AND (
          claim.subjectId = $id
          OR claim.objectId = $id
          OR EXISTS {
            MATCH (claim)-[:ABOUT_SUBJECT|ABOUT_OBJECT]->(endpoint)
          }
        )
      OPTIONAL MATCH (claim)-[:SUPPORTED_BY]->(evidence:Evidence)
      WITH endpoint,
           collect(DISTINCT claim) AS linkedClaims,
           collect(DISTINCT evidence) AS evidenceNodes

      OPTIONAL MATCH ()-[projection]->()
      WHERE projection.claimId IN [claim IN linkedClaims | claim.id]
      WITH endpoint, linkedClaims, evidenceNodes,
           collect(DISTINCT projection) AS projectionEdges

      FOREACH (edge IN projectionEdges | DELETE edge)
      FOREACH (evidence IN evidenceNodes | DETACH DELETE evidence)
      FOREACH (claim IN linkedClaims | DETACH DELETE claim)
      DETACH DELETE endpoint
      RETURN 1 AS deleted
    `;
    const result = await runWriteTransaction<{ deleted: number }>(cypher, { id });
    return result.records.length > 0 && result.records[0].deleted > 0;
  }

  async createRelation(
    fromId: string,
    toId: string,
    type: string,
    properties: Record<string, unknown> = {}
  ): Promise<GraphRelation> {
    // Inject temporal + provenance + confidence defaults. Caller-supplied
    // properties win over defaults (see buildRelationDefaults.overrides).
    const inferredSource: 'user' | 'agent' | 'system' =
      properties.source === 'user' || properties.source === 'agent' || properties.source === 'system'
        ? (properties.source as 'user' | 'agent' | 'system')
        : properties.aiSuggested === true
          ? 'agent'
          : 'system';
    const inferredAssertedBy =
      typeof properties.assertedBy === 'string' ? properties.assertedBy : `${inferredSource}:auto`;
    const enrichedProperties = buildRelationDefaults({
      source: inferredSource,
      assertedBy: inferredAssertedBy,
      confidence: typeof properties.confidence === 'number' ? properties.confidence : undefined,
      overrides: properties,
    });

    // Whitelist relation type — Cypher cannot bind type names as parameters.
    const safeType = relationTypeCypherSchema.parse(type);
    const cypher = `
      MATCH (from {id: $fromId}), (to {id: $toId})
      CREATE (from)-[r:${safeType}]->(to)
      SET r = $properties
      RETURN elementId(r) AS relId, type(r) AS relType, from.id AS sourceId, to.id AS targetId, properties(r) AS properties
    `;
    const result = await runWriteTransaction<{
      relId: string;
      relType: string;
      sourceId: string;
      targetId: string;
      properties: Record<string, unknown>;
    }>(cypher, { fromId, toId, properties: enrichedProperties });

    const record = result.records[0];
    return {
      id: record.relId,
      type: record.relType,
      sourceId: record.sourceId,
      targetId: record.targetId,
      properties: record.properties,
    };
  }

  async deleteRelation(relationId: string): Promise<boolean> {
    // Neo4j 5.x+ uses elementId (string) instead of id (integer)
    const cypher = `
      MATCH ()-[r]->()
      WHERE elementId(r) = $relationId
      DELETE r
      RETURN count(r) AS deleted
    `;
    const result = await runWriteTransaction<{ deleted: number }>(cypher, {
      relationId,
    });
    return result.records.length > 0 && result.records[0].deleted > 0;
  }

  // ==========================================================================
  // BULK OPERATIONS
  // ==========================================================================

  async syncEntities(
    entities: Array<{
      id: string;
      type: TransformationEntityType;
      data: Record<string, unknown>;
    }>
  ): Promise<{ created: number; updated: number; errors: number }> {
    let created = 0;
    let updated = 0;
    let errors = 0;

    for (const entity of entities) {
      try {
        // labels[1] derives from entityTypeToLabel() (internal mapping), but
        // validate anyway as defense-in-depth — Cypher cannot bind labels.
        const labels = ['Entity', this.entityTypeToLabel(entity.type)];
        const safeLabel = labelSchema.parse(labels[1]);
        const properties = {
          ...entity.data,
          id: entity.id,
          entityType: entity.type,
          syncedAt: Date.now(),
        };

        const cypher = `
          MERGE (n:Entity {id: $id})
          ON CREATE SET n = $properties, n:${safeLabel}
          ON MATCH SET n += $properties, n:${safeLabel}
          RETURN n, CASE WHEN n.createdAt IS NULL THEN 'created' ELSE 'updated' END AS action
        `;

        const result = await runWriteTransaction<{ action: string }>(cypher, {
          id: entity.id,
          properties,
        });

        if (result.records[0]?.action === 'created') {
          created++;
        } else {
          updated++;
        }
      } catch (error) {
        log.error('Failed to sync entity', error instanceof Error ? error : undefined, { entityId: entity.id });
        errors++;
      }
    }

    return { created, updated, errors };
  }

  async bulkCreateNodes(
    nodes: Array<{
      labels: string[];
      properties: Record<string, unknown>;
    }>
  ): Promise<GraphNode[]> {
    const results: GraphNode[] = [];

    // Use UNWIND for efficient bulk insert
    const cypher = `
      UNWIND $nodes AS nodeData
      CREATE (n)
      SET n = nodeData.properties
      WITH n, nodeData
      CALL apoc.create.addLabels(n, nodeData.labels) YIELD node
      RETURN node, labels(node) AS labels
    `;

    try {
      // Try APOC-based bulk insert first
      const result = await runWriteTransaction<{ node: Record<string, unknown>; labels: string[] }>(cypher, { nodes });
      return result.records.map((r) => ({
        id: r.node.id as string,
        labels: r.labels,
        properties: r.node,
      }));
    } catch {
      // Fallback to individual inserts if APOC not available
      for (const node of nodes) {
        const created = await this.createNode(node.labels, node.properties);
        results.push(created);
      }
      return results;
    }
  }

  async bulkCreateRelations(
    relations: Array<{
      fromId: string;
      toId: string;
      type: string;
      properties?: Record<string, unknown>;
    }>
  ): Promise<GraphRelation[]> {
    const results: GraphRelation[] = [];

    // Individual inserts (Cypher doesn't support dynamic relationship types in UNWIND easily)
    for (const rel of relations) {
      const created = await this.createRelation(rel.fromId, rel.toId, rel.type, rel.properties || {});
      results.push(created);
    }

    return results;
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  private entityTypeToLabel(type: TransformationEntityType): string {
    const mapping: Record<TransformationEntityType, string> = {
      technology: 'Technology',
      company: 'Company',
      useCase: 'UseCase',
      prototype: 'Prototype',
      strategy: 'Strategy',
      signal: 'Signal',
      document: 'Document',
      org_unit: 'OrgUnit',
      initiative: 'Initiative',
      pain_point: 'PainPoint',
    };
    return mapping[type] || 'Entity';
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let neo4jServiceInstance: Neo4jGraphService | null = null;

/**
 * Get or create the Neo4j graph service singleton.
 */
export function getNeo4jGraphService(): Neo4jGraphService {
  if (!neo4jServiceInstance) {
    neo4jServiceInstance = new Neo4jGraphService();
  }
  return neo4jServiceInstance;
}
