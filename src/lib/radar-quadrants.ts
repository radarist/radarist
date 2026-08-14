/**
 * @file lib/radar-quadrants.ts
 * @description Shared resolver for a radar's `QuadrantConfig[]` with a narrow
 * defensive fallback for the pre-migration transition window.
 *
 * Post-migration every radar stores `quadrants: QuadrantConfig[]`. This helper
 * is the canonical read path used by every render surface (main radar page,
 * public share page, dashboard, share visualization, share report) so that
 * "what's the current radar's quadrant list" is answered in exactly one place.
 *
 * Legacy radar documents may still contain `quadrants: string[]`.
 * The `legacy` branch below synthesizes a config list with `legacy-<i>` ids so
 * rendering does not crash. Remove the branch after legacy records are no
 * longer accepted.
 */

import { isQuadrantConfig, type QuadrantConfig, type RadarData } from '@/lib/types';
import { buildDefaultQuadrantConfigs } from '@/lib/constants';

/**
 * Return the canonical `QuadrantConfig[]` for a radar, synthesizing a
 * legacy-shape fallback only when the radar still carries `quadrants: string[]`.
 *
 * Contract:
 * - `radar == null` or `radar.quadrants` empty → `buildDefaultQuadrantConfigs()`
 * - `radar.quadrants[0]` is already a `QuadrantConfig` → return as-is
 * - otherwise → synthesize `{ id: 'legacy-<i>', name, order: i }` with a dev-only warning
 */
export function resolveQuadrantConfigs(
  radar: Pick<RadarData, 'id' | 'quadrants'> | null | undefined
): QuadrantConfig[] {
  if (!radar) return buildDefaultQuadrantConfigs();

  const raw = radar.quadrants;
  if (!Array.isArray(raw) || raw.length === 0) {
    return buildDefaultQuadrantConfigs();
  }

  // Canonical shape: already QuadrantConfig[]
  if (isQuadrantConfig(raw[0])) {
    return raw as QuadrantConfig[];
  }

  // Legacy transition branch — remove after Phase 12 verification per plan open item #13.
  //
  // At the type level this branch is unreachable (the canonical `RadarData.quadrants`
  // is `QuadrantConfig[]` and the first-element check above narrows it). It exists only
  // as a runtime defensive guard for Firestore docs that still carry `string[]` during
  // the pre-migration window. The explicit `as unknown` cast is deliberate.
  if (process.env.NODE_ENV !== 'production') {

    console.warn('[resolveQuadrantConfigs] Radar has legacy string[] quadrants — run the migration script.', {
      radarId: radar.id,
    });
  }
  const legacyNames = raw as unknown as string[];
  return legacyNames.map((name, order) => ({
    id: `legacy-${order}`,
    name,
    order,
  }));
}

/**
 * Resolve the display label for a radar entry's quadrant from the radar's
 * CURRENT quadrant configuration, by stable ID (UX-043).
 *
 * The stable-ID lookup wins so renames and reorders surface immediately and
 * always agree with the canvas (which renders from the same live config).
 * Bounded fallback, in order, for entries the current config cannot resolve:
 * 1. `entry.quadrantName` — the adapter-denormalized name (legacy entries and
 *    the brief window after a quadrant deletion moves placements),
 * 2. `entry.quadrantId` — last-resort raw identifier, never an invented name.
 */
export function resolveEntryQuadrantLabel(
  quadrants: readonly QuadrantConfig[],
  entry: { quadrantId?: string; quadrantName?: string }
): string {
  if (entry.quadrantId) {
    const hit = quadrants.find((quadrant) => quadrant.id === entry.quadrantId);
    if (hit) return hit.name;
  }
  return entry.quadrantName || entry.quadrantId || '';
}
