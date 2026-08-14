/**
 * @file app/api/graph/query/route.ts
 * @description API endpoint for executing Cypher queries against Neo4j
 *
 * Provides a Neo4j Browser-like experience for exploring graph data.
 * Features:
 * - Read-only mode by default (blocks mutations)
 * - Query validation for safety
 * - Rate limiting (10 queries/minute)
 * - 30 second timeout
 * - Sanitized error messages
 *
 * @author Radarist Team
 * @created 2026-01-18
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { runRawReadQuery, runReadTransaction, checkHealth } from '@/lib/graph';
import {
  PLACEMENT_ENRICHMENT_CYPHER,
  PLACEMENT_RESOLVED_DISPLAY_PROPS,
  radarPlacementFallbackCaption,
  resolvePlacementEnrichment,
  type PlacementEnrichmentRow,
} from '@/lib/graph/placement-enrichment';
import { deriveNodeCaption } from '@/lib/graph-node-caption';
import { GRAPH_QUERY_LIMITS } from '@/lib/graph-query-limits';
import { inspectCypherReadQuery } from '@/lib/graph/cypher-read-policy';
import { sanitizeNeo4jErrorMessage } from '@/lib/graph/neo4j-client';
import { GraphUnavailableError } from '@/lib/graph/errors';

const log = createLogger('api/graph/query');
import neo4j, {
  Node as Neo4jNode,
  Relationship as Neo4jRelationship,
  Path as Neo4jPath,
  Record as Neo4jRecord,
  Integer,
} from 'neo4j-driver';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Graph node format consumed by the Cytoscape `GraphVisualization` component.
 */
interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  // Styling hints
  caption?: string;
}

/**
 * Graph relationship format consumed by the `GraphVisualization` component.
 */
interface GraphRelationship {
  id: string;
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
}

/**
 * Query response format
 */
interface QueryResponse {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  stats: {
    nodeCount: number;
    relationshipCount: number;
    labelCounts: Record<string, number>;
    typeCounts: Record<string, number>;
  };
  executionTimeMs: number;
  truncated: boolean;
  truncationReasons: string[];
  limits: typeof GRAPH_QUERY_LIMITS;
}

// ============================================================================
// RATE LIMITING (simple in-memory implementation)
// ============================================================================

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10; // queries per minute
const RATE_WINDOW_MS = 60 * 1000; // 1 minute
const QUERY_TIMEOUT_MS = 30_000;

function checkRateLimit(clientId: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(clientId);

  if (!record || now > record.resetAt) {
    rateLimitMap.set(clientId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }

  if (record.count >= RATE_LIMIT) {
    return false;
  }

  record.count++;
  return true;
}

function isQueryTimeoutError(error: Error): boolean {
  const code = 'code' in error ? (error as Error & { code?: unknown }).code : undefined;
  return (
    error.message === 'Query timeout' ||
    code === 'CYPHER_QUERY_TIMEOUT' ||
    (typeof code === 'string' && code.includes('TransactionTimedOut'))
  );
}

// ============================================================================
// VALUE CONVERSION
// ============================================================================

/**
 * Convert Neo4j values to native JavaScript values
 */
function toNativeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Handle Neo4j Integer
  if (neo4j.isInt(value)) {
    return (value as Integer).toNumber();
  }

  // Handle Neo4j Date/DateTime
  if (neo4j.isDate(value) || neo4j.isDateTime(value) || neo4j.isLocalDateTime(value)) {
    return (value as { toString(): string }).toString();
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map(toNativeValue);
  }

  // Handle objects (but not Neo4j types which have their own conversion)
  if (typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = toNativeValue(v);
    }
    return obj;
  }

  return value;
}

/**
 * Check if a value is a Neo4j Node using the driver's type guard
 */
function isNeo4jNode(value: unknown): value is Neo4jNode {
  return neo4j.isNode(value);
}

/**
 * Check if a value is a Neo4j Relationship using the driver's type guard
 */
function isNeo4jRelationship(value: unknown): value is Neo4jRelationship {
  return neo4j.isRelationship(value);
}

/**
 * Check if a value is a Neo4j Path using the driver's type guard
 */
function isNeo4jPath(value: unknown): value is Neo4jPath {
  return neo4j.isPath(value);
}

// ============================================================================
// RESULT PROCESSING
// ============================================================================

/**
 * Extract nodes and relationships from raw Neo4j records
 */
function extractGraphElements(records: Neo4jRecord[]): {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  truncated: boolean;
  truncationReasons: string[];
} {
  const nodeMap = new Map<string, GraphNode>();
  const relMap = new Map<string, GraphRelationship>();
  const truncationReasons = new Set<string>();
  let traversedValues = 0;

  function processValue(value: unknown): void {
    traversedValues++;
    if (traversedValues > GRAPH_QUERY_LIMITS.traversedValues) {
      truncationReasons.add('nested result traversal limit');
      return;
    }

    if (isNeo4jNode(value)) {
      // Use elementId (string) or fall back to identity (integer)
      const id = value.elementId || (neo4j.isInt(value.identity) ? value.identity.toString() : String(value.identity));

      if (!nodeMap.has(id)) {
        if (nodeMap.size >= GRAPH_QUERY_LIMITS.nodes) {
          truncationReasons.add('node limit');
          return;
        }
        // Strip embedding vectors from response to reduce payload bloat
        const STRIPPED_PROPERTIES = new Set(['embedding', 'embeddings', 'vector', 'vectors']);
        const properties = Object.fromEntries(
          Object.entries(value.properties)
            .filter(([k]) => !STRIPPED_PROPERTIES.has(k))
            .map(([k, v]) => [k, toNativeValue(v)])
        );

        nodeMap.set(id, {
          id,
          labels: value.labels,
          properties,
          // Human caption per node type — RadarPlacement nodes have no
          // name/title, so the old `name || title || id` fallback rendered
          // machine ids like "placement-17716…" on the canvas.
          caption: deriveNodeCaption(value.labels, properties, id),
        });
      }
    } else if (isNeo4jRelationship(value)) {
      // Use elementId (string) or fall back to identity (integer)
      const id = value.elementId || (neo4j.isInt(value.identity) ? value.identity.toString() : String(value.identity));

      if (!relMap.has(id)) {
        if (relMap.size >= GRAPH_QUERY_LIMITS.relationships) {
          truncationReasons.add('relationship limit');
          return;
        }
        // Get start/end node IDs - use elementId if available
        const fromId =
          value.startNodeElementId || (neo4j.isInt(value.start) ? value.start.toString() : String(value.start));
        const toId = value.endNodeElementId || (neo4j.isInt(value.end) ? value.end.toString() : String(value.end));

        relMap.set(id, {
          id,
          from: fromId,
          to: toId,
          type: value.type,
          properties: Object.fromEntries(Object.entries(value.properties).map(([k, v]) => [k, toNativeValue(v)])),
        });
      }
    } else if (isNeo4jPath(value)) {
      // Process all nodes and relationships in the path
      processValue(value.start);
      processValue(value.end);
      for (const segment of value.segments) {
        processValue(segment.start);
        processValue(segment.end);
        processValue(segment.relationship);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (traversedValues >= GRAPH_QUERY_LIMITS.traversedValues) {
          truncationReasons.add('nested result traversal limit');
          break;
        }
        processValue(item);
      }
    } else if (typeof value === 'object' && value !== null) {
      // Check if it's not a Neo4j type before recursing
      if (!neo4j.isInt(value) && !neo4j.isDate(value) && !neo4j.isDateTime(value)) {
        for (const nestedValue of Object.values(value)) {
          if (traversedValues >= GRAPH_QUERY_LIMITS.traversedValues) {
            truncationReasons.add('nested result traversal limit');
            break;
          }
          processValue(nestedValue);
        }
      }
    }
  }

  // Process each record - iterate over the values in each record
  for (const record of records) {
    for (const key of record.keys) {
      processValue(record.get(key));
    }
  }

  const nodes = Array.from(nodeMap.values());
  const nodeIds = new Set(nodes.map((node) => node.id));
  // A node cap can leave relationships whose endpoint was intentionally not
  // retained. Dropping those edges keeps Cytoscape from receiving invalid
  // topology while preserving every complete edge within the bounded graph.
  const relationships = Array.from(relMap.values()).filter(
    (relationship) => nodeIds.has(relationship.from) && nodeIds.has(relationship.to)
  );

  return {
    nodes,
    relationships,
    truncated: truncationReasons.size > 0,
    truncationReasons: Array.from(truncationReasons),
  };
}

/**
 * Calculate statistics from nodes and relationships
 */
function calculateStats(nodes: GraphNode[], relationships: GraphRelationship[]): QueryResponse['stats'] {
  const labelCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};

  for (const node of nodes) {
    for (const label of node.labels) {
      labelCounts[label] = (labelCounts[label] || 0) + 1;
    }
  }

  for (const rel of relationships) {
    typeCounts[rel.type] = (typeCounts[rel.type] || 0) + 1;
  }

  return {
    nodeCount: nodes.length,
    relationshipCount: relationships.length,
    labelCounts,
    typeCounts,
  };
}

// ============================================================================
// API HANDLER
// ============================================================================

/**
 * POST /api/graph/query
 *
 * Execute a Cypher query against Neo4j
 *
 * Body:
 * - query: string - The Cypher query to execute
 * - params: object - Optional query parameters
 *
 * Returns:
 * - nodes: GraphNode[] - Nodes extracted from results
 * - relationships: GraphRelationship[] - Relationships extracted from results
 * - stats: object - Query statistics
 * - executionTimeMs: number - Query execution time
 */
/**
 * GRAPH-065 — resolve authoritative captions/context for RadarPlacement nodes
 * using ONE bounded enrichment query (no N+1). Mutates each placement node's
 * caption + resolved display names in place. Best-effort: on any enrichment
 * failure the nodes keep their own-prop fallback captions and the query still
 * returns.
 */
function clearStalePlacementDisplay(node: GraphNode, unresolved: string[]): void {
  // GRAPH-065 #12 — a placement whose context couldn't be resolved must NOT keep
  // a stale denormalized quadrant/technology/radar name; drop those display
  // props, fall back to an explicit #suffix caption, and mark what's unresolved.
  for (const key of PLACEMENT_RESOLVED_DISPLAY_PROPS) delete node.properties[key];
  const placementId = typeof node.properties.id === 'string' ? node.properties.id : node.id;
  node.caption = radarPlacementFallbackCaption(placementId);
  node.properties.unresolvedContext = unresolved;
}

async function enrichPlacementNodes(nodes: GraphNode[]): Promise<void> {
  const placementNodes = nodes.filter((node) => node.labels.includes('RadarPlacement'));
  if (placementNodes.length === 0) return;
  const placementIds = placementNodes
    .map((node) => (typeof node.properties.id === 'string' ? node.properties.id : null))
    .filter((id): id is string => Boolean(id));

  let resolvedById: Map<string, ReturnType<typeof resolvePlacementEnrichment>>;
  try {
    const result = await runReadTransaction<PlacementEnrichmentRow>(PLACEMENT_ENRICHMENT_CYPHER, {
      ids: placementIds,
    });
    resolvedById = new Map(result.records.map((row) => [row.placementId, resolvePlacementEnrichment(row)]));
  } catch (error) {
    // #12 — on an enrichment OUTAGE, clear every placement's stale resolved names
    // rather than leaving misleading denormalized text on the canvas/detail panel.
    log.warn('Placement enrichment failed; clearing stale display context', {
      error: error instanceof Error ? error.message : String(error),
    });
    for (const node of placementNodes) {
      clearStalePlacementDisplay(node, ['enrichment', 'technology', 'radar', 'quadrant']);
    }
    return;
  }

  for (const node of placementNodes) {
    const placementId = typeof node.properties.id === 'string' ? node.properties.id : null;
    const resolved = placementId ? resolvedById.get(placementId) : undefined;
    if (!resolved) {
      // #12 — a placement with NO enrichment row: don't retain stale names.
      clearStalePlacementDisplay(node, ['enrichment', 'technology', 'radar', 'quadrant']);
      continue;
    }
    node.caption = resolved.caption;
    // Read-time-resolved names surfaced in the detail panel — NOT persisted. The
    // authoritative quadrant name overrides any stale denormalized value.
    node.properties.technologyName = resolved.technologyName;
    node.properties.radarName = resolved.radarName;
    node.properties.quadrantName = resolved.quadrantName;
    if (resolved.unresolved.length > 0) {
      node.properties.unresolvedContext = resolved.unresolved;
    } else {
      delete node.properties.unresolvedContext;
    }
  }
}

export async function POST(request: NextRequest) {
  // Authenticate user
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    // Get client identifier for rate limiting
    const clientId = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'anonymous';

    // Check rate limit
    if (!checkRateLimit(clientId)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Rate limit exceeded',
          message: 'Maximum 10 queries per minute. Please wait before trying again.',
        },
        { status: 429 }
      );
    }

    // Parse request body
    const body = await request.json();
    const { query, params = {} } = body;

    if (!query || typeof query !== 'string') {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid request',
          message: 'Query parameter is required and must be a string.',
        },
        { status: 400 }
      );
    }

    const policy = inspectCypherReadQuery(query, params);
    if (!policy.allowed) {
      const inputTooLarge = policy.code === 'QUERY_TOO_LARGE' || policy.code === 'PARAMS_TOO_LARGE';
      const invalidInput = policy.code === 'EMPTY_QUERY' || policy.code === 'INVALID_PARAMS';
      return NextResponse.json(
        {
          success: false,
          error: inputTooLarge ? 'Query input too large' : invalidInput ? 'Invalid query' : 'Write operation blocked',
          message: policy.reason,
        },
        { status: inputTooLarge ? 413 : invalidInput ? 400 : 403 }
      );
    }

    // Check Neo4j health
    const health = await checkHealth();
    if (!health.healthy) {
      return NextResponse.json(
        {
          success: false,
          error: 'Neo4j not available',
          message: 'The graph database is currently unavailable. Please try again later.',
        },
        { status: 503 }
      );
    }

    const queryStartTime = Date.now();
    const result = await runRawReadQuery(query, params, {
      transactionTimeoutMs: QUERY_TIMEOUT_MS,
      wallTimeoutMs: QUERY_TIMEOUT_MS,
      maxRecords: GRAPH_QUERY_LIMITS.records,
      metadata: { application: 'radarist', surface: 'graph-workbench' },
    });

    const executionTimeMs = Date.now() - queryStartTime;

    // Extract graph elements from raw Neo4j records
    const extracted = extractGraphElements(result.records);
    const { nodes, relationships } = extracted;

    // GRAPH-065: resolve authoritative RadarPlacement captions/context from the
    // graph (one bounded query) so placements render distinctly instead of as
    // repeated bare rings. Best-effort — never fails the query.
    await enrichPlacementNodes(nodes);

    const stats = calculateStats(nodes, relationships);
    const truncationReasons = [...(result.truncationReasons ?? []), ...extracted.truncationReasons];

    const response: QueryResponse = {
      nodes,
      relationships,
      stats,
      executionTimeMs,
      truncated: truncationReasons.length > 0,
      truncationReasons,
      limits: GRAPH_QUERY_LIMITS,
    };

    const payload = {
      success: true,
      ...response,
    };
    const serializedPayload = JSON.stringify(payload);
    if (new TextEncoder().encode(serializedPayload).byteLength > GRAPH_QUERY_LIMITS.responseBytes) {
      return NextResponse.json(
        {
          success: false,
          error: 'Query result too large',
          message: 'The graph result exceeded the 2 MiB response limit. Narrow the query or return fewer properties.',
          limits: GRAPH_QUERY_LIMITS,
        },
        { status: 413 }
      );
    }

    return new NextResponse(serializedPayload, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const sanitizedError = error instanceof Error ? new Error(sanitizeNeo4jErrorMessage(error.message)) : undefined;
    log.error('Query execution failed', sanitizedError);

    // The backend being unreachable is not a bad request. Without this branch
    // an outage answers 400 "Query failed", which tells the caller to go fix a
    // query that was never wrong (AUDIT-020).
    if (error instanceof GraphUnavailableError) {
      return NextResponse.json(
        {
          success: false,
          degraded: true,
          error: 'Graph backend unavailable',
          message: error.message,
          backend: error.backend,
          executionTimeMs: Date.now() - startTime,
        },
        { status: 503 }
      );
    }

    // Handle specific error types
    if (error instanceof Error) {
      if (isQueryTimeoutError(error)) {
        return NextResponse.json(
          {
            success: false,
            error: 'Query timeout',
            message: 'Query exceeded 30 second timeout. Try a simpler query or add LIMIT.',
          },
          { status: 408 }
        );
      }

      // Sanitize Neo4j errors (don't expose connection details)
      const sanitizedMessage = sanitizeNeo4jErrorMessage(error.message);

      return NextResponse.json(
        {
          success: false,
          error: 'Query failed',
          message: sanitizedMessage,
          executionTimeMs: Date.now() - startTime,
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: 'Internal error',
        message: 'An unexpected error occurred while executing the query.',
        executionTimeMs: Date.now() - startTime,
      },
      { status: 500 }
    );
  }
}
