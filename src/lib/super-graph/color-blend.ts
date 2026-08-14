/**
 * @file lib/super-graph/color-blend.ts
 * @description Shared predicate for token-DERIVED colors.
 *
 * ECharts legitimately synthesizes colors the option never states literally:
 * a continuous visualMap interpolates linearly in RGB between the `inRange`
 * stops (risk-matrix ramp, calendar-heatmap ramp). Those interpolants are
 * brand-derived — flattening them to neutrals (what the palette sweep used to
 * do) or flagging them off-token (what the evaluator used to do) destroys the
 * data encoding the chart exists to show.
 *
 * A color is considered token-derived when it sits, within a small per-channel
 * tolerance, on the straight RGB segment between TWO colors of the allow set.
 * Exact allow-set members trivially satisfy this (t = 0 against any pair).
 */

/** Parse #rgb/#rrggbb (case-insensitive) to RGB channels; null otherwise. */
export function parseHexColor(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) {
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  }
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) {
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return null;
}

/** Per-channel tolerance for "sits on the segment" — covers zrender rounding. */
const BLEND_TOLERANCE = 10;

/**
 * True when `hex` is (within tolerance) a linear RGB blend `a + t·(b − a)`,
 * t ∈ [0, 1], of two colors in `allowRgb`. Pass the PARSED allow set — call
 * sites hold it in a stable order; pairs are O(n²) over ~14 entries.
 */
export function isTokenBlend(hex: string, allowRgb: Array<[number, number, number]>): boolean {
  const c = parseHexColor(hex);
  if (!c) return false;
  for (let i = 0; i < allowRgb.length; i++) {
    for (let j = i; j < allowRgb.length; j++) {
      const a = allowRgb[i];
      const b = allowRgb[j];
      // Least-squares t for c ≈ a + t(b − a), clamped to the segment.
      let num = 0;
      let den = 0;
      for (let k = 0; k < 3; k++) {
        const d = b[k] - a[k];
        num += (c[k] - a[k]) * d;
        den += d * d;
      }
      const t = den === 0 ? 0 : Math.min(1, Math.max(0, num / den));
      let ok = true;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(a[k] + t * (b[k] - a[k]) - c[k]) > BLEND_TOLERANCE) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
  }
  return false;
}
