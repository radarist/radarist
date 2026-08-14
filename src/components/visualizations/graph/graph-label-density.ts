/**
 * Pure label-density policy for the Cytoscape graph explorer.
 *
 * The renderer supplies current rendered positions and viewport dimensions;
 * this module returns a deterministic subset of captions to display. Keeping
 * it canvas-independent makes the collision policy cheap to benchmark in Jest.
 */

const MOBILE_VIEWPORT_WIDTH = 640;
const DESKTOP_AREA_PER_LABEL = 36_000;
const MOBILE_AREA_PER_LABEL = 48_000;
const DESKTOP_MIN_LABELS = 6;
const MOBILE_MIN_LABELS = 3;
const DESKTOP_COLLISION_PADDING = 8;
const MOBILE_COLLISION_PADDING = 12;

export interface RenderedLabelBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LabelDensityViewport {
  width: number;
  height: number;
  zoom: number;
  nodeCount: number;
}

export interface LabelDensityPolicy {
  budget: number;
  collisionPadding: number;
}

export interface LabelDensityCandidate {
  id: string;
  degree: number;
  bounds: RenderedLabelBounds;
  alwaysVisible?: boolean;
}

/**
 * Bound visible captions by available rendered area, not only total nodes.
 * Zoom grows the budget because rendered node spacing grows with it. Mobile
 * gets a deliberately smaller budget because captions consume more of its
 * narrow canvas.
 */
export function getLabelDensityPolicy({ width, height, zoom, nodeCount }: LabelDensityViewport): LabelDensityPolicy {
  const safeNodeCount = Math.max(0, nodeCount);
  const mobile = width < MOBILE_VIEWPORT_WIDTH;
  const areaPerLabel = mobile ? MOBILE_AREA_PER_LABEL : DESKTOP_AREA_PER_LABEL;
  const minimum = mobile ? MOBILE_MIN_LABELS : DESKTOP_MIN_LABELS;
  const safeArea = Math.max(0, width) * Math.max(0, height);
  const zoomFactor = Math.max(0.35, Math.min(3, zoom)) ** 1.25;
  const areaBudget = Math.floor((safeArea / areaPerLabel) * zoomFactor);

  return {
    budget: Math.min(safeNodeCount, Math.max(Math.min(minimum, safeNodeCount), areaBudget)),
    collisionPadding: mobile ? MOBILE_COLLISION_PADDING : DESKTOP_COLLISION_PADDING,
  };
}

/** Whether a rendered node body intersects the current canvas. */
export function intersectsViewport(bounds: RenderedLabelBounds, width: number, height: number): boolean {
  return bounds.x2 >= 0 && bounds.y2 >= 0 && bounds.x1 <= width && bounds.y1 <= height;
}

/** Whether the complete rendered label box fits inside the canvas. */
export function fitsViewport(bounds: RenderedLabelBounds, width: number, height: number, inset = 0): boolean {
  return bounds.x1 >= inset && bounds.y1 >= inset && bounds.x2 <= width - inset && bounds.y2 <= height - inset;
}

function boundsOverlap(left: RenderedLabelBounds, right: RenderedLabelBounds, padding: number): boolean {
  return !(
    left.x2 + padding <= right.x1 ||
    right.x2 + padding <= left.x1 ||
    left.y2 + padding <= right.y1 ||
    right.y2 + padding <= left.y1
  );
}

/**
 * UX-070 repair — whether a caption plate intrudes into any of the given boxes
 * by more than `tolerance` on BOTH axes. Used to keep plates off OTHER nodes'
 * bodies: a plate across a colored disc occludes the mark it exists to
 * identify. Tolerance keeps a mere touch from suppressing a caption.
 */
export function overlapsAnyBounds(
  bounds: RenderedLabelBounds,
  boxes: readonly RenderedLabelBounds[],
  tolerance = 2
): boolean {
  return boxes.some((box) => {
    const overlapX = Math.min(bounds.x2, box.x2) - Math.max(bounds.x1, box.x1);
    const overlapY = Math.min(bounds.y2, box.y2) - Math.max(bounds.y1, box.y1);
    return overlapX > tolerance && overlapY > tolerance;
  });
}

// ============================================================================
// GRAPH-072 — SCREEN-SPACE CAPTION METRICS
// ============================================================================

/**
 * Cytoscape sizes `font-size`, `text-max-width`, `text-margin-y` and
 * `text-background-padding` in MODEL units, so they scale with zoom. That turned
 * captions into a positive-feedback loop: zooming in enlarged every label
 * relative to node spacing, which produced MORE collisions, which the density
 * policy answered by culling MORE. Two cull systems then disagreed — the
 * stylesheet's `min-zoomed-font-size` hid all 107 captions at the default fit
 * zoom while this policy believed six were visible.
 *
 * Dividing each metric by the current zoom holds the RENDERED size constant.
 * Collisions can then only decrease as the operator zooms in, and
 * `min-zoomed-font-size` stops competing with the collision budget: because the
 * rendered font never changes, it can never cross the floor, so the budget below
 * becomes the single culling authority and the floor is only a floor.
 */
export const SCREEN_LABEL_METRICS = Object.freeze({
  /** Rendered caption size, in CSS pixels, at every zoom level. */
  fontPx: 12,
  /**
   * Rendered ellipsis width. 134px shows ~21 characters at 12px — enough for
   * real entity names to survive — while the plate (width + 2x padding, plus
   * the sub-character overshoot Cytoscape's ellipsis truncation adds before
   * the mark, measured ~5px at 12px font) stays inside the 150px acceptance
   * envelope with margin.
   */
  maxWidthPx: 134,
  /** Rendered gap between the node body and the caption plate. */
  marginYPx: 6,
  /** Rendered padding inside the caption plate. */
  backgroundPaddingPx: 3,
  /**
   * Rendered-pixel floor retained as a genuine floor. `fontPx` sits above it by
   * construction, so it never culls — it only guards a degenerate zoom.
   */
  minRenderedFontPx: 5,
});

/**
 * Edge labels keep their useful low-zoom threshold, but stop scaling once they
 * reach a readable caption size. A fixed model-space `10px` became 25–50
 * rendered pixels at the supported high zooms, overwhelming both endpoints.
 */
export const EDGE_LABEL_METRICS = Object.freeze({
  modelFontPx: 10,
  maxRenderedFontPx: 12,
  modelBackgroundPaddingPx: 2,
  maxRenderedBackgroundPaddingPx: 3,
});

/**
 * Blips retain degree semantics but never grow into dominant screen furniture.
 *
 * GRAPH-067 reopen (2026-07-31): the previous flat rendered ceiling
 * (`min(base, 80 / zoom)`) pinned every hub at exactly 80 rendered px from zoom
 * 1.25 while leaves kept growing, collapsing the degree hierarchy into uniform
 * giant discs precisely at the zooms where discs are most visible. The cap is
 * now PER NODE and PROPORTIONAL: past `maxScale`, each node freezes at its own
 * `model x maxScale` rendered size, so a hub stays visibly larger than a leaf
 * at every zoom and the largest supported node (64 model px) tops out at 76.8
 * rendered px — inside the 88px acceptance envelope.
 */
export const NODE_RENDER_METRICS = Object.freeze({
  /** Rendered growth stops at `model x maxScale`; hierarchy ratios survive. */
  maxScale: 1.2,
});

export function computeProportionalNodeSize(baseSize: number, zoom: number, metrics = NODE_RENDER_METRICS): number {
  const safeBaseSize = Number.isFinite(baseSize) && baseSize > 0 ? baseSize : 34;
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return safeBaseSize * Math.min(1, metrics.maxScale / safeZoom);
}

export interface BoundedEdgeLabelStyle {
  /** Model-space font size that never renders above the configured cap. */
  edgeFontSize: number;
  /** Model-space plate padding that never renders above the configured cap. */
  edgeTextBackgroundPadding: number;
}

export function computeBoundedEdgeLabelStyle(zoom: number, metrics = EDGE_LABEL_METRICS): BoundedEdgeLabelStyle {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    edgeFontSize: Math.min(metrics.modelFontPx, metrics.maxRenderedFontPx / safeZoom),
    edgeTextBackgroundPadding: Math.min(
      metrics.modelBackgroundPaddingPx,
      metrics.maxRenderedBackgroundPaddingPx / safeZoom
    ),
  };
}

export type ScreenLabelMetrics = typeof SCREEN_LABEL_METRICS;

export interface ScreenSpaceLabelStyle {
  /** Model-space `font-size`; renders at exactly `metrics.fontPx`. */
  fontSize: number;
  /** Model-space `text-max-width`; renders at exactly `metrics.maxWidthPx`. */
  textMaxWidth: number;
  /** Model-space `text-margin-y`; renders at exactly `metrics.marginYPx`. */
  textMarginY: number;
  /** Model-space `text-background-padding`. */
  textBackgroundPadding: number;
}

/**
 * Model-space values that render at a constant screen size for the given zoom.
 * A non-finite or non-positive zoom falls back to 1 rather than producing
 * Infinity, so a degenerate viewport cannot poison the stylesheet.
 */
export function computeScreenSpaceLabelStyle(
  zoom: number,
  metrics: ScreenLabelMetrics = SCREEN_LABEL_METRICS
): ScreenSpaceLabelStyle {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    fontSize: metrics.fontPx / safeZoom,
    textMaxWidth: metrics.maxWidthPx / safeZoom,
    textMarginY: metrics.marginYPx / safeZoom,
    textBackgroundPadding: metrics.backgroundPaddingPx / safeZoom,
  };
}

/**
 * One node's caption as the live renderer currently sees it. Values come from
 * Cytoscape's own computed style so this predicate never has to re-implement the
 * stylesheet cascade (`.label-deferred` / `.faded` / selection override).
 */
export interface RenderedCaptionProbe {
  hasLabel: boolean;
  /** False when the element is `display: none` (hard isolate). */
  visible: boolean;
  /** Computed `text-opacity` after the cascade. */
  textOpacity: number;
  /** Computed model-space `font-size`. */
  fontSize: number;
  zoom: number;
  /** Computed `min-zoomed-font-size`, in rendered pixels. */
  minZoomedFontSize: number;
}

/**
 * Whether a caption actually paints. This is the "actually rendered" side of the
 * GRAPH-072 contract that the density policy's own count must equal — the
 * measured baseline reported six visible captions while painting zero.
 */
export function isCaptionRendered(probe: RenderedCaptionProbe): boolean {
  if (!probe.hasLabel || !probe.visible) return false;
  if (!(probe.textOpacity > 0)) return false;
  return probe.fontSize * probe.zoom >= probe.minZoomedFontSize;
}

export function countRenderedCaptions(probes: readonly RenderedCaptionProbe[]): number {
  return probes.reduce((count, probe) => count + (isCaptionRendered(probe) ? 1 : 0), 0);
}

/**
 * Conservative rendered-space label box for renderers that do not expose
 * label-only bounds. Everything here is already in RENDERED pixels, so it stays
 * correct at any zoom instead of assuming a fixed model font size.
 *
 * GRAPH-072 repair (2026-07-31): the renderer paints exactly ONE ellipsized
 * line (`text-wrap: 'ellipsis'`), so the estimate models one line too. The old
 * multi-line wrap model over-estimated a 38-char caption as ~3 lines, making
 * collision culling and edge-of-canvas deferral disagree with the painted
 * truth. `platePaddingPx` extends the box to the painted plate so collision
 * boxes cover what the user actually sees.
 */
export function estimateRenderedLabelBox(input: {
  centerX: number;
  centerY: number;
  label: string;
  renderedFontPx: number;
  renderedMaxWidthPx: number;
  /** Rendered offset from the node center to the caption center. */
  offsetY?: number;
  /** Rendered plate padding drawn around the text on every side. */
  platePaddingPx?: number;
}): RenderedLabelBounds {
  const maxWidth = Math.max(1, input.renderedMaxWidthPx);
  // ~0.55em average advance width is the usual approximation for a proportional
  // sans face; it only needs to bound the box, not measure it exactly.
  const naturalWidth = Math.max(input.renderedFontPx, input.label.length * input.renderedFontPx * 0.55);
  const width = Math.min(maxWidth, naturalWidth);
  const height = input.renderedFontPx * 1.2;
  const centerY = input.centerY + (input.offsetY ?? 0);
  const plate = Math.max(0, input.platePaddingPx ?? 0);

  return {
    x1: input.centerX - width / 2 - plate,
    x2: input.centerX + width / 2 + plate,
    y1: centerY - height / 2 - plate,
    y2: centerY + height / 2 + plate,
  };
}

/**
 * Pick a deterministic, spatially separated label set. Selection and hover
 * bypass the budget; every other candidate is ranked by graph degree, then ID.
 */
export function selectVisibleNodeLabels(candidates: LabelDensityCandidate[], policy: LabelDensityPolicy): Set<string> {
  const forced = candidates.filter((candidate) => candidate.alwaysVisible).sort((a, b) => a.id.localeCompare(b.id));
  const ranked = candidates
    .filter((candidate) => !candidate.alwaysVisible)
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
  const visibleCandidates = [...forced];

  for (const candidate of ranked) {
    if (visibleCandidates.length >= policy.budget + forced.length) break;
    const collides = visibleCandidates.some((visible) =>
      boundsOverlap(candidate.bounds, visible.bounds, policy.collisionPadding)
    );
    if (!collides) visibleCandidates.push(candidate);
  }

  return new Set(visibleCandidates.map((candidate) => candidate.id));
}
