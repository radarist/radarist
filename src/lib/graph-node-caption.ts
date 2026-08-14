/**
 * @file graph-node-caption.ts
 * @description Pure caption derivation for the graph workbench.
 *
 * Shared between the `/api/graph/query` route (server) and the Cytoscape
 * `GraphVisualization` component (client) — keep this module dependency-free.
 *
 * `deriveNodeCaption` turns a Neo4j node's labels + properties into a human
 * caption. RadarPlacement nodes carry no `name`/`title` (the placement sync
 * writes `quadrantName` + `ring` — see
 * `src/lib/inngest/functions/sync-placement-to-neo4j.ts`), and some nodes
 * (`Radar`) only carry a machine id. Before this helper the route fell back to
 * the raw id, so nodes rendered captions like "placement-17716…".
 *
 * The Cytoscape renderer fits the display label to the node itself (bounded
 * length + native word-wrap, full text in the hover tooltip), so this module
 * no longer carries any renderer-specific caption geometry.
 */

const ELLIPSIS = '…';

/** Maximum length for long-text previews (prompt/summary/statement). */
const PREVIEW_CHARS = 40;

// ============================================================================
// CAPTION DERIVATION
// ============================================================================

/** Get the primary label for a node (first non-Entity label). */
export function getPrimaryNodeLabel(labels: string[]): string {
  return labels.find((l) => l !== 'Entity') || labels[0] || 'Node';
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const str = asNonEmptyString(value);
    if (str) return str;
  }
  return undefined;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function truncatePreview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > PREVIEW_CHARS ? compact.slice(0, PREVIEW_CHARS).trimEnd() + ELLIPSIS : compact;
}

/**
 * Recover readable words from a slug-style id by stripping trailing machine
 * segments (timestamps, random hashes, hex blocks).
 *
 * 'mwc-2026-emerging-tech-radar-1771689504682' → 'mwc 2026 emerging tech radar'
 * 'beverage'                                   → 'beverage'
 * 'placement-1771689515182-kj1w383'            → undefined ('placement' is
 *                                                 just the type prefix)
 */
function humanizeIdSlug(id: string, primaryLabel: string): string | undefined {
  // Only dash-joined alphanumerics are slugs. Neo4j element ids
  // ('4:abc123:42'), UUID-with-braces, etc. carry no readable words.
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return undefined;

  const segments = id.split('-').filter(Boolean);

  while (segments.length > 0) {
    const last = segments[segments.length - 1];
    const isTimestamp = /^\d{8,}$/.test(last);
    const isRandomHash = /^(?=.*\d)(?=.*[a-z])[a-z0-9]{5,}$/i.test(last);
    const isHexBlock = /^[0-9a-f]{4,}$/i.test(last);
    if (isTimestamp || isRandomHash || isHexBlock) {
      segments.pop();
    } else {
      break;
    }
  }

  if (segments.length === 0) return undefined;

  // Pure numbers carry no readable words either.
  if (segments.every((s) => /^\d+$/.test(s))) return undefined;

  // A lone type-prefix word ('placement' for RadarPlacement) adds nothing.
  if (segments.length === 1 && primaryLabel.toLowerCase().includes(segments[0].toLowerCase())) {
    return undefined;
  }

  return segments.join(' ');
}

/** Last 4 alphanumeric characters of an id, for disambiguating fallbacks. */
function shortIdSuffix(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(-4);
}

/**
 * Derive a human-readable caption for a graph node.
 *
 * Fallback chain:
 * 1. Direct descriptive properties (`name`, `title`, `displayName`,
 *    `canonicalName`, `fileName`).
 * 2. RadarPlacement: `quadrantName · Ring` (the descriptive properties the
 *    placement sync denormalizes onto the node — it has no name snapshot).
 * 3. Long-text previews (`prompt` for Missions, `summary` for Episodes /
 *    CommunityReports, `statement` for Assertions, `content` for Chunks).
 * 4. Readable words recovered from a slug-style id ('beverage',
 *    'mwc 2026 emerging tech radar').
 * 5. `PrimaryLabel #suffix` — never the raw machine id.
 */
export function deriveNodeCaption(labels: string[], properties: Record<string, unknown>, id: string): string {
  const direct = firstNonEmptyString(
    properties.name,
    properties.title,
    properties.displayName,
    properties.canonicalName,
    properties.fileName
  );
  if (direct) return direct;

  if (labels.includes('RadarPlacement')) {
    const ring = asNonEmptyString(properties.ring);
    // GRAPH-065: prefer the resolved placed-technology name when the read path
    // enriched it — that makes each placement distinct. Fall back to the
    // authoritative quadrant name, then bare ring, before the #suffix fallback.
    const technologyName = asNonEmptyString(properties.technologyName);
    const quadrant = asNonEmptyString(properties.quadrantName);
    const primary = technologyName ?? quadrant;
    if (primary || ring) {
      return [primary, ring ? capitalize(ring) : undefined].filter(Boolean).join(' · ');
    }
  }

  const preview = firstNonEmptyString(properties.prompt, properties.summary, properties.statement, properties.content);
  if (preview) return truncatePreview(preview);

  const primaryLabel = getPrimaryNodeLabel(labels);
  const idStr = asNonEmptyString(properties.id) ?? id;
  const humanized = humanizeIdSlug(idStr, primaryLabel);
  if (humanized) return humanized;

  const suffix = shortIdSuffix(idStr);
  return suffix ? `${primaryLabel} #${suffix}` : primaryLabel;
}
