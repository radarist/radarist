/**
 * @file relationship-graph-view.ts
 * @description Pure view-math helpers for the EntityRelationshipPanel force graph.
 *
 * Extracted from the component so the zoom-level chooser, d3-force tuning and
 * node-label layout are unit-testable without a canvas or a force engine.
 *
 * @author Radarist Team
 * @created 2026-06-10
 */

/**
 * Interactive + programmatic zoom bounds. Passed to ForceGraph2D as
 * `minZoom`/`maxZoom`, which set the d3-zoom scaleExtent — this also clamps
 * `zoomToFit`, whose computed scale for a single-node bounding box would
 * otherwise reach ~20x+ (the "giant circle filling the modal" bug).
 */
export const GRAPH_MIN_ZOOM = 0.25;
export const GRAPH_MAX_ZOOM = 8;

/** Graphs at or below this node count get a fixed zoom instead of zoomToFit. */
export const SMALL_GRAPH_NODE_LIMIT = 3;

/**
 * Fixed focus zoom for small graphs. Matches ContextualGraph's single-node
 * `zoom(2.5, …)` so the modal feels like the main Graph section.
 */
export const SMALL_GRAPH_ZOOM = 2.5;

/** Padding (screen px) handed to zoomToFit for multi-node graphs. */
export const FIT_PADDING_PX = 60;

/** Camera transition duration (ms) — same as the zoom button transitions. */
export const VIEW_TRANSITION_MS = 400;

export type InitialGraphView = { kind: 'zoom'; zoom: number } | { kind: 'fit'; padding: number };

/**
 * Decide how to frame the graph once it has settled.
 *
 * `zoomToFit` on 1–3 tightly-packed nodes degenerates into an extreme zoom-in
 * (the bounding box is barely larger than a node), so small graphs get a sane
 * fixed zoom instead; larger graphs fit-to-bounds with padding.
 */
export function getInitialView(nodeCount: number): InitialGraphView {
  if (nodeCount <= SMALL_GRAPH_NODE_LIMIT) {
    return { kind: 'zoom', zoom: SMALL_GRAPH_ZOOM };
  }
  return { kind: 'fit', padding: FIT_PADDING_PX };
}

// ============================================================================
// UX-069 — TRUTHFUL DISPLAY-CAP REPORTING
// ============================================================================

/**
 * How many first-degree neighbors get expanded to their own neighbors. Beyond
 * this, a neighbor's own connections are never fetched, so the true neighborhood
 * size is a LOWER BOUND, not a known number.
 */
export const SECOND_DEGREE_PARENT_LIMIT = 10;

/**
 * Ceiling that stops SECOND-degree nodes from being added. It is not a ceiling
 * on the rendered node count: every direct neighbor is drawn regardless, so a
 * hub can legitimately paint more than this many nodes.
 * The copy below must therefore never present it as a bound on what is visible.
 */
export const DISPLAY_NODE_LIMIT = 50;

export interface GraphScope {
  /** Nodes actually rendered. */
  displayedNodes: number;
  /** Distinct nodes discovered, including any the display limit excluded. */
  discoveredNodes: number;
  /** Links actually rendered. */
  displayedLinks: number;
  /** First-degree neighbors whose own connections were never fetched. */
  unexploredNeighbors: number;
}

export interface GraphScopeDescription {
  /** True when the footer must not present the rendered count as the real one. */
  capped: boolean;
  /** Footer text: a plain count, or an explicit `displayed of total` form. */
  nodesLabel: string;
  /** Full explanation for the tooltip / accessible description. */
  detail: string;
}

/**
 * Describe what the graph is showing versus what it found.
 *
 * The modal used to report a hard display cap as if it were the real
 * neighborhood size: on `A Technologies` the footer read "50 entities, 49
 * connections" — exactly the cap — with no indication that anything was withheld.
 *
 * When neighbors were left unexpanded the discovered total is itself a floor, so
 * the copy says "at least": claiming an exact total we never measured would just
 * replace one false precision with another.
 */
export function describeGraphScope(scope: GraphScope): GraphScopeDescription {
  const displayed = Math.max(0, scope.displayedNodes);
  const discovered = Math.max(displayed, scope.discoveredNodes);
  const unexplored = Math.max(0, scope.unexploredNeighbors);
  const withheld = discovered - displayed;
  const capped = withheld > 0 || unexplored > 0;

  if (!capped) {
    return {
      capped: false,
      nodesLabel: String(displayed),
      detail: `Showing all ${displayed} connected ${displayed === 1 ? 'entity' : 'entities'}.`,
    };
  }

  const bounded = unexplored > 0;
  const total = `${discovered}${bounded ? '+' : ''}`;
  const reasons: string[] = [];
  if (withheld > 0) {
    // Named as what it actually bounds. `AI Agents` paints 89 nodes because
    // direct neighbors bypass the ceiling entirely; calling 50 a "display
    // limit" there claimed a bound the visible count had already passed.
    reasons.push(
      `expansion beyond direct connections stopped at the ${DISPLAY_NODE_LIMIT}-node limit, which hid ${withheld} discovered ${
        withheld === 1 ? 'entity' : 'entities'
      }`
    );
  }
  if (unexplored > 0) {
    reasons.push(
      `${unexplored} neighbor${unexplored === 1 ? ' was' : 's were'} not expanded, so the total is a lower bound`
    );
  }

  return {
    capped: true,
    nodesLabel: `${displayed} of ${total}`,
    detail: `Showing ${displayed} of ${bounded ? 'at least ' : ''}${discovered} connected entities — ${reasons.join(
      '; '
    )}. Connection counts are limited the same way.`,
  };
}

export interface ForceTuning {
  /** d3 forceManyBody strength (negative = repulsion). */
  chargeStrength: number;
  /** d3 forceLink distance in graph units. */
  linkDistance: number;
}

/**
 * Scale repulsion and link length with node count so the layout stays
 * readable for 5 nodes and for 200 (d3 defaults — charge ~-30, link
 * distance ~30 — pile everything into a clump near the centre).
 *
 * Same formulas as ContextualGraph, the reference implementation.
 */
export function computeForceTuning(nodeCount: number): ForceTuning {
  return {
    chargeStrength: -Math.min(600, 120 + nodeCount * 4),
    linkDistance: Math.min(140, 50 + nodeCount * 0.6),
  };
}

export interface LabelLayout {
  /** Font size in graph units (canvas is scaled by globalScale). */
  fontSize: number;
  /** Max label width in graph units before truncation. */
  maxWidth: number;
}

export interface LabelLayoutOptions {
  /**
   * The focus/center node gets a generous width budget (~24 characters)
   * instead of the ~9-character budget used for peripheral nodes, so its
   * name renders in full instead of collapsing to 1-2 characters (P-C7).
   */
  isCenter?: boolean;
}

/** Peripheral-node character budget: `maxWidth = fontSize * PERIPHERAL_LABEL_CHAR_BUDGET`. */
const PERIPHERAL_LABEL_CHAR_BUDGET = 9;
/** Focus-node character budget — generous enough that names up to ~24 characters never truncate. */
const CENTER_LABEL_CHAR_BUDGET = 24;

/**
 * Compute node-label font size and width budget for a given zoom level.
 *
 * The font size floors at 3 graph units (so labels stay readable when zoomed
 * in), but the historical width budget was a flat `100 / scale` — once the
 * floor kicks in (scale > 4) that budget shrinks below a single character
 * while the rendered font keeps growing, producing the "Ll..." truncation.
 * Keep the budget proportional to the rendered font so ~9 characters always
 * fit regardless of zoom (~24 for the focus node — see `isCenter`).
 */
export function computeLabelLayout(globalScale: number, opts: LabelLayoutOptions = {}): LabelLayout {
  const safeScale = Math.max(globalScale, 0.01);
  const fontSize = Math.max(12 / safeScale, 3);
  const charBudget = opts.isCenter ? CENTER_LABEL_CHAR_BUDGET : PERIPHERAL_LABEL_CHAR_BUDGET;
  const maxWidth = Math.max(100 / safeScale, fontSize * charBudget);
  return { fontSize, maxWidth };
}

/**
 * Truncate a label with an ellipsis so its measured width fits the budget.
 * `measure` is injected (ctx.measureText in production) to keep this pure.
 */
export function truncateLabel(label: string, maxWidth: number, measure: (text: string) => number): string {
  if (measure(label) <= maxWidth) return label;
  let truncated = label;
  while (truncated.length > 0 && measure(`${truncated}...`) > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}...`;
}
