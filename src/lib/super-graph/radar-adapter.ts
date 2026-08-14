/**
 * @file super-graph/radar-adapter.ts
 * @description Pure mapping from a radar's graph data (config + placed
 * technologies) to the `TechRadarData` payload the diagrammer's tech-radar
 * template consumes.
 *
 * Backlog 3.5: previously the only way to render a radar diagram was for the
 * LLM to hand-author the `{quadrants,rings,items}` JSON from a getRadarDetails
 * dump — a transcription/hallucination surface. This adapter builds that
 * payload deterministically from the same data the live radar UI uses, so the
 * `renderRadarDiagram` tool produces a data-bound, reproducible chart.
 *
 * Pure + dependency-free (no SDK, no I/O) so it is trivially unit-testable; the
 * caller fetches the radar + placements (admin SDK, server-side) and passes
 * them in.
 */

import { TechRadarData, type TechRadarPayload } from './schemas/tech-radar';
import type { RadarData, TechnologyWithPlacement } from '@/lib/types';

/** Standard adoption rings (innermost → outermost) when a radar defines none. */
export const DEFAULT_RINGS = ['Adopt', 'Trial', 'Assess', 'Hold'];

/** TechRadarData caps items at 120; we slice and flag truncation. */
const MAX_ITEMS = 120;

export interface RadarDiagramAdapterResult {
  payload: TechRadarPayload;
  itemCount: number;
  truncated: boolean;
}

/**
 * Map a radar + its placed technologies to a validated `TechRadarData` payload.
 *
 * @throws ZodError if the result violates TechRadarData bounds (e.g. zero
 *   placed technologies → items.min(1)). Callers should guard the empty case
 *   and surface a friendly message rather than rendering an empty radar.
 */
export function buildRadarDiagramPayload(
  radar: Pick<RadarData, 'name' | 'quadrants' | 'ringConfigs'>,
  technologies: TechnologyWithPlacement[]
): RadarDiagramAdapterResult {
  // Rings, innermost-first: prefer the radar's own ringConfigs (sorted by
  // order); else the standard Adopt/Trial/Assess/Hold. Clamp to TechRadarData's
  // 2..5 bound (a single configured ring is unusable → fall back to standard).
  const ringConfigs = (radar.ringConfigs ?? []).slice().sort((a, b) => a.order - b.order);
  const rings = (ringConfigs.length >= 2 ? ringConfigs.map((r) => r.name) : DEFAULT_RINGS).slice(0, 5);

  // A placement's `ring` may hold a ringConfig id OR an already-resolved name;
  // map ids → names, leave names untouched.
  const ringNameById = new Map(ringConfigs.map((r) => [r.id, r.name]));
  const ringNameFor = (ring: string): string => ringNameById.get(ring) ?? ring;
  // Index for movement direction (lower index = more inner = "in").
  const ringIndex = new Map(rings.map((name, i) => [name, i] as const));

  const quadrants = radar.quadrants.map((q) => ({ id: q.id, name: q.name, order: q.order }));

  const allItems = technologies.map((t) => {
    const ring = ringNameFor(t.placement.ring);
    let movement: 'stable' | 'in' | 'out' = 'stable';
    if (t.placement.movedFrom) {
      const from = ringNameFor(t.placement.movedFrom);
      const to = ringIndex.get(ring);
      const prev = ringIndex.get(from);
      if (to !== undefined && prev !== undefined && to !== prev) {
        movement = to < prev ? 'in' : 'out';
      }
    }
    return { name: t.name, quadrantId: t.placement.quadrantId, ring, movement };
  });

  const truncated = allItems.length > MAX_ITEMS;
  const items = allItems.slice(0, MAX_ITEMS);

  const payload = TechRadarData.parse({ quadrants, rings, items, title: radar.name });
  return { payload, itemCount: items.length, truncated };
}
