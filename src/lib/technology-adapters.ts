/**
 * @file lib/technology-adapters.ts
 * @description Adapters to bridge legacy RadarEntry model with new decoupled Technology/RadarPlacement model
 *
 * These adapters enable gradual migration from the legacy model to the new decoupled model.
 * They can be used to:
 * 1. Transform new model data to work with legacy components
 * 2. Transform legacy data to work with new components
 * 3. Support both models during the transition period
 *
 * Migration Strategy:
 * - Phase 1: Create new model infrastructure (Technology, RadarPlacement, services, hooks)
 * - Phase 2: Use adapters to make new data work with legacy components
 * - Phase 3: Update components one by one to use new model natively
 * - Phase 4: Remove adapters when migration is complete
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import type {
  Technology,
  RadarPlacement,
  TechnologyWithPlacement,
  RadarData,
  RadarEntry,
  RadarEntryView,
  TechnologyCategory,
  Ring,
  Quadrant,
  QuadrantConfig,
  CreateRadarPlacementInput,
} from '@/lib/types';
import { getQuadrantById, resolveQuadrantReference } from '@/lib/types';
import type { TechnologyWithRadar } from '@/lib/technologies';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Extended TechnologyWithPlacement that includes radar metadata
 * Used for library views that need to show which radar(s) a technology belongs to
 */
export interface TechnologyWithPlacementAndRadar extends TechnologyWithPlacement {
  radarName: string;
}

// ============================================================================
// TRANSFORM: New Model → Legacy Model
// ============================================================================

/**
 * Transform a Technology + RadarPlacement into a legacy RadarEntry
 *
 * This adapter allows the new decoupled model to work with legacy components
 * like RadarVisualization that expect RadarEntry objects.
 *
 * @param technology - The Technology entity (facts)
 * @param placement - The RadarPlacement entity (opinion)
 * @returns RadarEntry compatible with legacy components
 *
 * @example
 * ```ts
 * const entry = toRadarEntry(technology, placement)
 * // Use with legacy Radar component
 * <Radar entries={[entry]} ... />
 * ```
 */
export function toRadarEntry(
  technology: Technology,
  placement: RadarPlacement,
  radar: Pick<RadarData, 'quadrants'>
): RadarEntryView {
  // Generate a numeric ID from the technology ID (legacy uses numeric IDs)
  const numericId = hashStringToNumber(technology.id);

  // Defensive resolution of quadrantId + quadrantName. Post-migration the
  // canonical placement has `quadrantId` set, so we hit the fast path on the
  // first line. Pre-migration placements still carry a legacy `quadrant`
  // display-name string — fall back to resolving that name against the
  // radar's current configs so render code always sees a valid id.
  //
  // This is narrow crash-avoidance, not dual-read: we ONLY reach the legacy
  // branch when the data was written before the schema flip. See the
  // "Fallback / defensive-guard stance" section of the plan.
  const configs: QuadrantConfig[] = Array.isArray(radar.quadrants) ? (radar.quadrants as QuadrantConfig[]) : [];

  let resolvedQuadrantId: string = placement.quadrantId ?? '';
  let resolvedQuadrantName: string = getQuadrantById(radar, resolvedQuadrantId)?.name ?? '';

  if (!resolvedQuadrantId || !resolvedQuadrantName) {
    // Legacy fallback: the raw Firestore doc may still have
    // `{ quadrant: "Tools" }` instead of `{ quadrantId: "q_tools" }`.
    const legacyName = (placement as unknown as { quadrant?: string }).quadrant;
    if (legacyName && configs.length > 0) {
      const hit = resolveQuadrantReference(radar, legacyName, { matchBy: 'name' });
      if (hit) {
        resolvedQuadrantId = hit.id;
        resolvedQuadrantName = hit.name;
      }
    }
    // Absolute last resort: use the first quadrant so the blip still
    // renders instead of crashing the positioning math.
    if ((!resolvedQuadrantId || !resolvedQuadrantName) && configs.length > 0) {
      resolvedQuadrantId = configs[0].id;
      resolvedQuadrantName = configs[0].name;
    }
  }

  return {
    id: numericId,
    name: technology.name,
    description: technology.description,
    quadrantId: resolvedQuadrantId,
    quadrantName: resolvedQuadrantName,
    ring: placement.ring as Ring,
    status: placement.status || 'Stable',
    tags: technology.tags,
    // Map costToPrototype - not in new model, default to 50
    costToPrototype: 50,
    // Map history - not in new model, create from placement if moved
    history: placement.movedFrom
      ? [
          {
            date: new Date(placement.movedAt || placement.createdAt).toISOString(),
            ring: placement.movedFrom,
            status: placement.status || 'Stable',
          },
        ]
      : [],
    // Pass through coordinates if set
    x: placement.x,
    y: placement.y,
    // Additional legacy fields (optional)
    // Only set hata if ring is NOT a TRL ring (HATA rings: Assess, Trial, Adopt, Hold)
    hata: placement.ring && !placement.ring.startsWith('TRL') ? placement.ring : undefined,
    // Map TRL score from placement (convert number to "TRL N" format)
    // Also check if ring itself is a TRL value (for backward compatibility)
    trl: placement.trlScore
      ? `TRL ${placement.trlScore}`
      : placement.ring && placement.ring.startsWith('TRL')
        ? placement.ring
        : undefined,
    // Map Time-to-Impact from placement (convert enum to display format)
    timeToImpact: mapTimeToImpactToDisplay(placement.timeToImpact),
    // Store original IDs for reverse lookup
    linkedUseCases: technology.linkedUseCases || [],
    // Deep research data (from Technology entity)
    deepResearch: technology.deepResearch,
    // Comprehensive research data (new model - preferred over deepResearch)
    comprehensiveResearch: technology.comprehensiveResearch,
    // Original technology ID for persistence operations
    originalTechId: technology.id,
  };
}

/**
 * Transform a TechnologyWithPlacement into a RadarEntry
 *
 * Note: TechnologyWithPlacement extends Technology directly with a placement property,
 * so we extract the Technology fields and pass them along with placement.
 *
 * @param twp - Combined technology + placement from new model
 * @returns RadarEntry compatible with legacy components
 */
export function technologyWithPlacementToRadarEntry(
  twp: TechnologyWithPlacement,
  radar: Pick<RadarData, 'quadrants'>
): RadarEntryView {
  // Extract technology properties (TechnologyWithPlacement extends Technology)
  const technology: Technology = {
    id: twp.id,
    name: twp.name,
    slug: twp.slug,
    description: twp.description,
    category: twp.category,
    tags: twp.tags,
    websiteUrl: twp.websiteUrl,
    githubUrl: twp.githubUrl,
    documentationUrl: twp.documentationUrl,
    linkedCompanies: twp.linkedCompanies,
    linkedUseCases: twp.linkedUseCases,
    createdAt: twp.createdAt,
    updatedAt: twp.updatedAt,
    createdBy: twp.createdBy,
    // Include deep research and market interest data
    deepResearch: twp.deepResearch,
    marketInterest: twp.marketInterest,
    // Comprehensive research data (new model)
    comprehensiveResearch: twp.comprehensiveResearch,
  };
  return toRadarEntry(technology, twp.placement, radar);
}

/**
 * Transform multiple TechnologyWithPlacements into RadarEntryViews
 *
 * @param technologies - Array of combined technology + placement
 * @param radar - The parent radar (used to denormalize quadrantName on each entry)
 * @returns Array of RadarEntryViews
 */
export function toRadarEntries(
  technologies: TechnologyWithPlacement[],
  radar: Pick<RadarData, 'quadrants'>
): RadarEntryView[] {
  return technologies.map((twp) => technologyWithPlacementToRadarEntry(twp, radar));
}

/**
 * Transform TechnologyWithPlacement into TechnologyWithRadar (for library view)
 *
 * Note: TechnologyWithPlacement extends Technology directly, so properties are
 * accessed directly from twp, not from twp.technology.
 *
 * @param twp - Combined technology + placement from new model
 * @param radarName - Name of the radar
 * @returns TechnologyWithRadar compatible with library pages
 */
export function toTechnologyWithRadar(
  twp: TechnologyWithPlacement,
  radarName: string,
  radar: Pick<RadarData, 'quadrants'>
): TechnologyWithRadar {
  const numericId = hashStringToNumber(twp.id);
  const quadrantName = getQuadrantById(radar, twp.placement.quadrantId)?.name ?? '';

  return {
    id: numericId,
    name: twp.name,
    description: twp.description,
    quadrantId: twp.placement.quadrantId,
    quadrantName,
    ring: twp.placement.ring as Ring,
    status: twp.placement.status || 'Stable',
    tags: twp.tags,
    costToPrototype: 50,
    history: [],
    radarId: twp.placement.radarId,
    radarName,
    // Technology-specific fields (preserved from new model)
    category: twp.category,
    originalTechId: twp.id,
    // TRL and TimeToImpact (from Technology entity, converted to string format)
    trl: twp.trl ? `TRL ${twp.trl}` : undefined,
    timeToImpact: mapTimeToImpactToDisplay(twp.timeToImpact),
    // Deep research and market interest data
    deepResearch: twp.deepResearch,
    marketInterest: twp.marketInterest,
    // Comprehensive research fields
    comprehensiveResearch: twp.comprehensiveResearch,
    researchStatus: twp.researchStatus,
    pendingSnapshotRefresh: twp.pendingSnapshotRefresh,
    // Notes (from Technology entity)
    notes: twp.notes,
    // Links (from Technology entity)
    websiteUrl: twp.websiteUrl,
    githubUrl: twp.githubUrl,
    documentationUrl: twp.documentationUrl,
  };
}

// ============================================================================
// TRANSFORM: Legacy Model → New Model
// ============================================================================

/**
 * Transform a legacy RadarEntry into Technology + CreateRadarPlacementInput
 *
 * Useful when migrating data from the old model to the new model,
 * or when creating new entities from legacy components.
 *
 * @param entry - Legacy RadarEntry
 * @param radarId - ID of the radar this entry belongs to
 * @param userId - ID of the user performing the migration
 * @returns Object with technology data and placement data
 */
export function fromRadarEntry(
  entry: RadarEntry,
  radarId: string,
  userId: string,
  radar: Pick<RadarData, 'quadrants'>
): {
  technology: Omit<Technology, 'id' | 'createdAt' | 'updatedAt'>;
  placement: CreateRadarPlacementInput;
} {
  const _now = Date.now();
  // Resolve the quadrant's display name from the radar (if present) for category inference.
  // For custom quadrants the frozen `inferCategoryFromQuadrantName` mapping returns `undefined`
  // — the caller is responsible for filling in `category` explicitly when that matters.
  const quadrantName = getQuadrantById(radar, entry.quadrantId)?.name;

  return {
    technology: {
      name: entry.name,
      slug: slugify(entry.name),
      description: entry.description,
      category: quadrantName ? inferCategoryFromQuadrantName(quadrantName) : undefined,
      tags: entry.tags || [],
      linkedCompanies: [],
      linkedUseCases: entry.linkedUseCases || [],
      createdBy: userId,
    },
    placement: {
      technologyId: '', // Will be set after technology is created
      radarId,
      quadrantId: entry.quadrantId,
      ring: entry.ring,
      rationale: '',
      status: entry.status,
      x: entry.x,
      y: entry.y,
      placedBy: userId,
    },
  };
}

/**
 * Transform TechnologyWithRadar (legacy library format) back to new model format
 *
 * @param twr - Legacy TechnologyWithRadar from library view
 * @param userId - ID of the user
 * @returns Combined technology and placement data
 */
export function fromTechnologyWithRadar(
  twr: TechnologyWithRadar,
  userId: string,
  radar: Pick<RadarData, 'quadrants'>
): {
  technology: Omit<Technology, 'id' | 'createdAt' | 'updatedAt'>;
  placement: CreateRadarPlacementInput;
} {
  return fromRadarEntry(
    {
      ...twr,
      costToPrototype: 50,
      history: [],
    },
    twr.radarId,
    userId,
    radar
  );
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Map TimeToImpact enum value to display format for radar visualization
 * @param timeToImpact - TimeToImpact enum value from RadarPlacement
 * @returns Display string matching RING_SYSTEMS["Time-to-Impact"] values
 */
export function mapTimeToImpactToDisplay(timeToImpact: string | undefined): string | undefined {
  if (!timeToImpact) return undefined;

  const mapping: Record<string, string> = {
    H1: 'H1 (0-6mo)',
    H2: 'H2 (6-18mo)',
    H3: 'H3 (18+mo)',
    unknown: undefined as unknown as string,
  };

  return mapping[timeToImpact] || undefined;
}

/**
 * Map display format back to TimeToImpact enum value
 * @param displayValue - Display string from radar visualization
 * @returns TimeToImpact enum value for storage
 */
export function mapDisplayToTimeToImpact(displayValue: string | undefined): string | undefined {
  if (!displayValue) return undefined;

  const mapping: Record<string, string> = {
    'H1 (0-6mo)': 'H1',
    'H2 (6-18mo)': 'H2',
    'H3 (18+mo)': 'H3',
  };

  return mapping[displayValue] || undefined;
}

/**
 * Generate a stable numeric ID from a string
 * Uses a simple hash function to convert UUID to number
 */
export function hashStringToNumber(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Generate a URL-friendly slug from a name
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Infer technology category from a quadrant **display name**.
 *
 * **Frozen mapping** — only the 9 classic ThoughtWorks-style quadrant names are
 * recognized. For custom quadrant names (e.g. "authn", "security", "SysAdmin")
 * this returns `undefined` and the caller must fill in `category` explicitly.
 * This is a deliberate limitation of the reverse adapter path
 * (`fromRadarEntry`) after the variable-quadrants refactor.
 */
export function inferCategoryFromQuadrantName(quadrantName: Quadrant | string): TechnologyCategory | undefined {
  const mapping: Record<string, TechnologyCategory> = {
    'Languages & Frameworks': 'framework',
    Frameworks: 'framework',
    Languages: 'language',
    Tools: 'tool',
    Platforms: 'platform',
    Techniques: 'methodology',
    Infrastructure: 'infrastructure',
    Services: 'service',
    Libraries: 'library',
  };
  return mapping[quadrantName];
}

/**
 * Create a lookup map from technology ID to TechnologyWithPlacement
 * Useful for quick lookups when working with mixed data
 */
export function createTechnologyLookupMap(
  technologies: TechnologyWithPlacement[]
): Map<string, TechnologyWithPlacement> {
  return new Map(technologies.map((twp) => [twp.id, twp]));
}

/**
 * Create a lookup map from radar entry ID to original technology ID
 * Useful for reverse lookup when clicking on legacy radar blips
 */
export function createRadarEntryToTechnologyMap(technologies: TechnologyWithPlacement[]): Map<number, string> {
  return new Map(technologies.map((twp) => [hashStringToNumber(twp.id), twp.id]));
}

// ============================================================================
// HYBRID DATA LOADING
// ============================================================================

/**
 * Load technologies and transform for legacy radar visualization
 *
 * This function:
 * 1. Loads technologies with placements for a specific radar
 * 2. Transforms them to RadarEntry format for the legacy Radar component
 * 3. Creates lookup maps for reverse navigation
 *
 * @param radarId - The radar to load technologies for
 * @param getTechnologiesWithPlacements - Function to fetch data (injected for testability)
 * @returns Transformed data ready for legacy components
 */
export interface HybridRadarData {
  /** Entries for legacy Radar component */
  entries: RadarEntry[];
  /** Lookup: numeric entry ID → technology ID */
  entryToTechnologyMap: Map<number, string>;
  /** Lookup: technology ID → full data */
  technologyMap: Map<string, TechnologyWithPlacement>;
  /** Original data */
  technologies: TechnologyWithPlacement[];
}

export async function loadHybridRadarData(
  radarId: string,
  getTechnologiesWithPlacements: (radarId: string) => Promise<TechnologyWithPlacement[]>,
  radar: Pick<RadarData, 'quadrants'>
): Promise<HybridRadarData> {
  const technologies = await getTechnologiesWithPlacements(radarId);

  return {
    entries: toRadarEntries(technologies, radar),
    entryToTechnologyMap: createRadarEntryToTechnologyMap(technologies),
    technologyMap: createTechnologyLookupMap(technologies),
    technologies,
  };
}

// ============================================================================
// TYPE GUARDS
// ============================================================================

/**
 * Check if an object is a TechnologyWithPlacement
 *
 * TechnologyWithPlacement extends Technology directly and adds a placement property.
 * So we check for Technology properties (id, name, slug) plus placement.
 */
export function isTechnologyWithPlacement(obj: unknown): obj is TechnologyWithPlacement {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'id' in obj &&
    'name' in obj &&
    'slug' in obj &&
    'placement' in obj &&
    typeof (obj as TechnologyWithPlacement).placement === 'object'
  );
}

/**
 * Check if an object is a legacy RadarEntry
 */
export function isRadarEntry(obj: unknown): obj is RadarEntry {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'id' in obj &&
    'name' in obj &&
    'quadrantId' in obj &&
    'ring' in obj &&
    typeof (obj as RadarEntry).id === 'number'
  );
}
