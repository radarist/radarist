/**
 * @file interface.ts
 * @description GraphService abstraction for swappable graph backend.
 *
 * This module defines the interface for graph operations, enabling:
 * - Vendor flexibility (Neo4j, Memgraph, Neptune, etc.)
 * - Testing without Neo4j container
 * - Graceful degradation if Neo4j is unavailable
 *
 * @phase Phase 5: GraphRAG Reasoning Engine
 * @author Radarist Team
 * @created 2026-01-09
 */

import type { TransformationEntityType } from '@/lib/types';

// ============================================================================
// CORE GRAPH TYPES
// ============================================================================

/**
 * A node in the graph.
 */
export interface GraphNode {
  /** Unique identifier */
  id: string;
  /** Node labels (e.g., ['Technology', 'Entity']) */
  labels: string[];
  /** Node properties */
  properties: Record<string, unknown>;
}

/**
 * A relationship in the graph.
 */
export interface GraphRelation {
  /** Unique identifier */
  id: string;
  /** Relationship type (e.g., 'SOLVES', 'USES') */
  type: string;
  /** Source node ID */
  sourceId: string;
  /** Target node ID */
  targetId: string;
  /** Relationship properties */
  properties: Record<string, unknown>;
}

/**
 * A path in the graph (sequence of nodes and relations).
 */
export interface GraphPath {
  /** Ordered list of nodes in the path */
  nodes: GraphNode[];
  /** Ordered list of relations connecting nodes */
  relations: GraphRelation[];
  /** Path length (number of hops) */
  length: number;
  /** Total weight (if applicable) */
  totalWeight?: number;
}

/**
 * Result of a graph query.
 */
export interface GraphQueryResult {
  /** Query result records */
  records: Record<string, unknown>[];
  /** Query summary */
  summary: {
    nodesCreated: number;
    nodesDeleted: number;
    relationshipsCreated: number;
    relationshipsDeleted: number;
    propertiesSet: number;
  };
  /** Query execution time in ms */
  executionTimeMs?: number;
}

// ============================================================================
// GRAPH MODE (Task 0.14 — Provenance Signaling)
// ============================================================================

/**
 * The current graph backend mode.
 * Exposed to tool responses and UI so users know the quality of graph answers.
 */
export type GraphMode = 'neo4j' | 'firestore-fallback' | 'mock' | 'unavailable';

// ============================================================================
// TRAVERSAL TYPES
// ============================================================================

/**
 * Options for graph traversal.
 */
export interface TraversalOptions {
  /** Maximum depth (default: 4) */
  maxDepth?: number;
  /** Relationship types to traverse (all if empty) */
  relationTypes?: readonly string[];
  /**
   * Restrict the traversal to nodes carrying at least one of these Neo4j
   * labels. Applies to EVERY node on the path, not just its ends — an
   * intermediate hop through a bookkeeping node is precisely what this exists
   * to refuse (GRAPH-062: `Strategy <-EXPLORED- Session -EXPLORED-> Technology`
   * was scored as strategic alignment).
   *
   * All labels if empty. The Firestore fallback derives connections from the
   * `relations` collection, which contains only domain entities, so it has
   * nothing to filter and ignores this rather than approximating it.
   */
  nodeLabels?: readonly string[];
  /** Direction: 'outgoing', 'incoming', 'both' (default: 'both') */
  direction?: 'outgoing' | 'incoming' | 'both';
  /** Minimum confidence for claims (0-100) */
  minConfidence?: number;
  /** Only include curated claims */
  curatedOnly?: boolean;
  /**
   * Include F1-superseded edges (`t_invalidated` set). Default false —
   * traversals only see currently-valid facts unless history is requested.
   */
  includeHistory?: boolean;
}

/**
 * Options for path finding.
 */
export interface PathFindingOptions extends TraversalOptions {
  /** Use weighted shortest path (uses confidence as weight) */
  weighted?: boolean;
  /** Find all paths (not just shortest) up to limit */
  allPaths?: boolean;
  /** Maximum paths to return (for allPaths) */
  pathLimit?: number;
}

/**
 * Options for neighbor queries.
 */
export interface NeighborOptions {
  /** Depth of neighbors (default: 1) */
  depth?: number;
  /** Relationship types filter */
  relationTypes?: string[];
  /** Target entity types */
  entityTypes?: TransformationEntityType[];
  /**
   * Restrict the traversal to nodes carrying at least one of these Neo4j labels,
   * applied to EVERY node on the path — the same contract as
   * `TraversalOptions.nodeLabels`, which this option was missing entirely
   * (AI-026). Without it no caller could express a label filter, so every one
   * was forced onto the `entityType` property for identity.
   *
   * Independent of the always-on business-entity envelope: bookkeeping nodes are
   * refused whether or not this is set. Use it to narrow further.
   */
  nodeLabels?: readonly string[];
  /** Limit results */
  limit?: number;
  /** Include relationship properties */
  includeRelations?: boolean;
  /** Edge direction relative to the source (default: 'both' — undirected). */
  direction?: 'outgoing' | 'incoming' | 'both';
  /**
   * Include F1-superseded edges (`t_invalidated` set). Default false —
   * neighbors are only reached over currently-valid edges unless history is
   * requested.
   */
  includeHistory?: boolean;
}

// ============================================================================
// GRAPH SERVICE INTERFACE
// ============================================================================

/**
 * Interface for graph service implementations.
 * Provides abstraction over different graph backends.
 */
export interface IGraphService {
  // ==========================================================================
  // CONNECTION MANAGEMENT
  // ==========================================================================

  /**
   * Connect to the graph database.
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the graph database.
   */
  disconnect(): Promise<void>;

  /**
   * Check if the connection is healthy.
   */
  isHealthy(): Promise<boolean>;

  /**
   * Get health details including latency.
   */
  getHealthDetails(): Promise<{
    healthy: boolean;
    latencyMs: number;
    error?: string;
    backend: string;
  }>;

  // ==========================================================================
  // READ OPERATIONS
  // ==========================================================================

  /**
   * Execute a raw query (Cypher for Neo4j).
   */
  query(queryString: string, params?: Record<string, unknown>): Promise<GraphQueryResult>;

  /**
   * Get a node by ID.
   */
  getNode(id: string): Promise<GraphNode | null>;

  /**
   * Get multiple nodes by IDs.
   */
  getNodes(ids: string[]): Promise<GraphNode[]>;

  /**
   * Get neighbors of a node.
   */
  getNeighbors(nodeId: string, options?: NeighborOptions): Promise<GraphNode[]>;

  /**
   * Find the shortest path between two nodes.
   */
  findPath(fromId: string, toId: string, options?: PathFindingOptions): Promise<GraphPath | null>;

  /**
   * Find all paths between two nodes (up to limit).
   */
  findAllPaths(fromId: string, toId: string, options?: PathFindingOptions): Promise<GraphPath[]>;

  /**
   * Find connected nodes of a specific type.
   */
  findConnected(nodeId: string, targetType: TransformationEntityType, options?: TraversalOptions): Promise<GraphNode[]>;

  /**
   * Check if two nodes are connected.
   */
  areConnected(fromId: string, toId: string, maxDepth?: number): Promise<boolean>;

  // ==========================================================================
  // WRITE OPERATIONS
  // ==========================================================================

  /**
   * Create a new node.
   */
  createNode(labels: string[], properties: Record<string, unknown>): Promise<GraphNode>;

  /**
   * Update a node's properties.
   */
  updateNode(id: string, properties: Record<string, unknown>): Promise<GraphNode | null>;

  /**
   * Delete a node (and its relationships).
   */
  deleteNode(id: string): Promise<boolean>;

  /**
   * Create a relationship between two nodes.
   */
  createRelation(
    fromId: string,
    toId: string,
    type: string,
    properties?: Record<string, unknown>
  ): Promise<GraphRelation>;

  /**
   * Delete a relationship.
   */
  deleteRelation(relationId: string): Promise<boolean>;

  // ==========================================================================
  // BULK OPERATIONS
  // ==========================================================================

  /**
   * Sync entities from Firestore to graph.
   */
  syncEntities(
    entities: Array<{
      id: string;
      type: TransformationEntityType;
      data: Record<string, unknown>;
    }>
  ): Promise<{
    created: number;
    updated: number;
    errors: number;
  }>;

  /**
   * Bulk create nodes.
   */
  bulkCreateNodes(
    nodes: Array<{
      labels: string[];
      properties: Record<string, unknown>;
    }>
  ): Promise<GraphNode[]>;

  /**
   * Bulk create relationships.
   */
  bulkCreateRelations(
    relations: Array<{
      fromId: string;
      toId: string;
      type: string;
      properties?: Record<string, unknown>;
    }>
  ): Promise<GraphRelation[]>;
}

// ============================================================================
// SERVICE FACTORY TYPES
// ============================================================================

/**
 * Configuration for the graph service.
 */
export interface GraphServiceConfig {
  /** Backend type */
  backend: 'neo4j' | 'mock' | 'firestore-fallback';
  /** Neo4j-specific config */
  neo4j?: {
    uri: string;
    username: string;
    password: string;
    database?: string;
  };
  /** Enable query caching */
  cacheEnabled?: boolean;
  /** Cache TTL in seconds */
  cacheTtlSeconds?: number;
}

/**
 * Health status for graph service.
 */
export interface GraphServiceHealth {
  /** Is the service healthy */
  healthy: boolean;
  /** Backend type in use */
  backend: 'neo4j' | 'mock' | 'firestore-fallback';
  /** Latency in milliseconds */
  latencyMs: number;
  /** Error message if unhealthy */
  error?: string;
  /** Timestamp of check */
  checkedAt: number;
}
