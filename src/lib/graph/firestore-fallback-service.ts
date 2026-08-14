/**
 * @file firestore-fallback-service.ts
 * @description Firestore-based fallback implementation of IGraphService.
 *
 * This module provides a degraded-mode graph service when Neo4j is unavailable:
 * - Uses Firestore relations collection for basic connectivity
 * - Limited traversal depth (max 2 hops)
 * - No complex path finding algorithms
 * - Keeps the app running with reduced functionality
 *
 * @phase Phase 5: GraphRAG Reasoning Engine
 * @author Radarist Team
 * @created 2026-01-09
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  limit as firestoreLimit,
  DocumentData,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { expandEntityTypes } from './entity-type-vocab';
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
import { GraphUnavailableError } from './errors';

const log = createLogger('graph/firestore-fallback');

// ============================================================================
// FIRESTORE FALLBACK SERVICE
// ============================================================================

/**
 * Firestore-based fallback implementation of IGraphService.
 * Provides basic graph operations using the Firestore relations collection.
 *
 * Limitations:
 * - Max depth: 2 (single Firestore query per hop)
 * - No weighted path finding
 * - Limited relation filtering
 * - Slower than Neo4j for complex queries
 */
export class FirestoreFallbackService implements IGraphService {
  private connected = false;

  // ==========================================================================
  // CONNECTION MANAGEMENT
  // ==========================================================================

  async connect(): Promise<void> {
    // Firestore is already connected via the firebase module
    this.connected = true;
    log.info('Using Firestore fallback mode');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async isHealthy(): Promise<boolean> {
    // This fallback is built on the Firebase CLIENT SDK, which has no usable
    // connection in a server/worker context: a network probe there hangs ~52s
    // on a gRPC Listen stream before failing with code:'unavailable' (and the
    // fallback is non-functional server-side anyway). Report unhealthy instantly
    // server-side instead of stalling the caller (e.g. the daily-pipeline
    // refresh-graph step when Neo4j is unreachable).
    if (typeof window === 'undefined') return false;
    try {
      // Simple health check - try to read from a collection
      const relationsRef = collection(db, 'relations');
      const q = query(relationsRef, firestoreLimit(1));
      await getDocs(q);
      return true;
    } catch {
      return false;
    }
  }

  async getHealthDetails(): Promise<{
    healthy: boolean;
    latencyMs: number;
    error?: string;
    backend: string;
  }> {
    const start = Date.now();
    // Use the isHealthy() result (it never throws) rather than unconditionally
    // reporting healthy:true — server-side it returns false instantly (no stall).
    const healthy = await this.isHealthy();
    return {
      healthy,
      latencyMs: Date.now() - start,
      backend: 'firestore-fallback',
      ...(healthy ? {} : { error: 'Firestore client SDK unavailable in this context' }),
    };
  }

  // ==========================================================================
  // READ OPERATIONS
  // ==========================================================================

  async query(_queryString: string, _params: Record<string, unknown> = {}): Promise<GraphQueryResult> {
    // Firestore fallback doesn't support Cypher queries — fail honestly
    // instead of fabricating an empty result set (H10).
    throw this.unavailable('query');
  }

  async getNode(id: string): Promise<GraphNode | null> {
    // Try to find entity in various collections.
    // H3: use-cases and org-units are kebab-case in Firestore — the camelCase
    // names 'useCases'/'orgUnits' do not exist and silently returned nothing.
    const collections = [
      'technologies',
      'companies',
      'prototypes',
      'use-cases',
      'strategies',
      'signals',
      'documents',
      'org-units',
      'initiatives',
      'painPoints',
    ];

    for (const collName of collections) {
      try {
        const docRef = doc(db, collName, id);
        const snapshot = await getDoc(docRef);
        if (snapshot.exists()) {
          const data = snapshot.data();
          return {
            id: snapshot.id,
            labels: ['Entity', this.collectionToLabel(collName)],
            properties: { ...data, id: snapshot.id },
          };
        }
      } catch {
        // Continue to next collection
      }
    }

    return null;
  }

  async getNodes(ids: string[]): Promise<GraphNode[]> {
    const nodes: GraphNode[] = [];
    for (const id of ids) {
      const node = await this.getNode(id);
      if (node) nodes.push(node);
    }
    return nodes;
  }

  async getNeighbors(nodeId: string, options: NeighborOptions = {}): Promise<GraphNode[]> {
    const { entityTypes: rawEntityTypes, limit = 50 } = options;
    // H2: writers store camelCase entityType ('orgUnit'/'painPoint'); accept
    // both vocabularies at the read boundary.
    const entityTypes = rawEntityTypes ? expandEntityTypes(rawEntityTypes) : rawEntityTypes;
    const neighbors: GraphNode[] = [];

    try {
      // Query relations where this node is source or target
      const relationsRef = collection(db, 'relations');

      // Source relations
      const sourceQuery = query(relationsRef, where('sourceId', '==', nodeId), firestoreLimit(limit));
      const sourceSnapshot = await getDocs(sourceQuery);

      for (const relDoc of sourceSnapshot.docs) {
        const data = relDoc.data();
        const targetId = data.targetId;
        const node = await this.getNode(targetId);
        if (node) {
          if (!entityTypes || entityTypes.includes(node.properties.entityType as TransformationEntityType)) {
            neighbors.push(node);
          }
        }
        if (neighbors.length >= limit) break;
      }

      if (neighbors.length < limit) {
        // Target relations
        const targetQuery = query(
          relationsRef,
          where('targetId', '==', nodeId),
          firestoreLimit(limit - neighbors.length)
        );
        const targetSnapshot = await getDocs(targetQuery);

        for (const relDoc of targetSnapshot.docs) {
          const data = relDoc.data();
          const sourceId = data.sourceId;
          const node = await this.getNode(sourceId);
          if (node) {
            if (!entityTypes || entityTypes.includes(node.properties.entityType as TransformationEntityType)) {
              if (!neighbors.some((n) => n.id === node.id)) {
                neighbors.push(node);
              }
            }
          }
          if (neighbors.length >= limit) break;
        }
      }
    } catch (error) {
      log.error('Error getting neighbors', error instanceof Error ? error : undefined);
    }

    return neighbors;
  }

  async findPath(fromId: string, toId: string, options: PathFindingOptions = {}): Promise<GraphPath | null> {
    const { maxDepth = 2 } = options; // Limit depth in fallback mode
    const effectiveMaxDepth = Math.min(maxDepth, 2); // Hard limit of 2 hops

    // Get start and end nodes
    const startNode = await this.getNode(fromId);
    const endNode = await this.getNode(toId);
    if (!startNode || !endNode) return null;

    // Direct connection (1 hop)
    const directRelation = await this.findDirectRelation(fromId, toId);
    if (directRelation) {
      return {
        nodes: [startNode, endNode],
        relations: [directRelation],
        length: 1,
      };
    }

    // 2-hop search (if allowed)
    if (effectiveMaxDepth >= 2) {
      const relationsRef = collection(db, 'relations');

      // Find all nodes connected to start
      const fromSourceQuery = query(relationsRef, where('sourceId', '==', fromId), firestoreLimit(50));
      const fromTargetQuery = query(relationsRef, where('targetId', '==', fromId), firestoreLimit(50));

      const [fromSourceSnap, fromTargetSnap] = await Promise.all([getDocs(fromSourceQuery), getDocs(fromTargetQuery)]);

      // Collect intermediate node IDs
      const intermediateIds = new Set<string>();
      const firstHopRels = new Map<string, GraphRelation>();

      for (const doc of fromSourceSnap.docs) {
        const data = doc.data();
        intermediateIds.add(data.targetId);
        firstHopRels.set(data.targetId, this.docToRelation(doc.id, data));
      }
      for (const doc of fromTargetSnap.docs) {
        const data = doc.data();
        intermediateIds.add(data.sourceId);
        firstHopRels.set(data.sourceId, this.docToRelation(doc.id, data));
      }

      // Check if any intermediate connects to end
      for (const intermediateId of intermediateIds) {
        const secondRel = await this.findDirectRelation(intermediateId, toId);
        if (secondRel) {
          const middleNode = await this.getNode(intermediateId);
          if (middleNode) {
            const firstRel = firstHopRels.get(intermediateId)!;
            return {
              nodes: [startNode, middleNode, endNode],
              relations: [firstRel, secondRel],
              length: 2,
            };
          }
        }
      }
    }

    return null;
  }

  async findAllPaths(fromId: string, toId: string, options: PathFindingOptions = {}): Promise<GraphPath[]> {
    // In fallback mode, just return the single shortest path
    const path = await this.findPath(fromId, toId, options);
    return path ? [path] : [];
  }

  async findConnected(
    nodeId: string,
    targetType: TransformationEntityType,
    options: TraversalOptions = {}
  ): Promise<GraphNode[]> {
    const neighbors = await this.getNeighbors(nodeId, {
      entityTypes: [targetType],
      depth: Math.min(options.maxDepth || 2, 2),
      limit: 100,
    });
    return neighbors;
  }

  async areConnected(fromId: string, toId: string, maxDepth = 2): Promise<boolean> {
    const path = await this.findPath(fromId, toId, { maxDepth });
    return path !== null;
  }

  // ==========================================================================
  // WRITE OPERATIONS (Not available in Fallback Mode — fail honestly, H10)
  // ==========================================================================

  async createNode(_labels: string[], _properties: Record<string, unknown>): Promise<GraphNode> {
    throw this.unavailable('createNode');
  }

  async updateNode(_id: string, _properties: Record<string, unknown>): Promise<GraphNode | null> {
    throw this.unavailable('updateNode');
  }

  async deleteNode(_id: string): Promise<boolean> {
    throw this.unavailable('deleteNode');
  }

  async createRelation(
    _fromId: string,
    _toId: string,
    _type: string,
    _properties: Record<string, unknown> = {}
  ): Promise<GraphRelation> {
    throw this.unavailable('createRelation');
  }

  async deleteRelation(_relationId: string): Promise<boolean> {
    throw this.unavailable('deleteRelation');
  }

  // ==========================================================================
  // BULK OPERATIONS (Not available in Fallback Mode — fail honestly, H10)
  // ==========================================================================

  async syncEntities(
    _entities: Array<{
      id: string;
      type: TransformationEntityType;
      data: Record<string, unknown>;
    }>
  ): Promise<{ created: number; updated: number; errors: number }> {
    throw this.unavailable('syncEntities');
  }

  async bulkCreateNodes(
    _nodes: Array<{
      labels: string[];
      properties: Record<string, unknown>;
    }>
  ): Promise<GraphNode[]> {
    throw this.unavailable('bulkCreateNodes');
  }

  async bulkCreateRelations(
    _relations: Array<{
      fromId: string;
      toId: string;
      type: string;
      properties?: Record<string, unknown>;
    }>
  ): Promise<GraphRelation[]> {
    throw this.unavailable('bulkCreateRelations');
  }

  /**
   * Build a GraphUnavailableError for an operation the Firestore fallback
   * cannot serve. Logged here so every unsupported call is observable.
   */
  private unavailable(operation: string): GraphUnavailableError {
    log.warn('Operation not supported in Firestore fallback mode', { operation });
    return new GraphUnavailableError(operation, 'firestore-fallback');
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private async findDirectRelation(fromId: string, toId: string): Promise<GraphRelation | null> {
    const relationsRef = collection(db, 'relations');

    // Check source -> target
    const sourceQuery = query(
      relationsRef,
      where('sourceId', '==', fromId),
      where('targetId', '==', toId),
      firestoreLimit(1)
    );
    const sourceSnap = await getDocs(sourceQuery);
    if (!sourceSnap.empty) {
      const doc = sourceSnap.docs[0];
      return this.docToRelation(doc.id, doc.data());
    }

    // Check target -> source (bidirectional)
    const targetQuery = query(
      relationsRef,
      where('sourceId', '==', toId),
      where('targetId', '==', fromId),
      firestoreLimit(1)
    );
    const targetSnap = await getDocs(targetQuery);
    if (!targetSnap.empty) {
      const doc = targetSnap.docs[0];
      return this.docToRelation(doc.id, doc.data());
    }

    return null;
  }

  private docToRelation(id: string, data: DocumentData): GraphRelation {
    return {
      id,
      type: data.relationType || 'RELATED',
      sourceId: data.sourceId,
      targetId: data.targetId,
      properties: {
        confidence: (data.effectiveConfidence ?? data.confidence) || 100,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      },
    };
  }

  private collectionToLabel(collName: string): string {
    const mapping: Record<string, string> = {
      technologies: 'Technology',
      companies: 'Company',
      prototypes: 'Prototype',
      'use-cases': 'UseCase',
      strategies: 'Strategy',
      signals: 'Signal',
      documents: 'Document',
      'org-units': 'OrgUnit',
      initiatives: 'Initiative',
      painPoints: 'PainPoint',
    };
    return mapping[collName] || 'Entity';
  }
}
