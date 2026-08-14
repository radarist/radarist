import { currentEdgePredicate } from '@/lib/graph-query-current';
import { GRAPH_QUERY_LIMITS } from '@/lib/graph-query-limits';
import { DOMAIN_NODE_LABELS } from '@/components/visualizations/graph/graph-view-model';

interface ExpansionNode {
  id: string;
}

interface ExpansionRelationship {
  id: string;
  from: string;
  to: string;
}

interface GraphExpansionLimits {
  nodes: number;
  relationships: number;
}

export interface GraphExpansionMergeResult<TNode extends ExpansionNode, TRelationship extends ExpansionRelationship> {
  nodes: TNode[];
  relationships: TRelationship[];
  addedNodeCount: number;
  addedRelationshipCount: number;
  unacceptedRelationshipCount: number;
  atGlobalLimit: boolean;
}

/**
 * Keep a single expansion small enough to inspect without resetting the
 * viewport preserved by GRAPH-003. One additional row is requested as a
 * lookahead so the UI can accurately offer another batch.
 */
export const GRAPH_EXPANSION_PAGE_SIZE = 12;

/**
 * GRAPH-071 — the Cypher list literal of business-entity labels the first-run
 * default keeps, derived from the SAME `DOMAIN_NODE_LABELS` set the Domain view
 * partitions on. Deriving it (rather than restating it) is the whole point: a
 * default query written against a different label set is what produced
 * `5 nodes, 0 relationships` in Domain, because every returned edge touched a
 * `Document` or a `Chunk`.
 *
 * These are compile-time constants, never caller input. The shape assertion is a
 * tripwire for a future label that would need quoting, not an injection guard.
 */
function domainLabelListLiteral(labels: Iterable<string>): string {
  const literals = [...labels].map((label) => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(label)) {
      throw new Error(`Domain node label is not a bare Cypher label: ${label}`);
    }
    return `'${label}'`;
  });
  if (literals.length === 0) throw new Error('Domain node label set is empty');
  return `[${literals.join(', ')}]`;
}

export const DOMAIN_LABEL_LIST_LITERAL = domainLabelListLiteral(DOMAIN_NODE_LABELS);

/**
 * First-run default. Returns the knowledge graph — business entities joined by
 * current, non-rejected claims — instead of `Document`/`Chunk` ingestion
 * plumbing. The temporal and claim-status guards are unchanged: they still come
 * from the one shared `currentEdgePredicate` fragment, so the current-fact
 * contract is identical to every other current-graph reader.
 *
 * Both endpoints are constrained, so every returned edge survives the Domain
 * partition and the Domain toggle can never render a dust of disconnected nodes.
 * The `WITH` root is an allowed read-policy root (`cypher-read-policy.ts`) and
 * binds the list once so the query stays readable in the compact editor.
 */
export const DEFAULT_GRAPH_QUERY = `WITH ${DOMAIN_LABEL_LIST_LITERAL} AS domainLabels
MATCH (n)-[r]->(m)
WHERE ${currentEdgePredicate('r')}
  AND any(label IN labels(n) WHERE label IN domainLabels)
  AND any(label IN labels(m) WHERE label IN domainLabels)
RETURN n, r, m
LIMIT 100`;

export const EXPAND_GRAPH_NEIGHBORS_QUERY = `MATCH (n)-[r]-(m)
WHERE (elementId(n) = $nodeId OR n.id = $nodeId)
  AND ${currentEdgePredicate('r')}
  AND NOT elementId(r) IN $excludedRelationshipIds
RETURN n, r, m
ORDER BY elementId(r)
LIMIT ${GRAPH_EXPANSION_PAGE_SIZE + 1}`;

/** Only relationships touching the selected node affect its next page. */
export function getVisibleNeighborRelationshipIds(relationships: ExpansionRelationship[], nodeId: string): string[] {
  return relationships
    .filter((relationship) => relationship.from === nodeId || relationship.to === nodeId)
    .map((relationship) => relationship.id);
}

/**
 * Remove the lookahead relationship and any node returned only for it. This
 * keeps every merged edge complete while bounding the visible increment.
 */
export function selectGraphExpansionPage<TNode extends ExpansionNode, TRelationship extends ExpansionRelationship>(
  nodes: TNode[],
  relationships: TRelationship[]
): { nodes: TNode[]; relationships: TRelationship[]; hasMore: boolean } {
  const pageRelationships = relationships.slice(0, GRAPH_EXPANSION_PAGE_SIZE);
  const visibleNodeIds = new Set(pageRelationships.flatMap((relationship) => [relationship.from, relationship.to]));

  return {
    nodes: nodes.filter((node) => visibleNodeIds.has(node.id)),
    relationships: pageRelationships,
    hasMore: relationships.length > GRAPH_EXPANSION_PAGE_SIZE,
  };
}

/**
 * Whether no further expansion can be displayed under the global UI caps.
 * Reaching either cap is deliberately terminal, even when a later edge might
 * happen to connect two visible nodes, so expansion remains predictable.
 */
export function isGraphAtExpansionLimit(
  nodes: ExpansionNode[],
  relationships: ExpansionRelationship[],
  limits: GraphExpansionLimits = GRAPH_QUERY_LIMITS
): boolean {
  return nodes.length >= limits.nodes || relationships.length >= limits.relationships;
}

/**
 * Merge a page edge-by-edge so an endpoint is never added without its edge,
 * and an edge is never added without both endpoints. Once the next complete
 * edge cannot fit, the caller gets a terminal global-limit state instead of
 * repeatedly fetching the same unaccepted relationship.
 */
export function mergeGraphExpansionPage<TNode extends ExpansionNode, TRelationship extends ExpansionRelationship>(
  existingNodes: TNode[],
  pageNodes: TNode[],
  existingRelationships: TRelationship[],
  pageRelationships: TRelationship[],
  limits: GraphExpansionLimits = GRAPH_QUERY_LIMITS
): GraphExpansionMergeResult<TNode, TRelationship> {
  const nodes = [...existingNodes];
  const relationships = [...existingRelationships];
  const visibleNodeIds = new Set(existingNodes.map((node) => node.id));
  const visibleRelationshipIds = new Set(existingRelationships.map((relationship) => relationship.id));
  const candidateRelationshipIds = new Set(
    pageRelationships
      .filter((relationship) => !visibleRelationshipIds.has(relationship.id))
      .map((relationship) => relationship.id)
  );
  const pageNodesById = new Map(pageNodes.map((node) => [node.id, node]));
  let atGlobalLimit = isGraphAtExpansionLimit(nodes, relationships, limits);

  if (atGlobalLimit) {
    return {
      nodes,
      relationships,
      addedNodeCount: 0,
      addedRelationshipCount: 0,
      unacceptedRelationshipCount: candidateRelationshipIds.size,
      atGlobalLimit: true,
    };
  }

  for (const relationship of pageRelationships) {
    if (visibleRelationshipIds.has(relationship.id)) continue;

    const missingNodeIds = [...new Set([relationship.from, relationship.to])].filter(
      (nodeId) => !visibleNodeIds.has(nodeId)
    );
    const missingNodes = missingNodeIds
      .map((nodeId) => pageNodesById.get(nodeId))
      .filter((node): node is TNode => Boolean(node));

    // A malformed API row must not create an edge with a missing endpoint.
    if (missingNodes.length !== missingNodeIds.length) continue;

    if (relationships.length >= limits.relationships || nodes.length + missingNodes.length > limits.nodes) {
      atGlobalLimit = true;
      break;
    }

    for (const node of missingNodes) {
      nodes.push(node);
      visibleNodeIds.add(node.id);
    }
    relationships.push(relationship);
    visibleRelationshipIds.add(relationship.id);
  }

  atGlobalLimit = atGlobalLimit || isGraphAtExpansionLimit(nodes, relationships, limits);

  const addedRelationshipCount = relationships.length - existingRelationships.length;

  return {
    nodes,
    relationships,
    addedNodeCount: nodes.length - existingNodes.length,
    addedRelationshipCount,
    unacceptedRelationshipCount: Math.max(0, candidateRelationshipIds.size - addedRelationshipCount),
    atGlobalLimit,
  };
}
