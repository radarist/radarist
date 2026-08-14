/**
 * @file graph/emergence.ts
 * @description C5 — edge-velocity emergence detection.
 *
 * The graph accumulates timestamped edges (`t_observed` ISO strings) on every
 * relation write, but
 * nothing NOTICES what's rising. This module compares each entity's edge
 * count in a recent window against the prior window of equal length and
 * flags entities whose activity is accelerating — new connections forming
 * faster than the entity's baseline.
 *
 * Two-phase design (mirrors `community-reports.ts`):
 *   1. `getEdgeVelocity` — pure Neo4j read, no thresholds applied.
 *   2. `selectEmergent` — PURE selection/ranking logic, unit-testable without
 *      a database.
 *   3. `detectEmergence` — composes the two for callers (the cron handler).
 */
import { runReadTransaction } from './neo4j-client';
import { currentEdgePredicate } from './current-edge-filter';
import { createLogger } from '@/lib/logger';

const log = createLogger('graph/emergence');

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_MIN_EDGES = 3;
const DEFAULT_ACCELERATION_FACTOR = 2;
const DEFAULT_LIMIT = 5;

export interface EdgeVelocityRow {
  entityId: string;
  entityName: string;
  entityType: string;
  /** Count of edges with `t_observed` in [now - windowDays, now]. */
  recentCount: number;
  /** Count of edges with `t_observed` in [now - 2*windowDays, now - windowDays). */
  priorCount: number;
}

export interface EmergenceFinding extends EdgeVelocityRow {
  /** recentCount / max(priorCount, 1) — how much faster the entity is accumulating edges. */
  acceleration: number;
}

interface EdgeVelocityQueryRow {
  entityId: string;
  entityName: string;
  entityType: string;
  recentCount: number;
  priorCount: number;
}

/**
 * Read raw recent/prior edge counts per entity. No thresholds — that's
 * `selectEmergent`'s job. Ordered by `recentCount DESC LIMIT 200` so the
 * pure selection step works off a bounded, already-ranked candidate set.
 */
export async function getEdgeVelocity(
  options: { entityId?: string; windowDays?: number } = {}
): Promise<EdgeVelocityRow[]> {
  const { entityId = null, windowDays = DEFAULT_WINDOW_DAYS } = options;
  const now = Date.now();
  const recentStart = new Date(now - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const priorStart = new Date(now - 2 * windowDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const result = await runReadTransaction<EdgeVelocityQueryRow>(
      `MATCH (e:Entity)-[r]-()
       WHERE r.t_observed IS NOT NULL AND r.t_observed >= $priorStart
         AND ${currentEdgePredicate('r')}
         AND ($entityId IS NULL OR e.id = $entityId)
       WITH e,
            sum(CASE WHEN r.t_observed >= $recentStart THEN 1 ELSE 0 END) AS recentCount,
            sum(CASE WHEN r.t_observed <  $recentStart THEN 1 ELSE 0 END) AS priorCount
       RETURN e.id AS entityId, coalesce(e.name, e.id) AS entityName,
              coalesce(e.entityType, 'unknown') AS entityType, recentCount, priorCount
       ORDER BY recentCount DESC LIMIT 200`,
      { entityId, windowDays, recentStart, priorStart }
    );

    return result.records.map((r) => ({
      entityId: r.entityId,
      entityName: r.entityName,
      entityType: r.entityType,
      recentCount: Number(r.recentCount) || 0,
      priorCount: Number(r.priorCount) || 0,
    }));
  } catch (error) {
    log.error('getEdgeVelocity failed', error instanceof Error ? error : new Error(String(error)), {
      entityId,
      windowDays,
    });
    throw error;
  }
}

/**
 * Pure selection/ranking: keep rows whose recent activity clears BOTH an
 * absolute floor (`minEdges`) and a relative-to-baseline bar
 * (`accelerationFactor` × prior, floored at 1 so a from-zero baseline
 * doesn't divide by zero / auto-qualify everything). Sort by acceleration
 * descending (fastest-accelerating first), tie-broken by recentCount, then
 * truncate to `limit`.
 *
 * No I/O — safe to unit test without a database.
 */
export function selectEmergent(
  rows: EdgeVelocityRow[],
  opts: { minEdges?: number; accelerationFactor?: number; limit?: number } = {}
): EmergenceFinding[] {
  const {
    minEdges = DEFAULT_MIN_EDGES,
    accelerationFactor = DEFAULT_ACCELERATION_FACTOR,
    limit = DEFAULT_LIMIT,
  } = opts;

  return rows
    .map((row) => ({ ...row, acceleration: row.recentCount / Math.max(row.priorCount, 1) }))
    .filter((row) => row.recentCount >= minEdges && row.recentCount >= accelerationFactor * Math.max(row.priorCount, 1))
    .sort((a, b) => b.acceleration - a.acceleration || b.recentCount - a.recentCount)
    .slice(0, limit);
}

/**
 * Compose `getEdgeVelocity` + `selectEmergent` — the entry point the cron
 * handler (and any future caller) uses.
 */
export async function detectEmergence(
  options: {
    entityId?: string;
    windowDays?: number;
    minEdges?: number;
    accelerationFactor?: number;
    limit?: number;
  } = {}
): Promise<EmergenceFinding[]> {
  const rows = await getEdgeVelocity({ entityId: options.entityId, windowDays: options.windowDays });
  return selectEmergent(rows, {
    minEdges: options.minEdges,
    accelerationFactor: options.accelerationFactor,
    limit: options.limit,
  });
}
