import { getQuadrantAnglesByOrder, type Point } from '@/lib/radar-utils';
import type { QuadrantConfig } from '@/lib/types';

export interface RadarItem {
  name: string;
  quadrantId: string; // matches QuadrantConfig.id
  ring: string; // matches one of `rings`
  movement?: 'stable' | 'in' | 'out';
}

export interface PlacedBlip {
  item: RadarItem;
  dot: { x: number; y: number };
  labelBox: { x: number; y: number; w: number; h: number };
  labelAnchor: 'start' | 'middle' | 'end';
  /** Used by the SVG renderer to decide whether to draw a leader line */
  leader: boolean;
}
export interface OverflowBlip {
  item: RadarItem;
  dot: { x: number; y: number };
  legendNumber: number;
  inlineNumberPos: { x: number; y: number };
  name: string;
}

export interface LayoutInput {
  items: RadarItem[];
  quadrants: QuadrantConfig[];
  rings: string[];
  /** disc radius in SVG units (output coordinate space) */
  radius: number;
  /** label font size in px */
  fontSize: number;
  /** average character width in px (Inter ≈ fontSize * 0.62) */
  charWidth: number;
  /** padding around each label (collision exclusion zone) */
  pad?: number;
  /** dot center anchor in output SVG coords */
  center: { x: number; y: number };
  /** seed for the deterministic blip-distribution */
  seedPrefix?: string;
  /** caller-supplied no-go zones (ring labels, quadrant titles, etc.) */
  reservedBoxes?: Array<{ x: number; y: number; w: number; h: number }>;
}

export interface LayoutOutput {
  placed: PlacedBlip[];
  overflow: OverflowBlip[];
}

const OCTANT_VECTORS: Array<{
  ux: number;
  uy: number;
  anchor: 'start' | 'middle' | 'end';
  angleDeg: number;
}> = [
  { ux: 1, uy: 0, anchor: 'start', angleDeg: 0 },
  { ux: Math.SQRT1_2, uy: Math.SQRT1_2, anchor: 'start', angleDeg: 45 },
  { ux: 0, uy: 1, anchor: 'middle', angleDeg: 90 },
  { ux: -Math.SQRT1_2, uy: Math.SQRT1_2, anchor: 'end', angleDeg: 135 },
  { ux: -1, uy: 0, anchor: 'end', angleDeg: 180 },
  { ux: -Math.SQRT1_2, uy: -Math.SQRT1_2, anchor: 'end', angleDeg: 225 },
  { ux: 0, uy: -1, anchor: 'middle', angleDeg: 270 },
  { ux: Math.SQRT1_2, uy: -Math.SQRT1_2, anchor: 'start', angleDeg: 315 },
];

const D_IDEAL = 16;
const D_GENEROUS = 28;
const PUSH_STEPS = [16, 28, 40] as const;
const LEADER_THRESHOLD = 12;

function octantOrderForSlice(centerAngleDeg: number): number[] {
  const target = centerAngleDeg;
  return OCTANT_VECTORS.map((oct, i) => {
    const d = Math.abs(((oct.angleDeg - target + 540) % 360) - 180);
    return { i, d };
  })
    .sort((a, b) => a.d - b.d)
    .map((x) => x.i);
}

function bboxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  pad = 0
): boolean {
  return !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x || a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
}

/** Tiny deterministic LCG seeded from a string. */
function lcgFromString(seed: string): () => number {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  if (s === 0) s = 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/**
 * Stratified per-cell blip distribution. For each (quadrant, ring) cell with K
 * blips, the angle range is split into K equal bands; each blip lands in one
 * band at a stratified-random angle and a stratified-random radius. Determ-
 * inistic via seeded LCG. Replaces the force-directed sim from radar-utils
 * because we want blips to FILL the cell, not just avoid pairwise collision.
 */
function distributeBlipsInCells(
  items: RadarItem[],
  quadrants: QuadrantConfig[],
  rings: string[],
  ringRadii: number[],
  center: Point,
  seedPrefix: string
): Map<number, Point> {
  const N = quadrants.length;
  const orderById = new Map(quadrants.map((q, i) => [q.id, i]));
  // Bucket items per (quadrantId, ring) cell.
  const buckets = new Map<string, number[]>();
  items.forEach((it, i) => {
    const k = `${it.quadrantId}|${it.ring}`;
    const arr = buckets.get(k);
    if (arr) arr.push(i);
    else buckets.set(k, [i]);
  });

  const out = new Map<number, Point>();
  const ringInnerR = (ri: number) => (ri === 0 ? 0 : ringRadii[ri - 1]);

  for (const [key, idxs] of buckets) {
    const [qid, ring] = key.split('|');
    const order = orderById.get(qid) ?? 0;
    const ri = rings.indexOf(ring);
    if (ri < 0) continue;

    const angles = getQuadrantAnglesByOrder(order, N);
    const aMin = angles.min;
    const aMax = angles.max;
    const rOuter = ringRadii[ri];
    const rInner = ringInnerR(ri);

    const K = idxs.length;
    const rng = lcgFromString(`${seedPrefix}|${key}|${K}`);

    // Inset so blips don't kiss the dividers / outer edge / ring strokes.
    // For the innermost ring, raise the inner floor so center stays empty (where
    // ring labels sit on the +Y axis).
    const aSpan = aMax - aMin;
    const aInsetFrac = 0.06; // 6% inset on each angular edge
    const rInsetFrac = 0.1; // 10% inset on each radial edge
    const innerFloorFrac = ri === 0 ? 0.3 : 0; // push inner-ring blips outward

    const aLo = aMin + aSpan * aInsetFrac;
    const aHi = aMax - aSpan * aInsetFrac;
    const rRange = rOuter - rInner;
    const rLo = rInner + Math.max(rRange * rInsetFrac, rRange * innerFloorFrac);
    const rHi = rOuter - rRange * rInsetFrac;

    // Stratify angular bands across K blips. Stratify radius into ceil(sqrt(K))
    // sub-bands so radii distribute as well.
    const radialBands = Math.max(1, Math.ceil(Math.sqrt(K)));
    for (let k = 0; k < K; k++) {
      const aBandStart = aLo + (k / K) * (aHi - aLo);
      const aBandEnd = aLo + ((k + 1) / K) * (aHi - aLo);
      const aDeg = aBandStart + rng() * (aBandEnd - aBandStart);

      const rBand = k % radialBands;
      const rBandStart = rLo + (rBand / radialBands) * (rHi - rLo);
      const rBandEnd = rLo + ((rBand + 1) / radialBands) * (rHi - rLo);
      const r = rBandStart + rng() * (rBandEnd - rBandStart);

      const aRad = (aDeg * Math.PI) / 180;
      out.set(idxs[k], {
        x: center.x + r * Math.cos(aRad),
        y: center.y - r * Math.sin(aRad), // SVG y flipped (math sin → -y)
      });
    }
  }

  return out;
}

export function computeLayout(input: LayoutInput): LayoutOutput {
  const { quadrants, rings, items, center, radius, fontSize, charWidth } = input;
  const pad = input.pad ?? 4;
  const lineH = fontSize * 1.25;
  const N = quadrants.length;

  const orderById = new Map(quadrants.map((q, i) => [q.id, i]));
  const ringRadii = rings.map((_, i) => Math.round(((i + 1) / rings.length) * radius));

  // Stratified per-cell placement (replaces force-directed sim).
  const positions = distributeBlipsInCells(
    items,
    quadrants,
    rings,
    ringRadii,
    center,
    input.seedPrefix ?? 'super-graph'
  );

  const placed: PlacedBlip[] = [];
  const overflow: OverflowBlip[] = [];
  // Caller-supplied no-go zones plus reservations we add as we place blips.
  const reservedBoxes: Array<{ x: number; y: number; w: number; h: number }> = [...(input.reservedBoxes ?? [])];
  let nextLegendNumber = 1;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const order = orderById.get(it.quadrantId) ?? 0;
    const dot = positions.get(i);
    if (!dot) continue;

    const sliceCenter = getQuadrantAnglesByOrder(order, N).center;
    const ord = octantOrderForSlice(sliceCenter);

    const labelW = it.name.length * charWidth;
    const labelH = lineH;
    let placedHere: PlacedBlip | null = null;

    const tryAt = (distance: number, leaderRequired: boolean): PlacedBlip | null => {
      for (const oi of ord) {
        const oct = OCTANT_VECTORS[oi];
        const cx = dot.x + oct.ux * distance;
        const cy = dot.y - oct.uy * distance;
        const labelX = oct.anchor === 'end' ? cx - labelW : oct.anchor === 'middle' ? cx - labelW / 2 : cx;
        const labelY = cy - labelH / 2;
        const candBox = { x: labelX, y: labelY, w: labelW, h: labelH };

        // Keep labels close to the disc — tighter clamp than before so we don't
        // wander out into the quadrant-title gutter.
        const farthest = Math.hypot(
          Math.max(Math.abs(labelX - center.x), Math.abs(labelX + labelW - center.x)),
          Math.max(Math.abs(labelY - center.y), Math.abs(labelY + labelH - center.y))
        );
        if (farthest > radius + 30) continue;

        if (placed.some((p) => bboxesOverlap(candBox, p.labelBox, pad))) continue;
        if (reservedBoxes.some((b) => bboxesOverlap(candBox, b, pad))) continue;

        return {
          item: it,
          dot,
          labelBox: candBox,
          labelAnchor: oct.anchor,
          leader: leaderRequired || distance > LEADER_THRESHOLD,
        };
      }
      return null;
    };

    placedHere = tryAt(D_IDEAL, false);
    if (!placedHere) placedHere = tryAt(D_GENEROUS, true);

    if (!placedHere) {
      // Tier 3: outward radial push.
      const dx = dot.x - center.x;
      const dy = dot.y - center.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      for (const push of PUSH_STEPS) {
        for (const oi of ord) {
          const oct = OCTANT_VECTORS[oi];
          const cx = dot.x + ux * push + oct.ux * D_IDEAL * 0.5;
          const cy = dot.y + uy * push - oct.uy * D_IDEAL * 0.5;
          const labelX = oct.anchor === 'end' ? cx - labelW : oct.anchor === 'middle' ? cx - labelW / 2 : cx;
          const labelY = cy - labelH / 2;
          const candBox = { x: labelX, y: labelY, w: labelW, h: labelH };
          // Same tightened disc clamp as tryAt.
          const farthest = Math.hypot(
            Math.max(Math.abs(labelX - center.x), Math.abs(labelX + labelW - center.x)),
            Math.max(Math.abs(labelY - center.y), Math.abs(labelY + labelH - center.y))
          );
          if (farthest > radius + 30) continue;
          if (placed.some((p) => bboxesOverlap(candBox, p.labelBox, pad))) continue;
          if (reservedBoxes.some((b) => bboxesOverlap(candBox, b, pad))) continue;
          placedHere = { item: it, dot, labelBox: candBox, labelAnchor: oct.anchor, leader: true };
          break;
        }
        if (placedHere) break;
      }
    }

    if (placedHere) {
      placed.push(placedHere);
    } else {
      overflow.push({
        item: it,
        dot,
        legendNumber: nextLegendNumber++,
        inlineNumberPos: { x: dot.x + 8, y: dot.y - 8 },
        name: it.name,
      });
      const numberW = 14;
      const numberH = 14;
      reservedBoxes.push({
        x: dot.x + 4,
        y: dot.y - 8 - numberH,
        w: numberW,
        h: numberH,
      });
    }
  }

  return { placed, overflow };
}
