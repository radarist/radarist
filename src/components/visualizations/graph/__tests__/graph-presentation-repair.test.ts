/** @jest-environment node */

/**
 * Repair lane `work/graph-design-quality-fable` — pure-core contracts for the
 * 2026-07-31 presentation regressions (GRAPH-067/072, UX-070 reopen).
 *
 * Each block pins an observer-side property the regressed implementation
 * violates, not an implementation constant:
 *  - node size hierarchy must survive every zoom (the flat 80px rendered cap
 *    collapsed 34–64 model px to a uniform 80px disc from zoom 1.25);
 *  - caption collision boxes must model the single-line ellipsis the renderer
 *    actually paints (the wrap-model estimator disagreed with it);
 *  - framing must reserve the caption envelope so a fitted graph can never
 *    paint a clipped caption at the viewport edge;
 *  - the rest-state edge stroke must be computably visible on BOTH theme
 *    surfaces (fuchsia at 0.4 opacity composited to ~1.2:1 on light).
 */

import {
  SCREEN_LABEL_METRICS,
  NODE_RENDER_METRICS,
  computeProportionalNodeSize,
  estimateRenderedLabelBox,
} from '../graph-label-density';
import { computeBodyFit } from '../graph-view-model';
import {
  GRAPH_THEME_FALLBACKS,
  computeEdgeRestStroke,
  contrastRatio,
  isDarkSurface,
  type GraphThemeTokens,
} from '../graph-theme';

const DARK_TOKENS: GraphThemeTokens = {
  surface: '#121722',
  ink: '#e3e8f2',
  mutedInk: '#97a1b5',
  line: '#232b3b',
  ring: '#171d2a',
};

describe('computeProportionalNodeSize (GRAPH-067 reopen: hierarchy survives zoom)', () => {
  it('returns the model size unchanged while natural scaling stays under the cap', () => {
    expect(computeProportionalNodeSize(64, 0.5)).toBe(64);
    expect(computeProportionalNodeSize(64, 1)).toBe(64);
    expect(computeProportionalNodeSize(64, NODE_RENDER_METRICS.maxScale)).toBe(64);
  });

  it('caps the RENDERED size at model x maxScale, per node, beyond the cap zoom', () => {
    const { maxScale } = NODE_RENDER_METRICS;
    for (const zoom of [maxScale + 0.01, 1.6, 2]) {
      expect(computeProportionalNodeSize(64, zoom) * zoom).toBeCloseTo(64 * maxScale, 6);
      expect(computeProportionalNodeSize(30, zoom) * zoom).toBeCloseTo(30 * maxScale, 6);
    }
  });

  it('preserves strict hierarchy at every zoom — a hub is never rendered equal to a leaf', () => {
    for (const zoom of [0.2, 0.5, 1, 1.3, 1.7, 2]) {
      const hub = computeProportionalNodeSize(64, zoom) * zoom;
      const leaf = computeProportionalNodeSize(30, zoom) * zoom;
      expect(hub / leaf).toBeCloseTo(64 / 30, 6);
    }
  });

  it('stays inside the mandated rendered ceiling for the largest supported node at max zoom', () => {
    // maxZoom is 2; the acceptance envelope for a blip body is 88 rendered px,
    // and sizeForDegree caps model bodies at 64 (the GRAPH-067 dense-layout
    // collision budget is calibrated against that maximum).
    expect(computeProportionalNodeSize(64, 2) * 2).toBeLessThanOrEqual(88);
  });

  it('guards degenerate inputs', () => {
    expect(computeProportionalNodeSize(Number.NaN, Number.NaN)).toBe(34);
    expect(computeProportionalNodeSize(0, 1)).toBe(34);
  });
});

describe('estimateRenderedLabelBox (GRAPH-072: estimator must match the ellipsis renderer)', () => {
  it('models exactly one line for a long caption — the renderer paints single-line ellipsis', () => {
    const box = estimateRenderedLabelBox({
      centerX: 0,
      centerY: 0,
      label: 'An intentionally very long decision-grade caption that would wrap many times',
      renderedFontPx: 12,
      renderedMaxWidthPx: 140,
    });
    expect(box.y2 - box.y1).toBeCloseTo(12 * 1.2, 6);
    expect(box.x2 - box.x1).toBeLessThanOrEqual(140);
  });

  it('includes the plate padding when provided, so collision boxes cover the painted plate', () => {
    const bare = estimateRenderedLabelBox({
      centerX: 0,
      centerY: 0,
      label: 'Short',
      renderedFontPx: 12,
      renderedMaxWidthPx: 140,
    });
    const plated = estimateRenderedLabelBox({
      centerX: 0,
      centerY: 0,
      label: 'Short',
      renderedFontPx: 12,
      renderedMaxWidthPx: 140,
      platePaddingPx: 3,
    });
    expect(plated.x1).toBeCloseTo(bare.x1 - 3, 6);
    expect(plated.x2).toBeCloseTo(bare.x2 + 3, 6);
    expect(plated.y1).toBeCloseTo(bare.y1 - 3, 6);
    expect(plated.y2).toBeCloseTo(bare.y2 + 3, 6);
  });
});

describe('computeBodyFit label envelope (GRAPH-072: framing reserves caption space)', () => {
  const bounds = { x1: 0, y1: 0, x2: 1000, y2: 800 };
  const viewport = { width: 1200, height: 900, padding: 48, minZoom: 0.05, maxZoom: 2 };

  it('keeps its exact previous behavior when no envelope is given', () => {
    const fit = computeBodyFit(bounds, viewport);
    expect(fit).not.toBeNull();
    expect(fit!.zoom).toBeCloseTo(Math.min((1200 - 96) / 1000, (900 - 96) / 800), 6);
  });

  it('reserves horizontal and vertical caption space, lowering the fitted zoom', () => {
    const withEnvelope = computeBodyFit(bounds, {
      ...viewport,
      labelEnvelope: { x: 70, top: 4, bottom: 22 },
    });
    const without = computeBodyFit(bounds, viewport);
    expect(withEnvelope!.zoom).toBeLessThan(without!.zoom);
  });

  it('guarantees the caption envelope of every body corner stays inside the canvas', () => {
    const envelope = { x: 70, top: 4, bottom: 22 };
    const fit = computeBodyFit(bounds, { ...viewport, labelEnvelope: envelope })!;
    // Rendered body extremes under the computed transform:
    const renderedX1 = fit.zoom * bounds.x1 + fit.pan.x;
    const renderedX2 = fit.zoom * bounds.x2 + fit.pan.x;
    const renderedY1 = fit.zoom * bounds.y1 + fit.pan.y;
    const renderedY2 = fit.zoom * bounds.y2 + fit.pan.y;
    expect(renderedX1 - envelope.x).toBeGreaterThanOrEqual(viewport.padding - 1e-6);
    expect(renderedX2 + envelope.x).toBeLessThanOrEqual(viewport.width - viewport.padding + 1e-6);
    expect(renderedY1 - envelope.top).toBeGreaterThanOrEqual(viewport.padding - 1e-6);
    expect(renderedY2 + envelope.bottom).toBeLessThanOrEqual(viewport.height - viewport.padding + 1e-6);
  });
});

describe('computeBodyFit envelope on small canvases', () => {
  it('caps the caption envelope so a phone canvas cannot collapse to minZoom', () => {
    const bounds = { x1: 0, y1: 0, x2: 2400, y2: 1800 };
    const phone = { width: 305, height: 545, padding: 48, minZoom: 0.05, maxZoom: 2 };
    const withEnvelope = computeBodyFit(bounds, {
      ...phone,
      labelEnvelope: { x: 70, top: 4, bottom: 26 },
    })!;
    const without = computeBodyFit(bounds, phone)!;
    // The envelope may cost some zoom but never the whole canvas: the fitted
    // zoom stays within 60% of the unreserved fit instead of pinning at
    // minZoom with every caption deferred.
    expect(withEnvelope.zoom).toBeGreaterThanOrEqual(without.zoom * 0.6);
    expect(withEnvelope.zoom).toBeGreaterThan(phone.minZoom);
  });
});

describe('computeEdgeRestStroke (UX-070 reopen: edges visible on BOTH surfaces)', () => {
  it('produces a stroke with computable contrast >= 1.4 against the light surface', () => {
    const stroke = computeEdgeRestStroke(GRAPH_THEME_FALLBACKS);
    expect(stroke).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrastRatio(stroke, GRAPH_THEME_FALLBACKS.surface)).toBeGreaterThanOrEqual(1.4);
  });

  it('produces a stroke with computable contrast >= 1.4 against the dark surface', () => {
    const stroke = computeEdgeRestStroke(DARK_TOKENS);
    expect(contrastRatio(stroke, DARK_TOKENS.surface)).toBeGreaterThanOrEqual(1.4);
  });

  it('stays recessive — the stroke must not out-contrast the caption ink', () => {
    for (const tokens of [GRAPH_THEME_FALLBACKS, DARK_TOKENS]) {
      const stroke = computeEdgeRestStroke(tokens);
      expect(contrastRatio(stroke, tokens.surface)).toBeLessThan(contrastRatio(tokens.ink, tokens.surface));
    }
  });
});

describe('isDarkSurface', () => {
  it('classifies the two shipped surfaces correctly', () => {
    expect(isDarkSurface(GRAPH_THEME_FALLBACKS)).toBe(false);
    expect(isDarkSurface(DARK_TOKENS)).toBe(true);
  });
});

describe('overlapsAnyBounds (UX-070: caption plates must not sit on other node bodies)', () => {
  const bodies = [
    { x1: 0, y1: 0, x2: 40, y2: 40 },
    { x1: 100, y1: 0, x2: 140, y2: 40 },
  ];

  it('detects a plate crossing a node body beyond the tolerance', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { overlapsAnyBounds } = require('../graph-label-density');
    expect(overlapsAnyBounds({ x1: 30, y1: 10, x2: 90, y2: 26 }, bodies, 2)).toBe(true);
  });

  it('accepts a plate that only touches within the tolerance or sits clear', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { overlapsAnyBounds } = require('../graph-label-density');
    expect(overlapsAnyBounds({ x1: 42, y1: 10, x2: 98, y2: 26 }, bodies, 2)).toBe(false);
    expect(overlapsAnyBounds({ x1: 39, y1: 10, x2: 98, y2: 26 }, bodies, 2)).toBe(false);
  });
});

describe('caption plate width stays inside the acceptance envelope', () => {
  it('rendered plate width (max-width + 2x padding) fits the 150px caption bound', () => {
    expect(SCREEN_LABEL_METRICS.maxWidthPx + 2 * SCREEN_LABEL_METRICS.backgroundPaddingPx).toBeLessThanOrEqual(150);
  });
});
