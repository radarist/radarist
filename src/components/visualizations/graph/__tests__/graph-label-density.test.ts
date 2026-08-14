/** @jest-environment node */

/**
 * GRAPH-072 — the caption policy's pure core.
 *
 * The measured baseline had two cull systems disagreeing: at the default fit zoom
 * of 0.221 the stylesheet's `min-zoomed-font-size: 5` hid all 107 captions
 * (`11px * 0.221 = 2.4px`) while this policy believed six were visible. These
 * tests pin the properties that make the two agree, and the monotonicity property
 * that stops zooming in from taking captions away.
 */

import {
  EDGE_LABEL_METRICS,
  SCREEN_LABEL_METRICS,
  computeBoundedEdgeLabelStyle,
  computeScreenSpaceLabelStyle,
  countRenderedCaptions,
  estimateRenderedLabelBox,
  getLabelDensityPolicy,
  fitsViewport,
  intersectsViewport,
  isCaptionRendered,
  selectVisibleNodeLabels,
  type LabelDensityCandidate,
  type RenderedCaptionProbe,
  type RenderedLabelBounds,
} from '../graph-label-density';

const ZOOM_LADDER = [0.221, 0.35, 0.5, 0.8, 1, 1.5, 2.5, 4, 5];

describe('computeScreenSpaceLabelStyle', () => {
  it('holds the RENDERED caption size constant at every zoom on the supported range', () => {
    for (const zoom of ZOOM_LADDER) {
      const style = computeScreenSpaceLabelStyle(zoom);
      expect(style.fontSize * zoom).toBeCloseTo(SCREEN_LABEL_METRICS.fontPx, 10);
      expect(style.textMaxWidth * zoom).toBeCloseTo(SCREEN_LABEL_METRICS.maxWidthPx, 10);
      expect(style.textMarginY * zoom).toBeCloseTo(SCREEN_LABEL_METRICS.marginYPx, 10);
      expect(style.textBackgroundPadding * zoom).toBeCloseTo(SCREEN_LABEL_METRICS.backgroundPaddingPx, 10);
    }
  });

  it('keeps the rendered font strictly above the stylesheet floor, so the floor never culls', () => {
    // This is what demotes `min-zoomed-font-size` from a competing policy to a
    // floor: the value it compares against no longer varies with zoom.
    expect(SCREEN_LABEL_METRICS.fontPx).toBeGreaterThan(SCREEN_LABEL_METRICS.minRenderedFontPx);
    for (const zoom of ZOOM_LADDER) {
      const { fontSize } = computeScreenSpaceLabelStyle(zoom);
      expect(fontSize * zoom).toBeGreaterThan(SCREEN_LABEL_METRICS.minRenderedFontPx);
    }
  });

  it('falls back to zoom 1 rather than producing Infinity on a degenerate viewport', () => {
    for (const badZoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const style = computeScreenSpaceLabelStyle(badZoom);
      expect(style.fontSize).toBe(SCREEN_LABEL_METRICS.fontPx);
      expect(Number.isFinite(style.textMaxWidth)).toBe(true);
    }
  });
});

// `computeBoundedNodeSize` (a flat rendered ceiling that pinned every hub at
// the same 80px and inverted the degree hierarchy) was replaced by the
// per-node proportional cap `computeProportionalNodeSize`, whose contract lives
// in graph-presentation-repair.test.ts alongside the other 2026-07-31 repairs.

describe('computeBoundedEdgeLabelStyle', () => {
  it('preserves the low-zoom visibility threshold and caps high-zoom captions', () => {
    const rendered = ZOOM_LADDER.map((zoom) => computeBoundedEdgeLabelStyle(zoom).edgeFontSize * zoom);

    expect(rendered[0]).toBeCloseTo(EDGE_LABEL_METRICS.modelFontPx * ZOOM_LADDER[0], 10);
    expect(Math.max(...rendered)).toBeLessThanOrEqual(EDGE_LABEL_METRICS.maxRenderedFontPx);
    expect(rendered.at(-1)).toBeCloseTo(EDGE_LABEL_METRICS.maxRenderedFontPx, 10);
  });

  it('caps the rendered edge-label plate padding and survives degenerate zoom', () => {
    for (const zoom of [1, 2, 5]) {
      const style = computeBoundedEdgeLabelStyle(zoom);
      expect(style.edgeTextBackgroundPadding * zoom).toBeLessThanOrEqual(
        EDGE_LABEL_METRICS.maxRenderedBackgroundPaddingPx
      );
    }
    expect(computeBoundedEdgeLabelStyle(Number.NaN)).toEqual(computeBoundedEdgeLabelStyle(1));
  });
});

describe('fitsViewport', () => {
  it('rejects partial caption fragments at every canvas edge', () => {
    expect(fitsViewport({ x1: 4, y1: 4, x2: 96, y2: 96 }, 100, 100, 4)).toBe(true);
    expect(fitsViewport({ x1: 3, y1: 4, x2: 96, y2: 96 }, 100, 100, 4)).toBe(false);
    expect(fitsViewport({ x1: 4, y1: -1, x2: 96, y2: 96 }, 100, 100, 4)).toBe(false);
    expect(fitsViewport({ x1: 4, y1: 4, x2: 101, y2: 96 }, 100, 100, 4)).toBe(false);
    expect(fitsViewport({ x1: 4, y1: 4, x2: 96, y2: 101 }, 100, 100, 4)).toBe(false);
  });
});

describe('isCaptionRendered', () => {
  const base: RenderedCaptionProbe = {
    hasLabel: true,
    visible: true,
    textOpacity: 1,
    fontSize: SCREEN_LABEL_METRICS.fontPx,
    zoom: 1,
    minZoomedFontSize: SCREEN_LABEL_METRICS.minRenderedFontPx,
  };

  it('reproduces the measured baseline: a model-space caption at fit zoom does NOT paint', () => {
    // 11 model px at zoom 0.221 renders at 2.4px against a floor of 5.
    expect(isCaptionRendered({ ...base, fontSize: 11, zoom: 0.221, minZoomedFontSize: 5 })).toBe(false);
  });

  it('paints the same caption once it is sized in screen space', () => {
    const { fontSize } = computeScreenSpaceLabelStyle(0.221);
    expect(isCaptionRendered({ ...base, fontSize, zoom: 0.221 })).toBe(true);
  });

  it('refuses captions the cascade has suppressed or the isolate has hidden', () => {
    expect(isCaptionRendered({ ...base, textOpacity: 0 })).toBe(false); // .label-deferred / .faded
    expect(isCaptionRendered({ ...base, visible: false })).toBe(false); // display:none isolate
    expect(isCaptionRendered({ ...base, hasLabel: false })).toBe(false);
  });

  it('counts only the captions that actually paint', () => {
    expect(countRenderedCaptions([base, { ...base, textOpacity: 0 }, { ...base, visible: false }, base])).toBe(2);
  });
});

describe('estimateRenderedLabelBox', () => {
  it('produces a rendered-space box that does not scale with zoom', () => {
    const boxes = ZOOM_LADDER.map((zoom) => {
      const style = computeScreenSpaceLabelStyle(zoom);
      return estimateRenderedLabelBox({
        centerX: 100,
        centerY: 100,
        label: 'Quantum Error Correction',
        renderedFontPx: style.fontSize * zoom,
        renderedMaxWidthPx: style.textMaxWidth * zoom,
      });
    });

    const widths = boxes.map((box) => box.x2 - box.x1);
    const heights = boxes.map((box) => box.y2 - box.y1);
    for (const width of widths) expect(width).toBeCloseTo(widths[0], 10);
    for (const height of heights) expect(height).toBeCloseTo(heights[0], 10);
  });

  it('places the box below the node when the caption is bottom-aligned', () => {
    const box = estimateRenderedLabelBox({
      centerX: 0,
      centerY: 0,
      label: 'Acme',
      renderedFontPx: 12,
      renderedMaxWidthPx: 132,
      offsetY: 24,
    });
    expect(box.y1).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Zoom monotonicity — the regression that proves the cull loop is broken.
// ---------------------------------------------------------------------------

const VIEWPORT = { width: 900, height: 700 };
const NODE_MODEL_DIAMETER = 40;

interface SimNode {
  id: string;
  degree: number;
  modelX: number;
  modelY: number;
  label: string;
}

/** A deterministic spread of nodes; degrees vary so ranking is not a tie-break. */
const SIM_NODES: SimNode[] = Array.from({ length: 48 }, (_, index) => ({
  id: `n-${String(index).padStart(2, '0')}`,
  degree: (index * 7) % 11,
  modelX: (index % 8) * 150,
  modelY: Math.floor(index / 8) * 150,
  label: `Entity ${index}`,
}));

const MODEL_CENTER = {
  x: (Math.max(...SIM_NODES.map((n) => n.modelX)) + Math.min(...SIM_NODES.map((n) => n.modelX))) / 2,
  y: (Math.max(...SIM_NODES.map((n) => n.modelY)) + Math.min(...SIM_NODES.map((n) => n.modelY))) / 2,
};

function renderedPosition(node: SimNode, zoom: number): { x: number; y: number } {
  return {
    x: (node.modelX - MODEL_CENTER.x) * zoom + VIEWPORT.width / 2,
    y: (node.modelY - MODEL_CENTER.y) * zoom + VIEWPORT.height / 2,
  };
}

function bodyBounds(node: SimNode, zoom: number): RenderedLabelBounds {
  const position = renderedPosition(node, zoom);
  const half = (NODE_MODEL_DIAMETER * zoom) / 2;
  return { x1: position.x - half, y1: position.y - half, x2: position.x + half, y2: position.y + half };
}

/** Nodes whose body is on screen — exactly the candidate rule the renderer uses. */
function candidatesAt(zoom: number): SimNode[] {
  return SIM_NODES.filter((node) => intersectsViewport(bodyBounds(node, zoom), VIEWPORT.width, VIEWPORT.height));
}

function selectAt(zoom: number): Set<string> {
  const candidates = candidatesAt(zoom);
  const style = computeScreenSpaceLabelStyle(zoom);
  const entries: LabelDensityCandidate[] = candidates.map((node) => {
    const position = renderedPosition(node, zoom);
    return {
      id: node.id,
      degree: node.degree,
      bounds: estimateRenderedLabelBox({
        centerX: position.x,
        centerY: position.y,
        label: node.label,
        renderedFontPx: style.fontSize * zoom,
        renderedMaxWidthPx: style.textMaxWidth * zoom,
        offsetY: (NODE_MODEL_DIAMETER * zoom) / 2 + style.textMarginY * zoom,
      }),
    };
  });

  return selectVisibleNodeLabels(entries, getLabelDensityPolicy({ ...VIEWPORT, zoom, nodeCount: candidates.length }));
}

describe('GRAPH-072 zoom-label monotonicity', () => {
  it('renders a bounded, non-zero caption set at the default overview zoom', () => {
    const selected = selectAt(0.221);
    expect(selected.size).toBeGreaterThan(0);
    expect(selected.size).toBeLessThanOrEqual(candidatesAt(0.221).length);
  });

  it('never takes a caption away from a node that is still on screen after zooming in', () => {
    // The honest invariant. Zooming in pushes nodes OFF screen, so the raw total
    // legitimately falls at high zoom (measured on this fixture: 6, 6, 7, 13, 17,
    // 16, 4, 4, 4 across the ladder). A node that leaves the viewport loses its
    // caption because it is no longer visible, not because the policy culled it.
    // The property that actually proves the cull loop is broken is therefore
    // stated over the RETAINED set: within it, zooming in may only add captions.
    let comparisons = 0;

    for (let index = 0; index < ZOOM_LADDER.length - 1; index += 1) {
      const lower = ZOOM_LADDER[index];
      const higher = ZOOM_LADDER[index + 1];
      const retained = new Set(candidatesAt(higher).map((node) => node.id));
      const keptFromLower = [...selectAt(lower)].filter((id) => retained.has(id));
      const selectedHigher = selectAt(higher);

      for (const id of keptFromLower) {
        comparisons += 1;
        expect({ zoom: `${lower}->${higher}`, id, rendered: selectedHigher.has(id) }).toEqual({
          zoom: `${lower}->${higher}`,
          id,
          rendered: true,
        });
      }
    }

    // Non-vacuity guard: a future change that emptied the retained set would make
    // every assertion above pass without testing anything.
    expect(comparisons).toBeGreaterThan(20);
  });

  it('keeps at least one caption at every zoom on the supported range', () => {
    for (const zoom of ZOOM_LADDER) {
      expect({ zoom, selected: selectAt(zoom).size > 0 }).toEqual({ zoom, selected: true });
    }
  });

  it('labels every node once the operator has zoomed into a small enough neighborhood', () => {
    // The `Focus Company (5 nodes)` case from the baseline, which rendered 0 of 5.
    const zoom = 4;
    const candidates = candidatesAt(zoom);
    expect(candidates.length).toBeGreaterThan(0);
    expect(selectAt(zoom).size).toBe(candidates.length);
  });
});
