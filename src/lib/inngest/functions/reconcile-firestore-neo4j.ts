/**
 * @file lib/inngest/functions/reconcile-firestore-neo4j.ts
 * @description Scheduled Firestore→Neo4j reconciliation plus the manual full-sync backfill.
 *
 * **Replay contract (PERF-007).** Both jobs in this file are re-entered by
 * Inngest on every retry, and Inngest memoizes a step by its *return value*.
 * A step that records its work by mutating a variable in the handler closure
 * therefore loses that work on replay: the mutation does not happen again, and
 * the handler reads the initial value. Every step here consequently returns
 * what it did, and the caller accumulates from those return values only.
 *
 * This is replay-safe, not distributed-exactly-once. Firestore, Neo4j, and the
 * Inngest queue commit separately; `BUILD-029` owns the durable outbox and
 * idempotent worker claim that a real exactly-once contract would need.
 *
 * **Trigger:** Cron schedule (every 15 minutes) / manual `app/full-sync.requested`
 * **Retries:** 2 (scheduled) / 1 (full sync)
 *
 * @author Radarist Team
 * @created 2026-01-16
 */

import { inngest } from '../client';
import { declareDomainOutcome } from '../domain-outcome';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';
import { runReadTransaction, checkHealth } from '@/lib/graph';
import { createRadarProjectionEvent } from '@/lib/radar-projection-sync';
import { runProjectionReconciliationCycle } from '@/lib/graph/projection-reconciliation-runner';
import { loadEligibleSignalProjectionIds } from '@/lib/graph/signal-projection-policy-admin';
import { toMillis } from '../utils';
import { parseCorrelationId } from '@/lib/observability/correlation';
import { resolveRelationSourceFingerprint } from '@/lib/relation-source-version';
import { STRUCTURAL_EDGE_REPAIRS } from './structural-edge-repairs';

const log = createLogger('inngest/reconcile-firestore-neo4j');

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface RadarVersion {
  id: string;
  updatedAt: number;
}

interface Neo4jRadarVersion {
  id: string;
  updatedAt: number | null;
}

/**
 * What one full-sync step actually did.
 *
 * Returned rather than accumulated in the closure so a replay reads the
 * memoized truth instead of a zeroed counter.
 */
interface SyncStepResult {
  synced: number;
  errors: string[];
}

/** Maximum errors carried in a durable step result (prevents unbounded growth). */
const MAX_REPORT_ERRORS = 50;

// ============================================================================
// REMOVED LEGACY MODE (PERF-007)
// ============================================================================

export const REMOVED_LEGACY_RECONCILIATION_MODE_ENV = 'GRAPH_RECONCILIATION_LEGACY_MODE';

/**
 * Reject the removed pre-GRAPH-033 reconciler selector.
 *
 * The legacy scheduled path recorded its work by mutating a handler-closure
 * report and returned nothing from any of its 16 steps. On replay the global
 * `MAX_SYNCS_PER_CYCLE` bound reset to zero (so a retrying cycle could exceed
 * its cap), the returned report was the zeroed initial value, and the relation
 * step's "are entities in sync" gate read that zero and changed branches. None
 * of its sends carried an event ID, so nothing deduplicated the re-send.
 *
 * It is removed rather than repaired because the default path already is the
 * contract it would have to be rewritten into.
 *
 * Rejected loudly rather than ignored: an operator who still sets this expects
 * a *different algorithm* to be running. Silently substituting the default one
 * would be precisely the false-state failure this contract exists to prevent.
 * Only the value that used to select the legacy path is rejected — an inert
 * leftover `false` keeps the behavior it already had.
 */
export function assertLegacyReconciliationModeRemoved(
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  if (env[REMOVED_LEGACY_RECONCILIATION_MODE_ENV] !== 'true') return;
  throw new Error(
    `${REMOVED_LEGACY_RECONCILIATION_MODE_ENV}=true selects a reconciler that was removed in PERF-007 ` +
      'because it lost its global dispatch bound and returned a fabricated report on replay. ' +
      'Unset the variable; the fair per-kind cursor reconciler is the only supported path.'
  );
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get count of entities in Firestore collection (admin SDK; works server-side).
 */
async function getFirestoreCount(collectionName: string): Promise<number> {
  const snapshot = await db.collection(collectionName).get();
  return snapshot.size;
}

/**
 * Get IDs of all entities in Firestore collection (admin SDK).
 */
async function getFirestoreIds(collectionName: string): Promise<string[]> {
  const snapshot = await db.collection(collectionName).get();
  return snapshot.docs.map((d) => d.id);
}

/** Load the source versions needed to repair both missing and stale Radars. */
async function getFirestoreRadarVersions(): Promise<RadarVersion[]> {
  const snapshot = await db.collection('radars').get();
  return snapshot.docs.map((doc) => {
    const data = doc.data() as { createdAt?: unknown; updatedAt?: unknown };
    return {
      id: doc.id,
      updatedAt: toMillis(data.updatedAt, toMillis(data.createdAt, 0)),
    };
  });
}

/**
 * Get count of entities in Neo4j by label
 */
async function getNeo4jCount(label: string): Promise<number> {
  try {
    const result = await runReadTransaction<{ count: number }>(`MATCH (n:${label}) RETURN count(n) as count`, {});
    return result.records[0]?.count || 0;
  } catch (error) {
    log.error('Error counting entities in Neo4j', error instanceof Error ? error : undefined, { label });
    return 0;
  }
}

/**
 * Get IDs of all entities in Neo4j by label
 */
async function getNeo4jIds(label: string): Promise<string[]> {
  try {
    const result = await runReadTransaction<{ id: string }>(`MATCH (n:${label}) RETURN n.id as id`, {});
    return result.records.map((r) => r.id);
  } catch (error) {
    log.error('Error getting entity IDs from Neo4j', error instanceof Error ? error : undefined, { label });
    return [];
  }
}

/** Only placements with both structural endpoints are converged. */
async function getNeo4jCompleteRadarPlacementIds(): Promise<string[]> {
  try {
    const result = await runReadTransaction<{ id: string }>(
      `MATCH (placement:RadarPlacement)-[:ON_RADAR]->(:Radar)
       WHERE EXISTS { (placement)-[:PLACES]->(:Entity) }
       RETURN DISTINCT placement.id AS id`,
      {}
    );
    return result.records.map((record) => record.id);
  } catch (error) {
    log.error('Error getting complete RadarPlacement IDs from Neo4j', error instanceof Error ? error : undefined);
    return [];
  }
}

/** Load projected Radar versions; skeleton nodes made by placements return null. */
async function getNeo4jRadarVersions(): Promise<Neo4jRadarVersion[]> {
  try {
    const result = await runReadTransaction<{ id: string; updatedAt: unknown }>(
      'MATCH (radar:Radar) RETURN radar.id AS id, radar.updatedAt AS updatedAt',
      {}
    );
    return result.records.map((record) => {
      const raw = record.updatedAt;
      const normalized =
        typeof raw === 'number'
          ? raw
          : raw && typeof raw === 'object' && 'toNumber' in raw && typeof raw.toNumber === 'function'
            ? raw.toNumber()
            : null;
      return { id: record.id, updatedAt: normalized };
    });
  } catch (error) {
    log.error('Error getting Radar versions from Neo4j', error instanceof Error ? error : undefined);
    return [];
  }
}

/**
 * Find missing entity IDs (in Firestore but not in Neo4j)
 */
function findMissingIds(firestoreIds: string[], neo4jIds: string[]): string[] {
  const neo4jSet = new Set(neo4jIds);
  return firestoreIds.filter((id) => !neo4jSet.has(id));
}

function findOutOfSyncRadars(
  firestoreRadars: RadarVersion[],
  neo4jRadars: Neo4jRadarVersion[]
): { missing: RadarVersion[]; stale: RadarVersion[] } {
  const neo4jById = new Map(neo4jRadars.map((radar) => [radar.id, radar.updatedAt]));
  const missing: RadarVersion[] = [];
  const stale: RadarVersion[] = [];

  for (const radar of firestoreRadars) {
    if (!neo4jById.has(radar.id)) {
      missing.push(radar);
    } else if (neo4jById.get(radar.id) !== radar.updatedAt) {
      stale.push(radar);
    }
  }

  return { missing, stale };
}

/**
 * Stable per-item event identity for a full sync.
 *
 * Derived from the triggering event so it is identical across a replay of the
 * same run — Inngest then deduplicates the re-send — while two genuinely
 * separate full syncs get distinct IDs and both dispatch.
 */
function fullSyncEventId(runKey: string, kind: string, id: string): string {
  return `full-sync-v1:${runKey}:${kind}:${id}`;
}

/**
 * Establish the run identity every deterministic event ID is derived from.
 *
 * Fails closed rather than substituting a constant: a shared fallback key would
 * make Inngest deduplicate a *later* disaster-recovery run against an earlier
 * one and silently drop all of its work.
 */
function requireFullSyncRunKey(eventId: unknown): string {
  if (typeof eventId === 'string' && eventId.trim().length > 0) return eventId;
  throw new Error('Full sync requires a triggering event ID to derive replay-stable dispatch identity');
}

/**
 * Trigger sync for a missing entity
 */
async function triggerEntitySync(
  entityType:
    | 'company'
    | 'technology'
    | 'strategy'
    | 'painPoint'
    | 'useCase'
    | 'document'
    | 'signal'
    | 'orgUnit'
    | 'initiative'
    | 'prototype',
  entityId: string,
  eventId: string
): Promise<void> {
  if (entityType === 'technology') {
    await inngest.send({
      id: eventId,
      name: 'app/technology.sync.requested',
      data: {
        operation: 'create',
        technologyId: entityId,
      },
    });
  } else {
    await inngest.send({
      id: eventId,
      name: 'app/unified-entity.sync.requested',
      data: {
        operation: 'create',
        entityType,
        entityId,
      },
    });
  }
}

/**
 * Trigger sync for a missing relation
 */
async function triggerRelationSync(relationId: string, source: unknown, eventId: string): Promise<void> {
  const raw = source && typeof source === 'object' && !Array.isArray(source) ? (source as Record<string, unknown>) : {};
  const sourceCorrelationId =
    raw.sourceCorrelationId === undefined ? undefined : parseCorrelationId(raw.sourceCorrelationId);
  if (raw.sourceCorrelationId !== undefined && !sourceCorrelationId) {
    throw new Error(`Malformed relation ${relationId}: invalid source correlation metadata`);
  }
  const sourceFingerprint = resolveRelationSourceFingerprint(raw.sourceFingerprint);
  await inngest.send({
    id: eventId,
    name: 'app/relation.sync.requested',
    data: {
      operation: 'create',
      relationId,
      ...(sourceCorrelationId ? { correlationId: sourceCorrelationId } : {}),
      ...(sourceFingerprint ? { sourceFingerprint } : {}),
    },
  });
}

/**
 * Trigger sync for a missing radar placement
 */
async function triggerPlacementSync(placementId: string, eventId: string): Promise<void> {
  await inngest.send({
    id: eventId,
    name: 'app/radar-placement.sync.requested',
    data: {
      operation: 'create',
      placementId,
    },
  });
}

/**
 * Trigger the same deterministic Radar projection handoff as Admin writes.
 *
 * `createRadarProjectionEvent` already derives its own event ID from
 * `(id, sourceUpdatedAt, dispatchKey)`, so a stable dispatch key is all this
 * path needs to be replay-deduplicated.
 */
async function triggerRadarSync(radar: RadarVersion, dispatchKey: string): Promise<void> {
  const accepted = await inngest.send(
    createRadarProjectionEvent({ id: radar.id, updatedAt: radar.updatedAt }, dispatchKey)
  );
  if (!accepted.ids?.length) {
    throw new Error('Inngest accepted no Radar projection event');
  }
}

/**
 * Trigger sync for a missing concept
 */
async function triggerConceptSync(conceptId: string, eventId: string): Promise<void> {
  await inngest.send({
    id: eventId,
    name: 'app/concept.sync.requested',
    data: {
      operation: 'create',
      conceptId,
    },
  });
}

/**
 * Trigger sync for a missing document (dedicated sync function)
 */
async function triggerDocumentSync(documentId: string, eventId: string): Promise<void> {
  await inngest.send({
    id: eventId,
    name: 'app/document.sync.requested',
    data: {
      operation: 'create',
      documentId,
    },
  });
}

async function triggerEntityDocumentLinkSync(linkId: string, eventId: string): Promise<void> {
  const accepted = await inngest.send({
    id: eventId,
    name: 'app/entity-document-link.sync.requested',
    data: { operation: 'update' as const, linkId },
  });
  if (!accepted.ids?.length) throw new Error('Inngest accepted no entity-document-link projection event');
}

// ============================================================================
// RECONCILIATION JOB
// ============================================================================

/**
 * Automated reconciliation job.
 *
 * The entire cycle is one durable step, so the report a replay returns is the
 * memoized return value of that step rather than a re-derived guess. Bounding,
 * per-kind cursors, deterministic event IDs, and capped diagnostics all live in
 * `runProjectionReconciliationCycle`.
 */
export const reconcileFirestoreNeo4jJob = inngest.createFunction(
  {
    id: 'reconcile-firestore-neo4j',
    name: 'Reconcile Firestore to Neo4j',
    retries: 2,
    concurrency: { limit: 1 },
  },
  { cron: '*/15 * * * *' },

  async ({ step }) => {
    // A stale selector for the removed reconciler is a configuration error
    // regardless of maintenance state, so it is surfaced before the pause check.
    assertLegacyReconciliationModeRemoved();
    if (isMaintenancePaused()) return maintenanceSkip('reconcile-firestore-neo4j');

    await step.run('check-neo4j-health-v1', async () => {
      const health = await checkHealth();
      if (!health.healthy) throw new Error(`Neo4j not healthy: ${health.error}`);
      return health;
    });
    const report = await step.run('reconcile-projections-v1', runProjectionReconciliationCycle);

    // Structural repair safety net. These exact topology MERGEs are bounded and
    // idempotent; reverse entity/relation candidates in the report remain
    // strictly report-only.
    await step.run('fix-orphan-edges-v1', async () => {
      const { runWriteTransaction } = await import('@/lib/graph/neo4j-client');
      let orphanEdgesFixed = 0;
      for (const { cypher } of STRUCTURAL_EDGE_REPAIRS) {
        try {
          const result = await runWriteTransaction<{ fixed: number }>(cypher, {});
          orphanEdgesFixed += result.records[0]?.fixed ?? 0;
        } catch {
          // Historical safety-net behavior is best effort; parity/replay
          // failures above remain fail-closed and visible.
        }
      }
      return { orphanEdgesFixed };
    });

    // GRAPH-061 — verifier results whose target is gone. The deleters cascade
    // on every supported path; this is the backstop for verdicts that predate
    // the cascade or were stranded by a crash between two writes. Deletion is
    // bounded and idempotent, so a failure propagates (Inngest retries) rather
    // than silently leaving unanchored trust claims in the graph.
    const verifierCleanup = await step.run('reconcile-verifier-results-v1', async () => {
      const { reconcileOrphanedVerificationResults } = await import('@/lib/graph/verification');
      return reconcileOrphanedVerificationResults();
    });

    // ARUN-030 — REPORT-ONLY lineage audit. Deliberately not a repair: the failure
    // mode being guarded against is a pass that "resolves" absent AgentRun /
    // Episode / Reflection records by WRITING them, which would manufacture
    // lineage for work that never ran. It also separates genuinely missing lineage
    // from intentionally non-agent work (a build supervisor has no reflection
    // stage), so the number an operator sees is work rather than noise.
    const lineageAudit = await step.run('audit-mission-lineage-v1', async () => {
      const { auditMissionLineage } = await import('@/lib/mission-lineage-audit-admin');
      return auditMissionLineage();
    });

    log.info('Fair graph reconciliation completed', {
      syncsTriggered: report.syncsTriggered,
      agentRunRepairsApplied: report.repairsApplied,
      errors: report.errors.length,
      planHash: report.repairPlan.planHash,
      orphanedVerificationResultsDeleted: verifierCleanup.entityResultsDeleted,
      orphanedEdgeVerificationResultsDeleted: verifierCleanup.edgeResultsDeleted,
      lineageIncomplete: lineageAudit.incomplete,
      lineageDivergent: lineageAudit.divergent,
      lineageExempt: lineageAudit.exempt,
    });
    // OBS-001: this cycle's own business outcome. `report.errors.length === 0` is
    // the delivery test; the lineage audit is a report and never fails the cycle.
    return declareDomainOutcome(
      { success: report.errors.length === 0, report, verifierCleanup, lineageAudit },
      report.errors.length === 0 ? { outcome: 'success' } : { outcome: 'partial', reason: 'reconciliation-errors' }
    );
  }
);

// ============================================================================
// FULL SYNC JOB (for initial backfill)
// ============================================================================

/**
 * Full sync job for initial backfill or disaster recovery
 *
 * This job is designed for large-scale sync operations:
 * - Phase 1: Sync all entities (higher limits)
 * - Phase 2: Wait and verify entities are synced
 * - Phase 3: Sync all relations
 * - Phase 4: Replay all entity-document links after their endpoints
 *
 * Every phase step returns its own counters and bounded errors; the handler
 * accumulates only from those return values, so a replay reports what the run
 * actually did rather than a closure that was never re-mutated.
 *
 * **Trigger:** Manual event (`app/full-sync.requested`)
 * **Timeout:** 30 minutes
 * **Retries:** 1 attempt
 */
export const fullSyncJob = inngest.createFunction(
  {
    id: 'full-sync-firestore-neo4j',
    name: 'Full Sync Firestore to Neo4j',
    retries: 1,
  },

  // Manual ops hook — no in-app sender; trigger via Inngest dev UI / API for backfill / disaster recovery.
  { event: 'app/full-sync.requested' },

  async ({ event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('full-sync-firestore-neo4j');
    const runKey = requireFullSyncRunKey(event.id);
    const options = event.data as {
      phase?: 'entities' | 'relations' | 'links' | 'all';
      entityBatchSize?: number;
      relationBatchSize?: number;
      linkBatchSize?: number;
    };

    const phase = options?.phase || 'all';
    const entityBatchSize = options?.entityBatchSize || 100;
    const relationBatchSize = options?.relationBatchSize || 500;
    const linkBatchSize = options?.linkBatchSize || 500;

    let entitiesSynced = 0;
    let relationsSynced = 0;
    let documentLinksSynced = 0;
    const errors: string[] = [];

    /** Fold one durable step result into the run totals. */
    const absorb = (result: SyncStepResult, target: 'entities' | 'relations' | 'links'): void => {
      if (target === 'entities') entitiesSynced += result.synced;
      else if (target === 'relations') relationsSynced += result.synced;
      else documentLinksSynced += result.synced;
      for (const error of result.errors) {
        if (errors.length < MAX_REPORT_ERRORS) errors.push(error);
      }
    };

    try {
      // Check Neo4j health
      await step.run('check-neo4j-health', async () => {
        const health = await checkHealth();
        if (!health.healthy) {
          throw new Error(`Neo4j not healthy: ${health.error}`);
        }
        return health;
      });

      // ========================================
      // PHASE 1: SYNC ENTITIES
      // ========================================
      if (phase === 'entities' || phase === 'all') {
        // Define entity types that use unified sync (excluding documents which have dedicated sync)
        const entityConfigs = [
          { collection: 'companies', label: 'Company', type: 'company' as const },
          { collection: 'technologies', label: 'Technology', type: 'technology' as const },
          { collection: 'strategies', label: 'Strategy', type: 'strategy' as const },
          { collection: 'painPoints', label: 'PainPoint', type: 'painPoint' as const },
          { collection: 'use-cases', label: 'UseCase', type: 'useCase' as const },
          { collection: 'signals', label: 'Signal', type: 'signal' as const },
          { collection: 'org-units', label: 'OrgUnit', type: 'orgUnit' as const },
          { collection: 'initiatives', label: 'Initiative', type: 'initiative' as const },
          { collection: 'prototypes', label: 'Prototype', type: 'prototype' as const },
        ];

        for (const config of entityConfigs) {
          const result = await step.run(`full-sync-${config.type}`, async (): Promise<SyncStepResult> => {
            const firestoreIds =
              config.type === 'signal'
                ? await loadEligibleSignalProjectionIds()
                : await getFirestoreIds(config.collection);
            const neo4jIds = await getNeo4jIds(config.label);
            const missing = findMissingIds(firestoreIds, neo4jIds);

            log.info('Full sync entity status', {
              entityType: config.type,
              missing: missing.length,
              total: firestoreIds.length,
            });

            const stepResult: SyncStepResult = { synced: 0, errors: [] };
            // Process ALL missing entities (no upper limit)
            for (let i = 0; i < missing.length; i++) {
              try {
                await triggerEntitySync(config.type, missing[i], fullSyncEventId(runKey, config.type, missing[i]));
                stepResult.synced++;
              } catch (error) {
                if (stepResult.errors.length < MAX_REPORT_ERRORS) {
                  stepResult.errors.push(`${config.type} ${missing[i]}: ${(error as Error).message}`);
                }
              }

              // Rate limit: pause after every batch
              if ((i + 1) % entityBatchSize === 0) {
                log.info('Full sync entity progress', {
                  entityType: config.type,
                  processed: i + 1,
                  total: missing.length,
                });
                await new Promise((resolve) => setTimeout(resolve, 2000));
              }
            }
            return stepResult;
          });
          absorb(result, 'entities');
        }

        // Sync Documents (dedicated sync function)
        absorb(
          await step.run('full-sync-documents', async (): Promise<SyncStepResult> => {
            const firestoreIds = await getFirestoreIds('documents');
            const neo4jIds = await getNeo4jIds('Document');
            const missing = findMissingIds(firestoreIds, neo4jIds);

            log.info('Full sync documents status', { missing: missing.length, total: firestoreIds.length });

            const stepResult: SyncStepResult = { synced: 0, errors: [] };
            for (let i = 0; i < missing.length; i++) {
              try {
                await triggerDocumentSync(missing[i], fullSyncEventId(runKey, 'document', missing[i]));
                stepResult.synced++;
              } catch (error) {
                if (stepResult.errors.length < MAX_REPORT_ERRORS) {
                  stepResult.errors.push(`Document ${missing[i]}: ${(error as Error).message}`);
                }
              }

              if ((i + 1) % entityBatchSize === 0) {
                log.info('Full sync documents progress', { processed: i + 1, total: missing.length });
                await new Promise((resolve) => setTimeout(resolve, 2000));
              }
            }
            return stepResult;
          }),
          'entities'
        );

        // Sync missing and stale Radars before placements. This includes
        // standalone Radars that have no ON_RADAR relationship to create a
        // graph skeleton as a side effect.
        absorb(
          await step.run('full-sync-radars', async (): Promise<SyncStepResult> => {
            const firestoreRadars = await getFirestoreRadarVersions();
            const neo4jRadars = await getNeo4jRadarVersions();
            const outOfSync = findOutOfSyncRadars(firestoreRadars, neo4jRadars);
            const pending = [...outOfSync.missing, ...outOfSync.stale];

            log.info('Full sync radars status', {
              missing: outOfSync.missing.length,
              stale: outOfSync.stale.length,
              total: firestoreRadars.length,
            });

            const stepResult: SyncStepResult = { synced: 0, errors: [] };
            for (let i = 0; i < pending.length; i++) {
              try {
                await triggerRadarSync(pending[i], `full-sync:${runKey}`);
                stepResult.synced++;
              } catch (error) {
                if (stepResult.errors.length < MAX_REPORT_ERRORS) {
                  stepResult.errors.push(`Radar ${pending[i].id}: ${(error as Error).message}`);
                }
              }

              if ((i + 1) % entityBatchSize === 0) {
                log.info('Full sync radar progress', { processed: i + 1, total: pending.length });
                await new Promise((resolve) => setTimeout(resolve, 2000));
              }
            }
            return stepResult;
          }),
          'entities'
        );

        // Sync RadarPlacements
        absorb(
          await step.run('full-sync-radar-placements', async (): Promise<SyncStepResult> => {
            const firestoreIds = await getFirestoreIds('radarPlacements');
            const neo4jIds = await getNeo4jCompleteRadarPlacementIds();
            const missing = findMissingIds(firestoreIds, neo4jIds);

            log.info('Full sync radar placements status', { missing: missing.length, total: firestoreIds.length });

            const stepResult: SyncStepResult = { synced: 0, errors: [] };
            for (let i = 0; i < missing.length; i++) {
              try {
                await triggerPlacementSync(missing[i], fullSyncEventId(runKey, 'radarPlacement', missing[i]));
                stepResult.synced++;
              } catch (error) {
                if (stepResult.errors.length < MAX_REPORT_ERRORS) {
                  stepResult.errors.push(`RadarPlacement ${missing[i]}: ${(error as Error).message}`);
                }
              }

              if ((i + 1) % entityBatchSize === 0) {
                log.info('Full sync radar placements progress', { processed: i + 1, total: missing.length });
                await new Promise((resolve) => setTimeout(resolve, 2000));
              }
            }
            return stepResult;
          }),
          'entities'
        );

        // Sync Concepts
        absorb(
          await step.run('full-sync-concepts', async (): Promise<SyncStepResult> => {
            const firestoreIds = await getFirestoreIds('concepts');
            const neo4jIds = await getNeo4jIds('Concept');
            const missing = findMissingIds(firestoreIds, neo4jIds);

            log.info('Full sync concepts status', { missing: missing.length, total: firestoreIds.length });

            const stepResult: SyncStepResult = { synced: 0, errors: [] };
            for (let i = 0; i < missing.length; i++) {
              try {
                await triggerConceptSync(missing[i], fullSyncEventId(runKey, 'concept', missing[i]));
                stepResult.synced++;
              } catch (error) {
                if (stepResult.errors.length < MAX_REPORT_ERRORS) {
                  stepResult.errors.push(`Concept ${missing[i]}: ${(error as Error).message}`);
                }
              }

              if ((i + 1) % entityBatchSize === 0) {
                log.info('Full sync concepts progress', { processed: i + 1, total: missing.length });
                await new Promise((resolve) => setTimeout(resolve, 2000));
              }
            }
            return stepResult;
          }),
          'entities'
        );
      }

      // ========================================
      // PHASE 2: WAIT FOR ENTITIES TO SYNC
      // ========================================
      if (phase === 'all') {
        await step.sleep('wait-for-entity-sync', '2m');

        // Verify entities are synced
        await step.run('verify-entity-sync', async () => {
          const entityConfigs = [
            { collection: 'companies', label: 'Company' },
            { collection: 'technologies', label: 'Technology' },
          ];

          let totalMissing = 0;
          for (const config of entityConfigs) {
            const firestoreCount = await getFirestoreCount(config.collection);
            const neo4jCount = await getNeo4jCount(config.label);
            totalMissing += Math.max(0, firestoreCount - neo4jCount);
          }

          if (totalMissing > 20) {
            log.warn('Entities not fully synced yet - relations may fail', { totalMissing });
          }
          return { totalMissing };
        });
      }

      // ========================================
      // PHASE 3: SYNC RELATIONS
      // ========================================
      if (phase === 'relations' || phase === 'all') {
        absorb(
          await step.run('full-sync-relations', async (): Promise<SyncStepResult> => {
            const firestoreSnapshot = await db.collection('relations').get();
            const neo4jRels = await runReadTransaction<{ relationId: string }>(
              `
              MATCH ()-[r]->()
              WHERE type(r) <> 'PLACES' AND type(r) <> 'CONTAINS' AND type(r) <> 'HAS_CONCEPT'
              RETURN r.relationId as relationId
              `,
              {}
            );
            const neo4jRelSet = new Set(neo4jRels.records.map((r) => r.relationId));

            const missingRelations = firestoreSnapshot.docs.filter((document) => !neo4jRelSet.has(document.id));

            log.info('Full sync relations status', {
              missing: missingRelations.length,
              total: firestoreSnapshot.size,
            });

            const stepResult: SyncStepResult = { synced: 0, errors: [] };
            // Process ALL missing relations (no upper limit)
            for (let i = 0; i < missingRelations.length; i++) {
              try {
                await triggerRelationSync(
                  missingRelations[i].id,
                  missingRelations[i].data(),
                  fullSyncEventId(runKey, 'relation', missingRelations[i].id)
                );
                stepResult.synced++;
              } catch (error) {
                if (stepResult.errors.length < MAX_REPORT_ERRORS) {
                  stepResult.errors.push(`Relation ${missingRelations[i].id}: ${(error as Error).message}`);
                }
              }

              // Rate limit: pause after every batch
              if ((i + 1) % relationBatchSize === 0) {
                log.info('Full sync relations progress', { processed: i + 1, total: missingRelations.length });
                await new Promise((resolve) => setTimeout(resolve, 3000));
              }
            }
            return stepResult;
          }),
          'relations'
        );
      }

      // ========================================
      // PHASE 4: REPLAY DOCUMENT LINKS
      // ========================================
      if (phase === 'links' || phase === 'all') {
        absorb(
          await step.run('full-sync-document-links', async (): Promise<SyncStepResult> => {
            const snapshot = await db.collection('entityDocumentLinks').select().get();
            const linkIds = snapshot.docs.map((document) => document.id);

            log.info('Full sync entity-document links status', { total: linkIds.length });
            const stepResult: SyncStepResult = { synced: 0, errors: [] };
            for (let i = 0; i < linkIds.length; i++) {
              try {
                await triggerEntityDocumentLinkSync(linkIds[i], fullSyncEventId(runKey, 'documentLink', linkIds[i]));
                stepResult.synced++;
              } catch (error) {
                if (stepResult.errors.length < MAX_REPORT_ERRORS) {
                  stepResult.errors.push(`EntityDocumentLink ${linkIds[i]}: ${(error as Error).message}`);
                }
              }
              if ((i + 1) % linkBatchSize === 0) {
                log.info('Full sync entity-document links progress', { processed: i + 1, total: linkIds.length });
                await new Promise((resolve) => setTimeout(resolve, 3000));
              }
            }
            return stepResult;
          }),
          'links'
        );
      }

      // Log summary. Reads the accumulated return values, so a replay logs the
      // same totals the caller returns rather than a zeroed closure.
      log.info('Full sync completed', {
        phase,
        entitiesSynced,
        relationsSynced,
        documentLinksSynced,
        errorCount: errors.length,
      });
      if (errors.length > 0) {
        log.error('Full sync errors', undefined, { errors: errors.slice(0, 20) });
      }

      return {
        success: errors.length === 0,
        phase,
        entitiesSynced,
        relationsSynced,
        documentLinksSynced,
        errors,
      };
    } catch (error) {
      log.error('Full sync failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }
);
