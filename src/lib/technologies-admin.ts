/**
 * @file technologies-admin.ts
 * @description Admin-SDK twin of the RADAR-AWARE technology view adapter
 * `@/lib/technologies` (`getTechnologies`). Provides
 * `adminGetTechnologiesWithRadar`, returning the SAME `TechnologiesResult`
 * shape (`{ technologies: TechnologyWithRadar[], radarsMap }`) by joining the
 * decoupled `technologies` + `radarPlacements` + `radars` collections.
 *
 * WHY: `@/lib/technologies` is a Firebase CLIENT-SDK module (`firebase/firestore`
 * + `@/lib/firebase`) — its `getDocs` and the `radar-placement-service`
 * client-SDK reads it chains into all use the client SDK. When that adapter
 * runs server-side (inside the `/api/ai/chat` tool executor —
 * `tools.ts:executeGetRelatedEntities`, the `src/app/api/search` route, or the
 * `page-research` AI tool — against PRODUCTION) the client SDK has no
 * persistent connection and either throws `FIRESTORE INTERNAL ASSERTION
 * FAILED a540` or returns `code: 'unavailable'` (the same failure mode
 * `entity-factory-admin.ts` / `signals-admin.ts` / `technology-admin.ts`
 * exist to avoid).
 *
 * This is a pure JOIN READ (no writes, no sync), so unlike `technology-admin.ts`
 * there is no transaction or Inngest event to replicate. The module re-uses the
 * EXACT transform + filter logic from `@/lib/technologies` (the `transform…` and
 * `applyFilters` helpers are pure and copied verbatim), reads the same three
 * collections via the admin SDK, and resolves the per-technology documents
 * through `adminGetTechnologyById` (from `technology-admin.ts`) so the two paths
 * can never drift in shape, dedupe, denormalization, or filtering.
 *
 * The exported `TechnologyWithRadar`, `TechnologiesResult`, and
 * `TechnologyFilters` types are re-exported from `@/lib/technologies` so callers
 * importing from here get the identical contract.
 *
 * @author Radarist Team
 * @created 2026-06-06
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { adminGetTechnologyById } from '@/lib/technology-admin';
import { createLogger } from '@/lib/logger';
import type { Technology, TechnologyWithPlacement } from '@/lib/types';
import type { TechnologiesResult, TechnologyFilters, TechnologyWithRadar } from '@/lib/technologies';

// Re-export the view-model contract so admin callers import the identical types.
export type { TechnologiesResult, TechnologyFilters, TechnologyWithRadar } from '@/lib/technologies';

const log = createLogger('technologies-admin');

/** Firestore collection name for radar placements — mirrors radar-placement-service.COLLECTION_NAME. */
const PLACEMENTS_COLLECTION = 'radarPlacements';
/** Firestore collection name for radars. */
const RADARS_COLLECTION = 'radars';

/**
 * Map TimeToImpact enum to display format. Copied verbatim from
 * `@/lib/technologies.mapTimeToImpactDisplay`.
 * H1 → "H1 (0-6mo)", H2 → "H2 (6-18mo)", H3 → "H3 (18+mo)"
 */
function mapTimeToImpactDisplay(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const mapping: Record<string, string> = {
    H1: 'H1 (0-6mo)',
    H2: 'H2 (6-18mo)',
    H3: 'H3 (18+mo)',
  };
  return mapping[value] || undefined;
}

/**
 * Transforms a TechnologyWithPlacement to the legacy TechnologyWithRadar format.
 * Copied verbatim from `@/lib/technologies.transformToTechnologyWithRadar` so
 * the admin path produces byte-identical view models.
 */
function transformToTechnologyWithRadar(
  twp: TechnologyWithPlacement & { radarId: string; radarName: string },
  quadrantName: string
): TechnologyWithRadar {
  const { placement } = twp;

  // Cast through `unknown` to handle id type change (string vs number).
  const transformed = {
    id: twp.id as unknown as number,
    name: twp.name,
    description: twp.description || '',
    quadrantId: placement.quadrantId,
    quadrantName,
    ring: placement.ring,
    status: placement.status || 'New',
    tags: twp.tags || [],
    linkedCompanies: twp.linkedCompanies || [],
    linkedUseCases: twp.linkedUseCases || [],
    category: twp.category,
    originalTechId: twp.id,
    trl: twp.trl ? `TRL ${twp.trl}` : undefined,
    timeToImpact: twp.timeToImpact ? mapTimeToImpactDisplay(twp.timeToImpact) : undefined,
    moved: placement.movedFrom ? (placement.ring === 'Adopt' ? 1 : -1) : 0,
    analysis: placement.rationale,
    costToPrototype: placement.trlScore !== undefined ? placement.trlScore * 10 : 50,
    radarId: twp.radarId,
    radarName: twp.radarName,
    history: placement.movedFrom
      ? [
          {
            date: placement.movedAt
              ? new Date(placement.movedAt).toISOString().split('T')[0]
              : new Date().toISOString().split('T')[0],
            ring: placement.ring,
            status: placement.status || 'New',
          },
        ]
      : [],
    deepResearch: twp.deepResearch,
    marketInterest: twp.marketInterest,
    comprehensiveResearch: twp.comprehensiveResearch,
    researchStatus: twp.researchStatus,
    notes: twp.notes,
    websiteUrl: twp.websiteUrl,
    githubUrl: twp.githubUrl,
    documentationUrl: twp.documentationUrl,
  };

  return transformed as TechnologyWithRadar;
}

/**
 * Applies filters to an array of technologies. Copied verbatim from
 * `@/lib/technologies.applyFilters`.
 */
function applyFilters(technologies: TechnologyWithRadar[], filters: TechnologyFilters): TechnologyWithRadar[] {
  let filtered = [...technologies];

  // Search filter (name or description).
  if (filters.search && filters.search.trim()) {
    const searchLower = filters.search.toLowerCase().trim();
    filtered = filtered.filter(
      (tech) => tech.name.toLowerCase().includes(searchLower) || tech.description?.toLowerCase().includes(searchLower)
    );
  }

  // Ring filter.
  if (filters.ring) {
    filtered = filtered.filter((tech) => tech.ring === filters.ring);
  }

  // Quadrant filter — matches by stable `quadrantId`.
  if (filters.quadrantId) {
    filtered = filtered.filter((tech) => tech.quadrantId === filters.quadrantId);
  }

  // Status filter.
  if (filters.status) {
    filtered = filtered.filter((tech) => tech.status === filters.status);
  }

  // Tag filter.
  if (filters.tag) {
    filtered = filtered.filter((tech) => tech.tags?.includes(filters.tag as string));
  }

  // Has relations filter.
  if (filters.hasRelations !== undefined) {
    filtered = filtered.filter((tech) => {
      const hasCompanies = tech.linkedCompanies && tech.linkedCompanies.length > 0;
      const hasUseCases = tech.linkedUseCases && tech.linkedUseCases.length > 0;
      return filters.hasRelations ? hasCompanies || hasUseCases : !(hasCompanies || hasUseCases);
    });
  }

  return filtered;
}

/**
 * Admin-SDK equivalent of the radar-aware join in
 * `radar-placement-service.getAllTechnologiesWithPlacements` — reads all
 * `radarPlacements`, builds a `radarId → name` map from `radars`, resolves each
 * placement's technology via `adminGetTechnologyById` (parallel, deduped by
 * technology id), and combines them into the `TechnologyWithPlacement & {
 * radarId, radarName }` shape. Mirrors the client path exactly: a placement
 * whose technology no longer exists is logged and skipped.
 */
async function adminGetAllTechnologiesWithPlacements(): Promise<
  Array<TechnologyWithPlacement & { radarId: string; radarName: string }>
> {
  // Read all placements.
  const placementsSnap = await db.collection(PLACEMENTS_COLLECTION).get();
  const placements = placementsSnap.docs.map((doc) => ({
    ...doc.data(),
    id: doc.id,
  })) as Array<TechnologyWithPlacement['placement']>;

  // Build radarId → name map from radars.
  const radarsSnap = await db.collection(RADARS_COLLECTION).get();
  const radarNameMap = new Map<string, string>();
  radarsSnap.docs.forEach((doc) => {
    const data = doc.data();
    radarNameMap.set(data.id, data.name || data.id);
  });

  // Fetch all unique technologies in parallel.
  const technologyIds = [...new Set(placements.map((p) => p.technologyId))];
  const technologiesResults = await Promise.all(technologyIds.map((id) => adminGetTechnologyById(id)));

  const technologyMap = new Map<string, Technology | null>();
  technologyIds.forEach((id, index) => {
    technologyMap.set(id, technologiesResults[index]);
  });

  // Combine technologies with placements.
  const results: Array<TechnologyWithPlacement & { radarId: string; radarName: string }> = [];
  for (const placement of placements) {
    const technology = technologyMap.get(placement.technologyId);
    if (!technology) {
      log.warn('Technology not found for placement', { technologyId: placement.technologyId, id: placement.id });
      continue;
    }
    results.push({
      ...technology,
      placement,
      radarId: placement.radarId,
      radarName: radarNameMap.get(placement.radarId) || placement.radarId,
    });
  }

  return results;
}

/**
 * Admin-SDK equivalent of `@/lib/technologies.getTechnologies`. Returns the
 * SAME `TechnologiesResult` shape (`{ technologies, radarsMap }`) and applies
 * the SAME radar metadata map, quadrant-name denormalization, dedupe-by-tech-id,
 * transform, and in-memory filters as the client adapter. Wraps failures in the
 * SAME generic `Error('Failed to fetch technologies')` the client path throws.
 */
export async function adminGetTechnologiesWithRadar(filters: TechnologyFilters = {}): Promise<TechnologiesResult> {
  try {
    // Get all technologies with their placements (admin join).
    const technologiesWithPlacements = await adminGetAllTechnologiesWithPlacements();

    // Build radar metadata map + collect quadrant configs per radar so the
    // adapter can denormalize `quadrantName` without an extra round-trip.
    const radarsMap = new Map<string, { id: string; name: string }>();
    const quadrantNameByRadarIdAndQuadrantId = new Map<string, Map<string, string>>();
    const radarsSnapshot = await db.collection(RADARS_COLLECTION).get();
    radarsSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      radarsMap.set(data.id, { id: data.id, name: data.name });
      const nameById = new Map<string, string>();
      if (Array.isArray(data.quadrants)) {
        for (const q of data.quadrants) {
          if (q && typeof q === 'object' && 'id' in q && 'name' in q) {
            nameById.set(q.id as string, q.name as string);
          }
        }
      }
      quadrantNameByRadarIdAndQuadrantId.set(data.id, nameById);
    });

    // DEDUPLICATE: keep first placement for each unique technology id (matches
    // client path — prevents duplicates when a tech is on multiple radars).
    const techByIdMap = new Map<string, (typeof technologiesWithPlacements)[0]>();
    for (const twp of technologiesWithPlacements) {
      if (!techByIdMap.has(twp.id)) {
        techByIdMap.set(twp.id, twp);
      }
    }

    // Transform UNIQUE technologies to TechnologyWithRadar.
    const technologies: TechnologyWithRadar[] = Array.from(techByIdMap.values()).map((twp) => {
      const quadrantName =
        quadrantNameByRadarIdAndQuadrantId.get(twp.placement.radarId)?.get(twp.placement.quadrantId) ?? '';
      return transformToTechnologyWithRadar(twp, quadrantName);
    });

    return {
      technologies: applyFilters(technologies, filters),
      radarsMap,
    };
  } catch (error) {
    log.error('Error fetching technologies (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to fetch technologies');
  }
}
