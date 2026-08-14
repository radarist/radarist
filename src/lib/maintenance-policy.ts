/**
 * @file maintenance-policy.ts
 * @description OPS-001 — the one server-owned switch that pauses ambient
 * scheduled maintenance for the local release.
 *
 * The OSS showcase runs local-only and seeds its data directly, so it ships
 * PAUSED: every ambient cron/broad-backfill handler (reconcile, snapshot
 * refresh, community reports, emergence, TRL sync, the daily pipeline, the
 * batch Firestore→Neo4j syncs, signal fetch/sweep/linker/discovery, digests)
 * returns a bounded skipped-audit record instead of mutating Firestore/Neo4j.
 *
 * What is NEVER gated:
 *  - Authenticated manual exact-ID operations. Those flow through the
 *    single-item sync handlers (sync-relation, sync-unified-entity,
 *    sync-technology, sync-placement, sync-entity-document-link, …) and the
 *    entity factory / write helpers, none of which call this guard — so a paused
 *    window still lets a user create, edit, or delete an exact entity/relation
 *    and have it sync.
 *  - The durable-delete drain (replay-relation-delete-outbox) and the radar
 *    graph-delete worker, so an in-flight deletion still converges while paused.
 *  - Resource/lifecycle GC (stuck missions, build sandboxes, zombie episodes)
 *    whose pausing would strand resources, and the graph-failure-digest observer
 *    that reports the skipped records.
 *
 * Mechanism: a plain server-read of `MAINTENANCE_PAUSED` (alias
 * `IMPULSE_MAINTENANCE_PAUSED`). This is NOT a runtime flag store — the feature
 * flag system was deleted; flipping the pause is an environment change.
 * Default when unset: PAUSED, except under test so the ambient-handler suites
 * exercise their run paths without each opting out.
 */

/** The single reason string every maintenance-skip record carries. */
export const MAINTENANCE_SKIP_REASON = 'maintenance-paused' as const;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * True when ambient scheduled maintenance is paused.
 *
 * Reads env live (not a frozen const) so operators and tests can toggle it.
 * An explicit `MAINTENANCE_PAUSED` / `IMPULSE_MAINTENANCE_PAUSED` value always
 * wins; when unset the local release defaults to paused, but the test
 * environment defaults to active so the ambient-handler suites still run.
 */
export function isMaintenancePaused(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MAINTENANCE_PAUSED ?? env.IMPULSE_MAINTENANCE_PAUSED)?.trim().toLowerCase();
  if (raw !== undefined && TRUTHY.has(raw)) return true;
  if (raw !== undefined && FALSY.has(raw)) return false;
  return env.NODE_ENV !== 'test';
}

export interface MaintenanceSkipResult {
  skipped: true;
  reason: typeof MAINTENANCE_SKIP_REASON;
  functionId: string;
  at: string;
}

/**
 * The bounded, fixed-shape record a gated handler returns instead of running.
 * Inngest stores it as the run output — one small object per run, so a long
 * pause window stays observably bounded. The `reason` lets the failure digest
 * tell an intentional pause apart from a 100%-skip outage.
 */
export function maintenanceSkip(functionId: string): MaintenanceSkipResult {
  return {
    skipped: true,
    reason: MAINTENANCE_SKIP_REASON,
    functionId,
    at: new Date().toISOString(),
  };
}
