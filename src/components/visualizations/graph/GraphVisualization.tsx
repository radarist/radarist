/**
 * @file GraphVisualization.tsx
 * @description Cytoscape.js-based interactive graph visualization.
 *
 * Renders the knowledge-graph result set for `/visualizations/graph`. Replaces
 * the former Neo4j-NVL renderer (proprietary license) with Cytoscape.js +
 * cytoscape-fcose — both MIT. cytoscape-fcose is the same force-layout family
 * NVL used internally, so node spacing matches; the declarative stylesheet
 * reproduces NVL's look (word-wrapped in-node captions, relationship-type edge
 * labels, arrowheads, curved edges, degree-sizing, selection highlight).
 *
 * Feature parity with the old NVL component:
 * - Force-directed layout (fcose), auto-fit on first layout.
 * - Stable-ID expansion that preserves positions, selection, pan, and zoom.
 * - Entity-type node colors + degree-based sizing + in-node wrapped captions.
 * - Relationship-type edge colors, labels, and arrowheads on curved edges.
 * - Node / relationship / background click handling; hover tooltip.
 * - Node drag; zoom in / out / fit / reset controls; bounded 0.05x–2x zoom range.
 * - Interactive entity legend + node/relationship count badge.
 *
 * Browser-only (Cytoscape touches window/canvas) — import via
 * `next/dynamic` with `ssr: false` (see the graph page).
 *
 * @author Radarist Team
 * @created 2026-07-10
 */

'use client';

import { useRef, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import cytoscape from 'cytoscape';
import type {
  BoundingBoxOptions,
  Core,
  ElementDefinition,
  EventObject,
  LayoutOptions,
  NodeSingular,
  Position,
  StylesheetJson,
} from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { Loader2, Maximize2, Move, RefreshCw, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GraphSkeleton } from '@/components/skeletons';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { deriveNodeCaption, getPrimaryNodeLabel } from '@/lib/graph-node-caption';
import {
  captureViewport,
  computeBodyFit,
  translateNeighborhood,
  type RingGroup,
  type ViewportSnapshot,
} from './graph-view-model';
import { computeEdgeRestStroke, isDarkSurface, readGraphThemeTokens, type GraphThemeTokens } from './graph-theme';
import { entityColorHex, isMappedEntityLabel, relationColorHex } from '@/lib/entity-colors';
import {
  SCREEN_LABEL_METRICS,
  computeBoundedEdgeLabelStyle,
  computeProportionalNodeSize,
  computeScreenSpaceLabelStyle,
  countRenderedCaptions,
  estimateRenderedLabelBox,
  getLabelDensityPolicy,
  fitsViewport,
  intersectsViewport,
  overlapsAnyBounds,
  selectVisibleNodeLabels,
  type RenderedCaptionProbe,
  type RenderedLabelBounds,
} from './graph-label-density';

// Register the fcose layout once per module. cytoscape.use throws if the same
// extension is registered twice (e.g. dev fast-refresh), so guard it.
let fcoseRegistered = false;
function ensureFcose(): void {
  if (fcoseRegistered) return;
  try {
    cytoscape.use(fcose);
  } catch {
    // Already registered by a previous module evaluation — safe to ignore.
  }
  fcoseRegistered = true;
}

/** Stable empty default so the ringGroups prop never churns re-renders. */
const EMPTY_RING_GROUPS: RingGroup[] = [];

// ============================================================================
// TYPES
// ============================================================================

/** Node data from the API. */
interface ApiNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  caption?: string;
}

/** Relationship data from the API. */
interface ApiRelationship {
  id: string;
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
}

interface GraphVisualizationProps {
  /** Nodes to display */
  nodes: ApiNode[];
  /** Relationships to display */
  relationships: ApiRelationship[];
  /**
   * GRAPH-067 #16 — presentation-only per-radar ring groups for the Domain view.
   * Each becomes a visual compound parent; member placements stay individual
   * nodes. Empty/absent in the Raw view.
   */
  ringGroups?: RingGroup[];
  /** Callback when a node is clicked */
  onNodeClick?: (node: ApiNode) => void;
  /** Callback when a relationship is clicked */
  onRelationshipClick?: (relationship: ApiRelationship) => void;
  /** Callback when background is clicked (deselect) */
  onBackgroundClick?: () => void;
  /** ID of currently selected node */
  selectedNodeId?: string | null;
  /** ID of currently selected relationship */
  selectedRelationshipId?: string | null;
  /** Entity label whose neighborhood should remain emphasized */
  activeLabel?: string | null;
  /** Relationship type whose matching paths should remain emphasized */
  activeRelationshipType?: string | null;
  /**
   * GRAPH-067 isolate — when set, HARD-hide every element outside the selected
   * node's one-hop neighborhood (removed from layout + fit). Takes precedence
   * over label/relationship focus because it is an explicit per-node action.
   */
  isolatedNodeId?: string | null;
  /** Callback when an on-canvas legend item changes the active label */
  onLabelFocusChange?: (label: string | null) => void;
  /** Whether the visualization is loading */
  isLoading?: boolean;
  /**
   * GRAPH-055 — operator-readable phase of the in-flight operation
   * ("contacting server" / "reading response" / "rendering result"), shown in
   * the busy overlay so a long wait is attributable instead of an opaque spinner.
   */
  loadingPhase?: string | null;
  /**
   * GRAPH-055 — identity of the in-flight operation. Supersession keeps
   * `isLoading` continuously true, so this keys the busy overlay's remount:
   * each operation's elapsed counter starts from ITS OWN start, not the hung
   * operation it replaced.
   */
  loadingOpId?: number | null;
  /** Custom class name */
  className?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Full human caption for a node — the API route derives it server-side;
 * older/cached responses without `caption` fall back to the same shared
 * derivation (`@/lib/graph-node-caption`). Used for the label + tooltip.
 */
function getFullCaption(node: ApiNode): string {
  return node.caption || deriveNodeCaption(node.labels, node.properties, node.id);
}

/**
 * Bound the in-node label so a sentence-length entity name (some `name`
 * properties hold a full description) can't render as a tall vertical text
 * column. Trims on a word boundary and ellipsizes. The full caption stays
 * available in the hover tooltip, so nothing is lost — this only fits the
 * *display* label, the same job NVL's canvas renderer did internally.
 */
const MAX_CAPTION_CHARS = 38;
function fitCaption(caption: string): string {
  const compact = caption.trim().replace(/\s+/g, ' ');
  if (compact.length <= MAX_CAPTION_CHARS) return compact;
  const slice = compact.slice(0, MAX_CAPTION_CHARS);
  const lastSpace = slice.lastIndexOf(' ');
  // Prefer a word boundary, but only if it doesn't lop off too much.
  const base = lastSpace > MAX_CAPTION_CHARS * 0.6 ? slice.slice(0, lastSpace) : slice;
  return base.trimEnd() + '…';
}

/**
 * Compute the degree (edge count) of each node so the viz can size hubs
 * larger than leaves. Done client-side from the already-fetched relationships
 * to avoid an extra round trip.
 */
function computeDegrees(apiNodes: ApiNode[], apiRels: ApiRelationship[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const n of apiNodes) degree.set(n.id, 0);
  for (const r of apiRels) {
    if (degree.has(r.from)) degree.set(r.from, (degree.get(r.from) ?? 0) + 1);
    if (degree.has(r.to)) degree.set(r.to, (degree.get(r.to) ?? 0) + 1);
  }
  return degree;
}

/**
 * Map degree → model node diameter.
 * Baseline 30 (leaves), cap 64 (mega-hubs). Sqrt keeps the top end from
 * dominating the canvas when one node has 20+ edges. GRAPH-067 reopen: the
 * previous 34–64 spread (ratio 1.9) flattened hub hierarchy; lowering the LEAF
 * baseline to 30 widens it to 2.13 while `computeProportionalNodeSize`
 * preserves the ratio at every zoom. The 64 cap is deliberately unchanged —
 * the dense-graph overlap-resolution budget (GRAPH-067's 275-node
 * collision-free terminal state) is calibrated against a 64px maximum body,
 * and a larger cap leaves residual collisions the bounded push-apart pass
 * cannot clear.
 */
function sizeForDegree(degree: number): number {
  const base = 30;
  const scale = 9;
  return Math.min(64, base + Math.sqrt(Math.max(0, degree)) * scale);
}

// UX-070 removed `getReadableNodeTextColors`. It picked a light/dark ink by WCAG
// contrast against the NODE FILL, which was the right question while the caption
// was painted on top of the node. The caption now sits below the node on a plate
// in the surface colour, so its contrast is a property of the theme tokens, not of
// the entity palette — keeping a fill-contrast helper would have been actively
// misleading about where the text lands.

// GRAPH-072 — captions are sized in SCREEN space (see `graph-label-density.ts`),
// so their rendered size never changes with zoom and this stylesheet floor can
// never cull them. The collision budget in that module is the single culling
// authority; this remains a floor, not a competing policy.
const LABEL_RENDERED_FONT_FLOOR = SCREEN_LABEL_METRICS.minRenderedFontPx;
/** Above this node count fCoSE uses its cheaper dense-graph settings. */
const DENSE_LAYOUT_NODES = 60;
/** Keep incrementally-added nodes clear of existing node bodies and labels. */
const EXPANSION_NODE_DISTANCE = 120;
const EXPANSION_NODE_MIN_SPACING = 96;

const NODE_BODY_BOUNDS: BoundingBoxOptions = {
  includeNodes: true,
  includeEdges: false,
  includeLabels: false,
  includeOverlays: false,
  includeUnderlays: false,
};
const LABEL_BOUNDS: BoundingBoxOptions = {
  includeNodes: false,
  includeEdges: false,
  includeLabels: true,
  includeOverlays: false,
  includeUnderlays: false,
};

/**
 * Frame the given elements on their NODE BODIES rather than Cytoscape's
 * label-inclusive bounding box. See `computeBodyFit` for why: screen-space
 * captions have a model footprint of `constant / zoom`, so a label-inclusive fit
 * feeds its own output back into its input and never settles.
 */
/**
 * GRAPH-072 repair — captions are screen-space, so their envelope is a CONSTANT
 * rendered padding. Reserving it in every framing pass guarantees a fitted
 * graph cannot paint a caption across the viewport edge (the operator-reported
 * clipped names on isolate/arrival), and because the envelope does not depend
 * on the zoom being computed it cannot re-create the fit feedback loop.
 */
function captionEnvelope(): { x: number; top: number; bottom: number } {
  const plate = SCREEN_LABEL_METRICS.backgroundPaddingPx;
  return {
    x: SCREEN_LABEL_METRICS.maxWidthPx / 2 + plate,
    top: plate + 1,
    bottom: SCREEN_LABEL_METRICS.marginYPx + SCREEN_LABEL_METRICS.fontPx * 1.2 + plate * 2,
  };
}

function fitToNodeBodies(cy: Core, elements: ReturnType<Core['elements']> | null, padding: number): void {
  const target = elements ?? cy.elements();
  if (target.length === 0) return;
  const fit = computeBodyFit(target.boundingBox(NODE_BODY_BOUNDS), {
    width: cy.width(),
    height: cy.height(),
    padding,
    minZoom: cy.minZoom(),
    maxZoom: cy.maxZoom(),
    labelEnvelope: captionEnvelope(),
  });
  // A degenerate viewport (zero-size container) has no meaningful framing; leave
  // the camera alone rather than moving it somewhere arbitrary.
  if (!fit) return;
  cy.zoom(fit.zoom);
  cy.pan(fit.pan);
}

function hasRenderedArea(bounds: RenderedLabelBounds & { w?: number; h?: number }): boolean {
  return (
    [bounds.x1, bounds.y1, bounds.x2, bounds.y2].every(Number.isFinite) &&
    (bounds.w ?? bounds.x2 - bounds.x1) > 0 &&
    (bounds.h ?? bounds.y2 - bounds.y1) > 0
  );
}

/** Conservative fallback for renderers that do not expose label-only bounds. */
function estimateRenderedLabelBounds(node: NodeSingular, zoom: number): RenderedLabelBounds {
  const position = node.renderedPosition();
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const modelFont = Number(node.data('fontSize')) || SCREEN_LABEL_METRICS.fontPx;
  const modelMaxWidth = Number(node.data('textMaxWidth')) || SCREEN_LABEL_METRICS.maxWidthPx;
  const modelMarginY = Number(node.data('textMarginY')) || 0;

  return estimateRenderedLabelBox({
    centerX: position.x,
    centerY: position.y,
    label: String(node.data('label') ?? ''),
    renderedFontPx: modelFont * safeZoom,
    renderedMaxWidthPx: modelMaxWidth * safeZoom,
    // The caption sits below the node body (UX-070), so the collision box has to
    // sit there too — otherwise the policy separates boxes that do not overlap
    // and lets ones that do collide through.
    offsetY: node.outerHeight() / 2 + modelMarginY * safeZoom,
    // The collision box covers the painted PLATE, not just the glyphs.
    platePaddingPx: SCREEN_LABEL_METRICS.backgroundPaddingPx,
  });
}

function getRenderedLabelBounds(node: NodeSingular, zoom: number): RenderedLabelBounds {
  const bounds = node.renderedBoundingBox(LABEL_BOUNDS);
  return hasRenderedArea(bounds) ? bounds : estimateRenderedLabelBounds(node, zoom);
}

/**
 * GRAPH-072 — rewrite the zoom-dependent caption metrics so every caption holds a
 * constant RENDERED size. The values are uniform across leaf nodes, so one
 * computation feeds the whole batch, and each node takes a single `.data()` call
 * to keep style invalidation to one pass per node.
 *
 * Repair (2026-07-31): this MUST run synchronously inside the `zoom` event —
 * the previous requestAnimationFrame deferral let Cytoscape paint frames whose
 * glyphs were ellipsized under one zoom's metrics but drawn through a box
 * computed at another's, clipping centered captions symmetrically mid-word
 * ("erfumery & Beau"). The zoom guard makes repeated calls at an unchanged
 * zoom free, so belt-and-braces call sites cost nothing.
 */
const SCREEN_SPACE_ZOOM_SCRATCH = '_repairScreenSpaceZoom';

function applyScreenSpaceLabelStyle(cy: Core, options?: { force?: boolean }): void {
  const zoom = cy.zoom();
  const previous = cy.scratch(SCREEN_SPACE_ZOOM_SCRATCH) as number | undefined;
  if (!options?.force && previous !== undefined && Math.abs(previous - zoom) < 1e-9) return;
  cy.scratch(SCREEN_SPACE_ZOOM_SCRATCH, zoom);

  const nodeStyle = computeScreenSpaceLabelStyle(zoom);
  const edgeStyle = computeBoundedEdgeLabelStyle(zoom);
  cy.batch(() => {
    for (const node of cy.nodes().toArray()) {
      if (node.data('isRingGroup')) continue;
      node.data({
        ...(nodeStyle as unknown as Record<string, unknown>),
        size: computeProportionalNodeSize(Number(node.data('baseSize')), zoom),
      });
    }
    for (const edge of cy.edges().toArray()) {
      edge.data(edgeStyle as unknown as Record<string, unknown>);
    }
  });
}

/**
 * Update only label classes; graph geometry and viewport state stay intact.
 * Returns the count the density policy REPORTS as visible, which GRAPH-072
 * requires to equal the count actually painted.
 */
function applyLabelDensity(cy: Core): number {
  const nodes = cy.nodes().toArray();
  const width = cy.width();
  const height = cy.height();
  const zoom = cy.zoom();
  // UX-070 repair — every visible node BODY is an obstacle: a caption plate
  // across another node's disc occludes the color mark it exists to identify
  // (the operator's dense-cluster screenshots). A plate never intersects its
  // OWN body — it hangs `text-margin-y` (6px) below it — so one shared
  // obstacle list serves every candidate without self-exclusion bookkeeping.
  const bodyBoxes: RenderedLabelBounds[] = [];
  for (const node of nodes) {
    if (!node.visible() || node.data('isRingGroup')) continue;
    const box = node.renderedBoundingBox(NODE_BODY_BOUNDS);
    bodyBoxes.push({ x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 });
  }

  const candidates = nodes.filter((node) => {
    // A hard-isolated node is `display: none`; it can neither be a collision
    // participant nor paint a caption, so counting it would report captions that
    // are not there.
    if (!node.visible()) return false;
    const explicitlyVisible = node.selected() || node.hasClass('label-hovered');
    const bodyOnScreen = intersectsViewport(node.renderedBoundingBox(NODE_BODY_BOUNDS), width, height);
    if (explicitlyVisible) return true;
    if (!bodyOnScreen) return false;
    const labelBounds = getRenderedLabelBounds(node, zoom);
    // A caption clipped by the canvas edge is worse than a temporarily omitted
    // one: it presents an unreadable fragment as if it were a usable name.
    if (!fitsViewport(labelBounds, width, height, 4)) return false;
    return !overlapsAnyBounds(labelBounds, bodyBoxes, 2);
  });
  const policy = getLabelDensityPolicy({
    width,
    height,
    zoom,
    nodeCount: candidates.length,
  });
  const visibleIds = selectVisibleNodeLabels(
    candidates.map((node) => ({
      id: node.id(),
      degree: Number(node.data('degree') ?? 0),
      bounds: getRenderedLabelBounds(node, zoom),
      alwaysVisible: node.selected() || node.hasClass('label-hovered'),
    })),
    policy
  );

  cy.batch(() => {
    for (const node of nodes) {
      if (visibleIds.has(node.id())) node.removeClass('label-deferred');
      else node.addClass('label-deferred');
    }
  });

  return visibleIds.size;
}

/**
 * Read each leaf caption as the live renderer sees it. Values come from
 * Cytoscape's OWN computed style, so the "actually rendered" side of the
 * GRAPH-072 contract never re-implements the stylesheet cascade.
 */
function readCaptionProbes(cy: Core): RenderedCaptionProbe[] {
  const zoom = cy.zoom();
  return cy
    .nodes()
    .toArray()
    .filter((node) => !node.data('isRingGroup'))
    .map((node) => ({
      hasLabel: String(node.data('label') ?? '').length > 0,
      visible: node.visible(),
      textOpacity: Number(node.numericStyle('text-opacity')),
      fontSize: Number(node.numericStyle('font-size')),
      zoom,
      minZoomedFontSize: Number(node.numericStyle('min-zoomed-font-size')),
    }));
}

interface GraphFocus {
  nodeIds: Set<string>;
  relationshipIds: Set<string>;
}

/**
 * Resolve contextual focus without removing topology. Label focus keeps the
 * matching nodes and their immediate neighborhood; relationship focus keeps
 * matching edges and endpoints. Combining both narrows the relationship paths
 * to those touching the selected label.
 */
export function resolveGraphFocus(
  apiNodes: ApiNode[],
  apiRels: ApiRelationship[],
  activeLabel?: string | null,
  activeRelationshipType?: string | null
): GraphFocus | null {
  const label = activeLabel?.trim();
  const relationshipType = activeRelationshipType?.trim();
  if (!label && !relationshipType) return null;

  const allNodeIds = new Set(apiNodes.map((node) => node.id));
  const labelNodeIds = new Set(
    label ? apiNodes.filter((node) => node.labels.includes(label)).map((node) => node.id) : []
  );
  const validRelationships = apiRels.filter((relationship) => {
    return allNodeIds.has(relationship.from) && allNodeIds.has(relationship.to);
  });
  const focusedRelationshipIds = new Set<string>();
  const focusedNodeIds = new Set<string>(labelNodeIds);

  for (const relationship of validRelationships) {
    const matchesLabel = !label || labelNodeIds.has(relationship.from) || labelNodeIds.has(relationship.to);
    const matchesType = !relationshipType || relationship.type === relationshipType;
    if (!matchesLabel || !matchesType) continue;

    focusedRelationshipIds.add(relationship.id);
    focusedNodeIds.add(relationship.from);
    focusedNodeIds.add(relationship.to);
  }

  return { nodeIds: focusedNodeIds, relationshipIds: focusedRelationshipIds };
}

/**
 * GRAPH-067 isolate — resolve the visible one-hop topology for a single
 * selected node. Returns the selected node plus every node that shares a
 * retained relationship with it, and those connecting relationships. The focus
 * effect then HARD-hides everything else (removed from layout + fit), so the
 * canvas shows exactly that node's intended neighborhood — not an opacity dim.
 * Pure so the rule stays unit-testable and identical in the browser.
 */
export function resolveNodeIsolation(
  apiNodes: ApiNode[],
  apiRels: ApiRelationship[],
  nodeId: string | null | undefined
): GraphFocus | null {
  if (!nodeId) return null;
  if (!apiNodes.some((node) => node.id === nodeId)) return null;
  const nodeIds = new Set<string>([nodeId]);
  const relationshipIds = new Set<string>();
  for (const rel of apiRels) {
    const neighbor = rel.from === nodeId ? rel.to : rel.to === nodeId ? rel.from : null;
    if (neighbor && apiNodes.some((node) => node.id === neighbor)) {
      relationshipIds.add(rel.id);
      nodeIds.add(neighbor);
    }
  }
  return { nodeIds, relationshipIds };
}

/**
 * Compound parents participate in Cytoscape's derived visibility. If a focused
 * RadarPlacement is visible while its presentation-only ring parent remains
 * `display:none`, Cytoscape treats the child as hidden too. Include only the
 * virtual parents that contain focused members; other ring groups remain out of
 * layout and fit.
 */
export function includeRingGroupParents(focus: GraphFocus, ringGroups: readonly RingGroup[]): GraphFocus {
  const nodeIds = new Set(focus.nodeIds);
  for (const group of ringGroups) {
    if (group.memberIds.some((memberId) => focus.nodeIds.has(memberId))) {
      nodeIds.add(group.groupId);
    }
  }
  return { nodeIds, relationshipIds: new Set(focus.relationshipIds) };
}

interface TooltipPosition {
  left: number;
  top: number;
}

/** Keep a measured tooltip inside the graph viewport on every edge. */
export function clampTooltipPosition(
  anchorX: number,
  anchorY: number,
  containerWidth: number,
  containerHeight: number,
  tooltipWidth: number,
  tooltipHeight: number
): TooltipPosition {
  const inset = 8;
  const offset = 12;
  const maxLeft = Math.max(inset, containerWidth - tooltipWidth - inset);
  const maxTop = Math.max(inset, containerHeight - tooltipHeight - inset);

  return {
    left: Math.max(inset, Math.min(anchorX + offset, maxLeft)),
    top: Math.max(inset, Math.min(anchorY + offset, maxTop)),
  };
}

const log = createLogger('graph-visualization');

/**
 * GRAPH-055 layout-phase diagnostic window. A layout that has not reached
 * `layoutstop` after this long is logged (log only — NOT a timeout; nothing
 * is aborted and no state changes). The busy indicator is deliberately not
 * tied to layout completion, so a silent layout stall would otherwise be
 * invisible; this line makes it attributable.
 */
const LAYOUT_STALL_WARN_MS = 10_000;

/**
 * GRAPH-067 — include rendered node dimensions in overlap avoidance. fCoSE
 * separates node centers but does not guarantee two large degree-scaled hubs
 * (up to 64 model units across) stay clear of each other, especially in a dense
 * 250–300 node layout. This bounded, deterministic pass pushes apart any
 * visible node bodies whose model-space circles intersect, using each node's
 * rendered dimension (`outerWidth` / `outerHeight`). It only pushes apart (never together),
 * iterates a bounded number of passes, and is sorted by id — so it converges
 * monotonically and the canvas reaches a stable terminal state with zero node
 * collisions. Ring-group compound parents are containers (auto-sized to their
 * children): their own members intentionally sit inside them, but the terminal
 * collision truth must still include parent-vs-external-node and parent-vs-parent
 * overlaps.
 */
const OVERLAP_MAX_PASSES = 40;
const OVERLAP_PAD = 2;

export interface NodeOverlapResolution {
  collisionFree: boolean;
  passes: number;
  residualCollisions: number;
}

function nodeCollisionRadius(node: NodeSingular): number {
  return Math.max(node.outerWidth(), node.outerHeight()) / 2;
}

function countNodeCollisions(nodes: readonly NodeSingular[]): number {
  let collisions = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const pa = a.position();
      const pb = b.position();
      const minDist = nodeCollisionRadius(a) + nodeCollisionRadius(b) + OVERLAP_PAD;
      if (Math.hypot(pb.x - pa.x, pb.y - pa.y) < minDist - 1e-6) collisions += 1;
    }
  }
  return collisions;
}

interface ModelBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function boundsCollide(a: ModelBounds, b: ModelBounds): boolean {
  return (
    a.x1 < b.x2 + OVERLAP_PAD && a.x2 + OVERLAP_PAD > b.x1 && a.y1 < b.y2 + OVERLAP_PAD && a.y2 + OVERLAP_PAD > b.y1
  );
}

/**
 * Count compound-container collisions without treating intentional parent /
 * child containment as an overlap. This is a terminal truth check: the bounded
 * leaf push-apart pass does not pretend it can reposition Cytoscape's
 * auto-sized parents independently of their children.
 */
function countCompoundCollisions(leaves: readonly NodeSingular[], groups: readonly NodeSingular[]): number {
  let collisions = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const groupBounds = group.boundingBox(NODE_BODY_BOUNDS);
    for (let j = i + 1; j < groups.length; j += 1) {
      if (boundsCollide(groupBounds, groups[j].boundingBox(NODE_BODY_BOUNDS))) {
        collisions += 1;
      }
    }
    for (const leaf of leaves) {
      if (leaf.data('parent') === group.id()) continue;
      if (boundsCollide(groupBounds, leaf.boundingBox(NODE_BODY_BOUNDS))) {
        collisions += 1;
      }
    }
  }
  return collisions;
}

export function resolveNodeOverlaps(cy: Core): NodeOverlapResolution {
  const allVisible = (cy.nodes().toArray() as unknown as NodeSingular[]).filter((node) => node.visible());
  const visible = allVisible.filter((node) => !node.data('isRingGroup'));
  const groups = allVisible.filter((node) => node.data('isRingGroup'));
  visible.sort((a, b) => (a.id() < b.id() ? -1 : a.id() > b.id() ? 1 : 0));
  let passes = 0;
  for (let pass = 0; pass < OVERLAP_MAX_PASSES; pass += 1) {
    let moved = false;
    for (let i = 0; i < visible.length; i += 1) {
      for (let j = i + 1; j < visible.length; j += 1) {
        const a = visible[i];
        const b = visible[j];
        const ra = nodeCollisionRadius(a);
        const rb = nodeCollisionRadius(b);
        const pa = a.position();
        const pb = b.position();
        let dx = pb.x - pa.x;
        let dy = pb.y - pa.y;
        let dist = Math.hypot(dx, dy);
        const minDist = ra + rb + OVERLAP_PAD;
        if (dist >= minDist) continue;
        moved = true;
        if (dist === 0) {
          dx = 1;
          dy = 0;
          dist = 1;
        }
        const overlap = minDist - dist;
        const ux = dx / dist;
        const uy = dy / dist;
        const half = overlap / 2;
        a.position({ x: pa.x - ux * half, y: pa.y - uy * half });
        b.position({ x: pb.x + ux * half, y: pb.y + uy * half });
      }
    }
    if (!moved) break;
    passes = pass + 1;
  }
  const residualCollisions = countNodeCollisions(visible) + countCompoundCollisions(visible, groups);
  return { collisionFree: residualCollisions === 0, passes, residualCollisions };
}

export function isGraphDiagnosticsEnabled(env: { emulator?: string; diagnostics?: string }): boolean {
  return env.emulator === 'true' && env.diagnostics === 'true';
}

// GRAPH-067 acceptance diagnostics require TWO explicit build-time guards. An
// ordinary local emulator session does not expose the seam. The runtime guard
// below additionally requires a connected Auth emulator before any snapshot is
// returned.
const GRAPH_DIAGNOSTICS_ENABLED = isGraphDiagnosticsEnabled({
  emulator: process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR,
  diagnostics: process.env.NEXT_PUBLIC_E2E_GRAPH_DIAGNOSTICS,
});

export interface GraphDiagnosticNode {
  i: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mx: number;
  my: number;
  hidden: boolean;
  selected: boolean;
}

export interface GraphDiagnosticGroup {
  i: number;
  memberCount: number;
  memberIndexes: number[];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  hidden: boolean;
}

/**
 * GRAPH-072 — the two caption counts that must agree. `reported` is what the
 * density policy claims is visible; `rendered` is what Cytoscape's own computed
 * style says actually paints. The measured baseline was `{reported: 6,
 * rendered: 0}` — two cull systems disagreeing.
 */
export interface GraphDiagnosticLabels {
  reported: number;
  rendered: number;
  /** Ids are never exposed; this is the count of leaf nodes carrying a caption. */
  captionable: number;
}

export interface GraphCanvasDiagnostics {
  ready: boolean;
  layoutStable: boolean;
  residualCollisions: number | null;
  nodeCount: number;
  visibleNodeCount: number;
  edgeCount: number;
  labels: GraphDiagnosticLabels;
  moveNeighborhood: boolean;
  isolated: boolean;
  pan: { x: number; y: number };
  zoom: number;
  viewportW: number;
  viewportH: number;
  nodes: GraphDiagnosticNode[];
  groups: GraphDiagnosticGroup[];
}

/** Read a content-safe geometry snapshot of the live Cytoscape core. */
export function readGraphDiagnostics(
  cy: Core,
  opts: {
    layoutStable: boolean;
    moveNeighborhood: boolean;
    residualCollisions: number | null;
    reportedLabelCount: number;
  }
): GraphCanvasDiagnostics {
  const captionProbes = readCaptionProbes(cy);
  const leafNodes = cy
    .nodes()
    .filter((node) => !node.data('isRingGroup'))
    .toArray() as unknown as NodeSingular[];
  const groupNodes = cy
    .nodes()
    .filter((node) => node.data('isRingGroup'))
    .toArray() as unknown as NodeSingular[];
  const pan = cy.pan();
  const zoom = cy.zoom();
  const nodes = leafNodes.map((node) => {
    const bb = node.renderedBoundingBox(NODE_BODY_BOUNDS);
    const pos = node.position();
    return {
      i: Number(node.data('diagnosticIndex')),
      x1: bb.x1,
      y1: bb.y1,
      x2: bb.x2,
      y2: bb.y2,
      mx: pos.x,
      my: pos.y,
      hidden: !node.visible(),
      selected: node.selected(),
    };
  });
  const groups = groupNodes.map((node) => {
    const bounds = node.renderedBoundingBox(NODE_BODY_BOUNDS);
    const memberIndexes = node
      .children()
      .map((child) => Number(child.data('diagnosticIndex')))
      .sort((a, b) => a - b);
    return {
      i: Number(node.data('diagnosticIndex')),
      memberCount: memberIndexes.length,
      memberIndexes,
      x1: bounds.x1,
      y1: bounds.y1,
      x2: bounds.x2,
      y2: bounds.y2,
      hidden: !node.visible(),
    };
  });
  const visibleNodeCount = nodes.reduce((count, node) => count + (node.hidden ? 0 : 1), 0);
  const isolated = nodes.some((node) => node.hidden);
  return {
    ready: true,
    layoutStable: opts.layoutStable,
    residualCollisions: opts.residualCollisions,
    nodeCount: nodes.length,
    visibleNodeCount,
    edgeCount: cy.edges().length,
    labels: {
      reported: opts.reportedLabelCount,
      rendered: countRenderedCaptions(captionProbes),
      captionable: captionProbes.filter((probe) => probe.hasLabel).length,
    },
    moveNeighborhood: opts.moveNeighborhood,
    isolated,
    pan: { x: pan.x, y: pan.y },
    zoom,
    viewportW: cy.width(),
    viewportH: cy.height(),
    nodes,
    groups,
  };
}

function runGraphLayout(cy: Core, nodeCount: number, onLayoutStop?: (resolution: NodeOverlapResolution) => void): void {
  const dense = nodeCount > DENSE_LAYOUT_NODES;
  const layoutSeed = graphLayoutSeed(cy.nodes().map((node) => node.id()));
  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const layout = cy.layout({
    name: 'fcose',
    // Final-super-check repair (GRAPH-067/072): fCoSE's default random seed
    // occasionally stretched the same 70/100 graph into a multi-screen line.
    // The terminal body-only fit then hit minZoom (0.05), reducing nodes to
    // 2-4px and leaving no caption that could pass the collision policy. Keep
    // the fast spectral path used by the 300-node workbench, but feed it a
    // stable graph-ID seed around `layout.run()` below.
    quality: 'default',
    randomize: true,
    nodeDimensionsIncludeLabels: false,
    // Dense graphs are expensive to animate and harder to follow while moving.
    animate: !dense && !reduceMotion,
    animationDuration: 500,
    // GRAPH-072 — fcose's own fit measures the label-inclusive bounding box, which
    // screen-space captions inflate as zoom falls. The explicit body-only fit in
    // `layoutstop` below is the single framing authority.
    fit: false,
    padding: 40,
    nodeSeparation: dense ? 150 : 90,
    idealEdgeLength: dense ? 180 : 120,
    nodeRepulsion: dense ? 16000 : 6500,
    gravity: dense ? 0.15 : 0.25,
    // Dense fCoSE cost rises quickly with node count. The API caps the
    // workbench at 300 nodes; fewer iterations keep that upper bound usable.
    numIter: dense ? 1600 : 2500,
  } as unknown as LayoutOptions);
  const layoutStartedAt = Date.now();
  const stallTimer = setTimeout(() => {
    log.warn('graph layout has not completed', {
      elapsedMs: Date.now() - layoutStartedAt,
      nodeCount,
    });
  }, LAYOUT_STALL_WARN_MS);
  // A layout discarded by unmount is not a stall — silence the diagnostic.
  cy.one('destroy', () => clearTimeout(stallTimer));
  layout.one('layoutstop', () => {
    clearTimeout(stallTimer);
    log.debug('graph layout complete', { durationMs: Date.now() - layoutStartedAt, nodeCount });
    // GRAPH-067 — push apart any remaining node-body collisions (degree-scaled
    // hubs can still overlap after fCoSE) BEFORE fitting, so the terminal fit
    // reflects a collision-free layout.
    const resolution = resolveNodeOverlaps(cy);
    if (!resolution.collisionFree) {
      log.warn('graph layout retained node collisions', {
        nodeCount,
        residualCollisions: resolution.residualCollisions,
        passes: resolution.passes,
      });
    }
    fitToNodeBodies(cy, null, 48);
    onLayoutStop?.(resolution);
  });
  runWithDeterministicGraphRandom(layoutSeed, () => layout.run());
}

/**
 * Busy-status pill (GRAPH-055): names the current operation phase and ticks
 * elapsed seconds so a long-running request reads as "waiting on X for Ns"
 * instead of an unexplained spinner. Mount lifetime = one busy period.
 */
function BusyStatus({ phase }: { phase?: string | null }) {
  const [elapsedS, setElapsedS] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      setElapsedS(Math.floor((Date.now() - startedAt) / 1000));
    }, 1_000);
    return () => clearInterval(interval);
  }, []);
  return (
    <div
      className="absolute bottom-4 left-4 flex h-7 items-center gap-1.5 rounded border bg-background/90 px-2 text-xs text-muted-foreground shadow-sm backdrop-blur"
      role="status"
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      Updating graph
      {phase ? ` — ${phase}` : ''}
      {elapsedS >= 1 ? ` (${elapsedS}s)` : ''}
    </div>
  );
}

/**
 * Build Cytoscape elements (nodes + edges) from the API result set. `zoom`
 * seeds the zoom-derived metrics at the CURRENT zoom, so elements added by a
 * reconcile paint correctly on their first frame instead of carrying zoom-1
 * seeds until the next zoom event.
 */
function buildElements(
  apiNodes: ApiNode[],
  apiRels: ApiRelationship[],
  ringGroups: RingGroup[] = [],
  zoom = 1
): ElementDefinition[] {
  const degrees = computeDegrees(apiNodes, apiRels);
  const nodeIds = new Set(apiNodes.map((n) => n.id));

  // GRAPH-067 #16 — presentation-only ring-group compound parents. Members keep
  // their own identity; the parent is a visual cluster, never a real placement node.
  const memberToGroup = new Map<string, string>();
  const groupEls: ElementDefinition[] = ringGroups.map((group, diagnosticIndex) => {
    for (const memberId of group.memberIds) memberToGroup.set(memberId, group.groupId);
    return {
      group: 'nodes',
      data: { id: group.groupId, label: group.label, isRingGroup: true, diagnosticIndex },
    };
  });

  const nodeEls: ElementDefinition[] = apiNodes.map((node, diagnosticIndex) => {
    const primaryLabel = getPrimaryNodeLabel(node.labels);
    const degree = degrees.get(node.id) ?? 0;
    const size = sizeForDegree(degree);
    const nodeColor = entityColorHex(primaryLabel);
    const parent = memberToGroup.get(node.id);
    return {
      group: 'nodes',
      data: {
        id: node.id,
        ...(parent ? { parent } : {}),
        label: fitCaption(getFullCaption(node)),
        color: nodeColor,
        size: computeProportionalNodeSize(size, zoom),
        baseSize: size,
        degree,
        labelFloor: LABEL_RENDERED_FONT_FLOOR,
        // GRAPH-072 — seeded at the caller's zoom so `data(fontSize)` is never
        // undefined on the very first paint. `applyScreenSpaceLabelStyle` owns
        // these from then on and rewrites them synchronously on every zoom,
        // holding the caption's RENDERED size constant. The wrap width is
        // screen-space rather than a multiple of the node, because the caption
        // now sits below the body instead of inside it.
        ...computeScreenSpaceLabelStyle(zoom),
        apiNode: node,
        primaryLabel,
        // Test-only ordinal used by the explicitly enabled, identifier-free
        // geometry diagnostics seam. It is scoped to the current result view.
        diagnosticIndex,
      },
    };
  });

  // Only keep edges whose endpoints are both in the node set — a dangling
  // endpoint would make Cytoscape throw on element add.
  const edgeEls: ElementDefinition[] = apiRels
    .filter((r) => nodeIds.has(r.from) && nodeIds.has(r.to))
    .map((rel) => ({
      group: 'edges',
      data: {
        id: rel.id,
        source: rel.from,
        target: rel.to,
        label: rel.type,
        color: relationColorHex(rel.type),
        ...computeBoundedEdgeLabelStyle(zoom),
        apiRel: rel,
      },
    }));

  return [...groupEls, ...nodeEls, ...edgeEls];
}

/** A stable hash keeps graph placement deterministic for the same IDs. */
function hashElementId(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function graphLayoutSeed(ids: readonly string[]): number {
  let seed = 2166136261;
  for (const id of [...ids].sort()) {
    seed ^= hashElementId(id);
    seed = Math.imul(seed, 16777619);
  }
  return seed >>> 0;
}

export function runWithDeterministicGraphRandom<T>(seed: number, action: () => T): T {
  let state = seed >>> 0;
  const originalRandom = Math.random;
  Math.random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return action();
  } finally {
    Math.random = originalRandom;
  }
}

function averagePosition(positions: Position[]): Position {
  if (positions.length === 0) return { x: 0, y: 0 };
  const total = positions.reduce((sum, position) => ({ x: sum.x + position.x, y: sum.y + position.y }), { x: 0, y: 0 });
  return { x: total.x / positions.length, y: total.y / positions.length };
}

function findOpenPosition(anchor: Position, nodeId: string, occupied: Position[]): Position {
  const hash = hashElementId(nodeId);

  for (let ring = 1; ring <= 32; ring += 1) {
    const radius = EXPANSION_NODE_DISTANCE * ring;
    const slots = 12 * ring;
    const startSlot = hash % slots;

    for (let offset = 0; offset < slots; offset += 1) {
      const angle = ((startSlot + offset) / slots) * Math.PI * 2;
      const candidate = {
        x: anchor.x + Math.cos(angle) * radius,
        y: anchor.y + Math.sin(angle) * radius,
      };
      const hasSpace = occupied.every((position) => {
        const dx = candidate.x - position.x;
        const dy = candidate.y - position.y;
        return dx * dx + dy * dy >= EXPANSION_NODE_MIN_SPACING ** 2;
      });
      if (hasSpace) return candidate;
    }
  }

  // The bounded search is deliberately generous; this is only a finite
  // fallback for pathological coordinates with thousands of coincident nodes.
  return { x: anchor.x + EXPANSION_NODE_DISTANCE * 33, y: anchor.y };
}

/**
 * Position only newly-added nodes. Retained nodes remain untouched, while new
 * neighborhoods grow around already-rendered endpoints. New-only components
 * are seeded near the existing graph and then placed breadth-first so their
 * local topology stays readable without a global layout or viewport reset.
 */
function positionExpansionNodes(
  cy: Core,
  retainedNodeIds: Set<string>,
  newNodeIds: Set<string>,
  apiRelationships: ApiRelationship[]
): Map<string, Position> {
  const knownPositions = new Map<string, Position>();
  for (const id of retainedNodeIds) {
    const position = cy.getElementById(id).position();
    if (Number.isFinite(position.x) && Number.isFinite(position.y)) knownPositions.set(id, position);
  }

  const adjacency = new Map<string, Set<string>>();
  for (const relationship of apiRelationships) {
    if (!adjacency.has(relationship.from)) adjacency.set(relationship.from, new Set());
    if (!adjacency.has(relationship.to)) adjacency.set(relationship.to, new Set());
    adjacency.get(relationship.from)!.add(relationship.to);
    adjacency.get(relationship.to)!.add(relationship.from);
  }

  const occupied = [...knownPositions.values()];
  const pending = new Set([...newNodeIds].sort());
  const placed = new Map<string, Position>();

  while (pending.size > 0) {
    let madeProgress = false;
    for (const nodeId of [...pending]) {
      const connectedPositions = [...(adjacency.get(nodeId) ?? [])]
        .map((neighborId) => knownPositions.get(neighborId))
        .filter((position): position is Position => position !== undefined);
      if (connectedPositions.length === 0) continue;

      const position = findOpenPosition(averagePosition(connectedPositions), nodeId, occupied);
      knownPositions.set(nodeId, position);
      placed.set(nodeId, position);
      occupied.push(position);
      pending.delete(nodeId);
      madeProgress = true;
    }

    if (madeProgress) continue;

    // No pending node touches known topology, so seed the next disconnected
    // component near the graph centroid. Its neighbors can then grow from it.
    const nodeId = pending.values().next().value as string;
    const position = findOpenPosition(averagePosition([...knownPositions.values()]), nodeId, occupied);
    knownPositions.set(nodeId, position);
    placed.set(nodeId, position);
    occupied.push(position);
    pending.delete(nodeId);
  }

  return placed;
}

const IMMUTABLE_ELEMENT_DATA = new Set(['id', 'source', 'target', 'parent']);

/**
 * GRAPH-072 — the zoom-derived caption metrics are owned by the renderer
 * (`applyScreenSpaceLabelStyle`), not by the element definition. A data reconcile
 * must not stomp the live zoom-corrected values back to their zoom-1 seed.
 */
const RENDERER_OWNED_ELEMENT_DATA = new Set([
  'fontSize',
  'textMaxWidth',
  'textMarginY',
  'textBackgroundPadding',
  // GRAPH-067 reopen — `size` and the edge caption metrics are zoom-derived
  // too. Leaving them out let every data reconcile stomp the live values back
  // to their seeds until the next zoom pass — the "random sizes" flicker.
  'size',
  'edgeFontSize',
  'edgeTextBackgroundPadding',
]);

function getElementId(definition: ElementDefinition): string {
  const id = definition.data.id;
  if (!id) throw new Error('Graph element is missing a stable ID');
  return id;
}

interface RelationshipEndpoints {
  source: string;
  target: string;
}

function getRelationshipEndpoints(definition: ElementDefinition): RelationshipEndpoints {
  const { source, target } = definition.data;
  if (!source || !target) throw new Error('Graph relationship is missing an endpoint');
  return { source, target };
}

/** Update presentation/API data without replacing the live Cytoscape element. */
function updateElementData(cy: Core, definition: ElementDefinition): void {
  const element = cy.getElementById(getElementId(definition));
  for (const [key, value] of Object.entries(definition.data)) {
    if (IMMUTABLE_ELEMENT_DATA.has(key) || RENDERER_OWNED_ELEMENT_DATA.has(key)) continue;
    element.data(key, value);
  }
}

/**
 * Declarative stylesheet — the whole visual layer: saturated entity-color node
 * fills with a high-contrast wrapped caption inside, and colored curved edges
 * carrying the relationship-type label + an arrowhead.
 *
 * Dense-graph readability (the key difference from a naive renderer): node
 * captions are budgeted by viewport area and zoom, then spatially thinned.
 * Edge labels are culled below a readable zoom. Hovering a node dims everything
 * outside its neighborhood, and its full caption remains available in the
 * tooltip.
 */
function buildStylesheet(theme: GraphThemeTokens): StylesheetJson {
  // UX-070 reopen — the rest-state edge stroke is COMPUTED against the live
  // surface (recessive but >= 1.5:1 on both themes), and the fade tiers are
  // per-theme: the dark-tuned 0.1 alpha washed the light theme to pastel dust.
  const dark = isDarkSurface(theme);
  const edgeStroke = computeEdgeRestStroke(theme);
  const fadedNodeOpacity = dark ? 0.15 : 0.25;
  const fadedEdgeOpacity = dark ? 0.06 : 0.12;
  return [
    {
      // GRAPH-067 #16 — ring-group compound parents: a subtle labelled cluster box
      // that auto-sizes to its member placements (never a placement node itself).
      selector: 'node[?isRingGroup]',
      style: {
        shape: 'round-rectangle',
        'background-opacity': 0.06,
        'background-color': theme.mutedInk,
        'border-width': 1,
        'border-style': 'dashed',
        'border-color': theme.mutedInk,
        label: 'data(label)',
        color: theme.mutedInk,
        'font-size': 11,
        'font-weight': 600,
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -4,
        padding: '16px',
        // GRAPH-072 — size the cluster box to its members' BODIES, not their
        // labels. Cytoscape auto-sizes a compound parent to contain its children
        // AND their label boxes; screen-space captions have a model footprint of
        // `constant / zoom`, so at a dense graph's low fit zoom that footprint is
        // enormous and it inflates the ring-group box with it. Measured on the
        // GRAPH-067 275-node fixture: parent boxes swelled far enough to overlap
        // 30-42 external nodes, which the leaf push-apart pass cannot resolve
        // (it does not reposition compound parents), so `collisionFree` never
        // became true and the canvas never reported a stable layout.
        'compound-sizing-wrt-labels': 'exclude',
        events: 'no',
      },
    },
    {
      // Leaf-only data mappings: virtual ring-group parents intentionally do not
      // carry these presentation fields and must retain compound auto-sizing.
      selector: 'node:childless',
      style: {
        'background-color': 'data(color)',
        width: 'data(size)',
        height: 'data(size)',
        label: 'data(label)',
        // GRAPH-072 — model-space font sized as `SCREEN_LABEL_METRICS.fontPx / zoom`,
        // so the RENDERED caption is a constant 12px at every zoom level. This is
        // what breaks the cull feedback loop: label boxes no longer grow relative
        // to node spacing as the operator zooms in.
        'font-size': 'data(fontSize)' as unknown as number,
        // Light weight reads cleaner than a heavy 600 — the outline halo below is
        // what carries legibility, not the stroke weight.
        'font-weight': 400 as unknown as number,
        // A floor, not a competing policy. The rendered font is constant and sits
        // above this value, so it can never cull; the collision budget in
        // `graph-label-density.ts` is the single culling authority.
        'min-zoomed-font-size': 'data(labelFloor)' as unknown as number,
        // UX-070 — the caption sits BELOW the node instead of on top of it, so it
        // stops occluding the colour mark it exists to identify.
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 'data(textMarginY)' as unknown as number,
        // Keep names a subordinate single-line caption. Full names remain in
        // the details/tooltip; the canvas gets a bounded ellipsis rather than
        // arbitrary mid-word breaks or multi-line plates competing with links.
        'text-wrap': 'ellipsis',
        'text-overflow-wrap': 'whitespace',
        'text-max-width': 'data(textMaxWidth)',
        // UX-070 — a plate on the surface colour, not a `text-outline` smear. Text
        // uses ink tokens so the node fill remains the only saturated layer.
        color: theme.ink,
        'text-background-color': theme.surface,
        // 0.6, not the previous 0.82 — plates must never read as opaque chips
        // stacked over the graph; the collision budget keeps them apart and the
        // softer plate lets edges pass under text without fighting it.
        'text-background-opacity': 0.6,
        'text-background-shape': 'roundrectangle',
        'text-background-padding': 'data(textBackgroundPadding)' as unknown as string,
        'text-border-opacity': 0,
        'text-outline-width': 0,
        // UX-070 — a ring in the SURFACE colour, so two touching nodes separate
        // instead of dirtying. The previous `rgba(15,23,42,0.35)` was a fixed dark
        // value that read as grime around every node on a dark canvas; the COLOUR
        // is what fixes that, not the width.
        //
        // Deliberately 1px, not the 2px the row suggested. Border width is a MODEL
        // dimension: it enters `outerWidth`, the overlap-resolution radius, and
        // every node's bounding box — and therefore the auto-sized compound
        // ring-group boxes too. At 2px the GRAPH-067 dense fixture gained 42
        // parent-vs-node overlaps that the leaf push-apart pass cannot resolve (it
        // does not reposition compound parents), leaving `layoutStable` false
        // forever. 1px keeps that row's calibrated geometry intact while still
        // separating touching fills.
        'border-width': 1,
        'border-color': theme.surface,
        'border-opacity': 1,
        'transition-property': 'opacity, border-width, border-color',
        'transition-duration': 120 as unknown as number,
      },
    },
    {
      selector: 'node:selected',
      style: {
        'border-width': 2,
        'border-color': '#0ea5e9',
        'underlay-color': '#0ea5e9',
        'underlay-opacity': 0.14,
        'underlay-padding': 4,
        'underlay-shape': 'ellipse',
        'min-zoomed-font-size': 0,
      },
    },
    {
      // UX-070 reopen — positive hover emphasis in the node's OWN hue. The
      // previous hover only faded everything else: at overview zoom the user
      // could not tell which dot they were on, and the highlight read as
      // "everything broke". Entity color is preserved, never replaced.
      selector: 'node.label-hovered',
      style: {
        'border-width': 2,
        'border-color': 'data(color)',
        'underlay-color': 'data(color)',
        'underlay-opacity': 0.16,
        'underlay-padding': 4,
        'underlay-shape': 'ellipse',
      },
    },
    {
      selector: 'node.label-deferred',
      style: {
        'text-opacity': 0,
      },
    },
    {
      selector: 'edge',
      style: {
        // UX-070 reopen — the rest state is NEUTRAL: a stroke computed from the
        // muted ink against the live surface (>= 1.5:1 on both themes, solid hex
        // so the measured number is the guaranteed number). The previous
        // full-saturation predicate hues at `line-opacity: 0.4` composited to
        // ~1.2:1 on light — near-invisible — and spent the color channel on
        // ambient noise. Predicate hue now belongs to interaction (`.edge-focus`
        // and selection), where it reads against this quiet ground.
        width: 1.5,
        'line-color': edgeStroke,
        'line-opacity': 1,
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'target-arrow-color': edgeStroke,
        'arrow-scale': 0.7,
        // NO rest-state label. Relationship text is interaction-revealed
        // (hover/selection); an ambient HAS_CONCEPT on every edge at working
        // zooms is pure clutter regardless of threshold tuning. The font/plate
        // metrics stay mapped so the focus tiers below inherit bounded sizes.
        'font-size': 'data(edgeFontSize)' as unknown as number,
        color: theme.mutedInk,
        'text-rotation': 'autorotate' as unknown as number,
        'text-background-color': theme.surface,
        'text-background-opacity': 0.85,
        'text-background-padding': 'data(edgeTextBackgroundPadding)' as unknown as string,
        'text-background-shape': 'roundrectangle',
        'text-border-opacity': 0,
        'transition-property': 'line-color, opacity, width',
        'transition-duration': 150 as unknown as number,
      },
    },
    {
      // Interaction-revealed relationship semantics: hovering an edge, or a
      // node (its whole neighborhood), colors the edge in its predicate hue and
      // shows its type label — against the neutral ground this is where the
      // GRAPH-073 color investment actually reads.
      selector: 'edge.edge-focus',
      style: {
        width: 2,
        'line-color': 'data(color)',
        'target-arrow-color': 'data(color)',
        'arrow-scale': 0.9,
        label: 'data(label)',
        'min-zoomed-font-size': 0,
        'z-index': 998,
      },
    },
    {
      selector: 'edge:selected',
      style: {
        width: 2,
        'line-color': '#0ea5e9',
        'target-arrow-color': '#0ea5e9',
        'arrow-scale': 1,
        label: 'data(label)',
        'z-index': 999,
        'min-zoomed-font-size': 0,
      },
    },
    {
      // Applied to everything outside the hovered node's neighborhood so the
      // node's own connections stand out from a dense background. Per-theme:
      // one dark-tuned constant washed the light theme out entirely.
      selector: 'node.faded',
      style: {
        opacity: fadedNodeOpacity,
        'text-opacity': 0,
      },
    },
    {
      selector: 'edge.faded',
      style: {
        opacity: fadedEdgeOpacity,
        'text-opacity': 0,
      },
    },
    {
      // GRAPH-067 #14 — a HARD isolate: `display: none` removes the element from
      // the fcose layout AND from `cy.fit()`, so hidden elements consume no layout
      // space (opacity dimming alone leaves them occupying the canvas).
      selector: '.isolated-hidden',
      style: {
        display: 'none',
      },
    },
    {
      // Selection and hover are explicit user intent, so their captions remain
      // visible even when density or contextual-focus classes would hide them.
      selector: 'node:selected, node.label-hovered',
      style: {
        opacity: 1,
        'text-opacity': 1,
        'min-zoomed-font-size': 0,
        'z-index': 1000,
      },
    },
  ];
}

// ============================================================================
// COMPONENT
// ============================================================================

export function GraphVisualization({
  nodes: apiNodes,
  relationships: apiRelationships,
  ringGroups = EMPTY_RING_GROUPS,
  onNodeClick,
  onRelationshipClick,
  onBackgroundClick,
  selectedNodeId,
  selectedRelationshipId,
  activeLabel,
  activeRelationshipType,
  isolatedNodeId,
  onLabelFocusChange,
  isLoading = false,
  loadingPhase = null,
  loadingOpId = null,
  className,
}: GraphVisualizationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const renderedNodeIdsRef = useRef(new Set<string>());
  const renderedRelationshipIdsRef = useRef(new Set<string>());
  const renderedRelationshipEndpointsRef = useRef(new Map<string, RelationshipEndpoints>());
  const syncedDataRef = useRef<{ nodes: ApiNode[]; relationships: ApiRelationship[] } | null>(null);
  const graphDataRef = useRef({ nodes: apiNodes, relationships: apiRelationships });
  const refreshLabelDensityRef = useRef<(() => void) | null>(null);
  // GRAPH-072 — the count the density policy last REPORTED as visible. The
  // diagnostics seam pairs it with the count actually painted; the measured
  // baseline reported six while painting zero.
  const reportedLabelCountRef = useRef(0);
  // GRAPH-067 #13 — the exact positions/pan/zoom captured before the first
  // isolate, so clearing focus restores the mental map without a global relayout.
  const baseViewportRef = useRef<ViewportSnapshot | null>(null);
  // GRAPH-067 — terminal-state signal for the content-safe browser diagnostics
  // seam: false while a layout pass is running, true once layoutstop + overlap
  // resolution + fit have settled. Lets acceptance poll for a stable canvas
  // instead of guessing with fixed waits.
  const layoutStableRef = useRef(false);
  // A stable layout is truthful only when the bounded overlap pass actually
  // terminated collision-free. Preserve the residual count for acceptance and
  // operator diagnostics instead of turning an exhausted pass into success.
  const residualCollisionsRef = useRef<number | null>(null);
  // GRAPH-067 #16 — latest ring groups read by the imperative element builders
  // without forcing an effect re-run; the group set changes with the view mode.
  const ringGroupsRef = useRef<RingGroup[]>(ringGroups);
  useEffect(() => {
    ringGroupsRef.current = ringGroups;
  }, [ringGroups]);
  // GRAPH-067 #15 — when on, dragging (or arrow-keying) a node moves its visible
  // one-hop neighborhood together; off keeps ordinary single-node dragging.
  const moveNeighborhoodRef = useRef(false);
  const [moveNeighborhood, setMoveNeighborhood] = useState(false);
  // Sync the ref in a layout effect (not a passive one) so the imperative grab
  // handler reads the committed value before the browser paints — otherwise a
  // drag started the instant `aria-pressed` flips to false can still see the
  // stale ref and translate the neighborhood (GRAPH-067 #15 toggle-off race).
  useLayoutEffect(() => {
    moveNeighborhoodRef.current = moveNeighborhood;
  }, [moveNeighborhood]);
  const [mounted, setMounted] = useState(false);
  const hasGraphData = apiNodes.length > 0;

  // Hover tooltip state
  const [hoveredNode, setHoveredNode] = useState<{ node: ApiNode; x: number; y: number } | null>(null);
  const [tooltipSize, setTooltipSize] = useState({ width: 260, height: 72 });

  // Latest callbacks without forcing a graph rebuild when they change identity.
  const handlersRef = useRef({ onNodeClick, onRelationshipClick, onBackgroundClick });
  useEffect(() => {
    handlersRef.current = { onNodeClick, onRelationshipClick, onBackgroundClick };
  }, [onNodeClick, onRelationshipClick, onBackgroundClick]);

  // Legend: unique primary labels actually present, ordered by frequency.
  const activeLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of apiNodes) {
      const label = getPrimaryNodeLabel(node.labels);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].sort(([labelA, countA], [labelB, countB]) => countB - countA || labelA.localeCompare(labelB));
  }, [apiNodes]);

  const graphFocus = useMemo(() => {
    // GRAPH-067 isolate — an explicit per-node one-hop isolate takes precedence
    // over the legend label / relationship-type focus.
    const focus = isolatedNodeId
      ? resolveNodeIsolation(apiNodes, apiRelationships, isolatedNodeId)
      : resolveGraphFocus(apiNodes, apiRelationships, activeLabel, activeRelationshipType);
    return focus ? includeRingGroupParents(focus, ringGroups) : null;
  }, [apiNodes, apiRelationships, activeLabel, activeRelationshipType, isolatedNodeId, ringGroups]);

  // Initialization depends only on the empty/non-empty transition. Keep the
  // latest payload in a ref so ordinary data updates cannot recreate the core.
  useEffect(() => {
    graphDataRef.current = { nodes: apiNodes, relationships: apiRelationships };
  }, [apiNodes, apiRelationships]);

  // SSR safety — only build Cytoscape after mount.
  useEffect(() => {
    setMounted(true);
  }, []);

  useLayoutEffect(() => {
    if (!hoveredNode || !tooltipRef.current) return;
    const { width, height } = tooltipRef.current.getBoundingClientRect();
    if (width > 0 && height > 0) setTooltipSize({ width, height });
  }, [hoveredNode]);

  // Build one Cytoscape instance for the lifetime of a non-empty canvas.
  useEffect(() => {
    const container = containerRef.current;
    if (!mounted || !hasGraphData || !container || cyRef.current) return;
    ensureFcose();

    const { nodes, relationships } = graphDataRef.current;
    const elements = buildElements(nodes, relationships, ringGroupsRef.current);

    const cy = cytoscape({
      container,
      elements,
      style: buildStylesheet(readGraphThemeTokens(container)),
      minZoom: 0.05,
      // Beyond 2x the model-space bodies and selection treatment overwhelm the
      // viewport while no additional semantic detail becomes available.
      maxZoom: 2,
      // Avoid repainting hundreds of edges for every pan frame. Cytoscape
      // restores them as soon as the viewport settles.
      hideEdgesOnViewport: relationships.length > 250,
      // Nodes draggable, canvas pannable, box-selection off (single select).
      boxSelectionEnabled: false,
      autounselectify: false,
    });
    cyRef.current = cy;
    let labelDensityFrame: number | null = null;
    const refreshLabelDensity = (): void => {
      if (labelDensityFrame !== null) cancelAnimationFrame(labelDensityFrame);
      labelDensityFrame = requestAnimationFrame(() => {
        if (!cy.destroyed()) {
          // GRAPH-072 — resize captions to screen space BEFORE measuring
          // collisions. The density policy has to read the label boxes that will
          // actually be painted at this zoom, not the ones left from the last.
          applyScreenSpaceLabelStyle(cy);
          reportedLabelCountRef.current = applyLabelDensity(cy);
        }
        labelDensityFrame = null;
      });
    };
    refreshLabelDensityRef.current = refreshLabelDensity;
    renderedNodeIdsRef.current = new Set(elements.filter((element) => element.group === 'nodes').map(getElementId));
    renderedRelationshipIdsRef.current = new Set(
      elements.filter((element) => element.group === 'edges').map(getElementId)
    );
    renderedRelationshipEndpointsRef.current = new Map(
      elements
        .filter((element) => element.group === 'edges')
        .map((element): [string, RelationshipEndpoints] => [getElementId(element), getRelationshipEndpoints(element)])
    );
    syncedDataRef.current = { nodes, relationships };

    // Interactions ----------------------------------------------------------
    cy.on('tap', 'node', (evt: EventObject) => {
      setHoveredNode(null);
      const apiNode = evt.target.data('apiNode') as ApiNode | undefined;
      if (apiNode) handlersRef.current.onNodeClick?.(apiNode);
    });
    cy.on('tap', 'edge', (evt: EventObject) => {
      const apiRel = evt.target.data('apiRel') as ApiRelationship | undefined;
      if (apiRel) handlersRef.current.onRelationshipClick?.(apiRel);
    });
    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) {
        setHoveredNode(null);
        handlersRef.current.onBackgroundClick?.();
      }
    });

    let hoveredLabelActive = false;
    // Hover: show the tooltip AND fade everything outside the node's
    // neighborhood so its connections are traceable in a dense graph. The
    // neighborhood's edges take their predicate hue + type label (`edge-focus`)
    // — relationship semantics are interaction-revealed, never ambient.
    cy.on('mouseover', 'node', (evt: EventObject) => {
      const node = evt.target;
      hoveredLabelActive = true;
      node.addClass('label-hovered');
      const apiNode = node.data('apiNode') as ApiNode | undefined;
      const rp = evt.renderedPosition ?? node.renderedPosition();
      if (apiNode && rp) setHoveredNode({ node: apiNode, x: rp.x, y: rp.y });
      const neighborhood = node.closedNeighborhood();
      cy.elements().not(neighborhood).addClass('faded');
      neighborhood.edges().addClass('edge-focus');
      refreshLabelDensity();
    });
    // Hovering an edge directly reveals that one edge's type and hue.
    cy.on('mouseover', 'edge', (evt: EventObject) => {
      evt.target.addClass('edge-focus');
    });
    cy.on('mouseout', 'edge', (evt: EventObject) => {
      // Neighborhood-driven focus is cleared by clearHover, not by edge exit.
      if (!hoveredLabelActive) evt.target.removeClass('edge-focus');
    });
    const clearHover = (): void => {
      setHoveredNode(null);
      cy.nodes().removeClass('label-hovered');
      cy.elements().removeClass('faded');
      cy.edges().removeClass('edge-focus');
      if (hoveredLabelActive) {
        hoveredLabelActive = false;
        refreshLabelDensity();
      }
    };
    // Cytoscape only emits node mouseout while its renderer receives pointer
    // movement. Leaving the canvas after a hover or drag can otherwise leave
    // the tooltip and neighborhood dimming latched until the next interaction.
    container.addEventListener('pointerleave', clearHover);
    cy.on('mouseout', 'node', clearHover);
    cy.on('pan', () => {
      clearHover();
      refreshLabelDensity();
    });
    cy.on('zoom', () => {
      clearHover();
      // GRAPH-072 repair — metrics are rewritten SYNCHRONOUSLY in the zoom
      // event. The previous rAF deferral let frames paint with the PREVIOUS
      // zoom's caption metrics, clipping centered captions mid-word on both
      // sides. The density CLASS pass may still land on the next frame; class
      // toggles a frame late are invisible, stale metrics are not.
      applyScreenSpaceLabelStyle(cy);
      refreshLabelDensity();
    });
    cy.on('dragfree', 'node', refreshLabelDensity);

    // GRAPH-067 #15 — move-neighborhood drag. On grab, snapshot the grabbed node
    // and its VISIBLE one-hop neighbors' positions; on drag, translate the
    // neighbors by the grabbed node's delta (edges stay attached automatically).
    // A local relaxation only — never a global fit. Gated by the toggle so plain
    // dragging stays predictable.
    let neighborhoodDrag: {
      nodeId: string;
      startPositions: Map<string, { x: number; y: number }>;
      grabStart: { x: number; y: number };
    } | null = null;
    cy.on('grab', 'node', (event) => {
      // Always clear a prior snapshot first. If the toggle is off (or the grab
      // is on a different node), a stale snapshot from a previous ON-drag must
      // NOT be carried into the drag handler — otherwise an off-drag would keep
      // translating the old neighborhood (GRAPH-067 #15).
      neighborhoodDrag = null;
      if (!moveNeighborhoodRef.current) return;
      const node = event.target;
      const neighborhood = node.closedNeighborhood().nodes().not('.isolated-hidden');
      const startPositions = new Map<string, { x: number; y: number }>();
      neighborhood.forEach((member: NodeSingular) => {
        startPositions.set(member.id(), { ...member.position() });
      });
      neighborhoodDrag = { nodeId: node.id(), startPositions, grabStart: { ...node.position() } };
    });
    cy.on('drag', 'node', (event) => {
      if (!moveNeighborhoodRef.current || !neighborhoodDrag || event.target.id() !== neighborhoodDrag.nodeId) return;
      const position = event.target.position();
      const delta = { x: position.x - neighborhoodDrag.grabStart.x, y: position.y - neighborhoodDrag.grabStart.y };
      const memberIds = new Set(
        [...neighborhoodDrag.startPositions.keys()].filter((id) => id !== neighborhoodDrag!.nodeId)
      );
      const moved = translateNeighborhood(neighborhoodDrag.startPositions, memberIds, delta);
      cy.batch(() => {
        for (const [id, point] of moved) {
          if (id === neighborhoodDrag!.nodeId) continue; // grabbed node moves natively
          cy.getElementById(id).position(point);
        }
      });
    });
    cy.on('dragfree', 'node', () => {
      neighborhoodDrag = null;
    });

    applyScreenSpaceLabelStyle(cy);
    reportedLabelCountRef.current = applyLabelDensity(cy);
    layoutStableRef.current = false;
    residualCollisionsRef.current = null;
    runGraphLayout(cy, nodes.length, (resolution) => {
      residualCollisionsRef.current = resolution.residualCollisions;
      layoutStableRef.current = resolution.collisionFree;
      refreshLabelDensity();
    });

    return () => {
      container.removeEventListener('pointerleave', clearHover);
      if (labelDensityFrame !== null) cancelAnimationFrame(labelDensityFrame);
      cy.destroy();
      if (cyRef.current === cy) cyRef.current = null;
      if (refreshLabelDensityRef.current === refreshLabelDensity) {
        refreshLabelDensityRef.current = null;
      }
      renderedNodeIdsRef.current = new Set();
      renderedRelationshipIdsRef.current = new Set();
      renderedRelationshipEndpointsRef.current = new Map();
      syncedDataRef.current = null;
    };
  }, [mounted, hasGraphData]);

  // Reconcile API results into the live core by stable element ID. Existing
  // elements are updated in place, preserving their positions, selection, and
  // the user's viewport. Only new nodes receive positions; no layout or fit is
  // triggered by query expansion.
  useEffect(() => {
    const cy = cyRef.current;
    if (
      !cy ||
      !hasGraphData ||
      (syncedDataRef.current?.nodes === apiNodes && syncedDataRef.current?.relationships === apiRelationships)
    ) {
      return;
    }

    const elements = buildElements(apiNodes, apiRelationships, ringGroupsRef.current, cy.zoom());
    const nodeDefinitions = elements.filter((element) => element.group === 'nodes');
    const relationshipDefinitions = elements.filter((element) => element.group === 'edges');
    const nextNodeIds = new Set(nodeDefinitions.map(getElementId));
    const nextRelationshipIds = new Set(relationshipDefinitions.map(getElementId));
    const nextRelationshipEndpoints = new Map(
      relationshipDefinitions.map((definition): [string, RelationshipEndpoints] => [
        getElementId(definition),
        getRelationshipEndpoints(definition),
      ])
    );
    const retainedNodeIds = new Set([...renderedNodeIdsRef.current].filter((id) => nextNodeIds.has(id)));
    // GRAPH-067 #16 — a retained node whose ring-group parent changed (Raw<->Domain
    // switch) can't be re-parented via `.data()` (parent is immutable there) or
    // `.move()` mid-batch. Treat such nodes as fresh re-adds: remove the old
    // instance and add it again so Cytoscape attaches it to its compound parent.
    const desiredParentById = new Map<string, string | null>();
    for (const definition of nodeDefinitions) {
      const id = getElementId(definition);
      const parent = (definition.data.parent as string | undefined) ?? null;
      desiredParentById.set(id, parent);
    }
    const reparentNodeIds = new Set<string>();
    for (const id of retainedNodeIds) {
      const desiredParent = desiredParentById.get(id) ?? null;
      const currentParent = (cy.getElementById(id).data('parent') as string | undefined) ?? null;
      if (desiredParent !== currentParent) reparentNodeIds.add(id);
    }
    for (const id of reparentNodeIds) retainedNodeIds.delete(id);
    // Removing a reparented node also drops its edges (Cytoscape side effect),
    // so re-add every retained edge that touches a reparented node.
    const reparentRelationshipIds = new Set<string>();
    for (const [id, endpoints] of nextRelationshipEndpoints) {
      if (reparentNodeIds.has(endpoints.source) || reparentNodeIds.has(endpoints.target)) {
        reparentRelationshipIds.add(id);
      }
    }
    const newNodeIds = new Set(
      [...nextNodeIds].filter((id) => !renderedNodeIdsRef.current.has(id) || reparentNodeIds.has(id))
    );
    const newRelationshipIds = new Set(
      [...nextRelationshipIds].filter((id) => !renderedRelationshipIdsRef.current.has(id))
    );
    const removedNodeIds = new Set(
      [...renderedNodeIdsRef.current].filter((id) => !nextNodeIds.has(id) || reparentNodeIds.has(id))
    );
    const removedRelationshipIds = new Set(
      [...renderedRelationshipIdsRef.current].filter((id) => !nextRelationshipIds.has(id))
    );
    const rewiredRelationshipIds = new Set(
      [...nextRelationshipIds].filter((id) => {
        const previous = renderedRelationshipEndpointsRef.current.get(id);
        const next = nextRelationshipEndpoints.get(id);
        return Boolean(previous && next && (previous.source !== next.source || previous.target !== next.target));
      })
    );
    const shouldRelayout =
      removedNodeIds.size > 0 || removedRelationshipIds.size > 0 || rewiredRelationshipIds.size > 0;
    const relationshipsToRemove = new Set([...removedRelationshipIds, ...rewiredRelationshipIds]);
    const newNodePositions = positionExpansionNodes(cy, retainedNodeIds, newNodeIds, apiRelationships);
    const relationshipsToReselect = new Set<string>();

    cy.batch(() => {
      for (const id of relationshipsToRemove) {
        const relationship = cy.getElementById(id);
        if (rewiredRelationshipIds.has(id) && (relationship.selected() || selectedRelationshipId === id)) {
          relationshipsToReselect.add(id);
        }
        relationship.remove();
      }
      for (const id of removedNodeIds) cy.getElementById(id).remove();

      for (const definition of nodeDefinitions) {
        if (retainedNodeIds.has(getElementId(definition))) updateElementData(cy, definition);
      }
      for (const definition of relationshipDefinitions) {
        const id = getElementId(definition);
        if (renderedRelationshipIdsRef.current.has(id) && !rewiredRelationshipIds.has(id)) {
          updateElementData(cy, definition);
        }
      }

      const additions = [
        ...nodeDefinitions
          .filter((definition) => newNodeIds.has(getElementId(definition)))
          .map((definition) => {
            const position = newNodePositions.get(getElementId(definition));
            return position ? { ...definition, position } : definition;
          }),
        ...relationshipDefinitions.filter(
          (definition) =>
            newRelationshipIds.has(getElementId(definition)) ||
            rewiredRelationshipIds.has(getElementId(definition)) ||
            reparentRelationshipIds.has(getElementId(definition))
        ),
      ];
      if (additions.length > 0) cy.add(additions);
      for (const id of relationshipsToReselect) cy.getElementById(id).select();
    });

    renderedNodeIdsRef.current = nextNodeIds;
    renderedRelationshipIdsRef.current = nextRelationshipIds;
    renderedRelationshipEndpointsRef.current = nextRelationshipEndpoints;
    syncedDataRef.current = { nodes: apiNodes, relationships: apiRelationships };
    // A reconcile can change a retained node's degree (and therefore its
    // baseSize) while `size` itself is renderer-owned; force one synchronous
    // metric pass so no element carries a stale zoom-derived value.
    applyScreenSpaceLabelStyle(cy, { force: true });
    refreshLabelDensityRef.current?.();
    if (shouldRelayout) {
      // GRAPH-067 #13 — a replacement/relayout invalidates the pre-isolate
      // snapshot; drop it so a later focus-clear can't restore a stale viewport.
      baseViewportRef.current = null;
      layoutStableRef.current = false;
      residualCollisionsRef.current = null;
      runGraphLayout(cy, apiNodes.length, (resolution) => {
        residualCollisionsRef.current = resolution.residualCollisions;
        layoutStableRef.current = resolution.collisionFree;
        refreshLabelDensityRef.current?.();
      });
    }
    setHoveredNode((current) => {
      if (!current) return current;
      const node = apiNodes.find((candidate) => candidate.id === current.node.id);
      if (!node) return null;
      return node === current.node ? current : { ...current, node };
    });
  }, [apiNodes, apiRelationships, hasGraphData, selectedRelationshipId]);

  // UX-070 — the canvas colours come from the app's theme tokens, and Cytoscape's
  // stylesheet is JavaScript, so it cannot re-resolve them the way CSS would.
  // Watch the class/attribute the theme provider flips on <html> and rebuild the
  // stylesheet, otherwise switching theme would leave the canvas painted for the
  // previous one. Element data, classes, positions and viewport all survive a
  // `cy.style()` replacement; only the label pass has to be re-run.
  useEffect(() => {
    if (!mounted || typeof MutationObserver === 'undefined') return;
    const root = document.documentElement;

    const reapply = (): void => {
      const cy = cyRef.current;
      if (!cy || cy.destroyed()) return;
      cy.style(buildStylesheet(readGraphThemeTokens(containerRef.current)));
      refreshLabelDensityRef.current?.();
    };

    const observer = new MutationObserver(reapply);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    return () => observer.disconnect();
  }, [mounted, hasGraphData]);

  // Cytoscape does not automatically notice flex/sidebar resizes. Observe the
  // actual mount element so canvas bounds stay aligned after sidebar changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!mounted || !container || typeof ResizeObserver === 'undefined') return;

    let animationFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const cy = cyRef.current;
        if (cy) {
          cy.resize();
          // GRAPH-067 #13 — a resize may re-scale the canvas, but it must NOT
          // overwrite a saved viewport. When an isolate snapshot is held, only
          // resize; otherwise refit so sidebar/mobile layout changes cannot clip
          // previously visible nodes.
          if (!baseViewportRef.current) fitToNodeBodies(cy, null, 48);
          refreshLabelDensityRef.current?.();
        }
        animationFrame = null;
      });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    };
  }, [mounted, hasGraphData]);

  // GRAPH-067 #13/#14 — focus/isolate is a HARD hide (removed from layout + fit),
  // not opacity dimming. Capture the exact viewport before the first isolate;
  // restore it exactly when focus clears; and restore the base snapshot BEFORE
  // each new focus so drift can never accumulate across focus changes.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const restoreBaseViewport = (snapshot: ViewportSnapshot) => {
      cy.batch(() => {
        cy.nodes().forEach((node) => {
          const position = snapshot.positions.get(node.id());
          if (position) node.position({ x: position.x, y: position.y });
        });
      });
      cy.zoom(snapshot.zoom);
      cy.pan({ x: snapshot.pan.x, y: snapshot.pan.y });
    };

    if (!graphFocus) {
      // Clearing focus → unhide everything and restore the EXACT pre-isolate
      // elements, positions, pan, and zoom (no relayout, no drift).
      cy.batch(() => cy.elements().removeClass('isolated-hidden'));
      if (baseViewportRef.current) {
        restoreBaseViewport(baseViewportRef.current);
        baseViewportRef.current = null;
      }
      refreshLabelDensityRef.current?.();
      return;
    }

    // Entering or changing focus.
    if (!baseViewportRef.current) {
      baseViewportRef.current = captureViewport(
        { pan: cy.pan(), zoom: cy.zoom() },
        cy.nodes().map((node) => ({ id: node.id(), position: node.position() }))
      );
    } else {
      // Focus changed while another was active — return to base first.
      cy.batch(() => cy.elements().removeClass('isolated-hidden'));
      restoreBaseViewport(baseViewportRef.current);
    }

    cy.batch(() => {
      cy.elements().addClass('isolated-hidden');
      for (const id of graphFocus.nodeIds) cy.getElementById(id).removeClass('isolated-hidden');
      for (const id of graphFocus.relationshipIds) cy.getElementById(id).removeClass('isolated-hidden');
    });
    // Fit ONLY the visible neighborhood — hidden (display:none) elements are
    // already excluded from the bounding box, so they consume no layout/fit space.
    fitToNodeBodies(cy, cy.elements().not('.isolated-hidden'), 60);
    refreshLabelDensityRef.current?.();
  }, [graphFocus, mounted]);

  // GRAPH-067 — expose the identifier-free geometry diagnostics reader on
  // `window` so the
  // real-browser acceptance can read Cytoscape canvas geometry (a <canvas>
  // renderer otherwise hides node positions, bounding boxes, and visibility).
  // Inert unless BOTH the disposable-emulator and dedicated diagnostics build
  // flags are enabled, and Auth is connected to an emulator at runtime.
  useEffect(() => {
    if (!GRAPH_DIAGNOSTICS_ENABLED || typeof window === 'undefined') return;
    const read = (): GraphCanvasDiagnostics | null => {
      const cy = cyRef.current;
      const runtime = (window as unknown as { __e2eFirebaseRuntime?: { authEmulatorOrigin?: string | null } })
        .__e2eFirebaseRuntime;
      if (!cy || cy.destroyed() || !runtime?.authEmulatorOrigin) return null;
      return readGraphDiagnostics(cy, {
        layoutStable: layoutStableRef.current,
        moveNeighborhood: moveNeighborhoodRef.current,
        residualCollisions: residualCollisionsRef.current,
        reportedLabelCount: reportedLabelCountRef.current,
      });
    };
    (window as unknown as { __radaristGraphDiagnostics?: typeof read }).__radaristGraphDiagnostics = read;
    return () => {
      const slot = window as unknown as { __radaristGraphDiagnostics?: unknown };
      if (slot.__radaristGraphDiagnostics === read) delete slot.__radaristGraphDiagnostics;
    };
  }, [mounted]);

  // Reflect external selection onto the existing instance without a rebuild.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements(':selected').unselect();
      if (selectedNodeId) cy.getElementById(selectedNodeId).select();
      if (selectedRelationshipId) cy.getElementById(selectedRelationshipId).select();
    });
    refreshLabelDensityRef.current?.();
  }, [selectedNodeId, selectedRelationshipId, mounted, hasGraphData, ringGroups]);

  // Zoom controls ------------------------------------------------------------
  const handleZoomIn = useCallback(() => {
    const cy = cyRef.current;
    if (cy) cy.zoom({ level: cy.zoom() * 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }, []);

  const handleZoomOut = useCallback(() => {
    const cy = cyRef.current;
    if (cy) cy.zoom({ level: cy.zoom() / 1.2, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }, []);

  const handleFit = useCallback(() => {
    const cy = cyRef.current;
    if (cy) fitToNodeBodies(cy, null, 48);
  }, []);

  // GRAPH-067 #15 — keyboard/touch-accessible neighborhood move. Arrow keys move
  // the selected node + its visible one-hop neighbors together (edges stay
  // attached); only active while the move-neighborhood toggle is on, so ordinary
  // keyboard navigation is unaffected. A local translation — never a global fit.
  const handleGraphKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!moveNeighborhoodRef.current) return;
    const deltas: Record<string, { x: number; y: number }> = {
      ArrowUp: { x: 0, y: -24 },
      ArrowDown: { x: 0, y: 24 },
      ArrowLeft: { x: -24, y: 0 },
      ArrowRight: { x: 24, y: 0 },
    };
    const delta = deltas[event.key];
    if (!delta) return;
    const cy = cyRef.current;
    if (!cy) return;
    const selected = cy.nodes(':selected:visible');
    if (selected.length === 0) return;
    event.preventDefault();
    const neighborhood = selected.closedNeighborhood().nodes(':visible');
    const positions = new Map<string, { x: number; y: number }>();
    neighborhood.forEach((node: NodeSingular) => {
      positions.set(node.id(), { ...node.position() });
    });
    const memberIds = new Set(positions.keys());
    const moved = translateNeighborhood(positions, memberIds, delta);
    cy.batch(() => {
      for (const [id, point] of moved) cy.getElementById(id).position(point);
    });
  }, []);

  const handleRelayout = useCallback(() => {
    const cy = cyRef.current;
    if (cy) {
      layoutStableRef.current = false;
      residualCollisionsRef.current = null;
      runGraphLayout(cy, apiNodes.length, (resolution) => {
        residualCollisionsRef.current = resolution.residualCollisions;
        layoutStableRef.current = resolution.collisionFree;
        refreshLabelDensityRef.current?.();
      });
    }
  }, [apiNodes.length]);

  const handleResetZoom = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom(1);
    cy.center();
  }, []);

  // The first load has no graph to preserve. Subsequent query/expansion loads
  // leave the current canvas mounted and show a lightweight status overlay.
  if (!mounted || (isLoading && apiNodes.length === 0)) {
    return <GraphSkeleton className={cn('h-full w-full', className)} />;
  }

  // Empty state.
  if (apiNodes.length === 0) {
    return (
      <div className={cn('h-full w-full flex items-center justify-center bg-muted/20 border rounded-md', className)}>
        <div className="text-center text-muted-foreground">
          <p className="text-sm">No data to display</p>
          <p className="text-xs mt-1">Run a query to visualize the graph</p>
        </div>
      </div>
    );
  }

  const tooltipPosition = hoveredNode
    ? clampTooltipPosition(
        hoveredNode.x,
        hoveredNode.y,
        containerRef.current?.clientWidth ?? 0,
        containerRef.current?.clientHeight ?? 0,
        tooltipSize.width,
        tooltipSize.height
      )
    : null;

  return (
    <div
      className={cn('relative h-full w-full bg-background rounded-md border', className)}
      data-testid="graph-container"
      role="region"
      aria-label="Interactive knowledge graph"
      aria-busy={isLoading}
      // UX-070 — canvas ground. A soft radial vignette behind the TRANSPARENT
      // Cytoscape canvas gives the graph a surface to sit on instead of an
      // undifferentiated void, at zero canvas render cost. Driven entirely by
      // existing theme tokens, so it follows light/dark with no JS colour math.
      style={{
        backgroundImage:
          'radial-gradient(ellipse at 50% 42%, hsl(var(--muted) / 0.55) 0%, hsl(var(--background) / 0) 68%)',
      }}
    >
      {/* Cytoscape mounts into this element imperatively. It is focusable so the
          accessible move-neighborhood arrow-key interaction (#15) can target it. */}
      <div
        ref={containerRef}
        className="absolute inset-0 h-full w-full focus-visible:outline-none"
        tabIndex={0}
        role="application"
        aria-label={
          moveNeighborhood
            ? 'Graph canvas — move-neighborhood on: arrow keys move the selected node and its neighbors'
            : 'Graph canvas'
        }
        onKeyDown={handleGraphKeyDown}
      />

      {/* Zoom Controls — z-30 so the mobile sidebar overlay (z-20) cannot cover
          and disable the viewport controls while the detail panel is open. */}
      <div
        className="absolute bottom-4 right-4 z-30 flex flex-col gap-1"
        role="toolbar"
        aria-label="Graph viewport controls"
      >
        <Button
          variant={moveNeighborhood ? 'default' : 'outline'}
          size="icon"
          className="h-8 w-8 bg-background/90 backdrop-blur"
          onClick={() => setMoveNeighborhood((on) => !on)}
          title={
            moveNeighborhood
              ? 'Move-neighborhood on — drag or arrow-key a node to move its neighbors too'
              : 'Move neighborhood — drag/arrow-key a node with its one-hop neighbors'
          }
          aria-label="Move selected node with its neighborhood"
          aria-pressed={moveNeighborhood}
          data-testid="move-neighborhood-toggle"
        >
          <Move className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 bg-background/90 backdrop-blur"
          onClick={handleZoomIn}
          title="Zoom in"
          aria-label="Zoom in"
        >
          <ZoomIn className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 bg-background/90 backdrop-blur"
          onClick={handleZoomOut}
          title="Zoom out"
          aria-label="Zoom out"
        >
          <ZoomOut className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 bg-background/90 backdrop-blur"
          onClick={handleFit}
          title="Fit graph to screen"
          aria-label="Fit graph to screen"
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 bg-background/90 backdrop-blur"
          onClick={handleRelayout}
          title="Re-layout graph"
          aria-label="Re-layout graph"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 bg-background/90 backdrop-blur"
          onClick={handleResetZoom}
          title="Reset zoom"
          aria-label="Reset zoom"
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      </div>

      {/* Node Count Badge */}
      <div
        className="absolute top-4 left-4 bg-background/90 backdrop-blur px-2 py-1 rounded text-xs text-muted-foreground"
        data-testid="graph-count"
        aria-live="polite"
      >
        {apiNodes.length} {apiNodes.length === 1 ? 'node' : 'nodes'}, {apiRelationships.length}{' '}
        {apiRelationships.length === 1 ? 'relationship' : 'relationships'}
      </div>

      {/* The legend doubles as a direct node-type focus control. */}
      {activeLabels.length > 0 && (
        <div
          className="absolute left-4 right-4 top-12 flex max-h-20 flex-wrap gap-1 overflow-y-auto rounded bg-background/90 px-1.5 py-1.5 text-xs shadow-sm backdrop-blur sm:left-auto sm:top-4 sm:max-h-28 sm:max-w-[min(320px,calc(100%_-_8rem))]"
          data-testid="graph-legend"
          role="group"
          aria-label="Graph node type legend"
        >
          {activeLabels.map(([label, count]) => {
            // GRAPH-073 — a label with no canonical colour still appears here, and
            // says so: a hollow ring plus an explicit note, so an unmapped type
            // reads as a gap in the encoding instead of joining the grey mass.
            const mapped = isMappedEntityLabel(label);
            const description = mapped
              ? `Focus ${label} nodes (${count})`
              : `Focus ${label} nodes (${count}) — no assigned color`;
            return (
              <button
                key={label}
                type="button"
                onClick={() => onLabelFocusChange?.(activeLabel === label ? null : label)}
                disabled={!onLabelFocusChange}
                aria-pressed={activeLabel === label}
                aria-label={description}
                title={description}
                data-unmapped-label={mapped ? undefined : 'true'}
                className={cn(
                  'flex h-6 items-center gap-1 rounded border border-transparent px-1.5 text-muted-foreground transition-colors',
                  onLabelFocusChange && 'hover:border-border hover:bg-muted hover:text-foreground',
                  activeLabel === label && 'border-primary/50 bg-primary/10 text-foreground'
                )}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={
                    mapped
                      ? { backgroundColor: entityColorHex(label) }
                      : { border: `2px solid ${entityColorHex(label)}` }
                  }
                />
                <span>{label}</span>
                {!mapped && <span className="text-[10px] opacity-70">unmapped</span>}
              </button>
            );
          })}
        </div>
      )}

      {isLoading && <BusyStatus key={loadingOpId ?? 0} phase={loadingPhase} />}

      {/* Hover tooltip */}
      {hoveredNode && (
        <div
          ref={tooltipRef}
          className="absolute pointer-events-none z-10 bg-background/95 backdrop-blur border rounded-md shadow-md px-2.5 py-1.5 text-xs"
          style={{
            ...(tooltipPosition ?? {}),
            maxWidth: 'min(260px, calc(100% - 16px))',
          }}
        >
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: entityColorHex(getPrimaryNodeLabel(hoveredNode.node.labels)) }}
            />
            <span className="font-medium text-foreground">{getPrimaryNodeLabel(hoveredNode.node.labels)}</span>
          </div>
          <div className="mt-0.5 text-foreground break-words">{getFullCaption(hoveredNode.node)}</div>
        </div>
      )}
    </div>
  );
}
