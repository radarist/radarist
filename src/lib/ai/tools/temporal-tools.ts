/**
 * @file ai/tools/temporal-tools.ts
 * @description AI tools that expose F1 temporal edges to chat.
 *
 *   - queryActiveEdges: for a given entity, which edges are currently valid
 *     (not invalidated or rejected)? Optional predicate filter. Answers
 *     "what does Nvidia partner with right now?" without the caller having
 *     to write Cypher.
 *   - getEntityTimeline: the full sequence of edges on an entity, ordered
 *     by t_valid (ascending). Mixes active + invalidated so the model can
 *     say "this was true until March, after which it flipped to X".
 *
 * Both tools are read-only and rely on temporal metadata written by
 * `invalidatePriorEdges` on the hot write path (see graph/temporal-queries.ts).
 *
 * @phase F.9 — temporal chat exposure (2026-04-18)
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import { runReadTransaction } from '@/lib/graph/neo4j-client';
import { currentEdgePredicate } from '@/lib/graph/current-edge-filter';
import { businessEntityIdentityCypher, businessEntityIdentityParams } from '@/lib/graph/business-entity-identity';
import {
  getEntityTimeline as getEntityTimelineService,
  getChangedSince as getChangedSinceService,
} from '@/lib/graph/temporal-queries';
import { createLogger } from '@/lib/logger';

const log = createLogger('ai/temporal-tools');

// Predicates in this codebase are SCREAMING_SNAKE_CASE. Anything else is
// either a typo or a Cypher-injection attempt — refuse both.
const SAFE_PREDICATE = /^[A-Z][A-Z0-9_]*$/;

// ============================================================================
// TOOL DECLARATIONS
// ============================================================================

export const TEMPORAL_TOOLS: FunctionDeclaration[] = [
  {
    name: 'queryActiveEdges',
    description:
      'Return edges out of or into an entity that are currently valid (not invalidated and not rejected). Use this when the user asks "what is still true about X?", "what does X partner with right now?", or otherwise wants the present-day view of an entity. Optional `predicate` narrows the result to a single typed relationship (e.g. COMPETES_WITH). Predicates must be SCREAMING_SNAKE_CASE.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityId: {
          type: SchemaType.STRING,
          description: 'ID of the entity (companies/technologies/etc.). Provide this OR entityName.',
        },
        entityName: {
          type: SchemaType.STRING,
          description: 'Name of the entity (e.g. "Anthropic") — resolved to its id if entityId is not known.',
        },
        predicate: {
          type: SchemaType.STRING,
          description: 'Optional relationship type filter (e.g. COMPETES_WITH, USES, VENDOR).',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Max edges to return (default 25, cap 100).',
        },
      },
      required: [],
    },
  },
  {
    name: 'getEntityTimeline',
    description:
      'Return the full relationship timeline for an entity, including invalidated edges, ordered by t_valid ascending. Use this for "what has changed about X?" or "show me the history of X" questions. Each entry carries t_valid, t_observed, and t_invalidated — null t_invalidated means the edge is still active.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityId: {
          type: SchemaType.STRING,
          description: 'ID of the entity whose timeline should be returned. Provide this OR entityName.',
        },
        entityName: {
          type: SchemaType.STRING,
          description: 'Name of the entity (e.g. "Anthropic") — resolved to its id if entityId is not known.',
        },
      },
      required: [],
    },
  },
  {
    name: 'getTemporalEdgeStats',
    description:
      'Return graph-wide temporal edge counts. Use this for "how many relationships have been superseded / invalidated?", "how many facts are still true?", or any corpus-level question about t_invalidated coverage. Returns { active, invalidated, totalWithTemporal } in one call — no Cypher required.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: 'getChangedSince',
    description:
      'Return relationships discovered across the ENTIRE graph since a given time (graph-wide "what changed / what is new on the radar lately?"), newest first. Use for corpus-level recency questions that are NOT scoped to one entity — for a single entity\'s history use getEntityTimeline instead. Pass `sinceDays` for a relative window (e.g. 7, 30) or an ISO `since` timestamp for a precise cutoff. Returns up to 100 recently-observed edges (blunt list — no per-entity grouping or velocity).',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        sinceDays: {
          type: SchemaType.NUMBER,
          description: 'Look back this many days from now (default 7). Ignored if `since` is provided.',
        },
        since: {
          type: SchemaType.STRING,
          description: 'Optional ISO-8601 timestamp; overrides sinceDays for a precise cutoff.',
        },
      },
      required: [],
    },
  },
];

// ============================================================================
// EXECUTORS
// ============================================================================

export interface ActiveEdge {
  relType: string;
  direction: 'in' | 'out';
  connectedEntityId: string;
  connectedEntityName: string;
  t_valid: string;
  t_observed: string;
}

export interface TimelineEdge {
  relType: string;
  connectedEntityId: string;
  connectedEntityName: string;
  t_valid: string;
  t_observed: string;
  t_invalidated: string | null;
}

/**
 * Resolve an entity reference from tool args: an explicit `entityId`, else a `entityName`
 * looked up in the graph (case-insensitive on name/title). The assistant usually references
 * entities by NAME, so temporal tools must accept a name — not just an id (the previous
 * id-only contract made "temporal history of Anthropic" fail with "entityId is required").
 */
async function resolveEntityRef(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.entityId === 'string' ? args.entityId.trim() : '';
  if (id) return id;
  const name = typeof args.entityName === 'string' ? args.entityName.trim() : '';
  if (!name) return '';
  // AI-026: this matched ANY node carrying a `name`/`title`, and
  // `:AgentObservation` nodes store a `title` — so "the timeline of X" could
  // resolve to an observation about X. Identity is now label-proven.
  const res = await runReadTransaction<{ id: string }>(
    `MATCH (e)
     WHERE e.id IS NOT NULL
       AND toLower(coalesce(e.name, e.title, '')) = toLower($name)
       AND ${businessEntityIdentityCypher('e')}
     RETURN e.id AS id LIMIT 1`,
    { name, ...businessEntityIdentityParams() }
  );
  return res.records[0]?.id ?? '';
}

export async function executeQueryActiveEdges(args: Record<string, unknown>): Promise<{
  success: boolean;
  edges: ActiveEdge[];
  entityId: string;
  predicate?: string;
  message: string;
}> {
  const entityId = await resolveEntityRef(args);
  const predicate = typeof args.predicate === 'string' ? args.predicate.trim() : undefined;
  const limit = Math.min(Math.max(typeof args.limit === 'number' ? args.limit : 25, 1), 100);

  if (!entityId) {
    return { success: false, edges: [], entityId: '', message: 'Provide an entityId or a resolvable entityName.' };
  }
  if (predicate && !SAFE_PREDICATE.test(predicate)) {
    return {
      success: false,
      edges: [],
      entityId,
      predicate,
      message: `Refusing unsafe predicate "${predicate}". Predicates must be SCREAMING_SNAKE_CASE.`,
    };
  }

  const relMatch = predicate ? `[r:\`${predicate}\`]` : '[r]';
  const cypher = `
    MATCH (a {id: $entityId})-${relMatch}-(b)
    WHERE ${currentEdgePredicate('r')} AND r.t_valid IS NOT NULL
    RETURN type(r) AS relType,
           CASE WHEN startNode(r).id = $entityId THEN 'out' ELSE 'in' END AS direction,
           b.id AS connectedEntityId,
           coalesce(b.name, b.title, '') AS connectedEntityName,
           r.t_valid AS t_valid,
           r.t_observed AS t_observed
    ORDER BY r.t_observed DESC
    LIMIT toInteger($limit)
  `;

  try {
    const rows = await runReadTransaction<{
      relType: string;
      direction: 'in' | 'out';
      connectedEntityId: string;
      connectedEntityName: string;
      t_valid: string;
      t_observed: string;
    }>(cypher, { entityId, limit });

    const edges: ActiveEdge[] = rows.records.map((r) => ({
      relType: r.relType,
      direction: r.direction,
      connectedEntityId: r.connectedEntityId,
      connectedEntityName: r.connectedEntityName,
      t_valid: String(r.t_valid ?? ''),
      t_observed: String(r.t_observed ?? ''),
    }));

    return {
      success: true,
      edges,
      entityId,
      predicate,
      message:
        edges.length === 0
          ? `No active edges for entity ${entityId}${predicate ? ` with predicate ${predicate}` : ''}.`
          : `Found ${edges.length} active edge${edges.length === 1 ? '' : 's'} for ${entityId}${predicate ? ` (${predicate})` : ''}.`,
    };
  } catch (error) {
    log.error('queryActiveEdges failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      edges: [],
      entityId,
      predicate,
      message: `Active-edge query failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

export async function executeGetEntityTimeline(args: Record<string, unknown>): Promise<{
  success: boolean;
  timeline: TimelineEdge[];
  activeCount: number;
  invalidatedCount: number;
  entityId: string;
  message: string;
}> {
  const entityId = await resolveEntityRef(args);
  if (!entityId) {
    return {
      success: false,
      timeline: [],
      activeCount: 0,
      invalidatedCount: 0,
      entityId: '',
      message: 'Provide an entityId or a resolvable entityName.',
    };
  }

  try {
    const entries = await getEntityTimelineService(entityId);
    const timeline: TimelineEdge[] = entries.map((e) => ({
      relType: e.relType,
      connectedEntityId: e.connectedEntityId,
      connectedEntityName: e.connectedEntityName,
      t_valid: e.t_valid,
      t_observed: e.t_observed,
      t_invalidated: e.t_invalidated,
    }));
    const activeCount = timeline.filter((t) => t.t_invalidated === null).length;
    const invalidatedCount = timeline.length - activeCount;

    return {
      success: true,
      timeline,
      activeCount,
      invalidatedCount,
      entityId,
      message:
        timeline.length === 0
          ? `No temporal edges found for entity ${entityId}.`
          : `Timeline for ${entityId}: ${activeCount} active + ${invalidatedCount} invalidated.`,
    };
  } catch (error) {
    log.error('getEntityTimeline failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      timeline: [],
      activeCount: 0,
      invalidatedCount: 0,
      entityId,
      message: `Timeline query failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

export async function executeGetTemporalEdgeStats(): Promise<{
  success: boolean;
  active: number;
  invalidated: number;
  totalWithTemporal: number;
  message: string;
}> {
  try {
    const rows = await runReadTransaction<{ active: number; invalidated: number }>(
      `
      MATCH ()-[r]->()
      WHERE r.t_valid IS NOT NULL
      RETURN
        count(CASE WHEN r.t_invalidated IS NULL THEN 1 END) AS active,
        count(CASE WHEN r.t_invalidated IS NOT NULL THEN 1 END) AS invalidated
      `
    );
    const active = rows.records[0]?.active ?? 0;
    const invalidated = rows.records[0]?.invalidated ?? 0;
    const totalWithTemporal = active + invalidated;
    return {
      success: true,
      active,
      invalidated,
      totalWithTemporal,
      message: `${active.toLocaleString()} edges are currently active (t_invalidated IS NULL); ${invalidated.toLocaleString()} have been superseded; total temporal-tracked edges: ${totalWithTemporal.toLocaleString()}.`,
    };
  } catch (error) {
    log.error('getTemporalEdgeStats failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      active: 0,
      invalidated: 0,
      totalWithTemporal: 0,
      message: `Temporal edge stats failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

export interface ChangedEdge {
  sourceId: string;
  targetId: string;
  relType: string;
  t_observed: string;
  t_invalidated: string | null;
}

export async function executeGetChangedSince(args: Record<string, unknown>): Promise<{
  success: boolean;
  edges: ChangedEdge[];
  since: string;
  message: string;
}> {
  let sinceDate: Date;
  if (typeof args.since === 'string' && args.since.trim()) {
    const parsed = new Date(args.since.trim());
    if (Number.isNaN(parsed.getTime())) {
      return {
        success: false,
        edges: [],
        since: '',
        message: `Invalid 'since' timestamp: "${args.since}". Use ISO-8601, or pass sinceDays instead.`,
      };
    }
    sinceDate = parsed;
  } else {
    const days = typeof args.sinceDays === 'number' && args.sinceDays > 0 ? args.sinceDays : 7;
    sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  try {
    const rows = await getChangedSinceService(sinceDate);
    const edges: ChangedEdge[] = rows.map((r) => ({
      sourceId: r.sourceId,
      targetId: r.targetId,
      relType: r.relType,
      t_observed: String(r.t_observed ?? ''),
      t_invalidated: r.t_invalidated ? String(r.t_invalidated) : null,
    }));
    return {
      success: true,
      edges,
      since: sinceDate.toISOString(),
      message:
        edges.length === 0
          ? `No relationships observed since ${sinceDate.toISOString()}.`
          : `${edges.length} relationship${edges.length === 1 ? '' : 's'} observed since ${sinceDate.toISOString()} (newest first${edges.length === 100 ? ', capped at 100' : ''}).`,
    };
  } catch (error) {
    log.error('getChangedSince failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      edges: [],
      since: sinceDate.toISOString(),
      message: `getChangedSince query failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
