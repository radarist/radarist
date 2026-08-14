/**
 * @file lib/inngest/functions/sync-assertion-to-neo4j.ts
 * @description Inngest jobs for syncing claims between Firestore and Neo4j
 *
 * This module provides background jobs for:
 * - Syncing individual claims to Neo4j when relations are created/updated
 * - Batch syncing for backfill operations
 *
 * Note: the legacy `sync-entity-to-neo4j` job (trigger
 * `app/entity.sync.requested`) was deleted 2026-06-10 — it had zero senders
 * and was superseded by `sync-unified-entity-to-neo4j`
 * (see sync-entity-to-neo4j.ts).
 *
 * **Execution Flow:**
 * 1. Receive event with relation/entity data
 * 2. Create/update corresponding Claim in Neo4j
 * 3. Handle evidence linking
 * 4. Send completion event
 *
 * **Trigger:** Event-driven (`app/claim.sync.requested`)
 * **Timeout:** 1 minute per claim
 * **Retries:** 3 attempts with exponential backoff
 *
 * @phase Phase 4: Relations-as-Claims
 * @author Radarist Team
 * @created 2026-01-09
 */

import { inngest } from '../client';
import { isMaintenancePaused, maintenanceSkip } from '@/lib/maintenance-policy';
import { extractFailureEventData } from '../utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/sync-assertion-to-neo4j');
import {
  createAssertion,
  getAssertion,
  updateAssertionStatus,
  updateAssertionConfidence,
  deleteAssertion,
  addEvidenceToAssertion,
  materializeAssertionAsEdge,
  checkHealth,
  initializeSchema,
} from '@/lib/graph';
// Imported from the defining module (not re-exported via the @/lib/graph barrel).
import { shouldMaterializeAssertion } from '@/lib/graph/assertions';
import { applyCorroborationNudge } from '@/lib/graph/confidence-calibration';
import { normalizeConfidence100 } from '@/lib/graph/relation-defaults';
import { config } from '@/lib/config';
import type { CreateAssertionInput, EvidenceInput, ClaimStatus } from '@/lib/graph/types';

// ============================================================================
// SYNC CLAIM JOB
// ============================================================================

/**
 * Sync a single claim to Neo4j
 *
 * **Trigger:** app/claim.sync.requested event
 * **Timeout:** 1 minute
 * **Retries:** 3 attempts
 */
export const syncAssertionToNeo4jJob = inngest.createFunction(
  {
    id: 'sync-assertion-to-neo4j',
    name: 'Sync Claim to Neo4j',
    retries: 3,
    throttle: {
      limit: 50,
      period: '1m',
    },

    onFailure: async ({ error, event }) => {
      // Inngest v3 nests the original event at event.data.event
      const data = extractFailureEventData<{ relationId?: string; claimId?: string }>(event.data);
      const id = data.claimId || data.relationId || 'unknown';
      log.error('Sync claim final failure', new Error(error.message), { id });

      await inngest.send({
        name: 'app/claim.sync.failed',
        data: {
          claimId: data.claimId,
          relationId: data.relationId,
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  { event: 'app/claim.sync.requested' },

  async ({ event, step }) => {
    const { operation, relationId, claimId, claimData, evidence } = event.data;

    try {
      // Step 1: Check Neo4j health
      await step.run('check-neo4j-health', async () => {
        const health = await checkHealth();
        if (!health.healthy) {
          throw new Error(`Neo4j not healthy: ${health.error}`);
        }
        return health;
      });

      // Step 2: Perform operation
      const result = await step.run('sync-assertion', async () => {
        switch (operation) {
          case 'create': {
            if (!claimData) {
              throw new Error('claimData required for create operation');
            }
            // Task 16 (A1) ingress normalization: heal legacy 0-1 confidence
            // on the create path too — mirrors the sync-relation-to-neo4j.ts
            // ingress fix so BOTH sync handlers reject re-poisoning. Flagged
            // so it can be rolled back to the raw passthrough.
            const normalizedClaimData =
              config.flags.confidenceScale100Enabled && typeof claimData.confidence === 'number'
                ? { ...claimData, confidence: normalizeConfidence100(claimData.confidence) }
                : claimData;
            const assertion = await createAssertion(normalizedClaimData as CreateAssertionInput);
            // Materialize the typed edge so traversal queries see it. For
            // agent assertions below confidence 75 (0–100 scale, per the
            // relation-write confidence contract), leave the Assertion in
            // 'proposed' state without materializing — the reviewer approves
            // separately (updateStatus → 'curated' below).
            // B0: the gate reads the asserted-confidence view when present
            // (refreshed every sync), falling back to the legacy confidence
            // mirror for rows written before the two-field split.
            // NOTE: the reliability bonus is intentionally NOT resolved here —
            // this 'create' branch is dead on the live write path (H4: direct
            // claim.sync create sends were removed; live creation flows via
            // sync-relation-to-neo4j → syncRelationAsAssertion, which resolves
            // the bonus). If this branch is ever revived, wire resolveReliabilityBonus
            // here too or the gate silently diverges.
            if (
              shouldMaterializeAssertion(assertion.assertedConfidence ?? assertion.confidence, assertion.assertedBy)
            ) {
              await materializeAssertionAsEdge(assertion.id);
            }
            return { claimId: assertion.id, operation: 'created' };
          }

          case 'update': {
            if (!claimId) {
              throw new Error('claimId required for update operation');
            }
            const existing = await getAssertion(claimId);
            if (!existing) {
              // Assertion doesn't exist in Neo4j, create it
              if (claimData) {
                const assertion = await createAssertion(claimData as CreateAssertionInput);
                return { claimId: assertion.id, operation: 'created' };
              }
              throw new Error(`Claim ${claimId} not found and no claimData provided`);
            }

            // Update confidence if changed
            if (claimData?.confidence && claimData.confidence !== existing.confidence) {
              await updateAssertionConfidence(claimId, claimData.confidence as number);
            }

            return { claimId, operation: 'updated' };
          }

          case 'delete': {
            if (!claimId) {
              throw new Error('claimId required for delete operation');
            }
            await deleteAssertion(claimId);
            return { claimId, operation: 'deleted' };
          }

          case 'updateStatus': {
            if (!claimId || !claimData?.status) {
              throw new Error('claimId and status required for updateStatus operation');
            }
            const newStatus = claimData.status as ClaimStatus;
            await updateAssertionStatus(claimId, newStatus);
            // Reviewer approval materializes the typed edge that the
            // confidence gate withheld at create time. Idempotent: the
            // materialization MERGEs on claimId, so re-approving an
            // already-materialized Assertion only refreshes edge properties.
            if (newStatus === 'curated') {
              await materializeAssertionAsEdge(claimId);

              // Promotion re-materializes the typed edge from scratch, so
              // the corroboration nudge applied when the Assertion was
              // first synced (below-threshold, Assertion-only path in
              // relation-assertion-sync.ts) doesn't automatically carry
              // over onto this freshly-materialized edge. Re-derive and
              // re-apply it here. Best-effort: relationId isn't guaranteed
              // on every event payload, and a nudge failure must never
              // fail the promotion itself — the edge is already durably
              // written above.
              if (relationId) {
                try {
                  await applyCorroborationNudge(relationId);
                } catch (err) {
                  log.warn('corroboration nudge failed after promotion (non-fatal)', {
                    claimId,
                    relationId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }
            return { claimId, operation: 'statusUpdated' };
          }

          default:
            throw new Error(`Unknown operation: ${operation}`);
        }
      });

      // Step 3: Add evidence if provided
      if (evidence && evidence.length > 0 && result.claimId && operation !== 'delete') {
        await step.run('add-evidence', async () => {
          for (const e of evidence) {
            await addEvidenceToAssertion(result.claimId, e as EvidenceInput);
          }
          return { evidenceCount: evidence.length };
        });
      }

      // Step 4: Send completion event
      await step.run('send-completion', async () => {
        await inngest.send({
          name: 'app/claim.sync.completed',
          data: {
            claimId: result.claimId,
            relationId,
            operation: result.operation,
            syncedAt: Date.now(),
          },
        });
      });

      return {
        success: true,
        ...result,
        relationId,
      };
    } catch (error) {
      log.error('Sync claim failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }
);

// ============================================================================
// BATCH SYNC JOB
// ============================================================================

/**
 * Batch sync multiple claims to Neo4j
 * Used for backfill operations and migrations
 *
 * **Trigger:** app/claim.batch-sync.requested event
 * **Timeout:** 10 minutes
 * **Retries:** 2 attempts
 */
export const batchSyncAssertionsJob = inngest.createFunction(
  {
    id: 'batch-sync-assertions-to-neo4j',
    name: 'Batch Sync Claims to Neo4j',
    retries: 2,

    onFailure: async ({ error, event: _event }) => {
      log.error('Batch sync claims final failure', new Error(error.message));

      await inngest.send({
        name: 'app/claim.batch-sync.failed',
        data: {
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },

  // Manual ops hook — no in-app sender; trigger via Inngest dev UI / API for backfills.
  { event: 'app/claim.batch-sync.requested' },

  async ({ event, step }) => {
    if (isMaintenancePaused()) return maintenanceSkip('batch-sync-assertions-to-neo4j');
    const { claims, options } = event.data;

    try {
      // Step 1: Initialize schema if needed
      if (options?.initSchema) {
        await step.run('init-schema', async () => {
          await initializeSchema();
          return { schemaInitialized: true };
        });
      }

      // Step 2: Check Neo4j health
      await step.run('check-neo4j-health', async () => {
        const health = await checkHealth();
        if (!health.healthy) {
          throw new Error(`Neo4j not healthy: ${health.error}`);
        }
      });

      // Step 3: Process claims in batches
      const batchSize = options?.batchSize || 50;
      const results = {
        created: 0,
        failed: 0,
        errors: [] as string[],
      };

      for (let i = 0; i < claims.length; i += batchSize) {
        const batch = claims.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;

        await step.run(`process-batch-${batchNum}`, async () => {
          for (const claimInput of batch) {
            try {
              await createAssertion(claimInput as CreateAssertionInput);
              results.created++;
            } catch (error) {
              results.failed++;
              results.errors.push(
                `Failed to create assertion: ${error instanceof Error ? error.message : 'Unknown error'}`
              );
            }
          }
          return { batchNum, processed: batch.length };
        });
      }

      // Step 4: Send completion event
      await step.run('send-completion', async () => {
        await inngest.send({
          name: 'app/claim.batch-sync.completed',
          data: {
            totalClaims: claims.length,
            created: results.created,
            failed: results.failed,
            syncedAt: Date.now(),
          },
        });
      });

      return {
        success: results.failed === 0,
        ...results,
      };
    } catch (error) {
      log.error('Batch sync claims failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }
);

// ============================================================================
// INITIALIZE GRAPH JOB
// ============================================================================

/**
 * Initialize the Neo4j graph schema
 * Run once during setup or when schema changes
 *
 * **Trigger:** app/graph.init.requested event
 * **Timeout:** 2 minutes
 * **Retries:** 1 attempt
 */
export const initGraphSchemaJob = inngest.createFunction(
  {
    id: 'init-graph-schema',
    name: 'Initialize Graph Schema',
    retries: 1,
  },

  // Manual ops hook — no in-app sender; trigger via Inngest dev UI / API during setup.
  { event: 'app/graph.init.requested' },

  async ({ step }) => {
    try {
      // Check health first
      const health = await step.run('check-health', async () => {
        return await checkHealth();
      });

      if (!health.healthy) {
        throw new Error(`Neo4j not healthy: ${health.error}`);
      }

      // Initialize schema
      await step.run('init-schema', async () => {
        await initializeSchema();
        return { initialized: true };
      });

      // Send completion
      await step.run('send-completion', async () => {
        await inngest.send({
          name: 'app/graph.init.completed',
          data: {
            initializedAt: Date.now(),
          },
        });
      });

      return { success: true };
    } catch (error) {
      log.error('Init graph schema failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }
);
