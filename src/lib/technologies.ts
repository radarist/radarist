/**
 * @file lib/technologies.ts
 * @description View-model adapter for technologies + radar placement.
 *
 * Joins the canonical decoupled model (`technologies` + `radarPlacements`)
 * into the legacy `TechnologyWithRadar` shape that the library UI still
 * consumes. Radar-coupled CRUD (writes to `radars/{id}/entries`) was deleted
 * in D4.2; for create/update/delete go through `@/lib/technology-service`.
 *
 * @author Radarist Team
 * @created 2025-11-27
 */

import { collection, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { RadarEntryView, Ring, Quadrant, Status, TechnologyWithPlacement } from '@/lib/types';
import { createLogger } from '@/lib/logger';
const log = createLogger('technologies');

/**
 * Extended RadarEntry with radar context and Technology-specific fields for library view.
 *
 * Extends `RadarEntryView` (not `RadarEntry`) so the denormalized
 * `quadrantName` string is always present and render code can read it without
 * a fallback. The adapter `toTechnologyWithRadar` in `technology-adapters.ts`
 * is the single denormalization point.
 *
 * Includes category from the Technology entity (not from RadarPlacement).
 */
export interface TechnologyWithRadar extends RadarEntryView {
  radarId: string;
  radarName: string;
  /** Technology category (from Technology entity, not placement) */
  category?: string;
  /** Original technology ID for reverse lookup */
  originalTechId?: string;
  /** Deep research data (from Technology entity) */
  deepResearch?: import('@/lib/types').DeepResearchData;
  /** Market interest metrics (from Technology entity) */
  marketInterest?: import('@/lib/types').MarketInterest;
  /** Comprehensive research data (12-section AI research) */
  comprehensiveResearch?: import('@/lib/types').TechnologyResearch;
  /** Research status (from Technology entity) */
  researchStatus?: 'idle' | 'pending' | 'completed' | 'failed';
  /** ARUN-028 — set when a completed attempt's snapshot refresh is still pending. */
  pendingSnapshotRefresh?: import('@/lib/types').PendingSnapshotRefresh;
  /** Notes attached to this technology */
  notes?: import('@/lib/types').TechnologyNote[];
  /** Website URL */
  websiteUrl?: string;
  /** GitHub repository URL */
  githubUrl?: string;
  /** Documentation URL */
  documentationUrl?: string;
}

/**
 * Result from getTechnologies including radar metadata
 */
export interface TechnologiesResult {
  technologies: TechnologyWithRadar[];
  radarsMap: Map<string, { id: string; name: string }>;
}

/**
 * Filter options for querying technologies
 */
export interface TechnologyFilters {
  search?: string;
  ring?: Ring | '';
  /** Filter by stable `quadrantId` (from the parent radar's quadrant config). */
  quadrantId?: string | '';
  status?: Status | '';
  tag?: string;
  hasRelations?: boolean;
}

/**
 * Map TimeToImpact enum to display format
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
 * Fetches all technologies (radar entries) across all radars
 *
 * PERFORMANCE: Uses Promise.all to parallelize Firestore reads across radars
 * instead of sequential for...of loop. This reduces load time from O(n) round-trips
 * to O(1) parallel requests.
 *
 * Reads from the decoupled `technologies` + `radarPlacements` collections
 * and shapes results into `TechnologyWithRadar` for backward-compatible
 * consumers.
 *
 * @param filters - Optional filters to apply
 * @returns Promise resolving to technologies and radar metadata
 */
export async function getTechnologies(filters: TechnologyFilters = {}): Promise<TechnologiesResult> {
  try {
    return await getTechnologiesFromDecoupledModel(filters);
  } catch (error) {
    log.error('Error fetching technologies', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to fetch technologies');
  }
}

/**
 * Fetches technologies from the decoupled model (Phase 3)
 *
 * Fetches from `technologies` and `radarPlacements` collections, then transforms
 * to the legacy TechnologyWithRadar format for backward compatibility.
 */
async function getTechnologiesFromDecoupledModel(filters: TechnologyFilters): Promise<TechnologiesResult> {
  const { getAllTechnologiesWithPlacements } = await import('@/lib/radar-placement-service');

  // Get all technologies with their placements
  const technologiesWithPlacements = await getAllTechnologiesWithPlacements();

  // Build radar metadata map + collect quadrant configs per radar so the
  // adapter can denormalize `quadrantName` without an extra round-trip.
  const radarsMap = new Map<string, { id: string; name: string }>();
  const quadrantNameByRadarIdAndQuadrantId = new Map<string, Map<string, string>>();
  const radarsCollection = collection(db, 'radars');
  const radarsSnapshot = await getDocs(radarsCollection);
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

  // DEDUPLICATE: Group by technology ID to prevent duplicate entries
  // when a technology is placed on multiple radars
  const techByIdMap = new Map<string, (typeof technologiesWithPlacements)[0]>();
  for (const twp of technologiesWithPlacements) {
    // Only keep first placement for each unique technology
    if (!techByIdMap.has(twp.id)) {
      techByIdMap.set(twp.id, twp);
    }
  }

  // Transform UNIQUE technologies to TechnologyWithRadar format for backward compatibility
  const technologies: TechnologyWithRadar[] = Array.from(techByIdMap.values()).map((twp) => {
    const quadrantName =
      quadrantNameByRadarIdAndQuadrantId.get(twp.placement.radarId)?.get(twp.placement.quadrantId) ?? '';
    return transformToTechnologyWithRadar(twp, quadrantName);
  });

  // Apply filters
  return {
    technologies: applyFilters(technologies, filters),
    radarsMap,
  };
}

/**
 * Transforms a TechnologyWithPlacement to the legacy TechnologyWithRadar format
 *
 * This adapter maintains backward compatibility during the migration period.
 * The new format (Technology + RadarPlacement) is converted to the old format
 * (RadarEntry with radar context) so existing UI components continue to work.
 *
 * NOTE: The new model uses string IDs (tech-xxx) while the legacy model uses
 * numeric IDs. We cast through `unknown` to handle this type incompatibility
 * during the migration period. UI code should treat `id` as a string.
 */
function transformToTechnologyWithRadar(
  twp: TechnologyWithPlacement & { radarId: string; radarName: string },
  quadrantName: string
): TechnologyWithRadar {
  const { placement } = twp;

  // Build the transformed object
  // Cast through `unknown` to handle id type change (string vs number)
  const transformed = {
    // Use the Technology ID (new format: tech-xxx)
    // Note: id is string in new model, number in legacy model
    id: twp.id as unknown as number,
    name: twp.name,
    description: twp.description || '',
    // Placement data (opinion) — now uses stable id + denormalized name
    quadrantId: placement.quadrantId,
    quadrantName,
    ring: placement.ring,
    status: placement.status || 'New',
    // Technology data (fact)
    tags: twp.tags || [],
    linkedCompanies: twp.linkedCompanies || [],
    linkedUseCases: twp.linkedUseCases || [],
    // Technology entity fields
    category: twp.category,
    originalTechId: twp.id,
    // TRL and TimeToImpact (converted to string format for RadarEntry compatibility)
    trl: twp.trl ? `TRL ${twp.trl}` : undefined,
    timeToImpact: twp.timeToImpact ? mapTimeToImpactDisplay(twp.timeToImpact) : undefined,
    // Placement metadata
    moved: placement.movedFrom ? (placement.ring === 'Adopt' ? 1 : -1) : 0,
    analysis: placement.rationale,
    costToPrototype: placement.trlScore !== undefined ? placement.trlScore * 10 : 50,
    // Radar context
    radarId: twp.radarId,
    radarName: twp.radarName,
    // History is tracked differently in new model, provide empty for compatibility
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
    // Deep research and market interest data (from Technology entity)
    deepResearch: twp.deepResearch,
    marketInterest: twp.marketInterest,
    // Comprehensive research (from Technology entity)
    comprehensiveResearch: twp.comprehensiveResearch,
    researchStatus: twp.researchStatus,
    // Notes (from Technology entity)
    notes: twp.notes,
    // Links (from Technology entity)
    websiteUrl: twp.websiteUrl,
    githubUrl: twp.githubUrl,
    documentationUrl: twp.documentationUrl,
  };

  return transformed as TechnologyWithRadar;
}

/**
 * Applies filters to an array of technologies
 *
 * @param technologies - Array of technologies to filter
 * @param filters - Filters to apply
 * @returns Filtered array of technologies
 */
function applyFilters(technologies: TechnologyWithRadar[], filters: TechnologyFilters): TechnologyWithRadar[] {
  let filtered = [...technologies];

  // Search filter (name or description)
  if (filters.search && filters.search.trim()) {
    const searchLower = filters.search.toLowerCase().trim();
    filtered = filtered.filter(
      (tech) => tech.name.toLowerCase().includes(searchLower) || tech.description?.toLowerCase().includes(searchLower)
    );
  }

  // Ring filter
  if (filters.ring) {
    filtered = filtered.filter((tech) => tech.ring === filters.ring);
  }

  // Quadrant filter — matches by stable `quadrantId`
  if (filters.quadrantId) {
    filtered = filtered.filter((tech) => tech.quadrantId === filters.quadrantId);
  }

  // Status filter
  if (filters.status) {
    filtered = filtered.filter((tech) => tech.status === filters.status);
  }

  // Tag filter
  if (filters.tag) {
    filtered = filtered.filter((tech) => tech.tags?.includes(filters.tag as string));
  }

  // Has relations filter
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
 * Gets all unique tags across all technologies
 *
 * @returns Promise resolving to array of unique tag strings
 */
export async function getAllTechnologyTags(): Promise<string[]> {
  const { technologies } = await getTechnologies();
  const tagsSet = new Set<string>();

  technologies.forEach((tech) => {
    tech.tags?.forEach((tag) => tagsSet.add(tag));
  });

  return Array.from(tagsSet).sort();
}

/**
 * Gets all unique quadrant display names across all technologies.
 *
 * Reads from the denormalized `quadrantName` on `TechnologyWithRadar`. Returns
 * a sorted list of names for UI dropdowns / filter bars. Note that quadrant
 * names are not guaranteed to be unique across radars — two different radars
 * can have a quadrant named "Tools" with different stable ids.
 *
 * @returns Promise resolving to array of unique quadrant display name strings
 */
export async function getAllQuadrants(): Promise<Quadrant[]> {
  const { technologies } = await getTechnologies();
  const quadrantsSet = new Set<Quadrant>();

  technologies.forEach((tech) => {
    if (tech.quadrantName) {
      quadrantsSet.add(tech.quadrantName);
    }
  });

  return Array.from(quadrantsSet).sort();
}

/**
 * Simple radar info for selection
 */
export interface RadarInfo {
  id: string;
  name: string;
}

/**
 * Gets all available radars in the system.
 * Useful for populating radar selection dropdowns.
 *
 * @returns Promise resolving to an array of radar info objects
 *
 * @example
 * ```typescript
 * const radars = await getRadars();
 * console.log(`Available radars: ${radars.map(r => r.name).join(', ')}`);
 * ```
 */
export async function getRadars(): Promise<RadarInfo[]> {
  try {
    const radarsCollection = collection(db, 'radars');
    const radarsSnapshot = await getDocs(radarsCollection);

    return radarsSnapshot.docs.map((doc) => {
      const data = doc.data();
      return { id: data.id, name: data.name };
    });
  } catch (error) {
    log.error('Error fetching radars', error instanceof Error ? error : new Error(String(error)));
    throw new Error('Failed to fetch radars');
  }
}

/**
 * Parses a composite technology ID into its components.
 *
 * @param compositeId - ID in format "radarId:techId"
 * @returns Object with radarId and techId, or null if invalid format
 *
 * @example
 * ```typescript
 * const parsed = parseTechnologyId("my-radar:42");
 * // { radarId: "my-radar", techId: 42 }
 * ```
 */
export function parseTechnologyId(compositeId: string): { radarId: string; techId: number } | null {
  const parts = compositeId.split(':');
  if (parts.length !== 2) return null;

  const [radarId, techIdStr] = parts;
  const techId = parseInt(techIdStr, 10);

  if (!radarId || isNaN(techId)) return null;

  return { radarId, techId };
}

/**
 * Creates a composite technology ID from radar and tech IDs.
 *
 * @param radarId - The radar ID
 * @param techId - The numeric technology ID
 * @returns Composite ID in format "radarId:techId"
 */
export function createTechnologyId(radarId: string, techId: number): string {
  return `${radarId}:${techId}`;
}
