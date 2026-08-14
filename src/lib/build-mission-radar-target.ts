/**
 * @file build-mission-radar-target.ts
 * @description Resolve which radar + quadrant an evaluation's RadarPlacement
 * should target. Null-and-defer: when nothing resolves, the proposed Assessment
 * carries no target and the reviewer picks at approval. Under autopilot a target
 * MUST fully resolve (radar + quadrant) or the placement can't be auto-applied.
 *
 * Server-only (admin reads). Resolution order for the radar:
 *   0. the technology's EXISTING placement — an evaluation of a tracked tech
 *      should move its current blip, not spawn a duplicate elsewhere
 *   1. config.build.defaultRadarId (the autopilot default)
 *   2. the sole radar, if exactly one exists
 *   3. undefined → reviewer picks
 * Quadrant (only when it falls through to a config/sole radar): match
 * technology.category to a quadrant name (case-insensitive), else the first
 * quadrant by order. An existing placement carries its own quadrant, so step 0
 * keeps the tech in the quadrant it already occupies.
 */
import 'server-only';

import { db } from '@/lib/firebase-admin';
import { config } from '@/lib/config';
import { adminGetAllRadars, adminGetRadarById } from '@/lib/radars-admin';
import { adminGetPlacementsForTechnology } from '@/lib/radar-placement-admin';
import { createLogger } from '@/lib/logger';
import type { SupportedEntityType } from '@/lib/schemas/proposed-entity';

const log = createLogger('build-mission-radar-target');

export interface RadarTarget {
  radarId?: string;
  quadrantId?: string;
}

export interface ResolvedRadarTarget extends RadarTarget {
  radarId: string;
  quadrantId: string;
}

export async function resolveRadarTarget(
  sourceEntityId: string,
  entityType: SupportedEntityType = 'technology'
): Promise<RadarTarget> {
  // A RadarPlacement is a technology concept; other entity types defer (null-and-defer).
  if (entityType !== 'technology') return {};
  const technologyId = sourceEntityId;
  try {
    // 0 — prefer where the technology already lives. An evaluation of a tracked
    // tech should MOVE its existing blip (its ring is updated on approval), not
    // resolve to the config-default radar and create a duplicate placement. When
    // it sits on several radars, the most-recently-touched one wins. A lookup
    // failure is non-fatal: fall through to the config/sole-radar path below.
    try {
      const placements = await adminGetPlacementsForTechnology(technologyId);
      const latest = placements
        .filter((p) => p.radarId && p.quadrantId)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
      if (latest) return { radarId: latest.radarId, quadrantId: latest.quadrantId };
    } catch (placementError) {
      log.warn('existing-placement lookup failed — falling back to config radar', {
        technologyId,
        error: placementError instanceof Error ? placementError.message : String(placementError),
      });
    }

    // 1/2/3 — the tech isn't placed yet: pick the radar from config.
    let radarId = config.build.defaultRadarId;
    if (!radarId) {
      const radars = await adminGetAllRadars();
      if (radars.length === 1) radarId = radars[0].id;
    }
    if (!radarId) return {};

    const radar = await adminGetRadarById(radarId);
    if (!radar) {
      log.warn('configured radar not found — deferring to reviewer', { radarId });
      return {};
    }

    // Quadrant: match the technology's category to a quadrant name, else first.
    let category: string | undefined;
    try {
      const techSnap = await db.collection('technologies').doc(technologyId).get();
      category = (techSnap.data()?.category as string | undefined)?.toLowerCase();
    } catch {
      /* category is a nicety; fall through to the first quadrant */
    }

    const quadrants = radar.quadrants ?? [];
    const matched = category
      ? quadrants.find((q) => q.name.toLowerCase() === category || q.name.toLowerCase().includes(category!))
      : undefined;
    const quadrant = matched ?? [...quadrants].sort((a, b) => a.order - b.order)[0];

    return { radarId, quadrantId: quadrant?.id };
  } catch (error) {
    log.warn('radar-target resolution failed — deferring to reviewer', {
      technologyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * Autopilot may auto-apply an assessment ONLY when a RadarPlacement can actually
 * be created — i.e. BOTH the radar and quadrant resolved. When the target is
 * partial or empty (the common default-config case), the assessment must stay
 * `proposed` for human triage: auto-approving it would flip it to `approved`
 * with no placement AND record a false "approved" learning signal for a
 * placement that never happened.
 */
export function canAutopilotApplyAssessment(target: RadarTarget): target is ResolvedRadarTarget {
  return Boolean(target.radarId && target.quadrantId);
}
