/**
 * @file lib/inngest/functions/expand-signal.ts
 * @description Expand a signal with deep analysis (Phase 4.2)
 *
 * This function is triggered when a signal needs expansion with:
 * - Deep entity analysis using Gemini + Google Search
 * - Strategic alignment assessment
 * - Trust score calculation
 * - Actionable recommendations
 *
 * **Execution Flow:**
 * 1. Load signal
 * 2. Run expansion (with retry on failure)
 * 3. Send completion event
 *
 * **Trigger:** Event-driven (`app/signal.expand.requested`)
 * **Timeout:** 5 minutes (expansion can be slow with Google Search)
 * **Retries:** 3 attempts
 *
 * @author Radarist Team
 * @created 2025-11-26
 */

import { inngest } from '../client';
import { extractFailureEventData } from '../utils';
import {
  type ExpandSignalOptions,
  loadSignalContext,
  generateSignalExpansion,
  resolveSignalExpansionEndpoints,
  scoreSignalExpansion,
  persistSignalExpansion,
} from '@/lib/signals/expand-signal';
import {
  evaluateSignalAutoApply,
  isSignalAutopilotEnabled,
  parseSignalAutoApproveThreshold,
  signalAutoApplyFingerprint,
  technologyIdForSignal,
} from '@/lib/signals/auto-apply-policy';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';

const log = createLogger('inngest/expand-signal');

class AutoApplyGraphSyncError extends Error {
  constructor(signalId: string, entityId: string, cause: unknown) {
    super(
      `Auto-applied graph synchronization failed for signal ${signalId} and Technology ${entityId}: ` +
        (cause instanceof Error ? cause.message : String(cause))
    );
    this.name = 'AutoApplyGraphSyncError';
    this.cause = cause;
  }
}

type AutoAppliedTechnology = { entityId: string; entityType: 'technology' };
const KNOWN_SIGNAL_STATUSES = new Set(['Detected', 'Validated', 'Approved', 'Rejected', 'Imported', 'Archived']);
const KNOWN_IMPORTED_ENTITY_TYPES = new Set(['technology', 'company', 'useCase']);

class AutoApplyRecoveryError extends Error {
  constructor(signalId: string, detail: string, mutationError: unknown, cause: unknown = mutationError) {
    super(
      `Signal ${signalId} auto-apply commit state could not be reconciled: ${detail}. ` +
        `Mutation error: ${mutationError instanceof Error ? mutationError.message : String(mutationError)}`
    );
    this.name = 'AutoApplyRecoveryError';
    this.cause = cause;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Resolve Firestore's ambiguous commit outcome without checkpointing a false
 * miss. Document reads are strongly consistent: a complete link resumes the
 * ordered graph sync, absence of both writes confirms a non-commit, and every
 * partial or unreadable state is retried by Inngest.
 */
async function recoverAutoAppliedTechnology(
  signalId: string,
  mutationError: unknown
): Promise<AutoAppliedTechnology | null> {
  let signalExists = false;
  let signalData: Record<string, unknown> | undefined;
  try {
    const signalSnapshot = await db.collection('signals').doc(signalId).get();
    signalExists = signalSnapshot.exists;
    const rawSignal = signalExists ? signalSnapshot.data() : undefined;
    if (signalExists && !isRecord(rawSignal)) {
      throw new Error('Signal snapshot has no document data');
    }
    signalData = rawSignal as Record<string, unknown> | undefined;
  } catch (readError) {
    throw new AutoApplyRecoveryError(signalId, 'the Signal reread failed', mutationError, readError);
  }

  const expectedTechnologyId = technologyIdForSignal(signalId);
  const rawImportedAs = signalData?.importedAs;
  let importedTechnologyId: string | undefined;
  let importedAsMalformed = false;
  let importedAsOtherEntity = false;

  if (rawImportedAs !== undefined && rawImportedAs !== null) {
    if (
      !isRecord(rawImportedAs) ||
      typeof rawImportedAs.type !== 'string' ||
      !KNOWN_IMPORTED_ENTITY_TYPES.has(rawImportedAs.type) ||
      typeof rawImportedAs.id !== 'string' ||
      !rawImportedAs.id.trim() ||
      rawImportedAs.id !== rawImportedAs.id.trim()
    ) {
      importedAsMalformed = true;
    } else if (rawImportedAs.type === 'technology') {
      importedTechnologyId = rawImportedAs.id.trim();
    } else {
      importedAsOtherEntity = true;
    }
  }

  const signalStatus = typeof signalData?.status === 'string' ? signalData.status : undefined;
  if (signalExists && (!signalStatus || !KNOWN_SIGNAL_STATUSES.has(signalStatus))) {
    throw new AutoApplyRecoveryError(signalId, 'the Signal has an unknown or missing status', mutationError);
  }
  if (signalStatus !== 'Imported' && rawImportedAs !== undefined && rawImportedAs !== null) {
    throw new AutoApplyRecoveryError(signalId, 'a non-Imported Signal already has an importedAs link', mutationError);
  }

  const technologyIds = [...new Set([expectedTechnologyId, importedTechnologyId].filter(Boolean) as string[])];
  let technologyExistsById: Map<string, boolean>;
  try {
    technologyExistsById = new Map(
      await Promise.all(
        technologyIds.map(async (technologyId) => {
          const snapshot = await db.collection('technologies').doc(technologyId).get();
          return [technologyId, snapshot.exists] as const;
        })
      )
    );
  } catch (readError) {
    throw new AutoApplyRecoveryError(signalId, 'the Technology reread failed', mutationError, readError);
  }

  const expectedTechnologyExists = technologyExistsById.get(expectedTechnologyId) === true;
  const linkedTechnologyExists = importedTechnologyId ? technologyExistsById.get(importedTechnologyId) === true : false;

  if (signalStatus === 'Imported' && importedTechnologyId && linkedTechnologyExists) {
    if (importedTechnologyId !== expectedTechnologyId && expectedTechnologyExists) {
      throw new AutoApplyRecoveryError(
        signalId,
        'both the linked and deterministic Technology documents exist',
        mutationError
      );
    }
    log.warn('Signal auto-apply commit was recovered after an ambiguous mutation response', {
      signalId,
      technologyId: importedTechnologyId,
    });
    return { entityId: importedTechnologyId, entityType: 'technology' };
  }

  if (importedAsMalformed) {
    throw new AutoApplyRecoveryError(signalId, 'the persisted importedAs link is malformed', mutationError);
  }
  if (importedTechnologyId || expectedTechnologyExists) {
    throw new AutoApplyRecoveryError(signalId, 'only part of the Signal/Technology import is present', mutationError);
  }
  if (signalStatus === 'Imported' && !importedAsOtherEntity) {
    throw new AutoApplyRecoveryError(signalId, 'the Signal is Imported without a valid entity link', mutationError);
  }

  log.warn('Signal auto-apply was confirmed not to have committed', {
    signalId,
    signalExists,
    signalStatus,
  });
  return null;
}

/**
 * Expand signal function
 *
 * **Trigger:** app/signal.expand.requested event
 * **Timeout:** 5 minutes
 * **Retries:** 3 attempts
 */
export const expandSignalJob = inngest.createFunction(
  {
    id: 'expand-signal',
    name: 'Expand Signal',
    retries: 3,

    /**
     * Failure handler - logs error and sends notification event
     */
    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event
      const signalId = extractFailureEventData<{ signalId?: string }>(event.data).signalId || 'unknown';
      log.error('Final failure for signal expansion', new Error(error.message), { signalId });

      if (error.name === 'AutoApplyGraphSyncError' || error.name === 'AutoApplyRecoveryError') {
        await inngest.send({
          name: 'app/signal.auto-apply.sync.failed',
          data: {
            signalId,
            error: error.message,
            failedAt: Date.now(),
          },
        });
        return;
      }

      // Send failure event for monitoring/alerting
      await inngest.send({
        name: 'app/signal.expand.failed',
        data: {
          signalId,
          error: error.message,
          failedAt: Date.now(),
          severity: 'medium',
        },
      });
    },
  },

  /**
   * Event trigger
   */
  { event: 'app/signal.expand.requested' },

  /**
   * Main function handler
   */
  async ({ event, step, attempt = 0 }) => {
    const { signalId, options } = event.data as {
      signalId: string;
      options?: ExpandSignalOptions;
    };

    const startTime = Date.now();
    try {
      /**
       * Step 1 — fetch signal + strategies (Firestore reads, ~100-300 ms).
       * Kept separate so step.run boundaries bracket each Inngest HTTP POST
       * and a 25s monolithic run can't exceed Inngest's client timeout.
       */
      const ctxSerialized = await step.run('load-signal-context', async () => {
        log.info('Loading signal + strategies', { signalId });
        const ctx = await loadSignalContext(signalId);
        // Strip the transient startTime before returning — Inngest JSON-encodes
        // step results for durability, and we don't want clock skew across steps.
        return { signal: ctx.signal, strategies: ctx.strategies };
      });

      /**
       * Step 2 — Gemini call. This is the one slow step (10-30s). Isolated
       * so the app returns to Inngest as soon as the Gemini response arrives.
       */
      const generatedContent = await step.run('ai-analyze-signal', async () => {
        log.info('Calling Gemini for expansion', { signalId });
        return generateSignalExpansion(
          { signal: ctxSerialized.signal, strategies: ctxSerialized.strategies, startTime },
          options || {}
        );
      });

      /**
       * Step 2b (GRAPH-063) — resolve or reject the endpoint IDs the model
       * invented, BEFORE anything persists them or schedules convergence on
       * them. A phantom ID becomes a graph MATCH that silently writes nothing,
       * which permanently blocks the signal's source fingerprint and makes the
       * reconciler replay it every cycle. Own step so the decision is memoized
       * across retries alongside the (expensive) generation above.
       */
      const resolution = await step.run('resolve-expansion-endpoints', async () => {
        return resolveSignalExpansionEndpoints(signalId, generatedContent);
      });
      const expandedContent = { ...generatedContent, relatedItems: resolution.relatedItems };

      /**
       * Step 3 — trust score (pure CPU, fast).
       */
      const trustScore = await step.run('score-signal-expansion', async () => {
        return scoreSignalExpansion(
          { signal: ctxSerialized.signal, strategies: ctxSerialized.strategies, startTime },
          expandedContent,
          options || {}
        );
      });

      /**
       * Step 4 — persist to Firestore (~100-300 ms).
       */
      await step.run('persist-signal-expansion', async () => {
        await persistSignalExpansion(signalId, expandedContent, trustScore, resolution);
      });

      /**
       * Step 4b — re-sync the signal to Neo4j so the expansion-discovered
       * relations (RELATED_SIGNAL / DISCOVERED edges) and the updated trustScore
       * land in the graph. `persistSignalExpansion` writes Firestore directly
       * (it bypasses adminUpdateSignal, the only path that fires the entity-sync
       * event), so without this the expanded content never reaches Neo4j and the
       * signal stays orphaned. Operation 'update' — the node already exists from
       * ingestion. The handler reloads the freshly-persisted signal from
       * Firestore and is idempotent (all edge writes are MERGE).
       */
      await step.run('resync-signal-to-graph', async () => {
        await inngest.send({
          name: 'app/unified-entity.sync.requested',
          data: { entityId: signalId, entityType: 'signal', operation: 'update' },
        });
      });

      const result = {
        success: true as const,
        signalId,
        expansionDuration: Date.now() - startTime,
        expandedContent,
        trustScore,
      };

      /**
       * Step 5: Send completion event
       */
      await step.run('send-completion', async () => {
        await inngest.send({
          name: 'app/signal.expand.completed',
          data: {
            signalId,
            success: true,
            expansionDuration: result.expansionDuration,
            trustScore: result.trustScore?.overall || 0,
          },
        });
      });

      /**
       * Task 3.7: Auto-apply high-trust signals.
       * If trust score >= threshold AND autopilot enabled, auto-approve and import.
       */
      const persistedSignal = {
        ...ctxSerialized.signal,
        expandedContent,
        trustScore: result.trustScore,
      };
      // Checkpoint the policy decision before the mutation. Inngest replays this
      // step result on a function retry, so disabling autopilot or raising the
      // threshold after an import commits cannot skip the ordered graph-sync
      // recovery that still has to finish for that import.
      const autoApplyDecision = await step.run('decide-signal-auto-apply', async () => {
        const enabled = isSignalAutopilotEnabled(process.env);
        const threshold = parseSignalAutoApproveThreshold(process.env);
        const evaluation = threshold === null ? null : evaluateSignalAutoApply(persistedSignal, threshold);
        const trustOverall = result.trustScore?.overall ?? 0;
        const qualifies = enabled && evaluation?.eligible === true;

        if (enabled && !qualifies) {
          log.info('Signal did not pass the complete auto-apply policy', {
            signalId,
            trustScore: trustOverall,
            threshold,
            reason: threshold === null ? 'invalid-threshold' : evaluation?.reason,
            confirmingSourceCount: evaluation?.confirmingSourceCount ?? 0,
          });
        }

        return {
          qualifies,
          threshold,
          trustOverall,
          confirmingSourceCount: evaluation?.confirmingSourceCount ?? 0,
          expansionFingerprint: signalAutoApplyFingerprint(persistedSignal),
        };
      });
      let autoApplied = false;
      const authorizedThreshold = autoApplyDecision.threshold;

      if (autoApplyDecision.qualifies && authorizedThreshold !== null) {
        const importResult = await step.run('auto-apply-signal', async () => {
          log.info('Signal qualifies for auto-apply', {
            signalId,
            trustScore: autoApplyDecision.trustOverall,
            threshold: authorizedThreshold,
            confirmingSourceCount: autoApplyDecision.confirmingSourceCount,
          });

          try {
            // Approve + import as Technology via the narrow admin helper.
            // Pre-T1.3 this was `await import('@/lib/signals-approval')`, which
            // pulled the Firebase client SDK into the Inngest worker via that
            // module's static imports of `@/lib/firebase` + `firebase/firestore`,
            // failing with `code: 'unavailable'`. The helper is admin-SDK only.
            const { autoApproveAndImportTechnology } = await import('@/lib/signals-autopilot-admin');
            const imported = await autoApproveAndImportTechnology(signalId, {
              expansionFingerprint: autoApplyDecision.expansionFingerprint,
              threshold: authorizedThreshold,
            });

            log.info('Signal auto-applied successfully', {
              signalId,
              entityId: imported.entityId,
              entityType: imported.entityType,
              trustScore: autoApplyDecision.trustOverall,
            });
            return imported;
          } catch (autoApplyError) {
            log.warn('Signal auto-apply mutation returned an error; reconciling commit state', {
              signalId,
              error: autoApplyError instanceof Error ? autoApplyError.message : String(autoApplyError),
            });
            return recoverAutoAppliedTechnology(signalId, autoApplyError);
          }
        });

        if (importResult) {
          // Invoke the dedicated sync and wait for it before re-syncing the
          // signal. The signal's BECAME edge MATCHes the Technology node, so
          // event-only fan-out would race and could leave the graph stale.
          try {
            const { syncTechnologyToNeo4jJob } = await import('./sync-technology-to-neo4j');
            const technologySync = await step.invoke(`sync-auto-applied-technology-${attempt}`, {
              function: syncTechnologyToNeo4jJob,
              data: { technologyId: importResult.entityId, operation: 'create' },
            });
            if (!technologySync || technologySync.success === false) {
              throw new Error(`Technology graph sync returned an unsuccessful result`);
            }

            const { syncUnifiedEntityToNeo4jJob } = await import('./sync-entity-to-neo4j');
            const signalSync = await step.invoke(`resync-auto-applied-signal-${attempt}`, {
              function: syncUnifiedEntityToNeo4jJob,
              data: { entityId: signalId, entityType: 'signal', operation: 'update' },
            });
            if (!signalSync || !('success' in signalSync) || signalSync.success === false) {
              throw new Error(`Signal graph sync returned an unsuccessful result`);
            }
          } catch (syncError) {
            throw new AutoApplyGraphSyncError(signalId, importResult.entityId, syncError);
          }

          try {
            await step.sendEvent('emit-signal-auto-applied', {
              name: 'app/signal.auto-applied',
              data: {
                signalId,
                entityId: importResult.entityId,
                entityType: importResult.entityType,
                trustScore: autoApplyDecision.trustOverall,
                threshold: authorizedThreshold,
              },
            });
          } catch (eventError) {
            log.warn('Signal auto-apply activity event failed', {
              signalId,
              error: eventError instanceof Error ? eventError.message : String(eventError),
            });
          }
          autoApplied = true;
        }
      }

      return {
        success: true,
        signalId,
        expansionDuration: result.expansionDuration,
        trustScore: result.trustScore,
        autoApplied,
      };
    } catch (error) {
      // Expansion already committed. Do not stamp it failed while Inngest
      // retries an indeterminate import or the ordered graph synchronization.
      const errorName = error instanceof Error ? error.name : undefined;
      if (
        error instanceof AutoApplyGraphSyncError ||
        error instanceof AutoApplyRecoveryError ||
        errorName === 'AutoApplyGraphSyncError' ||
        errorName === 'AutoApplyRecoveryError'
      ) {
        log.error('Post-expansion auto-apply recovery failed', error, { signalId, attempt });
        throw error;
      }

      log.error('Expansion failed', error instanceof Error ? error : undefined, { signalId });

      /**
       * Step 3: Mark expansion as failed in Firestore
       * (only after all retries are exhausted)
       */
      await step.run('mark-expansion-failed', async () => {
        const signalRef = db.collection('signals').doc(signalId);
        await signalRef.update({
          expansionFailed: true,
          expansionError: error instanceof Error ? error.message : 'Unknown error',
          expansionFailedAt: Date.now(),
          updatedAt: Date.now(),
        });
      });

      /**
       * Step 4: Send failure event
       */
      await step.run('send-failure', async () => {
        await inngest.send({
          name: 'app/signal.expand.failed',
          data: {
            signalId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      });

      throw error; // Re-throw to trigger retry
    }
  }
);
