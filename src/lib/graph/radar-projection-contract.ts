import { toMillis } from '@/lib/inngest/utils';
import { resolveQuadrantConfigs } from '@/lib/radar-quadrants';
import type { RadarData } from '@/lib/types';

export interface RadarGraphProjectionProperties extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  ringSystem: RadarData['ringSystem'] | 'Standard';
  quadrantIds: string[];
  quadrantNames: string[];
  quadrantCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Canonical Firestore Radar -> Neo4j property mapping used by writers and repair review. */
export function buildRadarGraphProjectionProperties(radar: RadarData): RadarGraphProjectionProperties {
  const updatedAt = toMillis(radar.updatedAt, toMillis(radar.createdAt, 0));
  const quadrants = resolveQuadrantConfigs(radar);
  return {
    id: radar.id,
    name: radar.name,
    slug: radar.slug ?? null,
    description: radar.description ?? null,
    ringSystem: radar.ringSystem ?? 'Standard',
    quadrantIds: quadrants.map((quadrant) => quadrant.id),
    quadrantNames: quadrants.map((quadrant) => quadrant.name),
    quadrantCount: quadrants.length,
    createdAt: toMillis(radar.createdAt, updatedAt),
    updatedAt,
  };
}
