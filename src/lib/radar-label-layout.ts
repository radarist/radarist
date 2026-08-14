/**
 * @file radar-label-layout.ts
 * @description Pure helpers for laying out blip labels on the Tech Radar.
 *
 *  - `splitLabelLines` — word-wraps an entry name into at most two centered
 *    lines, ellipsizing only when the name exceeds two lines.
 *  - `estimateLabelBoxPct` — approximates the rendered label's bounding box
 *    (derived from line lengths + font metrics) in container-percent units.
 *  - `resolveLabelCollisions` — deterministic post-layout collision pass:
 *    overlapping label boxes are separated by small radial/angular nudges of
 *    the blip positions WITHIN their (quadrant, ring) band; when a pair is
 *    clamp-stuck at a band edge, the screen-higher label flips above its blip.
 *
 * Everything here is deterministic. Any tie-break "jitter" derives from the
 * seeded PRNG (`seedrandom`) keyed on stable entry ids — never `Math.random`
 * at render time — so blip positions are stable across renders.
 */

import { cartesianToPolar, polarToCartesian, getQuadrantAnglesByOrder } from './radar-utils';
import { seedrandom } from './seedrandom';

/** Maximum characters per rendered label line (≈75px at the 9px label font). */
export const LABEL_MAX_CHARS_PER_LINE = 14;
/** Maximum rendered label lines before ellipsizing. */
export const LABEL_MAX_LINES = 2;

/** Label font metrics — must mirror the label classes in `Radar.tsx`
 * (`text-[9px] font-medium px-1 py-0.5`, `leading-[1.4]`). */
export const LABEL_FONT_PX = 9;
export const LABEL_CHAR_WIDTH_PX = 5.5; // ≈0.61em average glyph width at font-medium
export const LABEL_LINE_HEIGHT_PX = 13; // 9px * 1.4 line-height, rounded up
export const LABEL_PADDING_X_PX = 8; // px-1 → 4px each side
export const LABEL_PADDING_Y_PX = 4; // py-0.5 → 2px each side
/** Vertical gap between the blip center and the near edge of its label box. */
export const LABEL_OFFSET_PX = 14;

const ELLIPSIS = '…';

/** Matches the radius clamp buffer used by `calculateRadarPositions`. */
const RADIUS_BUFFER = 4;
/** Movement (in % units) below which a nudge is considered clamp-stuck. */
const MIN_EFFECTIVE_MOVE_PCT = 0.05;
/** Extra separation (in % units) added on top of the measured overlap. */
const SEPARATION_EPSILON_PCT = 0.25;
const DEFAULT_MAX_ITERATIONS = 24;

/**
 * Split an entry name into at most `maxLines` lines of at most
 * `maxCharsPerLine` characters, breaking on word boundaries.
 *
 * - A name that fits one line is returned as a single line.
 * - A single word longer than a whole line is hard-truncated with an ellipsis.
 * - If words remain after `maxLines` lines, the final line is ellipsized.
 *
 * @param name - The raw entry name.
 * @param maxCharsPerLine - Per-line character budget.
 * @param maxLines - Maximum number of lines before ellipsizing.
 * @returns The wrapped lines (empty array for a blank name).
 */
export function splitLabelLines(
  name: string,
  maxCharsPerLine: number = LABEL_MAX_CHARS_PER_LINE,
  maxLines: number = LABEL_MAX_LINES
): string[] {
  const normalized = name.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) return [];
  if (normalized.length <= maxCharsPerLine) return [normalized];

  const words = normalized.split(' ');
  const lines: string[] = [];
  let i = 0;

  while (i < words.length && lines.length < maxLines) {
    let line = '';
    while (i < words.length) {
      const candidate = line.length === 0 ? words[i] : `${line} ${words[i]}`;
      if (candidate.length > maxCharsPerLine) break;
      line = candidate;
      i++;
    }
    if (line.length === 0) {
      // Single word longer than a whole line — hard-truncate it.
      line = words[i].substring(0, Math.max(1, maxCharsPerLine - 1)) + ELLIPSIS;
      i++;
    }
    lines.push(line);
  }

  if (i < words.length) {
    // Ran out of lines — ellipsize the final line.
    const last = lines[lines.length - 1];
    if (!last.endsWith(ELLIPSIS)) {
      lines[lines.length - 1] =
        last.length + 1 > maxCharsPerLine
          ? last.substring(0, Math.max(1, maxCharsPerLine - 1)) + ELLIPSIS
          : last + ELLIPSIS;
    }
  }

  return lines;
}

/**
 * Approximate a label's rendered bounding-box size in container-percent units.
 *
 * @param lines - The label lines (from `splitLabelLines`).
 * @param radarSizePx - The radar container's pixel size (square).
 * @returns Width/height as percentages of the radar container.
 */
export function estimateLabelBoxPct(lines: string[], radarSizePx: number): { widthPct: number; heightPct: number } {
  if (lines.length === 0 || radarSizePx <= 0) return { widthPct: 0, heightPct: 0 };
  const maxChars = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const widthPx = maxChars * LABEL_CHAR_WIDTH_PX + LABEL_PADDING_X_PX;
  const heightPx = lines.length * LABEL_LINE_HEIGHT_PX + LABEL_PADDING_Y_PX;
  return { widthPct: (widthPx / radarSizePx) * 100, heightPct: (heightPx / radarSizePx) * 100 };
}

/** Which side of the blip the label renders on. */
export type LabelSide = 'below' | 'above';

/** Axis-aligned label bounding box in container-percent units. */
export interface LabelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One blip + label entering the collision pass. */
export interface LabelCollisionItem {
  /** Stable entry id (used for deterministic ordering + tie-break jitter). */
  id: number | string;
  /** Blip center, percent of the radar container (0–100). */
  xPct: number;
  yPct: number;
  /** Approximate label box size, percent units (from `estimateLabelBoxPct`). */
  labelWidthPct: number;
  labelHeightPct: number;
  /** User-pinned (manually dragged) blips never move; labels may still flip. */
  fixed: boolean;
  /** Slice index within the radar's quadrant configs. */
  quadrantOrder: number;
  /** Ring radial band in blip-radius units (0–100; screen % = r / 2). */
  ringMinRadius: number;
  ringMaxRadius: number;
}

/** Resolved output per item. */
export interface ResolvedBlipLabel {
  xPct: number;
  yPct: number;
  labelSide: LabelSide;
}

export interface LabelCollisionOptions {
  /** Number of quadrant slices on the radar (clamped to ≥ 1). */
  quadrantCount: number;
  /** `LABEL_OFFSET_PX` converted to container-percent units. */
  labelOffsetPct: number;
  /** Iteration cap (default 24); tiny residual overlap is acceptable. */
  maxIterations?: number;
}

/**
 * Compute the label bounding box for a blip at (`xPct`, `yPct`).
 * Exported so tests (and overlap assertions) share the exact geometry the
 * resolver uses.
 */
export function computeLabelBox(
  xPct: number,
  yPct: number,
  labelWidthPct: number,
  labelHeightPct: number,
  labelOffsetPct: number,
  side: LabelSide
): LabelBox {
  const halfWidth = labelWidthPct / 2;
  if (side === 'above') {
    return {
      left: xPct - halfWidth,
      right: xPct + halfWidth,
      top: yPct - labelOffsetPct - labelHeightPct,
      bottom: yPct - labelOffsetPct,
    };
  }
  return {
    left: xPct - halfWidth,
    right: xPct + halfWidth,
    top: yPct + labelOffsetPct,
    bottom: yPct + labelOffsetPct + labelHeightPct,
  };
}

/** Per-axis penetration depth; both must be > 0 for the boxes to overlap. */
function overlapAmounts(a: LabelBox, b: LabelBox): { ox: number; oy: number } {
  return {
    ox: Math.min(a.right, b.right) - Math.max(a.left, b.left),
    oy: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
  };
}

/**
 * Clamp a screen-percent position back into the item's (quadrant, ring) band.
 * Mirrors the polar clamping used by `calculateRadarPositions` so nudged
 * blips obey the exact same constraints as the force simulation.
 */
function clampToBand(
  xPct: number,
  yPct: number,
  item: Pick<LabelCollisionItem, 'quadrantOrder' | 'ringMinRadius' | 'ringMaxRadius'>,
  quadrantCount: number
): { xPct: number; yPct: number } {
  const N = Math.max(1, Math.min(8, quadrantCount));
  // Screen % → cartesian blip-radius space (matches `left = 50 + x / 2`).
  const polar = cartesianToPolar((xPct - 50) * 2, (50 - yPct) * 2);
  let r = polar.r;
  let thetaDeg = (polar.theta * 180) / Math.PI;

  let minR = item.ringMinRadius + RADIUS_BUFFER;
  let maxR = item.ringMaxRadius - RADIUS_BUFFER;
  if (minR > maxR) {
    // Band thinner than twice the buffer — collapse to the band's midline.
    const mid = (item.ringMinRadius + item.ringMaxRadius) / 2;
    minR = mid;
    maxR = mid;
  }
  r = Math.max(minR, Math.min(maxR, r));

  if (N !== 1) {
    const angles = getQuadrantAnglesByOrder(item.quadrantOrder, N);
    const angleBuffer = Math.min(2, 360 / N / 10);
    let delta = thetaDeg - angles.center;
    while (delta <= -180) delta += 360;
    while (delta > 180) delta -= 360;
    const halfWidth = Math.max(0, angles.halfWidth - angleBuffer);
    if (delta < -halfWidth) delta = -halfWidth;
    if (delta > halfWidth) delta = halfWidth;
    thetaDeg = angles.center + delta;
  }

  const clamped = polarToCartesian(r, (thetaDeg * Math.PI) / 180);
  return { xPct: 50 + clamped.x / 2, yPct: 50 - clamped.y / 2 };
}

interface BlipLabelState {
  item: LabelCollisionItem;
  x: number;
  y: number;
  side: LabelSide;
}

/**
 * Deterministically resolve overlapping label bounding boxes.
 *
 * Strategy per overlapping pair, in stable id-sorted order:
 *  1. Push the two blips apart along their center line by half the overlap
 *     (plus a small epsilon), clamped to each blip's (quadrant, ring) band.
 *     Coincident blips get a separation angle derived from a stable hash of
 *     the pair's ids.
 *  2. If the nudge is clamp-stuck (no effective movement), flip the
 *     screen-higher label ABOVE its blip (one-way flip → no oscillation).
 *
 * Iterations are capped (`maxIterations`, default 24); a tiny residual
 * overlap after the cap is acceptable by design.
 *
 * @param items - Blips + label boxes to lay out.
 * @param options - Quadrant count, label offset, iteration cap.
 * @returns Map keyed by `String(item.id)` with resolved position + label side.
 */
export function resolveLabelCollisions(
  items: LabelCollisionItem[],
  options: LabelCollisionOptions
): Map<string, ResolvedBlipLabel> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const quadrantCount = Math.max(1, options.quadrantCount);

  // Stable processing order regardless of caller's array order.
  const states: BlipLabelState[] = items
    .map((item) => ({ item, x: item.xPct, y: item.yPct, side: 'below' as LabelSide }))
    .sort((a, b) => String(a.item.id).localeCompare(String(b.item.id)));

  const boxOf = (s: BlipLabelState): LabelBox =>
    computeLabelBox(s.x, s.y, s.item.labelWidthPct, s.item.labelHeightPct, options.labelOffsetPct, s.side);

  const moveBy = (s: BlipLabelState, dx: number, dy: number): number => {
    if (s.item.fixed) return 0;
    const next = clampToBand(s.x + dx, s.y + dy, s.item, quadrantCount);
    const moved = Math.hypot(next.xPct - s.x, next.yPct - s.y);
    s.x = next.xPct;
    s.y = next.yPct;
    return moved;
  };

  /**
   * Flip the screen-higher label above its blip so the pair separates
   * vertically. One-way (below → above) so flips can't oscillate.
   */
  const flipSide = (a: BlipLabelState, b: BlipLabelState): boolean => {
    const aFirst = a.y < b.y || (a.y === b.y && String(a.item.id) <= String(b.item.id));
    const ordered = aFirst ? [a, b] : [b, a];
    for (const s of ordered) {
      if (s.side === 'below') {
        s.side = 'above';
        return true;
      }
    }
    return false;
  };

  for (let iter = 0; iter < maxIterations; iter++) {
    let adjusted = false;

    for (let j = 0; j < states.length; j++) {
      for (let k = j + 1; k < states.length; k++) {
        const a = states[j];
        const b = states[k];
        const { ox, oy } = overlapAmounts(boxOf(a), boxOf(b));
        if (ox <= 0 || oy <= 0) continue;

        if (a.item.fixed && b.item.fixed) {
          // Both pinned by the user — the only lever left is the label side.
          if (flipSide(a, b)) adjusted = true;
          continue;
        }

        const push = Math.min(ox, oy) / 2 + SEPARATION_EPSILON_PCT;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-3) {
          // Coincident blips: derive a stable separation angle from the
          // pair's ids (deterministic — never Math.random at render time).
          const angle = seedrandom(`${String(a.item.id)}|${String(b.item.id)}`)() * Math.PI * 2;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          dist = 1;
        }
        const ux = dx / dist;
        const uy = dy / dist;
        // If one side is pinned, the free blip absorbs the whole separation.
        const aShare = b.item.fixed ? 2 : 1;
        const bShare = a.item.fixed ? 2 : 1;
        const moved =
          moveBy(a, -ux * push * aShare, -uy * push * aShare) + moveBy(b, ux * push * bShare, uy * push * bShare);

        if (moved < MIN_EFFECTIVE_MOVE_PCT) {
          if (flipSide(a, b)) adjusted = true;
        } else {
          adjusted = true;
        }
      }
    }

    if (!adjusted) break;
  }

  return new Map(states.map((s) => [String(s.item.id), { xPct: s.x, yPct: s.y, labelSide: s.side }]));
}
