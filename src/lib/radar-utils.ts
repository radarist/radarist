/**
 * @file radar-utils.ts
 * @description Pure geometry and force-directed layout helpers for the Radar.
 *
 * Variable-quadrants model (1..8 per radar):
 *   Slices are uniform. Each slice is `360° / N` wide. The FIRST DIVIDER always
 *   sits at math-space 90° (screen top / 12 o'clock), subsequent dividers
 *   advance clockwise by `360° / N`, and slice `i` is the arc BETWEEN divider
 *   `i` and divider `i+1`. This matches the classic Tech Radar convention:
 *
 *     N=4 → dividers at (top, right, bottom, left) = (90°, 0°, 270°, 180°)
 *           slice centers at (top-right, bottom-right, bottom-left, top-left)
 *                            = (45°, -45°, -135°, 135°) = (45°, 315°, 225°, 135°)
 *     N=3 → dividers at (90°, 330°, 210°); slices centered at (30°, 270°, 150°)
 *     N=2 → divider at top and bottom (one vertical line); slices at right (0°)
 *           and left (180°)
 *     N=1 → no dividers; single slice covers 0°..360°, label positioned at top
 *
 *   Formula (math-space degrees):
 *     dividerStep(N)    = 360 / N
 *     halfWidth(N)      = 180 / N
 *     divider_j         = 90° - j * dividerStep(N)            (mod 360)
 *     slice_i center    = divider_i - halfWidth(N)            (mod 360)
 *                       = 90° - (i + 0.5) * dividerStep(N)    (mod 360)
 *     slice_i min / max = center ± halfWidth                  (mod 360)
 */

import { RadarEntry, QuadrantConfig, Ring } from './types';
import { MAX_BLIP_RADIUS } from './constants';
import { seedrandom } from './seedrandom';

/**
 * Represents a point in 2D Cartesian space.
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * Represents a point in Polar coordinates.
 */
export interface PolarPoint {
  r: number;
  theta: number; // radians
}

// Configuration for the simulation
const SIMULATION_ITERATIONS = 150;
const COLLISION_THRESHOLD = 4; // Approximate diameter of a blip in % coordinates (0-100 scale)
const REPULSION_STRENGTH = 0.5;

/**
 * Converts polar coordinates (radius, angle) to Cartesian coordinates (x, y).
 *
 * @param r - The radius.
 * @param theta - The angle in radians.
 * @returns A point in Cartesian space.
 */
export const polarToCartesian = (r: number, theta: number): Point => {
  return {
    x: r * Math.cos(theta),
    y: r * Math.sin(theta),
  };
};

/**
 * Converts Cartesian coordinates (x, y) to polar coordinates (radius, angle).
 *
 * @param x - The x-coordinate.
 * @param y - The y-coordinate.
 * @returns A point in Polar coordinates (r, theta).
 */
export const cartesianToPolar = (x: number, y: number): PolarPoint => {
  const r = Math.sqrt(x * x + y * y);
  let theta = Math.atan2(y, x);
  if (theta < 0) theta += 2 * Math.PI;
  return { r, theta };
};

/**
 * Shape returned by `getQuadrantAnglesByOrder`.
 * All angles are in math-space degrees (0 = right, 90 = top, 180 = left, 270 = bottom).
 */
export interface SliceAngles {
  /** Counter-clockwise edge of the slice, in degrees (mod 360). */
  min: number;
  /** Clockwise edge of the slice, in degrees (mod 360). */
  max: number;
  /** Centerline of the slice, in degrees (0..360). */
  center: number;
  /** Half-width in degrees (equal to 180 / N). */
  halfWidth: number;
}

/**
 * Compute the angular boundaries of slice `order` in a uniform N-slice layout.
 *
 * The first divider sits at math 90° (screen top); dividers advance clockwise
 * by `360° / N`. Slice `i` is the arc BETWEEN divider `i` and divider `i+1`,
 * centered halfway between them. `count` is clamped to [1, 8].
 *
 * N=1 is a degenerate case: the whole circle is one slice. `center` is 90°
 * (top) so that the single label sits at 12 o'clock, matching every other N.
 *
 * @param order - Zero-indexed slice position.
 * @param count - Total number of slices (1..8).
 * @returns The slice's angular boundaries in math-space degrees.
 */
export function getQuadrantAnglesByOrder(order: number, count: number): SliceAngles {
  const N = Math.max(1, Math.min(8, count));

  if (N === 1) {
    // Whole circle: min/max cover everything, center sits at top so the label
    // anchors above center consistently with every other N.
    return { min: 0, max: 360, center: 90, halfWidth: 180 };
  }

  const dividerStep = 360 / N;
  const halfWidth = 180 / N;
  // Slice center: start at 90° (top divider), step CLOCKWISE (decreasing math
  // angle) past `order` full divider gaps plus a half-gap so the slice sits
  // between dividers instead of on top of them.
  const center = (((90 - (order + 0.5) * dividerStep) % 360) + 360) % 360;
  const min = (center - halfWidth + 360) % 360;
  const max = (center + halfWidth + 360) % 360;
  return { min, max, center, halfWidth };
}

/**
 * Calculates the radial boundaries (min, max radius) for a given ring.
 *
 * @param ring - The ring to get radii for.
 * @param rings - The ordered list of all rings.
 * @returns An object containing `min` and `max` radii.
 */
export const getRingRadii = (ring: Ring, rings: string[]) => {
  const ringIndex = rings.indexOf(ring);
  const segmentSize = MAX_BLIP_RADIUS / rings.length;
  return {
    min: ringIndex * segmentSize,
    max: (ringIndex + 1) * segmentSize,
  };
};

/**
 * CSS-ready position for a quadrant label sitting just outside the outermost
 * ring, returned by `getQuadrantLabelPosition`.
 *
 * The label is anchored on the ring edge and pushed outward by 50% of its
 * OWN size in the radial direction — the `transform` field encodes that
 * offset. Consumers apply the transform verbatim (no extra `translate`) so
 * the label's INNER edge sits on the ring and it grows outward into the
 * outer-container padding zone.
 */
export interface QuadrantLabelPosition {
  /** CSS `top` as a percentage of the container (positioning anchor). */
  top: string;
  /** CSS `left` as a percentage of the container (positioning anchor). */
  left: string;
  /** How the text copy should be aligned within its block. */
  textAlign: 'left' | 'center' | 'right';
  /**
   * CSS `transform` string that offsets the label by half its own size
   * OUTWARD from the anchor (so the label's inner edge touches the ring edge
   * and it extends into the padding zone).
   */
  transform: string;
}

/**
 * Compute CSS `top`/`left`/`transform` for a quadrant label placed on the
 * radar's outermost ring edge at the given slice's center angle. The
 * transform uses **octant-based corner/edge anchoring** so the label's inner
 * edge or corner (whichever is closest to the center) lines up with the
 * anchor, regardless of the label's aspect ratio.
 *
 * Anchor is placed at radius `outerRadiusPct` (default 52 — 2 percentage
 * points beyond the ring edge at radius 50) to leave a small visual gap
 * between the ring stroke and the label text.
 *
 * Octant map (screen angle from top, clockwise):
 *
 *   0 top          → translate(-50%, -100%)   bottom-edge at anchor
 *   1 top-right    → translate(  0%, -100%)   bottom-left corner at anchor
 *   2 right        → translate(  0%,  -50%)   left-edge at anchor
 *   3 bottom-right → translate(  0%,    0%)   top-left corner at anchor
 *   4 bottom       → translate(-50%,    0%)   top-edge at anchor
 *   5 bottom-left  → translate(-100%,   0%)   top-right corner at anchor
 *   6 left         → translate(-100%, -50%)   right-edge at anchor
 *   7 top-left     → translate(-100%, -100%)  bottom-right corner at anchor
 *
 * This guarantees a wide label at a diagonal angle (e.g. N=4 top-right) has
 * its inner CORNER on the ring edge, not its geometric center projected
 * outward — which was the old formula's bug for rectangular labels.
 *
 * Worked examples:
 *
 *   N=4, slice 0 → center=45° math → screen top-right → octant 1
 *     anchor: top="12.18%", left="87.82%"   (radius 52, not 50)
 *     transform: "translate(0%, -100%)"     (BL corner at anchor)
 *     textAlign: "left"                      (text flows right)
 *
 *   N=2, slice 0 → center=0° math → screen right → octant 2
 *     anchor: top="50%", left="102%"
 *     transform: "translate(0%, -50%)"       (left-edge at anchor)
 *     textAlign: "left"
 *
 *   N=1, slice 0 → center=90° math → screen top → octant 0
 *     anchor: top="-2%", left="50%"
 *     transform: "translate(-50%, -100%)"    (bottom-edge at anchor)
 *     textAlign: "center"
 */
export function getQuadrantLabelPosition(
  order: number,
  count: number,
  outerRadiusPct: number = 52
): QuadrantLabelPosition {
  const { center } = getQuadrantAnglesByOrder(order, count);
  const rad = (center * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // Anchor point on (or just beyond) the ring edge.
  const left = 50 + cos * outerRadiusPct;
  const top = 50 - sin * outerRadiusPct;

  // Screen angle measured from top (0 = top, 90 = right, 180 = bottom, 270 = left)
  const screenAngle = (((90 - center) % 360) + 360) % 360;

  // Octant index 0..7 starting at top, advancing clockwise. Each octant spans
  // 45° and is centered on one of the 8 compass directions.
  //   0 = top (screenAngle in [337.5, 22.5))
  //   1 = top-right (screenAngle in [22.5, 67.5))
  //   2 = right (screenAngle in [67.5, 112.5))
  //   ... and so on
  const octant = Math.floor(((screenAngle + 22.5) % 360) / 45);

  // Transform offsets (as %-of-label): each entry places the label's inner
  // edge or corner at the anchor, depending on the octant.
  const OCTANT_TRANSFORMS: Array<{ tx: number; ty: number }> = [
    { tx: -50, ty: -100 }, // 0 top — bottom-edge at anchor
    { tx: 0, ty: -100 }, //   1 top-right — bottom-left corner
    { tx: 0, ty: -50 }, //    2 right — left-edge
    { tx: 0, ty: 0 }, //      3 bottom-right — top-left corner
    { tx: -50, ty: 0 }, //    4 bottom — top-edge
    { tx: -100, ty: 0 }, //   5 bottom-left — top-right corner
    { tx: -100, ty: -50 }, // 6 left — right-edge
    { tx: -100, ty: -100 }, // 7 top-left — bottom-right corner
  ];
  const { tx, ty } = OCTANT_TRANSFORMS[octant];

  // Text alignment: right-half labels read left-to-right starting from the
  // anchor; left-half labels read the other way. A 20° band around top/bottom
  // keeps straight-up/down labels centered.
  let textAlign: 'left' | 'center' | 'right' = 'center';
  if (screenAngle > 20 && screenAngle < 160) {
    textAlign = 'left';
  } else if (screenAngle > 200 && screenAngle < 340) {
    textAlign = 'right';
  }

  return {
    top: `${top}%`,
    left: `${left}%`,
    textAlign,
    transform: `translate(${tx}%, ${ty}%)`,
  };
}

/**
 * Compute the SVG `(x1, y1, x2, y2)` segment for divider line `index`. There
 * are `count` dividers total (one per slice boundary) and they are laid out
 * starting at math 90° (screen top) and advancing clockwise by `360° / count`.
 *
 * Returns `null` for `count < 2` (a single-slice radar has no dividers).
 *
 * Worked examples:
 *   count=2: dividers at (top, bottom)             — one vertical line total
 *   count=3: dividers at (top, lower-right, lower-left)
 *   count=4: dividers at (top, right, bottom, left) — cardinal cross
 *   count=6: dividers at every 60° starting from top
 *
 * SVG coordinates are in the 0..100 space with center at (50, 50).
 */
export function getSliceDividerSegment(
  index: number,
  count: number
): { x1: number; y1: number; x2: number; y2: number } | null {
  if (count < 2) return null;
  const N = Math.max(1, Math.min(8, count));
  const dividerStep = 360 / N;
  const mathDeg = (((90 - index * dividerStep) % 360) + 360) % 360;
  const rad = (mathDeg * Math.PI) / 180;
  const x2 = 50 + Math.cos(rad) * 50;
  // SVG y is inverted, so subtract sin * 50 from center-y
  const y2 = 50 - Math.sin(rad) * 50;
  return { x1: 50, y1: 50, x2, y2 };
}

/**
 * Calculates the display positions for radar entries using a force-directed layout simulation.
 * This ensures that blips are positioned within their correct sectors (quadrant/ring) and
 * do not overlap excessively.
 *
 * Accepts the radar's canonical `QuadrantConfig[]` (not legacy string names).
 * Each entry's `quadrantId` is looked up in the config array to determine its
 * `order`, which drives the slice angles via `getQuadrantAnglesByOrder`.
 *
 * Defensive guard: if an entry's `quadrantId` is not present in the config
 * (data corruption / partial sync), the entry is placed in slice 0 with an
 * error log — per plan "Fallback / defensive-guard stance".
 *
 * @param entries - The list of radar entries to position.
 * @param quadrantConfigs - The radar's canonical quadrant config list (1..8 entries).
 * @param rings - The ordered list of rings.
 * @param seedPrefix - An optional seed prefix for the random number generator to ensure determinism.
 * @returns A Map where the key is a composite string (`${id}-${quadrantId}-${ring}`) and the value is the CSS position (`top`, `left` in percentages).
 */
export const calculateRadarPositions = (
  entries: RadarEntry[],
  quadrantConfigs: QuadrantConfig[],
  rings: string[],
  seedPrefix: string = ''
): Map<string, { top: string; left: string }> => {
  const positions = new Map<string, Point>();
  const entryMap = new Map<string, RadarEntry>();
  const N = Math.max(1, quadrantConfigs.length);

  // Build an id → order lookup once per call
  const orderByQuadrantId = new Map<string, number>();
  quadrantConfigs.forEach((c, i) => orderByQuadrantId.set(c.id, i));

  // Angle buffer scales with slice width: ~1/10 of the slice, clamped at 2°
  // (the old fixed default). For N=1 the buffer must be 0 or the sim can't
  // place anything.
  const angleBuffer = N === 1 ? 0 : Math.min(2, 360 / N / 10);

  const resolveOrder = (entry: RadarEntry): number => {
    const hit = orderByQuadrantId.get(entry.quadrantId);
    if (hit !== undefined) return hit;
    // Defensive guard: an entry references a quadrantId that isn't in the
    // radar's current configs. Callers (notably `Radar.tsx`) filter stale
    // entries out BEFORE calling us, so reaching this branch means either
    // (a) a caller bypassed the filter, or (b) the data is genuinely
    // inconsistent. We silently degrade to slice 0 to keep the blip
    // visible — loud logging from here created noise during the normal
    // settings-save race window, where the decoupled hook's placement
    // cache briefly held stale quadrantIds while the subscription caught
    // up. If a true inconsistency is suspected, run the verification
    // step in `scripts/migrate-radar-quadrants.ts` which asserts every
    // placement's `quadrantId` matches its radar's configs.
    return 0;
  };

  // 1. Initial Random Placement
  entries.forEach((entry) => {
    const key = entry.id.toString();
    entryMap.set(key, entry);

    const rng = seedrandom(seedPrefix + entry.id.toString() + entry.quadrantId + entry.ring);

    const order = resolveOrder(entry);
    const angles = getQuadrantAnglesByOrder(order, N);
    const radii = getRingRadii(entry.ring, rings);

    // For N=1 the slice spans the whole circle; sample uniformly in [0, 360)
    // instead of going through the wrap-around bookkeeping below.
    let angleDeg: number;
    if (N === 1) {
      angleDeg = rng() * 360;
    } else {
      // Add buffers and handle wrap-around by working around the slice center
      const halfWidth = angles.halfWidth - angleBuffer;
      // Pick a delta uniformly in [-halfWidth, halfWidth], then rebuild
      const delta = (rng() * 2 - 1) * halfWidth;
      angleDeg = (((angles.center + delta) % 360) + 360) % 360;
    }

    const radiusMin = radii.min + 1; // Small buffer
    const radiusMax = radii.max - 1;
    const radius = radiusMin + rng() * (radiusMax - radiusMin);
    const angleRad = (angleDeg * Math.PI) / 180;

    positions.set(key, polarToCartesian(radius, angleRad));
  });

  // 2. Force-Directed Simulation
  for (let i = 0; i < SIMULATION_ITERATIONS; i++) {
    const forces = new Map<string, Point>();

    // Initialize forces
    entries.forEach((e) => forces.set(e.id.toString(), { x: 0, y: 0 }));

    // Calculate Repulsion
    for (let j = 0; j < entries.length; j++) {
      for (let k = j + 1; k < entries.length; k++) {
        const id1 = entries[j].id.toString();
        const id2 = entries[k].id.toString();
        const p1 = positions.get(id1)!;
        const p2 = positions.get(id2)!;

        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const distSq = dx * dx + dy * dy;
        const dist = Math.sqrt(distSq);

        if (dist < COLLISION_THRESHOLD && dist > 0) {
          const force = (COLLISION_THRESHOLD - dist) * REPULSION_STRENGTH;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          const f1 = forces.get(id1)!;
          const f2 = forces.get(id2)!;

          forces.set(id1, { x: f1.x + fx, y: f1.y + fy });
          forces.set(id2, { x: f2.x - fx, y: f2.y - fy });
        }
      }
    }

    // Apply Forces and Clamp
    entries.forEach((entry) => {
      const id = entry.id.toString();
      const p = positions.get(id)!;
      const f = forces.get(id)!;

      const newX = p.x + f.x;
      const newY = p.y + f.y;

      // Convert to Polar to check constraints
      const polar = cartesianToPolar(newX, newY);
      let r = polar.r;
      let thetaDeg = (polar.theta * 180) / Math.PI;

      const order = resolveOrder(entry);
      const angles = getQuadrantAnglesByOrder(order, N);
      const radii = getRingRadii(entry.ring, rings);

      // Clamp Radius
      // Ensure we don't push it out of its ring
      // Increase buffer to 5 to account for blip size (approx 2.5% radius)
      const radiusBuffer = 4;
      if (r < radii.min + radiusBuffer) r = radii.min + radiusBuffer;
      if (r > radii.max - radiusBuffer) r = radii.max - radiusBuffer;

      // Clamp Angle
      // Normalize thetaDeg to 0-360
      if (thetaDeg < 0) thetaDeg += 360;

      // For N=1 the slice is the full circle → angle clamping is a no-op
      if (N !== 1) {
        // Handle wrap-around clamping by working with the delta from the slice center.
        let delta = thetaDeg - angles.center;
        // Normalize delta to [-180, 180]
        while (delta <= -180) delta += 360;
        while (delta > 180) delta -= 360;

        // Allowed half-width (accounts for the buffer so blips don't touch the divider)
        const halfWidth = angles.halfWidth - angleBuffer;

        if (delta < -halfWidth) delta = -halfWidth;
        if (delta > halfWidth) delta = halfWidth;

        thetaDeg = angles.center + delta;

        // Normalize back to 0-360
        if (thetaDeg < 0) thetaDeg += 360;
        if (thetaDeg >= 360) thetaDeg -= 360;
      }

      // Convert back to Cartesian
      const newTheta = (thetaDeg * Math.PI) / 180;
      const clampedP = polarToCartesian(r, newTheta);

      positions.set(id, clampedP);
    });
  }

  // 3. Convert to CSS %
  const finalPositions = new Map<string, { top: string; left: string }>();
  entries.forEach((entry) => {
    const p = positions.get(entry.id.toString())!;
    // Cartesian center is (0,0). SVG center is (50, 50). Radius is 0..100, so divide by 2.
    const left = 50 + p.x / 2;
    const top = 50 - p.y / 2;

    finalPositions.set(`${entry.id}-${entry.quadrantId}-${entry.ring}`, {
      left: `${left}%`,
      top: `${top}%`,
    });
  });

  return finalPositions;
};
