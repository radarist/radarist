/**
 * @file graph-view-model.ts
 * @description Pure, canvas-independent view-model helpers for GRAPH-067 dense
 * graph exploration. Kept free of Cytoscape so the domain/raw partition, the
 * viewport snapshot, and the neighborhood-translation math can be unit-tested and
 * reused by the imperative renderer without duplicating the rules.
 */

export interface GraphViewNode {
  id: string;
  labels: string[];
}

export interface GraphViewEdge {
  id: string;
  from: string;
  to: string;
}

export type GraphViewMode = 'domain' | 'raw';

/**
 * Business-domain node labels. The Raw audit view shows every node the query
 * returned; the Domain view narrows to these first-class business entities and
 * hides provenance/verification/runtime scaffolding (Assertion, Evidence,
 * Document/Chunk, Community/observation/insight nodes, …). This is a presentation
 * filter only — it never changes the query response.
 */
export const DOMAIN_NODE_LABELS: ReadonlySet<string> = new Set([
  'Company',
  'Technology',
  'Signal',
  'Prototype',
  'UseCase',
  'Strategy',
  'PainPoint',
  'Initiative',
  'OrgUnit',
  'Radar',
  'RadarPlacement',
  'Concept',
]);

/** True when a node carries at least one business-domain label. */
export function isDomainNode(labels: string[]): boolean {
  return labels.some((label) => DOMAIN_NODE_LABELS.has(label));
}

export interface GraphViewPartition {
  visibleNodeIds: Set<string>;
  visibleEdgeIds: Set<string>;
}

/**
 * Partition a returned graph into the visible set for a view mode WITHOUT
 * mutating the inputs. `raw` keeps the exact returned topology; `domain` keeps
 * only domain nodes and the edges whose endpoints are both still visible (an
 * edge to a hidden audit node is hidden too, so no dangling edges remain).
 */
export function partitionGraphView(
  nodes: readonly GraphViewNode[],
  edges: readonly GraphViewEdge[],
  mode: GraphViewMode
): GraphViewPartition {
  if (mode === 'raw') {
    return {
      visibleNodeIds: new Set(nodes.map((node) => node.id)),
      visibleEdgeIds: new Set(edges.map((edge) => edge.id)),
    };
  }

  const visibleNodeIds = new Set(nodes.filter((node) => isDomainNode(node.labels)).map((node) => node.id));
  const visibleEdgeIds = new Set(
    edges.filter((edge) => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to)).map((edge) => edge.id)
  );
  return { visibleNodeIds, visibleEdgeIds };
}

/**
 * GRAPH-067 #16 — presentation-only per-radar ring grouping for the Domain view.
 * Groups placements by [radarId, ring] into a virtual cluster labelled
 * "<Radar> / <Ring>" WITHOUT collapsing them: each placement stays its own node
 * with its own identity, and the group is derived at render time, never
 * persisted. Seven technologies in Trial on one radar produce seven placement
 * members under one "<Radar> / Trial" group — never a single shared Trial node,
 * and never one global Trial group across radars.
 */
export interface RingGroupablePlacement {
  id: string;
  radarId: string | null;
  radarName?: string | null;
  ring: string | null;
}

export interface RingGroup {
  /** Deterministic virtual group id — distinct per (radarId, ring). */
  groupId: string;
  radarId: string;
  ring: string;
  label: string;
  memberIds: string[];
}

/** Deterministic virtual group id for a placement's (radar, ring) — presentation only. */
export function ringGroupId(radarId: string, ring: string): string {
  return `ringgroup::${radarId}::${ring}`;
}

/**
 * Derive the per-radar ring groups for the Domain view. Placements missing a
 * radar or ring are left ungrouped (returned in `ungrouped`) rather than forced
 * into a bogus shared group.
 */
export function computeDomainRingGroups(placements: RingGroupablePlacement[]): {
  groups: RingGroup[];
  ungrouped: string[];
} {
  const byGroup = new Map<string, RingGroup>();
  const ungrouped: string[] = [];
  for (const placement of placements) {
    if (!placement.radarId || !placement.ring) {
      ungrouped.push(placement.id);
      continue;
    }
    const groupId = ringGroupId(placement.radarId, placement.ring);
    const existing = byGroup.get(groupId);
    if (existing) {
      existing.memberIds.push(placement.id);
    } else {
      const radarLabel = placement.radarName?.trim() || placement.radarId;
      byGroup.set(groupId, {
        groupId,
        radarId: placement.radarId,
        ring: placement.ring,
        label: `${radarLabel} / ${placement.ring}`,
        memberIds: [placement.id],
      });
    }
  }
  return { groups: [...byGroup.values()], ungrouped };
}

export interface BodyFitBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface BodyFitViewport {
  width: number;
  height: number;
  padding: number;
  minZoom: number;
  maxZoom: number;
  /**
   * GRAPH-072 repair — rendered caption envelope to reserve around the body
   * bounds. Captions are screen-space (constant rendered size), so their
   * envelope is a CONSTANT padding: reserving it here cannot re-create the
   * fit feedback loop that motivated body-only framing, and it guarantees a
   * fitted graph never paints a caption across the viewport edge. `x` reserves
   * half the plate width on each side; `top`/`bottom` reserve the vertical
   * plate extent (captions hang below their node, so `bottom` dominates).
   */
  labelEnvelope?: { x: number; top: number; bottom: number };
}

export interface BodyFitResult {
  zoom: number;
  pan: { x: number; y: number };
}

/**
 * GRAPH-072/UX-070 — frame the graph on its NODE BODIES.
 *
 * Cytoscape's own `fit()` measures the bounding box WITH labels. That is fine
 * while captions are model-sized, but screen-space captions are sized
 * `constant / zoom`, so their model footprint GROWS as zoom falls — and fit then
 * becomes a feedback loop: fit lowers the zoom, the lower zoom inflates every
 * label box, the inflated boxes demand an even lower zoom. On a dense graph the
 * viewport never settles and the content ends up far smaller than the viewport.
 *
 * Framing on node bodies breaks the loop at its source: the thing being framed no
 * longer depends on the zoom being computed. Labels are decoration that resizes
 * itself to the screen; they must not drive the camera.
 */
export function computeBodyFit(bounds: BodyFitBounds, viewport: BodyFitViewport): BodyFitResult | null {
  const width = bounds.x2 - bounds.x1;
  const height = bounds.y2 - bounds.y1;
  if (![bounds.x1, bounds.y1, bounds.x2, bounds.y2].every(Number.isFinite)) return null;
  if (!(viewport.width > 0) || !(viewport.height > 0)) return null;

  const requestedEnvelope = viewport.labelEnvelope ?? { x: 0, top: 0, bottom: 0 };
  // On a phone-sized canvas the constant caption envelope would consume most
  // of the frame (146 of a 209px usable width at 390px) and pin the fit at
  // minZoom with every caption deferred. Cap the reservation at a fraction of
  // each axis: edge captions then defer individually (the clip gate still
  // protects them) instead of crushing the whole graph.
  const envelope = {
    x: Math.min(requestedEnvelope.x, viewport.width * 0.12),
    top: Math.min(requestedEnvelope.top, viewport.height * 0.05),
    bottom: Math.min(requestedEnvelope.bottom, viewport.height * 0.08),
  };

  // A single node (or a perfectly flat run) has zero extent on an axis; fall back
  // to the other axis rather than dividing by zero into an infinite zoom.
  const availableWidth = Math.max(1, viewport.width - viewport.padding * 2 - envelope.x * 2);
  const availableHeight = Math.max(1, viewport.height - viewport.padding * 2 - envelope.top - envelope.bottom);
  const candidates: number[] = [];
  if (width > 0) candidates.push(availableWidth / width);
  if (height > 0) candidates.push(availableHeight / height);
  const raw = candidates.length > 0 ? Math.min(...candidates) : viewport.maxZoom;
  const zoom = Math.max(viewport.minZoom, Math.min(viewport.maxZoom, raw));

  return {
    zoom,
    pan: {
      // The x envelope is symmetric, so horizontal centering is unchanged; the
      // vertical envelope is asymmetric (captions hang below), so the content
      // shifts up by half the difference to stay centered in the usable band.
      x: (viewport.width - zoom * (bounds.x1 + bounds.x2)) / 2,
      y: (viewport.height + envelope.top - envelope.bottom - zoom * (bounds.y1 + bounds.y2)) / 2,
    },
  };
}

export interface ViewportPoint {
  x: number;
  y: number;
}

export interface ViewportSnapshot {
  pan: ViewportPoint;
  zoom: number;
  positions: Map<string, ViewportPoint>;
}

/**
 * Capture pan/zoom and every node position by id, deep-copying positions so a
 * later node drag (or a ResizeObserver-driven refit) cannot corrupt the snapshot.
 * Clearing an isolate restores from this exact snapshot instead of relaying out,
 * so the mental map is preserved and drift cannot accumulate across focus changes.
 */
export function captureViewport(
  viewport: { pan: ViewportPoint; zoom: number },
  nodes: Array<{ id: string; position: ViewportPoint }>
): ViewportSnapshot {
  const positions = new Map<string, ViewportPoint>();
  for (const node of nodes) {
    positions.set(node.id, { x: node.position.x, y: node.position.y });
  }
  return { pan: { x: viewport.pan.x, y: viewport.pan.y }, zoom: viewport.zoom, positions };
}

/**
 * Translate exactly the named neighborhood members (the selected node + its
 * visible one-hop neighbors) by a delta, returning a NEW positions map. Nodes
 * outside the set are copied unchanged, so a neighborhood move never triggers a
 * global refit. Pure — the source map is not mutated.
 */
export function translateNeighborhood(
  positions: ReadonlyMap<string, ViewportPoint>,
  memberIds: ReadonlySet<string>,
  delta: ViewportPoint
): Map<string, ViewportPoint> {
  const next = new Map<string, ViewportPoint>();
  for (const [id, position] of positions) {
    if (memberIds.has(id)) {
      next.set(id, { x: position.x + delta.x, y: position.y + delta.y });
    } else {
      next.set(id, { x: position.x, y: position.y });
    }
  }
  return next;
}
