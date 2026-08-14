/**
 * Tests for lib/radar-utils.ts
 *
 * Pure math functions for radar position calculation under the variable-
 * quadrants model (uniform slices, slice 0 at 12 o'clock, clockwise):
 * - polarToCartesian / cartesianToPolar
 * - getQuadrantAnglesByOrder / getRingRadii
 * - getQuadrantLabelPosition / getSliceDividerSegment
 * - calculateRadarPositions (force-directed layout)
 */

import {
  polarToCartesian,
  cartesianToPolar,
  getQuadrantAnglesByOrder,
  getRingRadii,
  getQuadrantLabelPosition,
  getSliceDividerSegment,
  calculateRadarPositions,
} from '../radar-utils';
import type { RadarEntry, QuadrantConfig, Ring } from '../types';

// ============================================================================
// TEST DATA
// ============================================================================

const QUADRANT_CONFIGS: QuadrantConfig[] = [
  { id: 'q_techniques', name: 'Techniques', order: 0 },
  { id: 'q_tools', name: 'Tools', order: 1 },
  { id: 'q_platforms', name: 'Platforms', order: 2 },
  { id: 'q_languages_frameworks', name: 'Languages & Frameworks', order: 3 },
];
const RINGS: Ring[] = ['Adopt', 'Trial', 'Assess', 'Hold'];

function makeEntry(overrides: Partial<RadarEntry> = {}): RadarEntry {
  return {
    id: 1,
    name: 'React',
    quadrantId: 'q_techniques',
    ring: 'Adopt' as Ring,
    description: 'A JavaScript library',
    tags: [],
    status: 'Stable',
    costToPrototype: 0,
    ...overrides,
  } as RadarEntry;
}

// ============================================================================
// TESTS
// ============================================================================

describe('radar-utils', () => {
  // ==========================================================================
  // polarToCartesian
  // ==========================================================================

  describe('polarToCartesian', () => {
    it('should convert (r=0, theta=0) to (0, 0)', () => {
      const p = polarToCartesian(0, 0);
      expect(p.x).toBeCloseTo(0);
      expect(p.y).toBeCloseTo(0);
    });

    it('should convert (r=1, theta=0) to (1, 0)', () => {
      const p = polarToCartesian(1, 0);
      expect(p.x).toBeCloseTo(1);
      expect(p.y).toBeCloseTo(0);
    });

    it('should convert (r=1, theta=PI/2) to (0, 1)', () => {
      const p = polarToCartesian(1, Math.PI / 2);
      expect(p.x).toBeCloseTo(0);
      expect(p.y).toBeCloseTo(1);
    });
  });

  // ==========================================================================
  // cartesianToPolar
  // ==========================================================================

  describe('cartesianToPolar', () => {
    it('should convert (0, 0) to (r=0, theta=0)', () => {
      const p = cartesianToPolar(0, 0);
      expect(p.r).toBeCloseTo(0);
    });

    it('should convert (1, 0) to (r=1, theta=0)', () => {
      const p = cartesianToPolar(1, 0);
      expect(p.r).toBeCloseTo(1);
      expect(p.theta).toBeCloseTo(0);
    });

    it('should convert (0, 1) to (r=1, theta=PI/2)', () => {
      const p = cartesianToPolar(0, 1);
      expect(p.r).toBeCloseTo(1);
      expect(p.theta).toBeCloseTo(Math.PI / 2);
    });

    it('should be inverse of polarToCartesian', () => {
      const r = 10;
      const theta = Math.PI / 3;
      const cart = polarToCartesian(r, theta);
      const polar = cartesianToPolar(cart.x, cart.y);
      expect(polar.r).toBeCloseTo(r);
      expect(polar.theta).toBeCloseTo(theta);
    });

    it('should handle (3, 4) => r=5', () => {
      const p = cartesianToPolar(3, 4);
      expect(p.r).toBeCloseTo(5);
    });
  });

  // ==========================================================================
  // getQuadrantAnglesByOrder (new uniform-slice model)
  // ==========================================================================

  describe('getQuadrantAnglesByOrder', () => {
    it('N=1 single slice covers whole circle (halfWidth=180, center=90°)', () => {
      const s = getQuadrantAnglesByOrder(0, 1);
      expect(s.center).toBeCloseTo(90);
      expect(s.halfWidth).toBeCloseTo(180);
      expect(s.min).toBeCloseTo(0);
      expect(s.max).toBeCloseTo(360);
    });

    // ────────────────────────────────────────────────────────────────────────
    // N=4: the classic Tech Radar.
    //
    // Dividers sit at the CARDINAL axes (math 90°, 0°, 270°, 180° → screen
    // top/right/bottom/left). Slice centers therefore sit at the DIAGONAL
    // corners (math 45°, 315°, 225°, 135° → screen top-right, bottom-right,
    // bottom-left, top-left). halfWidth = 180/4 = 45°.
    // ────────────────────────────────────────────────────────────────────────
    it('N=4 slice 0 centered at top-right corner (math 45°)', () => {
      const s = getQuadrantAnglesByOrder(0, 4);
      expect(s.center).toBeCloseTo(45);
      expect(s.halfWidth).toBeCloseTo(45);
      // Slice 0 is bounded by dividers at top (90°) and right (0°)
      expect(s.min).toBeCloseTo(0);
      expect(s.max).toBeCloseTo(90);
    });

    it('N=4 slice 1 centered at bottom-right corner (math 315°)', () => {
      const s = getQuadrantAnglesByOrder(1, 4);
      expect(s.center).toBeCloseTo(315);
      expect(s.halfWidth).toBeCloseTo(45);
    });

    it('N=4 slice 2 centered at bottom-left corner (math 225°)', () => {
      const s = getQuadrantAnglesByOrder(2, 4);
      expect(s.center).toBeCloseTo(225);
      expect(s.halfWidth).toBeCloseTo(45);
    });

    it('N=4 slice 3 centered at top-left corner (math 135°)', () => {
      const s = getQuadrantAnglesByOrder(3, 4);
      expect(s.center).toBeCloseTo(135);
      expect(s.halfWidth).toBeCloseTo(45);
    });

    // ────────────────────────────────────────────────────────────────────────
    // N=2: one vertical divider splits the circle into right half and left
    // half. Slice 0 center = 0° (right), slice 1 center = 180° (left).
    // ────────────────────────────────────────────────────────────────────────
    it('N=2 slice 0 center at right (0°), slice 1 center at left (180°)', () => {
      const s0 = getQuadrantAnglesByOrder(0, 2);
      const s1 = getQuadrantAnglesByOrder(1, 2);
      expect(s0.center).toBeCloseTo(0);
      expect(s1.center).toBeCloseTo(180);
      expect(s0.halfWidth).toBeCloseTo(90);
    });

    // ────────────────────────────────────────────────────────────────────────
    // N=3: dividers at 90°, 330°, 210°. Slice centers at math 30° (upper-
    // right), 270° (bottom), 150° (upper-left).
    // ────────────────────────────────────────────────────────────────────────
    it('N=3 slices are 120° wide with centers at 30°, 270°, 150°', () => {
      const s0 = getQuadrantAnglesByOrder(0, 3);
      const s1 = getQuadrantAnglesByOrder(1, 3);
      const s2 = getQuadrantAnglesByOrder(2, 3);
      expect(s0.halfWidth).toBeCloseTo(60);
      expect(s0.center).toBeCloseTo(30); // upper-right
      expect(s1.center).toBeCloseTo(270); // bottom
      expect(s2.center).toBeCloseTo(150); // upper-left
    });

    it('N=8 slices are 45° wide', () => {
      const s = getQuadrantAnglesByOrder(0, 8);
      expect(s.halfWidth).toBeCloseTo(22.5);
    });

    it('clamps count to [1, 8]', () => {
      expect(getQuadrantAnglesByOrder(0, 0).halfWidth).toBeCloseTo(180); // clamped to N=1
      expect(getQuadrantAnglesByOrder(0, 9).halfWidth).toBeCloseTo(22.5); // clamped to N=8
    });
  });

  // ==========================================================================
  // getQuadrantLabelPosition — labels sit OUTSIDE the ring, pushed radially
  // ==========================================================================

  describe('getQuadrantLabelPosition', () => {
    // Default outerRadiusPct is 52 — labels sit 2% beyond the ring edge at
    // radius 50 for a small visual gap. The transform uses octant-based
    // corner/edge anchoring so a wide label's inner corner lines up with
    // the anchor regardless of the label's aspect ratio.

    it('N=1 label anchor is at the top, 2% beyond the ring edge', () => {
      const p = getQuadrantLabelPosition(0, 1);
      expect(parseFloat(p.left)).toBeCloseTo(50);
      expect(parseFloat(p.top)).toBeCloseTo(-2);
      expect(p.textAlign).toBe('center');
      // Octant 0 (top): translate(-50%, -100%) — bottom edge at anchor
      expect(p.transform).toMatch(/translate\(-50%,\s*-100%\)/);
    });

    it('N=4 slice 0 label anchor is at the top-right diagonal beyond the ring', () => {
      const p = getQuadrantLabelPosition(0, 4);
      // Anchor at radius 52 along math 45°:
      //   left = 50 + cos(45°)*52 ≈ 86.77
      //   top  = 50 - sin(45°)*52 ≈ 13.23
      expect(parseFloat(p.left)).toBeCloseTo(86.77, 1);
      expect(parseFloat(p.top)).toBeCloseTo(13.23, 1);
      // Right half → text aligns left so it reads outward to the right
      expect(p.textAlign).toBe('left');
      // Octant 1 (top-right diagonal): bottom-left corner at anchor
      expect(p.transform).toMatch(/translate\(0%,\s*-100%\)/);
    });

    it('N=4 slice 1 label anchor is at the bottom-right diagonal', () => {
      const p = getQuadrantLabelPosition(1, 4);
      expect(parseFloat(p.left)).toBeCloseTo(86.77, 1);
      expect(parseFloat(p.top)).toBeCloseTo(86.77, 1);
      expect(p.textAlign).toBe('left');
      // Octant 3 (bottom-right): top-left corner at anchor
      expect(p.transform).toMatch(/translate\(0%,\s*0%\)/);
    });

    it('N=4 slice 2 label anchor is at the bottom-left diagonal', () => {
      const p = getQuadrantLabelPosition(2, 4);
      expect(parseFloat(p.left)).toBeCloseTo(13.23, 1);
      expect(parseFloat(p.top)).toBeCloseTo(86.77, 1);
      expect(p.textAlign).toBe('right');
      // Octant 5 (bottom-left): top-right corner at anchor
      expect(p.transform).toMatch(/translate\(-100%,\s*0%\)/);
    });

    it('N=4 slice 3 label anchor is at the top-left diagonal', () => {
      const p = getQuadrantLabelPosition(3, 4);
      expect(parseFloat(p.left)).toBeCloseTo(13.23, 1);
      expect(parseFloat(p.top)).toBeCloseTo(13.23, 1);
      expect(p.textAlign).toBe('right');
      // Octant 7 (top-left): bottom-right corner at anchor
      expect(p.transform).toMatch(/translate\(-100%,\s*-100%\)/);
    });

    it('N=2 slice 0 label is on the right edge, 2% beyond', () => {
      const p = getQuadrantLabelPosition(0, 2);
      expect(parseFloat(p.left)).toBeCloseTo(102);
      expect(parseFloat(p.top)).toBeCloseTo(50);
      expect(p.textAlign).toBe('left');
      // Octant 2 (right): left edge at anchor — translate(0%, -50%)
      expect(p.transform).toMatch(/translate\(0%,\s*-50%\)/);
    });

    it('N=2 slice 1 label is on the left edge, 2% beyond', () => {
      const p = getQuadrantLabelPosition(1, 2);
      expect(parseFloat(p.left)).toBeCloseTo(-2);
      expect(parseFloat(p.top)).toBeCloseTo(50);
      expect(p.textAlign).toBe('right');
      // Octant 6 (left): right edge at anchor — translate(-100%, -50%)
      expect(p.transform).toMatch(/translate\(-100%,\s*-50%\)/);
    });

    it.each([1, 2, 3, 4, 5, 6, 7, 8])('N=%d — all slice anchors sit at radius 52 (2%% beyond the ring edge)', (N) => {
      for (let i = 0; i < N; i++) {
        const p = getQuadrantLabelPosition(i, N);
        const cx = parseFloat(p.left);
        const cy = parseFloat(p.top);
        const dist = Math.sqrt((cx - 50) ** 2 + (cy - 50) ** 2);
        expect(dist).toBeCloseTo(52, 5);
      }
    });
  });

  // ==========================================================================
  // Label-position no-overlap test for every N ∈ [1, 8]
  //
  // This is the user-requested test. It models each label as a bounding box
  // centered on its anchor, pushed outward by half its size (matching the
  // `transform` returned by `getQuadrantLabelPosition`). Two labels overlap
  // iff their bounding boxes intersect on both axes. With reasonable label
  // sizes (12–18% of container width, 3% height), labels should never
  // overlap for N ∈ [1, 8] because slices are uniform and their centers are
  // at least `360/N` degrees apart.
  //
  // The test covers all N from 1..8, exactly as the user asked for.
  // ==========================================================================

  describe('quadrant label overlap — no pair of labels may touch', () => {
    /**
     * Compute the SCREEN bounding box of a label, accounting for the
     * outward `transform` returned by `getQuadrantLabelPosition`. All values
     * in percent-of-container units. Matches how Radar.tsx actually renders
     * the label (`style={{top, left, transform}}` with `position: absolute`).
     */
    function computeLabelBBox(
      order: number,
      count: number,
      labelW: number,
      labelH: number
    ): { x1: number; y1: number; x2: number; y2: number } {
      const p = getQuadrantLabelPosition(order, count);
      const anchorLeft = parseFloat(p.left);
      const anchorTop = parseFloat(p.top);

      // Extract transform in percent of the label's own size
      const match = p.transform.match(/translate\((-?\d+\.?\d*)%,\s*(-?\d+\.?\d*)%\)/);
      expect(match).not.toBeNull();
      const txPct = parseFloat(match![1]) / 100; // 0 = no move, -1 = -100%
      const tyPct = parseFloat(match![2]) / 100;

      // Label's TOP-LEFT corner in container %
      const labelLeft = anchorLeft + txPct * labelW;
      const labelTop = anchorTop + tyPct * labelH;
      return {
        x1: labelLeft,
        y1: labelTop,
        x2: labelLeft + labelW,
        y2: labelTop + labelH,
      };
    }

    function overlaps(
      a: { x1: number; y1: number; x2: number; y2: number },
      b: { x1: number; y1: number; x2: number; y2: number }
    ): boolean {
      // Axis-aligned rectangle intersection. Exact equality on edges is NOT
      // an overlap — labels can touch edges without visual collision.
      return !(a.x2 <= b.x1 || a.x1 >= b.x2 || a.y2 <= b.y1 || a.y1 >= b.y2);
    }

    // Reasonable label sizes (percent of container).
    //   Width: ~18% — matches a 180px label in a 1000px container, or a
    //   slightly truncated label in the current 800px radar with `maxWidth: 28%`.
    //   Height: ~4% — matches a two-line label (name + underline) at the
    //   default font size.
    const LABEL_WIDTH_PCT = 18;
    const LABEL_HEIGHT_PCT = 4;

    it.each([1, 2, 3, 4, 5, 6, 7, 8])('N=%d — no pair of quadrant labels overlaps at standard label size', (N) => {
      const bboxes = Array.from({ length: N }, (_, i) => computeLabelBBox(i, N, LABEL_WIDTH_PCT, LABEL_HEIGHT_PCT));

      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const collision = overlaps(bboxes[i], bboxes[j]);
          if (collision) {
            throw new Error(
              `N=${N}: labels ${i} and ${j} overlap. ` +
                `bbox[${i}]=${JSON.stringify(bboxes[i])} bbox[${j}]=${JSON.stringify(bboxes[j])}`
            );
          }
        }
      }
    });

    it.each([1, 2, 3, 4, 5, 6, 7, 8])(
      "N=%d — every label's center is pushed outside the ring circle (visible text extends outward)",
      (N) => {
        // The label's CENTER (post-transform) is what determines where the
        // visible text renders. We check that the center sits at or beyond
        // the ring edge, which guarantees the text extends outward into
        // the padding zone rather than overlapping the blip area.
        //
        // NB: the AABB corners of a diagonally-oriented label may dip a
        // fraction inside the ring because a rectangle's corners are closer
        // to the center than its midpoint edge — that's a bbox artifact,
        // not a visual overlap. The text itself (which flows outward from
        // the anchor via `textAlign`) is wholly outside.
        const center = { x: 50, y: 50 };

        for (let i = 0; i < N; i++) {
          const b = computeLabelBBox(i, N, LABEL_WIDTH_PCT, LABEL_HEIGHT_PCT);
          const labelCenterX = (b.x1 + b.x2) / 2;
          const labelCenterY = (b.y1 + b.y2) / 2;
          const dist = Math.sqrt((labelCenterX - center.x) ** 2 + (labelCenterY - center.y) ** 2);
          // Label center must sit at or beyond the ring edge (radius 50).
          // Tolerance of 0.1 allows for floating-point drift.
          expect(dist).toBeGreaterThanOrEqual(49.9);
        }
      }
    );
  });

  // ==========================================================================
  // getSliceDividerSegment
  // ==========================================================================

  describe('getSliceDividerSegment', () => {
    it('returns null for N=1 (no dividers needed)', () => {
      expect(getSliceDividerSegment(0, 1)).toBeNull();
    });

    it('N=2 → one vertical divider top-to-bottom through center', () => {
      // divider 0 at math 90° (top) = (50, 0)
      const seg0 = getSliceDividerSegment(0, 2);
      expect(seg0).not.toBeNull();
      expect(seg0!.x1).toBe(50);
      expect(seg0!.y1).toBe(50);
      expect(seg0!.x2).toBeCloseTo(50, 5);
      expect(seg0!.y2).toBeCloseTo(0, 5);

      // divider 1 at math -90° = 270° (bottom) = (50, 100)
      const seg1 = getSliceDividerSegment(1, 2);
      expect(seg1!.x2).toBeCloseTo(50, 5);
      expect(seg1!.y2).toBeCloseTo(100, 5);
    });

    it('N=4 → dividers at cardinal axes (top, right, bottom, left)', () => {
      // divider 0 at math 90° → top (50, 0)
      const top = getSliceDividerSegment(0, 4);
      expect(top!.x2).toBeCloseTo(50, 5);
      expect(top!.y2).toBeCloseTo(0, 5);

      // divider 1 at math 0° → right (100, 50)
      const right = getSliceDividerSegment(1, 4);
      expect(right!.x2).toBeCloseTo(100, 5);
      expect(right!.y2).toBeCloseTo(50, 5);

      // divider 2 at math 270° → bottom (50, 100)
      const bottom = getSliceDividerSegment(2, 4);
      expect(bottom!.x2).toBeCloseTo(50, 5);
      expect(bottom!.y2).toBeCloseTo(100, 5);

      // divider 3 at math 180° → left (0, 50)
      const left = getSliceDividerSegment(3, 4);
      expect(left!.x2).toBeCloseTo(0, 5);
      expect(left!.y2).toBeCloseTo(50, 5);
    });

    it.each([2, 3, 4, 5, 6, 7, 8])('N=%d — all dividers reach the outer ring edge (distance 50 from center)', (N) => {
      for (let i = 0; i < N; i++) {
        const seg = getSliceDividerSegment(i, N);
        expect(seg).not.toBeNull();
        const dist = Math.sqrt((seg!.x2 - 50) ** 2 + (seg!.y2 - 50) ** 2);
        expect(dist).toBeCloseTo(50, 5);
      }
    });
  });

  // ==========================================================================
  // getRingRadii
  // ==========================================================================

  describe('getRingRadii', () => {
    it('should return first ring radii', () => {
      const radii = getRingRadii(RINGS[0], RINGS);
      expect(radii.min).toBe(0);
      expect(radii.max).toBe(25); // MAX_BLIP_RADIUS(100) / 4 rings = 25 per ring
    });

    it('should return second ring radii', () => {
      const radii = getRingRadii(RINGS[1], RINGS);
      expect(radii.min).toBe(25);
      expect(radii.max).toBe(50);
    });

    it('should return third ring radii', () => {
      const radii = getRingRadii(RINGS[2], RINGS);
      expect(radii.min).toBe(50);
      expect(radii.max).toBe(75);
    });

    it('should return fourth ring radii', () => {
      const radii = getRingRadii(RINGS[3], RINGS);
      expect(radii.min).toBe(75);
      expect(radii.max).toBe(100);
    });

    it('rings should tile without gaps', () => {
      for (let i = 0; i < RINGS.length - 1; i++) {
        const current = getRingRadii(RINGS[i], RINGS);
        const next = getRingRadii(RINGS[i + 1], RINGS);
        expect(current.max).toBe(next.min);
      }
    });

    it('should handle two-ring system', () => {
      const twoRings: Ring[] = ['Adopt', 'Hold'];
      const r0 = getRingRadii('Adopt', twoRings);
      const r1 = getRingRadii('Hold', twoRings);
      expect(r0).toEqual({ min: 0, max: 50 });
      expect(r1).toEqual({ min: 50, max: 100 });
    });
  });

  // ==========================================================================
  // calculateRadarPositions
  // ==========================================================================

  describe('calculateRadarPositions', () => {
    it('should return empty map for no entries', () => {
      const result = calculateRadarPositions([], QUADRANT_CONFIGS, RINGS);
      expect(result.size).toBe(0);
    });

    it('should return positions for single entry', () => {
      const entries = [makeEntry({ id: 1, quadrantId: 'q_techniques', ring: 'Adopt' })];
      const result = calculateRadarPositions(entries, QUADRANT_CONFIGS, RINGS);

      expect(result.size).toBe(1);
      const pos = result.get('1-q_techniques-Adopt');
      expect(pos).toBeDefined();
      expect(pos!.left).toMatch(/^-?\d+(\.\d+)?%$/);
      expect(pos!.top).toMatch(/^-?\d+(\.\d+)?%$/);
    });

    it('should silently place an entry with an unknown quadrantId at slice 0 without logging', () => {
      // Regression test: during the race window between a settings save and
      // the TanStack placement refetch, an entry may briefly reference a
      // quadrantId that's no longer in the radar's configs. The legacy log
      // spammed the console with "Entry references unknown quadrantId" for
      // every entry on every frame. That log has been removed because the
      // consumer (`Radar.tsx`) now filters stale entries upstream; when the
      // filter is bypassed, this path silently degrades to slice 0.
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const entries = [makeEntry({ id: 1, quadrantId: 'q_removed', ring: 'Adopt' })];
      const result = calculateRadarPositions(entries, QUADRANT_CONFIGS, RINGS);

      // Entry still gets a position (degraded to slice 0)
      expect(result.size).toBe(1);
      const pos = result.get('1-q_removed-Adopt');
      expect(pos).toBeDefined();

      // No console noise during the transient race window
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();

      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('should produce deterministic positions with same seed', () => {
      const entries = [makeEntry({ id: 1, quadrantId: 'q_tools', ring: 'Trial' })];
      const r1 = calculateRadarPositions(entries, QUADRANT_CONFIGS, RINGS, 'seed1');
      const r2 = calculateRadarPositions(entries, QUADRANT_CONFIGS, RINGS, 'seed1');

      expect(r1.get('1-q_tools-Trial')).toEqual(r2.get('1-q_tools-Trial'));
    });

    it('should position Techniques (slice 0) in top half', () => {
      // Slice 0 centered at 90° = top → screen y < 50
      const entries = [makeEntry({ id: 1, quadrantId: 'q_techniques', ring: 'Assess' })];
      const result = calculateRadarPositions(entries, QUADRANT_CONFIGS, RINGS);
      const pos = result.get('1-q_techniques-Assess')!;

      const top = parseFloat(pos.top);
      // Slice 0 spans 45-135° which all have positive math-space y; screen
      // `top = 50 - y/2` → top < 50.
      expect(top).toBeLessThan(50);
    });

    it('should position Tools (slice 1) in right half', () => {
      // Slice 1 centered at 0° = right → screen x > 50
      const entries = [makeEntry({ id: 1, quadrantId: 'q_tools', ring: 'Adopt' })];
      const result = calculateRadarPositions(entries, QUADRANT_CONFIGS, RINGS);
      const pos = result.get('1-q_tools-Adopt')!;

      const left = parseFloat(pos.left);
      expect(left).toBeGreaterThan(50);
    });

    it('should handle multiple entries in same sector', () => {
      const entries = [
        makeEntry({ id: 1, quadrantId: 'q_techniques', ring: 'Adopt' }),
        makeEntry({ id: 2, quadrantId: 'q_techniques', ring: 'Adopt' }),
        makeEntry({ id: 3, quadrantId: 'q_techniques', ring: 'Adopt' }),
      ];
      const result = calculateRadarPositions(entries, QUADRANT_CONFIGS, RINGS);

      expect(result.size).toBe(3);
      // All should be in top half (slice 0 centered at top)
      for (const [, pos] of result) {
        expect(parseFloat(pos.top)).toBeLessThan(50);
      }
    });

    it('should handle entries across all quadrants', () => {
      const entries = QUADRANT_CONFIGS.map((c, i) => makeEntry({ id: i, quadrantId: c.id, ring: 'Trial' }));
      const result = calculateRadarPositions(entries, QUADRANT_CONFIGS, RINGS);

      expect(result.size).toBe(4);
    });

    it('should handle entries across all rings', () => {
      const entries = RINGS.map((r, i) => makeEntry({ id: i, quadrantId: 'q_tools', ring: r }));
      const result = calculateRadarPositions(entries, QUADRANT_CONFIGS, RINGS);

      expect(result.size).toBe(4);
    });

    it('should keep positions within bounds (0-100%)', () => {
      const entries: RadarEntry[] = [];
      let counter = 0;
      for (const c of QUADRANT_CONFIGS) {
        for (const r of RINGS) {
          entries.push(makeEntry({ id: counter++, quadrantId: c.id, ring: r }));
        }
      }
      const result = calculateRadarPositions(entries, QUADRANT_CONFIGS, RINGS);

      for (const [, pos] of result) {
        const left = parseFloat(pos.left);
        const top = parseFloat(pos.top);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left).toBeLessThanOrEqual(100);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top).toBeLessThanOrEqual(100);
      }
    });

    it('force simulation should separate overlapping entries', () => {
      // Create many entries in same sector - force sim should spread them
      const entries = Array.from({ length: 10 }, (_, i) => makeEntry({ id: i, quadrantId: 'q_tools', ring: 'Adopt' }));
      const result = calculateRadarPositions(entries, QUADRANT_CONFIGS, RINGS);

      // Collect positions
      const positions = Array.from(result.values()).map((p) => ({
        left: parseFloat(p.left),
        top: parseFloat(p.top),
      }));

      // Check that not all positions are identical (force sim should spread them)
      const allSame = positions.every(
        (p) => Math.abs(p.left - positions[0].left) < 0.01 && Math.abs(p.top - positions[0].top) < 0.01
      );
      expect(allSame).toBe(false);
    });

    it('N=1 should place single entry anywhere in the full circle', () => {
      const singleQuadrant: QuadrantConfig[] = [{ id: 'q_only', name: 'Everything', order: 0 }];
      const entries = [makeEntry({ id: 1, quadrantId: 'q_only', ring: 'Adopt' })];
      const result = calculateRadarPositions(entries, singleQuadrant, RINGS);

      expect(result.size).toBe(1);
      const pos = result.get('1-q_only-Adopt');
      expect(pos).toBeDefined();
    });
  });
});
