/**
 * @file lib/inngest/functions/daily-pipeline.ts
 * @description Daily pipeline orchestration for automated freshness
 *
 * This function runs daily or on an authenticated manual trigger and coordinates:
 * 1. Ingest   - Process new signals
 * 2. Extract  - Extract entities from signals
 * 3. Resolve  - Deduplicate entities (fuzzy matching)
 * 4. Claim    - Propose relations (AI-based)
 * 5. Compute  - Calculate trends and alignment scores
 * 6. Refresh  - Update graph projection
 *
 * **Execution Flow:**
 * 1. Triggered on schedule or by `app/pipeline.trigger`
 * 2. Each step is idempotent and can be retried
 * 3. Progress is tracked in Firestore
 * 4. Failures trigger notifications
 *
 * **Retry Strategy:**
 * - Max retries: 3
 * - Backoff: Exponential (2min, 5min, 15min)
 * - Each step has its own timeout
 *
 * @phase Phase 6: Daily Pipeline
 * @author Radarist Team
 * @created 2026-01-09
 */

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { createLogger } from '@/lib/logger';
import { parseCorrelationId } from '@/lib/observability/correlation';

const log = createLogger('inngest/daily-pipeline');
import { countAssertionStructuralDrift } from '@/lib/graph/assertion-integrity';
import { cleanupOldRejectedProposals, cleanupOrphanedProposals } from '@/lib/proposed-relations-admin';
import { adminCleanupOrphanedRelations } from '@/lib/relations-admin';
import {
  DAILY_PIPELINE_STATUS_POLICY,
  selectSignalsForStep,
  summarizeEnrichmentCoverage,
} from '@/lib/signals/daily-pipeline-policy';
import type { Signal, SignalStatus } from '@/lib/types';

// ---------------------------------------------------------------------------
// Admin-SDK direct reader for the early-pipeline path.
//
// Same bug class as the 2026-05-12 fetch-signals fix: going through
// @/lib/system-config or @/lib/signals (which import the client SDK) hangs
// gRPC Listen streams server-side and silently fails the cron. The daily
// pipeline had been affected since 2026-05-11 along with fetch-signals.
//
// These helpers bypass the service-module chain for the two early-pipeline
// read. The cleanup functions (cleanupOldRejectedProposals,
// cleanupOrphanedProposals, adminCleanupOrphanedRelations) run LATER in the
// pipeline and have been migrated to the *-admin.ts helpers (admin SDK) so
// they no longer leak gRPC Listen streams server-side. They remain wrapped in
// step.run so an individual cleanup hang doesn't block earlier steps' results.
// ---------------------------------------------------------------------------

/**
 * Load every signal whose status the policy admits for a step (DISC-017).
 *
 * Previously a single-status `where('status','==',…)` query, which structurally
 * could not express a multi-state lifecycle: a human-approved signal was
 * invisible to the whole pipeline. One `in` query covers the declared set (well
 * under Firestore's 30-value ceiling) and keeps the read count unchanged.
 */
async function loadSignalsForStatusesAdmin(statuses: readonly SignalStatus[]): Promise<Signal[]> {
  if (statuses.length === 0) return [];
  const { db: adminDb } = await import('@/lib/firebase-admin');
  const snap = await adminDb
    .collection('signals')
    .where('status', 'in', statuses as SignalStatus[])
    .get();
  const signals = snap.docs.map((d) => d.data() as unknown as Signal);
  // Sort in-memory by detectedAt (newest first) — matches signals-core behavior.
  signals.sort((a, b) => b.detectedAt - a.detectedAt);
  return signals;
}

/**
 * Recency window for the selection step. A signal is inside it when the LATER
 * of detection and human review falls within the window.
 */
const SELECTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Keep job-run output bounded while still proving which fixture entered. */
const SELECTION_RECEIPT_SIGNAL_LIMIT = 25;

function selectedSignalReceipt(signals: readonly Signal[]): {
  selectedSignalIdsSample: string[];
  selectedSignalIdsOmitted: number;
} {
  const selectedSignalIdsSample: string[] = [];
  for (const signal of signals) {
    if (selectedSignalIdsSample.length >= SELECTION_RECEIPT_SIGNAL_LIMIT) break;
    if (typeof signal.id === 'string' && signal.id.trim().length > 0) {
      selectedSignalIdsSample.push(signal.id);
    }
  }
  return {
    selectedSignalIdsSample,
    selectedSignalIdsOmitted: Math.max(0, signals.length - selectedSignalIdsSample.length),
  };
}

// ============================================================================
// TYPES
// ============================================================================

export interface PipelineStepResult {
  step: string;
  success: boolean;
  duration: number;
  itemsProcessed: number;
  errors?: string[];
  details?: Record<string, unknown>;
  /**
   * True when Inngest returned this step from its memoized result instead of
   * executing it on this request. DISC-017: an operator reading a replayed run
   * must be able to tell "this work happened earlier" from "this work happened
   * again" — the difference between an idempotent retry and a double write.
   */
  replayed: boolean;
  /**
   * Whether the step wrote anything durable. Several analysis steps are
   * in-memory only; reporting their item counts without this flag reads as
   * persisted work that never happened.
   */
  persisted: boolean;
}

export interface PipelineRunResult {
  /**
   * Domain outcome, not transport completion. `false` means the function
   * reached its final receipt but at least one degradable stage failed.
   */
  success: boolean;
  startedAt: number;
  completedAt: number;
  duration: number;
  steps: PipelineStepResult[];
  summary: {
    /**
     * Signals that passed the declared status + recency policy and entered the
     * analysis steps. NOT the number of rows read — see `selection.scanned`.
     */
    signalsProcessed: number;
    /**
     * In-memory analysis counts. These steps deliberately persist nothing, so
     * these are findings, not writes. `persisted: false` on the matching step.
     */
    entitiesExtracted: number;
    duplicatesResolved: number;
    relationsProposed: number;
    trendsComputed: number;
    /** Real durable writes performed by @/lib/pipeline/alignment-calculation. */
    alignmentScoresUpdated: number;
    graphNodesRefreshed: number;
  };
  /** DISC-017 — the exact query cohort and its recency selection. */
  selection: {
    /** Statuses applied by Firestore before rows enter this function. */
    queriedStatuses: readonly SignalStatus[];
    /** Rows returned by that bounded status query. */
    scanned: number;
    selected: number;
    skippedByRecency: number;
    /** Bounded proof of which signals entered this run. */
    selectedSignalIdsSample: readonly string[];
    /** Selected rows not represented in the bounded ID sample. */
    selectedSignalIdsOmitted: number;
  };
  /** DISC-017 — per-outcome alignment counts from the real calculator. */
  alignment: {
    processed: number;
    updated: number;
    skipped: number;
    failed: number;
  };
  /**
   * DISC-017 — enrichment coverage of the selected Approved cohort. Reported,
   * never performed: enrichment is owned solely by `enrich-liked-signals`, so
   * "exactly once" holds by single ownership rather than by coordination.
   */
  enrichment: {
    candidates: number;
    alreadyEnriched: number;
    awaitingOwner: number;
    owner: string;
  };
  /** Steps Inngest served from memoized results on this request. */
  stepsReplayed: number;
  /**
   * OBS-003 — the accepted request identity that triggered this run.
   *
   * Absent for a cron run, which has no accepted request. Present here so the
   * job-run `output` an operator reads names the request, closing the last hop
   * of the trigger → event → job → graph path.
   */
  correlationId?: string;
}

export interface PipelineStatus {
  isRunning: boolean;
  lastRunAt?: number;
  lastResult?: PipelineRunResult;
  nextScheduledAt?: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extract entities mentioned in signal content.
 * Uses AI to identify companies, technologies, and other entities.
 */
async function extractEntitiesFromSignals(
  signals: Signal[]
): Promise<{ signalId: string; entities: Array<{ type: string; name: string; confidence: number }> }[]> {
  const results: { signalId: string; entities: Array<{ type: string; name: string; confidence: number }> }[] = [];

  for (const signal of signals) {
    // Extract from linkedEntities and expandedContent
    const entities: Array<{ type: string; name: string; confidence: number }> = [];

    if (signal.linkedEntities?.technologies) {
      for (const techId of signal.linkedEntities.technologies) {
        entities.push({ type: 'technology', name: techId, confidence: 80 });
      }
    }

    if (signal.linkedEntities?.companies) {
      for (const companyId of signal.linkedEntities.companies) {
        entities.push({ type: 'company', name: companyId, confidence: 80 });
      }
    }

    if (signal.expandedContent?.relatedItems?.technologies) {
      for (const tech of signal.expandedContent.relatedItems.technologies) {
        entities.push({ type: 'technology', name: tech.name, confidence: 70 });
      }
    }

    if (signal.expandedContent?.relatedItems?.companies) {
      for (const company of signal.expandedContent.relatedItems.companies) {
        entities.push({ type: 'company', name: company.name, confidence: 70 });
      }
    }

    results.push({ signalId: signal.id, entities });
  }

  return results;
}

/**
 * Find and resolve duplicate entities using fuzzy matching.
 */
async function deduplicateEntities(
  entityNames: Array<{ type: string; name: string }>
): Promise<{ merged: number; duplicates: Array<{ canonical: string; duplicates: string[] }> }> {
  // Simple fuzzy matching based on normalized names
  const normalizedMap = new Map<string, string[]>();

  for (const entity of entityNames) {
    const normalized = entity.name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .trim();

    if (!normalizedMap.has(normalized)) {
      normalizedMap.set(normalized, []);
    }
    normalizedMap.get(normalized)!.push(entity.name);
  }

  const duplicates: Array<{ canonical: string; duplicates: string[] }> = [];
  let merged = 0;

  for (const [, names] of normalizedMap) {
    if (names.length > 1) {
      // First name is canonical
      duplicates.push({
        canonical: names[0],
        duplicates: names.slice(1),
      });
      merged += names.length - 1;
    }
  }

  return { merged, duplicates };
}

/**
 * Propose relations between entities based on signal co-occurrence.
 */
async function proposeRelations(
  extractionResults: Array<{ signalId: string; entities: Array<{ type: string; name: string; confidence: number }> }>
): Promise<
  Array<{
    sourceType: string;
    sourceName: string;
    targetType: string;
    targetName: string;
    confidence: number;
    signalId: string;
  }>
> {
  const relations: Array<{
    sourceType: string;
    sourceName: string;
    targetType: string;
    targetName: string;
    confidence: number;
    signalId: string;
  }> = [];

  for (const result of extractionResults) {
    const entities = result.entities;

    // Create relations between entities mentioned in the same signal
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const source = entities[i];
        const target = entities[j];

        // Calculate confidence based on entity confidences
        const confidence = Math.round((source.confidence + target.confidence) / 2);

        if (confidence >= 60) {
          relations.push({
            sourceType: source.type,
            sourceName: source.name,
            targetType: target.type,
            targetName: target.name,
            confidence,
            signalId: result.signalId,
          });
        }
      }
    }
  }

  return relations;
}

/**
 * Recalculate alignment scores against current strategies.
 *
 * DISC-017: this used to be a local no-op that returned a hardcoded
 * `updated: 0` while `@/lib/pipeline/alignment-calculation` — which already
 * accepted multiple statuses and genuinely wrote scores — sat with zero
 * production callers. It now delegates to that real calculator, using the
 * statuses declared in the status policy.
 *
 * Dynamic import for the same reason `refreshGraphProjection` uses one: the
 * module's admin-SDK dependency chain must not load at worker module init
 * (see the Inngest static-import rule at the top of this file).
 *
 * Replay-safety: the calculator only writes when the score moves by at least
 * `minScoreChange`. On a replay the stored score is already the recalculated
 * value, so the delta is ~0 and the row is counted as skipped rather than
 * written a second time.
 *
 * Failures degrade to a zero result with the error counted, so one bad
 * strategy cannot fail the whole pipeline.
 */
async function recalculateAlignmentScores(): Promise<{
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
}> {
  try {
    const { recalculateAlignmentScores: runAlignment } = await import('@/lib/pipeline/alignment-calculation');
    const result = await runAlignment({
      signalStatuses: [...DAILY_PIPELINE_STATUS_POLICY['recalculate-alignment'].statuses],
    });
    return {
      processed: result.processedSignals,
      updated: result.updatedSignals,
      skipped: result.skippedSignals,
      failed: result.errors.length,
    };
  } catch (error) {
    log.error('Alignment recalculation failed', error instanceof Error ? error : undefined);
    return { processed: 0, updated: 0, skipped: 0, failed: 1 };
  }
}

/**
 * Refresh Neo4j graph with latest entities.
 *
 * Delegates to the real refresh service (src/lib/pipeline/graph-refresh.ts):
 * health check, cache invalidation, and Firestore→Neo4j entity re-sync.
 * Dynamic import keeps the module's admin-SDK dependency chain out of the
 * worker's module init, preserving the Inngest static-import boundary.
 * Failures are logged and returned as an explicitly degraded stage so the
 * rest of the pipeline can finish without persisting a false clean result.
 */
type GraphRefreshFailureReason = 'unhealthy' | 'entity-errors' | 'incomplete' | 'exception';

interface DailyPipelineGraphRefreshResult {
  success: boolean;
  nodesRefreshed: number;
  relationsRefreshed: number;
  failed: number;
  failureReason?: GraphRefreshFailureReason;
}

async function refreshGraphProjection(correlationId?: string): Promise<DailyPipelineGraphRefreshResult> {
  try {
    const { refreshGraphProjection: runGraphRefresh } = await import('@/lib/pipeline/graph-refresh');
    // OBS-003: the accepted request identity reaches the graph writes this stage
    // performs, so an operator can join a projection back to the trigger. Spread
    // conditionally — a cron run has no accepted request and must not carry one.
    const result = await runGraphRefresh({ clearCache: true, ...(correlationId ? { correlationId } : {}) });

    if (!result.healthStatus.healthy) {
      log.warn('Graph service unhealthy, refresh skipped');
    }
    if (result.errors.length > 0) {
      log.warn('Graph refresh completed with entity errors', { errorCount: result.errors.length });
    }

    const failed = result.errors.length;
    const failureReason: GraphRefreshFailureReason | undefined = !result.healthStatus.healthy
      ? 'unhealthy'
      : failed > 0
        ? 'entity-errors'
        : !result.success
          ? 'incomplete'
          : undefined;

    return {
      success: failureReason === undefined,
      nodesRefreshed: result.nodesRefreshed,
      relationsRefreshed: result.relationsRefreshed,
      failed,
      ...(failureReason ? { failureReason } : {}),
    };
  } catch (error) {
    log.error('Graph refresh failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      nodesRefreshed: 0,
      relationsRefreshed: 0,
      failed: 1,
      failureReason: 'exception',
    };
  }
}

function graphRefreshError(result: DailyPipelineGraphRefreshResult): string | undefined {
  switch (result.failureReason) {
    case 'unhealthy':
      return 'Graph service was unhealthy';
    case 'entity-errors':
      return `${result.failed} graph entity refresh ${result.failed === 1 ? 'failure' : 'failures'}`;
    case 'incomplete':
      return 'Graph refresh did not complete successfully';
    case 'exception':
      return 'Graph refresh failed';
    default:
      return undefined;
  }
}

// ============================================================================
// INNGEST FUNCTION
// ============================================================================

/**
 * Daily pipeline orchestration function
 *
 * **Trigger:** Authenticated manual request or daily schedule
 * **Timeout:** 30 minutes total
 * **Retries:** 3 attempts with exponential backoff
 */
export const dailyPipeline = inngest.createFunction(
  {
    id: 'daily-pipeline',
    name: 'Daily Pipeline',
    retries: 3,
    concurrency: { limit: 1 },

    onFailure: async ({ error }) => {
      log.error('Daily pipeline final failure', new Error(error.message));

      await inngest.send({
        name: 'app/pipeline.failed',
        data: {
          pipeline: 'daily',
          error: error.message,
          failedAt: Date.now(),
          severity: 'high',
        },
      });
    },
  },

  // Manual API/tool event or schedule (8 AM UTC)
  [{ event: 'app/pipeline.trigger' }, { cron: '0 8 * * *' }],

  async ({ event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('daily-pipeline');
    const startedAt = Date.now();
    // OBS-003 — bounded by the same rule as every other correlation ingress: the
    // exact opaque token or nothing. Unrecognised caller text is discarded, never
    // threaded into events, receipts, or graph properties.
    //
    // Read through an index rather than a property: this handler serves BOTH the
    // manual `app/pipeline.trigger` event and the cron trigger, and the cron
    // member of that union carries no request identity at all — which is exactly
    // the case that must resolve to `undefined`.
    const correlationId =
      parseCorrelationId((event?.data as Record<string, unknown> | undefined)?.correlationId) ?? undefined;

    // DISC-017 — replay-safe step accounting.
    //
    // Every `steps.push(...)` used to sit INSIDE a `step.run` callback. On an
    // Inngest replay those callbacks never execute — the memoized result is
    // returned instead — so `steps` came back empty while `summary` was fully
    // populated from memoized values, and the error path reported empty
    // completed/failed step lists. Records are now assembled in handler scope,
    // which runs on EVERY request, and each record reports whether its step
    // actually executed this time. `cleanupOrphans` already uses this shape.
    const stepRecords: PipelineStepResult[] = [];
    const executedThisRequest = new Set<string>();

    /** Assemble one step record in handler scope (replay-visible). */
    const recordStep = (
      id: string,
      persisted: boolean,
      outcome: {
        durationMs: number;
        itemsProcessed: number;
        details?: Record<string, unknown>;
        success?: boolean;
        errors?: string[];
      }
    ): void => {
      stepRecords.push({
        step: id,
        success: outcome.success ?? true,
        duration: outcome.durationMs,
        itemsProcessed: outcome.itemsProcessed,
        ...(outcome.details ? { details: outcome.details } : {}),
        ...(outcome.errors && outcome.errors.length > 0 ? { errors: outcome.errors } : {}),
        replayed: !executedThisRequest.has(id),
        persisted,
      });
    };

    // PERF-005: the Inngest job-run-tracking middleware already persists one
    // stable `inngest-<runId>` job-runs record with a real lifecycle. The
    // previous manual observable-job writer added a SECOND, manually-keyed
    // record that never reached its completing writer on Inngest replay —
    // leaving permanently-"running" duplicate rows. Log to the run logger.
    log.info('Pipeline started', { triggeredBy: event.name, correlationId });

    try {
      // ==== Step 1: Select signals under the declared status policy ====
      const selection = await step.run('get-signals', async () => {
        executedThisRequest.add('get-signals');
        const stepStart = Date.now();

        const policy = DAILY_PIPELINE_STATUS_POLICY['get-signals'];
        const scanned = await loadSignalsForStatusesAdmin(policy.statuses);
        // Recency uses the LATER of detection and human review, so a signal
        // detected outside the window but approved inside it still enters —
        // the exact case that previously "processed zero".
        const chosen = selectSignalsForStep('get-signals', scanned, {
          now: Date.now(),
          windowMs: SELECTION_WINDOW_MS,
        });
        const enrichment = summarizeEnrichmentCoverage(chosen.signals);
        const receipt = selectedSignalReceipt(chosen.signals as Signal[]);

        log.info('Selected signals under status policy', {
          statuses: policy.statuses,
          scanned: chosen.scanned,
          selected: chosen.selected,
          skippedByRecency: chosen.skippedByRecency,
          enrichmentAwaitingOwner: enrichment.awaitingOwner,
        });

        return {
          // This value is memoized with the first step, so the final handler
          // request can report whole-run time instead of only its own replay.
          pipelineStartedAt: startedAt,
          signals: chosen.signals as Signal[],
          tally: {
            queriedStatuses: [...policy.statuses],
            scanned: chosen.scanned,
            selected: chosen.selected,
            skippedByRecency: chosen.skippedByRecency,
            ...receipt,
          },
          enrichment,
          itemsProcessed: chosen.selected,
          details: {
            statuses: [...policy.statuses],
            scanned: chosen.scanned,
            skippedByRecency: chosen.skippedByRecency,
            ...receipt,
          },
          durationMs: Date.now() - stepStart,
        };
      });
      recordStep('get-signals', false, selection);
      const signals = selection.signals;
      const runStartedAt =
        typeof selection.pipelineStartedAt === 'number' &&
        Number.isFinite(selection.pipelineStartedAt) &&
        selection.pipelineStartedAt > 0
          ? selection.pipelineStartedAt
          : startedAt;
      // A run that was already in flight when this receipt field shipped may
      // replay a legacy memoized get-signals result. Reconstruct the bounded
      // proof from that result instead of persisting an interface-shaped lie.
      const fallbackSelectionReceipt = selectedSignalReceipt(signals);
      const selectionResult: PipelineRunResult['selection'] = {
        queriedStatuses: selection.tally.queriedStatuses,
        scanned: selection.tally.scanned,
        selected: selection.tally.selected,
        skippedByRecency: selection.tally.skippedByRecency,
        selectedSignalIdsSample:
          selection.tally.selectedSignalIdsSample ?? fallbackSelectionReceipt.selectedSignalIdsSample,
        selectedSignalIdsOmitted:
          selection.tally.selectedSignalIdsOmitted ?? fallbackSelectionReceipt.selectedSignalIdsOmitted,
      };

      // ==== Step 2: Extract entities from signals (analysis only) ====
      const extraction = await step.run('extract-entities', async () => {
        executedThisRequest.add('extract-entities');
        const stepStart = Date.now();

        const results = await extractEntitiesFromSignals(signals);
        const totalEntities = results.reduce((sum, r) => sum + r.entities.length, 0);

        log.info('Extracted entities from signals', { totalEntities, signalCount: results.length });
        return {
          results,
          itemsProcessed: totalEntities,
          details: { signalsProcessed: results.length, analysisOnly: true },
          durationMs: Date.now() - stepStart,
        };
      });
      recordStep('extract-entities', false, extraction);
      const extractionResults = extraction.results;

      // ==== Step 4: Deduplicate entities (analysis only) ====
      const deduplication = await step.run('deduplicate-entities', async () => {
        executedThisRequest.add('deduplicate-entities');
        const stepStart = Date.now();

        // Flatten all entities
        const allEntities = extractionResults.flatMap((r) => r.entities.map((e) => ({ type: e.type, name: e.name })));

        const result = await deduplicateEntities(allEntities);

        log.info('Resolved duplicate entities', { merged: result.merged });
        return {
          result,
          itemsProcessed: result.merged,
          details: { duplicateSets: result.duplicates.length, analysisOnly: true },
          durationMs: Date.now() - stepStart,
        };
      });
      recordStep('deduplicate-entities', false, deduplication);
      const deduplicationResult = deduplication.result;

      // ==== Step 5: Identify relation candidates (analysis only) ====
      const relationCandidates = await step.run('propose-relations', async () => {
        executedThisRequest.add('propose-relations');
        const stepStart = Date.now();

        const relations = await proposeRelations(extractionResults);

        log.info('Identified relation candidates', { count: relations.length });
        return {
          relations,
          itemsProcessed: relations.length,
          details: { analysisOnly: true },
          durationMs: Date.now() - stepStart,
        };
      });
      recordStep('propose-relations', false, relationCandidates);
      const proposedRelations = relationCandidates.relations;

      // ==== Step 6: Compute trends ====
      const trends = await step.run('compute-trends', async () => {
        executedThisRequest.add('compute-trends');
        const stepStart = Date.now();

        // Narrow admin helper: `@/lib/trends` does
        // client-SDK Firestore reads/writes (getTrends/updateTrend), which
        // fail in the Inngest worker with `code: 'unavailable'`. Use the
        // admin-SDK twin, dynamically imported inside step.run.
        const { adminComputeTrends } = await import('@/lib/trends-admin');
        const result = await adminComputeTrends({
          lookbackDays: 30,
          maxClusters: 15,
          minSignalsPerCluster: 2,
        });

        log.info('Computed trends', { created: result.created, updated: result.updated });
        return {
          result,
          itemsProcessed: result.created + result.updated,
          details: {
            created: result.created,
            updated: result.updated,
            deleted: result.deleted,
            // Trends runs its own query; the policy records the narrower set.
            statuses: [...DAILY_PIPELINE_STATUS_POLICY['compute-trends'].statuses],
          },
          durationMs: Date.now() - stepStart,
        };
      });
      recordStep('compute-trends', true, trends);
      const trendResult = trends.result;

      // ==== Step 7: Recalculate alignment scores (real calculator) ====
      const alignment = await step.run('recalculate-alignment', async () => {
        executedThisRequest.add('recalculate-alignment');
        const stepStart = Date.now();

        const result = await recalculateAlignmentScores();

        log.info('Recalculated alignment scores', result);
        return {
          result,
          success: result.failed === 0,
          ...(result.failed > 0
            ? {
                errors: [
                  `${result.failed} alignment recalculation ${result.failed === 1 ? 'failure' : 'failures'}`,
                ],
              }
            : {}),
          itemsProcessed: result.updated,
          details: {
            ...result,
            statuses: [...DAILY_PIPELINE_STATUS_POLICY['recalculate-alignment'].statuses],
          },
          durationMs: Date.now() - stepStart,
        };
      });
      recordStep('recalculate-alignment', true, alignment);
      const alignmentResult = alignment.result;

      // ==== Step 8: Refresh graph projection ====
      const graph = await step.run('refresh-graph', async () => {
        executedThisRequest.add('refresh-graph');
        const stepStart = Date.now();

        const result = await refreshGraphProjection(correlationId);

        log.info('Refreshed graph', {
          nodesRefreshed: result.nodesRefreshed,
          relationsRefreshed: result.relationsRefreshed,
        });
        const error = graphRefreshError(result);
        return {
          result,
          success: result.success,
          ...(error ? { errors: [error] } : {}),
          itemsProcessed: result.nodesRefreshed + result.relationsRefreshed,
          details: { ...result },
          durationMs: Date.now() - stepStart,
        };
      });
      recordStep('refresh-graph', true, graph);
      const graphResult = graph.result;

      const failedSteps = stepRecords.filter((stage) => !stage.success).map((stage) => stage.step);
      const domainSuccess = failedSteps.length === 0;

      // ==== Step 9: Send completion event ====
      await step.run('send-completion', async () => {
        await inngest.send({
          name: 'app/pipeline.completed',
          data: {
            pipeline: 'daily',
            duration: Math.max(0, Date.now() - runStartedAt),
            signalsProcessed: signals.length,
            trendsComputed: trendResult.created + trendResult.updated,
            success: domainSuccess,
            failedSteps,
            ...(correlationId ? { correlationId } : {}),
          },
        });
      });

      // Build summary
      const summary: PipelineRunResult['summary'] = {
        signalsProcessed: signals.length,
        entitiesExtracted: extractionResults.reduce((sum, r) => sum + r.entities.length, 0),
        duplicatesResolved: deduplicationResult.merged,
        relationsProposed: proposedRelations.length,
        trendsComputed: trendResult.created + trendResult.updated,
        alignmentScoresUpdated: alignmentResult.updated,
        graphNodesRefreshed: graphResult.nodesRefreshed,
      };

      const completedAt = Date.now();
      const result: PipelineRunResult = {
        // A degraded dependency does not abort later accounting, but it must
        // not be persisted as a clean run. The job itself completed; this
        // domain-level success flag captures whether every stage did.
        success: domainSuccess,
        startedAt: runStartedAt,
        completedAt,
        duration: Math.max(0, completedAt - runStartedAt),
        steps: stepRecords,
        summary,
        selection: selectionResult,
        alignment: {
          processed: alignmentResult.processed,
          updated: alignmentResult.updated,
          skipped: alignmentResult.skipped,
          failed: alignmentResult.failed,
        },
        enrichment: selection.enrichment,
        stepsReplayed: stepRecords.filter((s) => s.replayed).length,
        ...(correlationId ? { correlationId } : {}),
      };

      log.info('Pipeline complete', {
        durationMs: result.duration,
        summary,
        selection: result.selection,
        alignment: result.alignment,
        enrichment: result.enrichment,
        stepsReplayed: result.stepsReplayed,
      });
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // stepRecords is handler-scoped, so these lists stay truthful on a replay
      // that fails partway — previously both were always empty.
      log.error('Pipeline failed', err, {
        triggeredBy: event.name,
        completedSteps: stepRecords.filter((s) => s.success).map((s) => s.step),
        replayedSteps: stepRecords.filter((s) => s.replayed).map((s) => s.step),
      });

      await inngest.send({
        name: 'app/pipeline.failed',
        data: {
          pipeline: 'daily',
          error: err.message,
          stepsFailed: stepRecords.filter((s) => !s.success).map((s) => s.step),
          ...(correlationId ? { correlationId } : {}),
        },
      });

      throw error;
    }
  }
);

/**
 * Cleanup orphaned data function
 *
 * Runs weekly to report Assertion integrity and clean up stale non-graph data.
 */
export const cleanupOrphans = inngest.createFunction(
  {
    id: 'cleanup-orphans',
    name: 'Cleanup Orphaned Data',
    retries: 2,
  },
  { cron: '0 3 * * 0' }, // Sunday at 3 AM UTC

  async ({ step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('cleanup-orphans');
    log.info('Starting orphan cleanup');
    const results: Record<string, number | null> = {};

    // Preserve the historical step ID for replay compatibility, but never
    // delete graph topology from this scheduled diagnostic.
    const assertionDiagnostic = (await step.run('cleanup-orphaned-claims', async () => {
      try {
        const structuralDrift = await countAssertionStructuralDrift();
        log.info('Inspected Assertion structural integrity', { structuralDrift });
        return { structuralDrift, deleted: 0 };
      } catch (error) {
        log.error('Failed to inspect Assertion structural integrity', error instanceof Error ? error : undefined);
        return { structuralDrift: null, deleted: 0 };
      }
    })) ?? { structuralDrift: null, deleted: 0 };
    results.assertionStructuralDrift = assertionDiagnostic.structuralDrift;
    results.orphanedClaims = assertionDiagnostic.deleted;

    // Step 2: Archive old signals
    results.oldSignals = await step.run('archive-old-signals', async () => {
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000; // 90 days
      const oldSignals = await loadSignalsForStatusesAdmin(['Archived']);
      const toArchive = oldSignals.filter((s: Signal) => s.detectedAt < cutoff);

      // For now, just count them
      log.info('Found old signals', { count: toArchive.length });
      return toArchive.length;
    });

    // Step 3: Clean up old rejected proposed relations
    results.oldRejectedProposals = await step.run('cleanup-rejected-proposals', async () => {
      try {
        const deleted = await cleanupOldRejectedProposals();
        log.info('Deleted old rejected proposals', { count: deleted });
        return deleted;
      } catch (error) {
        log.error('Failed to cleanup old rejected proposals', error instanceof Error ? error : undefined);
        return 0;
      }
    });

    // Step 4: Clean up orphaned proposed relations (deleted entities)
    results.orphanedProposals = await step.run('cleanup-orphaned-proposals', async () => {
      try {
        const orphanResult = await cleanupOrphanedProposals();
        log.info('Deleted orphaned proposals', { count: orphanResult.deleted });
        return orphanResult.deleted;
      } catch (error) {
        log.error('Failed to cleanup orphaned proposals', error instanceof Error ? error : undefined);
        return 0;
      }
    });

    log.info('Cleanup complete', results);
    return results;
  }
);

/**
 * Daily consistency cleanup function
 *
 * Runs daily at 4 AM UTC to clean up orphaned Firestore/proposed relations
 * and report Neo4j Assertion integrity without mutating graph structure.
 *
 * This is a defense-in-depth mechanism to catch orphans from:
 * - Race conditions during concurrent deletes
 * - Partial failures where entity was deleted but relations weren't
 * - Past bugs where cascade deletes were missing
 */
export const consistencyCleanup = inngest.createFunction(
  {
    id: 'consistency-cleanup',
    name: 'Daily Consistency Cleanup',
    retries: 2,
  },
  { cron: '0 4 * * *' }, // Daily at 4 AM UTC

  async ({ step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('consistency-cleanup');
    log.info('Starting daily consistency cleanup');
    const results: Record<string, unknown> = {};

    // Step 1: Clean up orphaned Firestore relations
    results.firestoreRelations = await step.run('cleanup-orphaned-firestore-relations', async () => {
      try {
        const result = await adminCleanupOrphanedRelations();
        log.info('Firestore relations cleanup', {
          checked: result.checked,
          orphaned: result.orphaned,
          deleted: result.deleted,
        });
        return result;
      } catch (error) {
        log.error('Failed to cleanup orphaned Firestore relations', error instanceof Error ? error : undefined);
        return { checked: 0, orphaned: 0, deleted: 0, error: String(error) };
      }
    });

    // Neo4j cannot store a relationship without both endpoint nodes. Treating
    // a missing generic `id` property as an orphan is also invalid because
    // metadata labels use other canonical keys (RelationType uses `name`).
    // Keep this boundary diagnostic-only; repairs require the guarded operator
    // workflow and explicit approval.
    // Preserve the historical step id so an in-flight Inngest replay does not
    // execute a second step after deployment; only its implementation changes.
    results.neo4jAssertions = (await step.run('cleanup-orphaned-neo4j-relationships', async () => {
      try {
        const structuralDrift = await countAssertionStructuralDrift();
        if (structuralDrift > 0) {
          log.warn('Neo4j Assertion structural drift detected; operator repair required', { structuralDrift });
        } else {
          log.info('Neo4j Assertion structure is consistent', { structuralDrift });
        }
        return { structuralDrift, deleted: 0 };
      } catch (error) {
        log.error('Failed to diagnose Neo4j Assertion integrity', error instanceof Error ? error : undefined);
        return { structuralDrift: null, deleted: 0, error: String(error) };
      }
    })) ?? { structuralDrift: null, deleted: 0 };

    // Step 3: Clean up orphaned proposed relations
    results.orphanedProposals = await step.run('cleanup-orphaned-proposals-daily', async () => {
      try {
        const orphanResult = await cleanupOrphanedProposals();
        log.info('Orphaned proposals cleanup', { deleted: orphanResult.deleted });
        return orphanResult;
      } catch (error) {
        log.error('Failed to cleanup orphaned proposals', error instanceof Error ? error : undefined);
        return { deleted: 0, error: String(error) };
      }
    });

    log.info('Daily consistency cleanup complete', results as Record<string, unknown>);
    return results;
  }
);
