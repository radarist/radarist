/**
 * @file lib/graph/placement-enrichment.ts
 * @description GRAPH-065 — authoritative RadarPlacement caption + context.
 *
 * A RadarPlacement node carries no name; captioning it from its own props
 * rendered every same-quadrant/ring placement identically (and, when the
 * denormalized `quadrantName` was null, a bare "Trial"). Instead, ONE bounded
 * Neo4j enrichment query resolves each placement's real display context from the
 * graph — the placed Technology's name via `PLACES`, the Radar's name via
 * `ON_RADAR`, and the quadrant name from the Radar node's AUTHORITATIVE
 * `quadrantIds`/`quadrantNames` config (no stale placement text, no N+1 Firestore
 * read). The pure resolver below turns one such row into a distinct caption
 * ("Quantum Annealing · Trial") and a resolved context, degrading honestly when
 * an endpoint is missing — it never invents a name.
 */

/**
 * Bounded enrichment query: resolve display context for every RadarPlacement id
 * in `$ids` in a single round-trip. `OPTIONAL MATCH` keeps rows for placements
 * whose Technology/Radar endpoint is missing so the caller can render them as
 * explicitly unresolved.
 */
export const PLACEMENT_ENRICHMENT_CYPHER = `
  MATCH (p:RadarPlacement)
  WHERE p.id IN $ids
  OPTIONAL MATCH (p)-[:PLACES]->(t:Technology)
  OPTIONAL MATCH (p)-[:ON_RADAR]->(r:Radar)
  RETURN p.id AS placementId,
         t.name AS technologyName,
         p.ring AS ring,
         p.quadrantId AS quadrantId,
         r.id AS radarId,
         r.name AS radarName,
         r.quadrantIds AS quadrantIds,
         r.quadrantNames AS quadrantNames
`;

/** One row returned by {@link PLACEMENT_ENRICHMENT_CYPHER}. */
export interface PlacementEnrichmentRow {
  placementId: string;
  technologyName?: string | null;
  ring?: string | null;
  quadrantId?: string | null;
  radarId?: string | null;
  radarName?: string | null;
  quadrantIds?: string[] | null;
  quadrantNames?: string[] | null;
}

/** Resolved display context attached to a placement node in the query response. */
export interface ResolvedPlacement {
  placementId: string;
  caption: string;
  technologyName: string | null;
  radarId: string | null;
  radarName: string | null;
  quadrantId: string | null;
  quadrantName: string | null;
  ring: string | null;
  /** Endpoints that could not be resolved (e.g. `['technology','radar']`). */
  unresolved: string[];
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Last 4 alphanumerics of the placement id — the `#suffix` fallback. Matches the
 * lowercase convention `deriveNodeCaption` uses so both surfaces agree.
 */
function placementSuffix(placementId: string): string {
  const alnum = placementId.replace(/[^a-zA-Z0-9]/g, '');
  return alnum.slice(-4) || alnum || placementId;
}

/** The explicit unresolved caption for a placement with no resolvable context. */
export function radarPlacementFallbackCaption(placementId: string): string {
  return `RadarPlacement #${placementSuffix(placementId)}`;
}

/** Read-time display-name properties that must be cleared when context is unresolved. */
export const PLACEMENT_RESOLVED_DISPLAY_PROPS = ['technologyName', 'radarName', 'quadrantName'] as const;

/**
 * Resolve the authoritative quadrant name from the radar's parallel
 * `quadrantIds`/`quadrantNames` config, by stable id. Returns null when the
 * config is absent or the id is not configured — never a guessed name.
 */
function resolveQuadrantName(
  quadrantId: string | null,
  quadrantIds: string[] | null | undefined,
  quadrantNames: string[] | null | undefined
): string | null {
  if (!quadrantId || !Array.isArray(quadrantIds) || !Array.isArray(quadrantNames)) return null;
  const index = quadrantIds.indexOf(quadrantId);
  if (index < 0) return null;
  return nonEmpty(quadrantNames[index]);
}

/**
 * Turn one enrichment row into a distinct caption + resolved context. When the
 * placed technology is missing the caption falls back to `RadarPlacement #suffix`
 * rather than inventing a name.
 */
export function resolvePlacementEnrichment(row: PlacementEnrichmentRow): ResolvedPlacement {
  const technologyName = nonEmpty(row.technologyName);
  const radarName = nonEmpty(row.radarName);
  const radarId = nonEmpty(row.radarId);
  const quadrantId = nonEmpty(row.quadrantId);
  const ring = nonEmpty(row.ring);
  const quadrantName = resolveQuadrantName(quadrantId, row.quadrantIds, row.quadrantNames);

  const unresolved: string[] = [];
  if (!technologyName) unresolved.push('technology');
  if (!radarName) unresolved.push('radar');
  if (!quadrantName) unresolved.push('quadrant');

  const caption = technologyName
    ? [technologyName, ring ? capitalize(ring) : null].filter(Boolean).join(' · ')
    : `RadarPlacement #${placementSuffix(row.placementId)}`;

  return {
    placementId: row.placementId,
    caption,
    technologyName,
    radarId,
    radarName,
    quadrantId,
    quadrantName,
    ring,
    unresolved,
  };
}
