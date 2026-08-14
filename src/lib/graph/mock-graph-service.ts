/**
 * @file mock-graph-service.ts
 * @description In-memory mock implementation of IGraphService for testing.
 *
 * This module provides a test-friendly graph service that:
 * - Runs entirely in memory (no Neo4j required)
 * - Supports seeding from fixtures
 * - Provides assertion helpers for tests
 *
 * @phase Phase 5: GraphRAG Reasoning Engine
 * @author Radarist Team
 * @created 2026-01-09
 */

import type { TransformationEntityType } from '@/lib/types';
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

const log = createLogger('graph/mock-service');

// ============================================================================
// GRAPH FIXTURE TYPE
// ============================================================================

/**
 * Fixture for seeding the mock graph with test data.
 */
export interface GraphFixture {
  nodes: Array<{
    id: string;
    labels: string[];
    properties: Record<string, unknown>;
  }>;
  relations: Array<{
    id: string;
    type: string;
    sourceId: string;
    targetId: string;
    properties?: Record<string, unknown>;
  }>;
}

// ============================================================================
// MOCK GRAPH SERVICE
// ============================================================================

/**
 * In-memory mock implementation of IGraphService.
 * Useful for unit tests without requiring a Neo4j instance.
 */
export class MockGraphService implements IGraphService {
  private nodes: Map<string, GraphNode> = new Map();
  private relations: Map<string, GraphRelation> = new Map();
  private connected = false;
  private relationIdCounter = 1;

  // ==========================================================================
  // CONNECTION MANAGEMENT
  // ==========================================================================

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async isHealthy(): Promise<boolean> {
    return this.connected;
  }

  async getHealthDetails(): Promise<{
    healthy: boolean;
    latencyMs: number;
    error?: string;
    backend: string;
  }> {
    return {
      healthy: this.connected,
      latencyMs: 1, // Instant for mock
      backend: 'mock',
    };
  }

  // ==========================================================================
  // READ OPERATIONS
  // ==========================================================================

  async query(
    queryString: string,
    params: Record<string, unknown> = {}
  ): Promise<GraphQueryResult> {
    // Basic mock implementation - just return empty results
    // In a more sophisticated mock, we could parse simple Cypher patterns
    log.debug("Query", { query: queryString.substring(0, 100), params });
    return {
      records: [],
      summary: {
        nodesCreated: 0,
        nodesDeleted: 0,
        relationshipsCreated: 0,
        relationshipsDeleted: 0,
        propertiesSet: 0,
      },
      executionTimeMs: 1,
    };
  }

  async getNode(id: string): Promise<GraphNode | null> {
    return this.nodes.get(id) || null;
  }

  async getNodes(ids: string[]): Promise<GraphNode[]> {
    return ids
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  async getNeighbors(nodeId: string, options: NeighborOptions = {}): Promise<GraphNode[]> {
    const { relationTypes, entityTypes, limit = 100 } = options;
    const neighbors: GraphNode[] = [];
    const visited = new Set<string>();

    for (const rel of this.relations.values()) {
      let neighborId: string | null = null;

      if (rel.sourceId === nodeId) {
        neighborId = rel.targetId;
      } else if (rel.targetId === nodeId) {
        neighborId = rel.sourceId;
      }

      if (!neighborId || visited.has(neighborId)) continue;

      // Filter by relation type
      if (relationTypes?.length && !relationTypes.includes(rel.type)) {
        continue;
      }

      const neighbor = this.nodes.get(neighborId);
      if (!neighbor) continue;

      // Filter by entity type
      if (entityTypes?.length) {
        const entityType = neighbor.properties.entityType as TransformationEntityType;
        if (!entityTypes.includes(entityType)) continue;
      }

      visited.add(neighborId);
      neighbors.push(neighbor);

      if (neighbors.length >= limit) break;
    }

    return neighbors;
  }

  async findPath(
    fromId: string,
    toId: string,
    options: PathFindingOptions = {}
  ): Promise<GraphPath | null> {
    const { maxDepth = 6 } = options;
    const paths = await this.bfsAllPaths(fromId, toId, maxDepth);
    return paths.length > 0 ? paths[0] : null;
  }

  async findAllPaths(
    fromId: string,
    toId: string,
    options: PathFindingOptions = {}
  ): Promise<GraphPath[]> {
    const { maxDepth = 4, pathLimit = 10 } = options;
    const paths = await this.bfsAllPaths(fromId, toId, maxDepth);
    return paths.slice(0, pathLimit);
  }

  async findConnected(
    nodeId: string,
    targetType: TransformationEntityType,
    options: TraversalOptions = {}
  ): Promise<GraphNode[]> {
    const { maxDepth = 4 } = options;
    const connected: GraphNode[] = [];
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const node = this.nodes.get(id);
      if (node && node.properties.entityType === targetType && id !== nodeId) {
        connected.push(node);
      }

      // Add neighbors to queue
      for (const rel of this.relations.values()) {
        if (rel.sourceId === id && !visited.has(rel.targetId)) {
          queue.push({ id: rel.targetId, depth: depth + 1 });
        } else if (rel.targetId === id && !visited.has(rel.sourceId)) {
          queue.push({ id: rel.sourceId, depth: depth + 1 });
        }
      }
    }

    return connected;
  }

  async areConnected(fromId: string, toId: string, maxDepth = 6): Promise<boolean> {
    const path = await this.findPath(fromId, toId, { maxDepth });
    return path !== null;
  }

  // ==========================================================================
  // WRITE OPERATIONS
  // ==========================================================================

  async createNode(
    labels: string[],
    properties: Record<string, unknown>
  ): Promise<GraphNode> {
    const id = (properties.id as string) || `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const node: GraphNode = {
      id,
      labels,
      properties: { ...properties, id },
    };
    this.nodes.set(id, node);
    return node;
  }

  async updateNode(
    id: string,
    properties: Record<string, unknown>
  ): Promise<GraphNode | null> {
    const existing = this.nodes.get(id);
    if (!existing) return null;

    const updated: GraphNode = {
      ...existing,
      properties: { ...existing.properties, ...properties },
    };
    this.nodes.set(id, updated);
    return updated;
  }

  async deleteNode(id: string): Promise<boolean> {
    const existed = this.nodes.has(id);
    this.nodes.delete(id);

    // Also delete related relations
    for (const [relId, rel] of this.relations.entries()) {
      if (rel.sourceId === id || rel.targetId === id) {
        this.relations.delete(relId);
      }
    }

    return existed;
  }

  async createRelation(
    fromId: string,
    toId: string,
    type: string,
    properties: Record<string, unknown> = {}
  ): Promise<GraphRelation> {
    const id = `rel-${this.relationIdCounter++}`;
    const relation: GraphRelation = {
      id,
      type,
      sourceId: fromId,
      targetId: toId,
      properties,
    };
    this.relations.set(id, relation);
    return relation;
  }

  async deleteRelation(relationId: string): Promise<boolean> {
    return this.relations.delete(relationId);
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

    for (const entity of entities) {
      const existing = this.nodes.get(entity.id);
      const labels = ['Entity', this.entityTypeToLabel(entity.type)];
      const properties = {
        ...entity.data,
        id: entity.id,
        entityType: entity.type,
        syncedAt: Date.now(),
      };

      if (existing) {
        await this.updateNode(entity.id, properties);
        updated++;
      } else {
        await this.createNode(labels, properties);
        created++;
      }
    }

    return { created, updated, errors: 0 };
  }

  async bulkCreateNodes(
    nodes: Array<{
      labels: string[];
      properties: Record<string, unknown>;
    }>
  ): Promise<GraphNode[]> {
    const results: GraphNode[] = [];
    for (const node of nodes) {
      const created = await this.createNode(node.labels, node.properties);
      results.push(created);
    }
    return results;
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
    for (const rel of relations) {
      const created = await this.createRelation(
        rel.fromId,
        rel.toId,
        rel.type,
        rel.properties
      );
      results.push(created);
    }
    return results;
  }

  // ==========================================================================
  // TEST UTILITIES
  // ==========================================================================

  /**
   * Seed the mock graph from a fixture.
   */
  seedFromFixture(fixture: GraphFixture): void {
    this.clear();

    for (const node of fixture.nodes) {
      this.nodes.set(node.id, {
        id: node.id,
        labels: node.labels,
        properties: { ...node.properties, id: node.id },
      });
    }

    for (const rel of fixture.relations) {
      this.relations.set(rel.id, {
        id: rel.id,
        type: rel.type,
        sourceId: rel.sourceId,
        targetId: rel.targetId,
        properties: rel.properties || {},
      });
    }
  }

  /**
   * Clear all data from the mock graph.
   */
  clear(): void {
    this.nodes.clear();
    this.relations.clear();
    this.relationIdCounter = 1;
  }

  /**
   * Assert that a node exists.
   */
  assertNodeExists(id: string): void {
    if (!this.nodes.has(id)) {
      throw new Error(`Expected node '${id}' to exist, but it doesn't`);
    }
  }

  /**
   * Assert that a node doesn't exist.
   */
  assertNodeNotExists(id: string): void {
    if (this.nodes.has(id)) {
      throw new Error(`Expected node '${id}' not to exist, but it does`);
    }
  }

  /**
   * Assert that a relation exists between two nodes.
   */
  assertRelationExists(fromId: string, toId: string, type?: string): void {
    for (const rel of this.relations.values()) {
      const matches =
        rel.sourceId === fromId &&
        rel.targetId === toId &&
        (!type || rel.type === type);
      if (matches) return;
    }
    throw new Error(
      `Expected relation from '${fromId}' to '${toId}'${type ? ` of type '${type}'` : ''} to exist, but it doesn't`
    );
  }

  /**
   * Get node count.
   */
  getNodeCount(): number {
    return this.nodes.size;
  }

  /**
   * Get relation count.
   */
  getRelationCount(): number {
    return this.relations.size;
  }

  /**
   * Get all nodes (for testing).
   */
  getAllNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get all relations (for testing).
   */
  getAllRelations(): GraphRelation[] {
    return Array.from(this.relations.values());
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private async bfsAllPaths(
    fromId: string,
    toId: string,
    maxDepth: number
  ): Promise<GraphPath[]> {
    const paths: GraphPath[] = [];
    const queue: Array<{
      currentId: string;
      pathNodes: GraphNode[];
      pathRels: GraphRelation[];
    }> = [];

    const startNode = this.nodes.get(fromId);
    if (!startNode) return [];

    queue.push({
      currentId: fromId,
      pathNodes: [startNode],
      pathRels: [],
    });

    while (queue.length > 0 && paths.length < 100) {
      const { currentId, pathNodes, pathRels } = queue.shift()!;

      if (pathRels.length >= maxDepth) continue;

      // Find all relations from current node
      for (const rel of this.relations.values()) {
        let nextId: string | null = null;

        if (rel.sourceId === currentId) {
          nextId = rel.targetId;
        } else if (rel.targetId === currentId) {
          nextId = rel.sourceId;
        }

        if (!nextId) continue;

        // Avoid cycles
        if (pathNodes.some((n) => n.id === nextId)) continue;

        const nextNode = this.nodes.get(nextId);
        if (!nextNode) continue;

        const newPathNodes = [...pathNodes, nextNode];
        const newPathRels = [...pathRels, rel];

        // Found path to target
        if (nextId === toId) {
          paths.push({
            nodes: newPathNodes,
            relations: newPathRels,
            length: newPathRels.length,
          });
        } else {
          queue.push({
            currentId: nextId,
            pathNodes: newPathNodes,
            pathRels: newPathRels,
          });
        }
      }
    }

    // Sort by path length (shortest first)
    return paths.sort((a, b) => a.length - b.length);
  }

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
// TEST FIXTURES
// ============================================================================

/**
 * Sample fixture for testing graph traversal.
 */
export const SAMPLE_GRAPH_FIXTURE: GraphFixture = {
  nodes: [
    {
      id: 'tech-react',
      labels: ['Entity', 'Technology'],
      properties: { name: 'React', entityType: 'technology', status: 'stable' },
    },
    {
      id: 'tech-tensorflow',
      labels: ['Entity', 'Technology'],
      properties: { name: 'TensorFlow', entityType: 'technology', status: 'stable' },
    },
    {
      id: 'pain-ui-performance',
      labels: ['Entity', 'PainPoint'],
      properties: { name: 'UI Performance', entityType: 'pain_point', severity: 'high' },
    },
    {
      id: 'org-dairy',
      labels: ['Entity', 'OrgUnit'],
      properties: { name: 'Dairy Division', entityType: 'org_unit' },
    },
    {
      id: 'strategy-digital',
      labels: ['Entity', 'Strategy'],
      properties: { name: 'Digital Transformation', entityType: 'strategy' },
    },
    {
      id: 'company-google',
      labels: ['Entity', 'Company'],
      properties: { name: 'Google', entityType: 'company', type: 'vendor' },
    },
  ],
  relations: [
    {
      id: 'rel-1',
      type: 'SOLVES',
      sourceId: 'tech-react',
      targetId: 'pain-ui-performance',
      properties: { confidence: 85 },
    },
    {
      id: 'rel-2',
      type: 'IMPACTS',
      sourceId: 'pain-ui-performance',
      targetId: 'org-dairy',
      properties: { confidence: 90 },
    },
    {
      id: 'rel-3',
      type: 'ALIGNS_WITH',
      sourceId: 'tech-react',
      targetId: 'strategy-digital',
      properties: { confidence: 75 },
    },
    {
      id: 'rel-4',
      type: 'VENDOR',
      sourceId: 'company-google',
      targetId: 'tech-tensorflow',
      properties: { confidence: 100 },
    },
    {
      id: 'rel-5',
      type: 'ENABLES',
      sourceId: 'tech-tensorflow',
      targetId: 'tech-react',
      properties: { confidence: 60 },
    },
  ],
};
