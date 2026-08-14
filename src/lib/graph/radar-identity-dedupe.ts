/**
 * @file graph/radar-identity-dedupe.ts
 * @description GRAPH-071 closure — the pure planner that collapses duplicate
 * `:Radar` nodes sharing one `id`.
 *
 * ROOT CAUSE, not a symptom repair. `graph:health` reports two separate radar
 * violations on a retained graph — a missing `radar_id` uniqueness constraint
 * and RadarPlacement nodes "without exactly one ON_RADAR". They are the same
 * defect seen twice. `sync-placement-to-neo4j.ts` writes
 * `MATCH (r:Radar {id: $radarId}) MERGE (p)-[:ON_RADAR]->(r)`; with no
 * uniqueness constraint that MATCH can bind TWO nodes, so the MERGE mints one
 * edge per duplicate and the placement ends up with two ON_RADAR edges pointing
 * at two copies of the same radar. Deleting the surplus edges would leave the
 * duplicate node behind to re-mint them on the next sync — and the constraint
 * still could not be created. The duplicate node is the thing to remove.
 *
 * That also explains the ordering the migration must respect: the
 * `2026-07-22-radar-placement-pair-identity` migration cannot run at all while a
 * duplicate exists, because its preflight (`planRadarPlacementPairMigration`)
 * correctly aborts on `duplicate Radar.id` before writing anything.
 *
 * The planner is deliberately narrow and FAILS CLOSED. It only authorizes
 * deleting a duplicate that is provably redundant: identical properties, and an
 * incident-edge set that is a subset of the survivor's. Anything else — a
 * property that differs, an edge only the duplicate carries — is a violation
 * that halts the migration with the exact drift named, because collapsing it
 * would silently pick a winner on the operator's behalf.
 *
 * Pure, dependency-free, and unit-testable without a graph, mirroring
 * `radar-placement-pair-key`'s planner.
 */

export type RadarIdentityEdgeDirection = 'incoming' | 'outgoing';

export interface RadarIdentityEdge {
  type: string;
  direction: RadarIdentityEdgeDirection;
  /** Stable identity of the OTHER endpoint. */
  otherElementId: string;
  /** The other endpoint's `id` property, for human-readable violation text. */
  otherId: string | null;
}

export interface RadarIdentityNode {
  /** Neo4j `elementId` — the only stable handle for a node with a duplicated id. */
  elementId: string;
  /** The duplicated `Radar.id`. */
  id: string;
  /** Full property bag, already converted to native JS values. */
  properties: Record<string, unknown>;
  edges: RadarIdentityEdge[];
}

export interface RadarIdentityDedupeGroup {
  radarId: string;
  survivorElementId: string;
  /** Duplicates proven redundant against the survivor; safe to DETACH DELETE. */
  redundantElementIds: string[];
  /** Edges removed as a consequence of deleting the redundant nodes. */
  removedEdgeCount: number;
}

export interface RadarIdentityDedupePlan {
  groups: RadarIdentityDedupeGroup[];
  violations: string[];
  nodesToDelete: number;
  edgesToDelete: number;
}

/** Direction-aware, neighbour-exact edge key. */
function edgeKey(edge: RadarIdentityEdge): string {
  return `${edge.direction}|${edge.type}|${edge.otherElementId}`;
}

/**
 * Order-independent canonical form of a property bag, so two nodes written by
 * the same sync in a different key order still compare equal. Values are
 * JSON-encoded, which distinguishes `1` from `'1'` and `[1,2]` from `[2,1]` —
 * an array order difference is real drift, not noise.
 */
export function canonicalRadarProperties(properties: Record<string, unknown>): string {
  const entries = Object.entries(properties)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, JSON.stringify(value ?? null)] as const);
  return JSON.stringify(entries);
}

/**
 * Pick the survivor deterministically: the node carrying the most incident
 * edges (so the fewest edges are ever discarded), tie-broken by the lexically
 * smallest `elementId`. Determinism is what makes a replay of the migration
 * choose the same survivor rather than churning the graph.
 */
function pickSurvivor(nodes: RadarIdentityNode[]): RadarIdentityNode {
  return [...nodes].sort(
    (left, right) => right.edges.length - left.edges.length || left.elementId.localeCompare(right.elementId)
  )[0];
}

/**
 * Compute the complete dedupe plan with ZERO mutation. The migration must call
 * this first and refuse to write when `violations` is non-empty, so ambiguous
 * drift produces no change at all rather than a partial collapse.
 *
 * @param nodes - every `:Radar` node whose `id` is shared by more than one node.
 *   Passing non-duplicated nodes is harmless: a group of one plans nothing.
 */
export function planRadarIdentityDedupe(nodes: RadarIdentityNode[]): RadarIdentityDedupePlan {
  const byId = new Map<string, RadarIdentityNode[]>();
  const violations: string[] = [];

  for (const node of nodes) {
    if (!node.id) {
      violations.push(`:Radar node ${node.elementId} has no id and cannot be identity-deduped`);
      continue;
    }
    byId.set(node.id, [...(byId.get(node.id) ?? []), node]);
  }

  const groups: RadarIdentityDedupeGroup[] = [];

  for (const [radarId, members] of [...byId.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (members.length < 2) continue;

    const survivor = pickSurvivor(members);
    const survivorEdgeKeys = new Set(survivor.edges.map(edgeKey));
    const survivorProperties = canonicalRadarProperties(survivor.properties);

    const redundant: RadarIdentityNode[] = [];
    for (const candidate of members) {
      if (candidate.elementId === survivor.elementId) continue;

      if (canonicalRadarProperties(candidate.properties) !== survivorProperties) {
        const differing = differingPropertyKeys(survivor.properties, candidate.properties);
        violations.push(
          `Radar ${radarId}: duplicate ${candidate.elementId} differs from survivor ${survivor.elementId} on ` +
            `propert${differing.length === 1 ? 'y' : 'ies'} ${differing.join(', ')} — resolve by hand before deduping`
        );
        continue;
      }

      const exclusive = candidate.edges.filter((edge) => !survivorEdgeKeys.has(edgeKey(edge)));
      if (exclusive.length > 0) {
        violations.push(
          `Radar ${radarId}: duplicate ${candidate.elementId} carries ${exclusive.length} edge(s) the survivor ` +
            `${survivor.elementId} does not (${exclusive
              .slice(0, 5)
              .map((edge) => `${edge.direction} ${edge.type} -> ${edge.otherId ?? edge.otherElementId}`)
              .join(', ')}) — re-point them before deduping`
        );
        continue;
      }

      redundant.push(candidate);
    }

    if (redundant.length === 0) continue;

    groups.push({
      radarId,
      survivorElementId: survivor.elementId,
      redundantElementIds: redundant.map((node) => node.elementId).sort(),
      removedEdgeCount: redundant.reduce((total, node) => total + node.edges.length, 0),
    });
  }

  return {
    groups,
    violations,
    nodesToDelete: groups.reduce((total, group) => total + group.redundantElementIds.length, 0),
    edgesToDelete: groups.reduce((total, group) => total + group.removedEdgeCount, 0),
  };
}

function differingPropertyKeys(left: Record<string, unknown>, right: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => JSON.stringify(left[key] ?? null) !== JSON.stringify(right[key] ?? null)).sort();
}
