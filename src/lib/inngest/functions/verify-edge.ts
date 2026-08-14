/**
 * @file inngest/functions/verify-edge.ts
 * @description Inngest function to verify typed-relation (edge) data via the Defense Minister.
 *
 * Triggered by: app/edge.verification.requested
 * Steps:
 *   1. Load relation snapshot from Firestore
 *   2. Run three verification checks:
 *      a. Both endpoint entities have web presence (verifyEntityReality × 2)
 *      b. Evidence text mentions both entity names (case-insensitive)
 *      c. sourceUrl HEAD-reachable (verifyUrlsReachable)
 *   3. Compute confirming/contradicting tally → score → status
 *   4. Write EdgeVerificationResult to Neo4j
 *
 * Scoring: score = confirming / decisive * 100 (decisive=0 → 50)
 * Status:  ≥80 AND ≥2 confirming → verified | 50–79 (or high score, 1 source) → unverified | <50 → disputed
 *
 * @phase Impulse v1.0 — Phase 3: Defense Minister (edge verification)
 */

import { inngest } from '../client';
import { SKIP_REASONS } from '../skip-reasons';
import { createLogger } from '@/lib/logger';
import type { CapturedProviderUsage } from '@/lib/operation-context';
// OBS-007 — the ONE verification-output contract, shared with verify-entity and
// with the Jobs reader that parses what this function persists.
import { summarizeVerificationSources, type VerificationSource } from '@/lib/verification-output-contract';

const log = createLogger('inngest:verify-edge');

export const verifyEdgeJob = inngest.createFunction(
  {
    id: 'verify-edge',
    retries: 2,
    onFailure: async ({ error }) => {
      log.error('verify-edge failed permanently', error instanceof Error ? error : new Error(String(error)));
    },
  },
  { event: 'app/edge.verification.requested' },
  async ({ event, step, runId }) => {
    const { relationId, sourceEntityId, targetEntityId } = event.data;

    // Master gate — defense in depth. Same env var as the trigger sites.
    // If any event leaks through (e.g. queued before the env was set), the
    // worker still no-ops here so no Gemini call is made.
    if (process.env.DEFENSE_MINISTER_ENABLED !== 'true') {
      log.info('Defense Minister disabled — skipping edge verification', {
        relationId,
        sourceEntityId,
        targetEntityId,
      });
      return { relationId, skipped: true, reason: SKIP_REASONS.DEFENSE_MINISTER_DISABLED };
    }

    // Step 1: Load relation snapshot from Firestore
    const relationData = await step.run('load-relation', async () => {
      const { adminGetRelationById } = await import('@/lib/relations-admin');
      const relation = await adminGetRelationById(relationId);
      if (!relation) throw new Error(`Relation ${relationId} not found in Firestore`);
      return relation;
    });

    // Step 2: Run verification checks. ARUN-022 — open an ambient operation-usage
    // sink so the two nested Gemini grounded searches (source + target reality)
    // capture their provider spend; the captured usage is returned as part of the
    // memoized step result (the edge-result id is not minted until Step 3).
    const verifyOutcome = await step.run('verify', async () => {
      const doVerify = async () => {
        const { verifyEntityReality } = await import('@/lib/entity-reality-check');
        const { verifyUrlsReachable } = await import('@/lib/scout-url-verifier');

        const sourceName = relationData.sourceSnapshot?.name ?? '';
        const targetName = relationData.targetSnapshot?.name ?? '';
        const sources: VerificationSource[] = [];

        // Check 1a: Source entity web presence
        try {
          const sourceVerdict = await verifyEntityReality(sourceName);
          if (sourceVerdict.ok && sourceVerdict.reason === 'verified') {
            sources.push({ label: `source-reality:${sourceName}`, verdict: 'confirming' });
          } else if (sourceVerdict.ok && sourceVerdict.reason === 'inconclusive') {
            sources.push({ label: `source-reality:${sourceName}`, verdict: 'inconclusive' });
          } else {
            sources.push({ label: `source-reality:${sourceName}`, verdict: 'contradicting' });
          }
        } catch (err) {
          log.warn('source entity reality check threw', { error: err instanceof Error ? err.message : String(err) });
        }

        // Check 1b: Target entity web presence
        try {
          const targetVerdict = await verifyEntityReality(targetName);
          if (targetVerdict.ok && targetVerdict.reason === 'verified') {
            sources.push({ label: `target-reality:${targetName}`, verdict: 'confirming' });
          } else if (targetVerdict.ok && targetVerdict.reason === 'inconclusive') {
            sources.push({ label: `target-reality:${targetName}`, verdict: 'inconclusive' });
          } else {
            sources.push({ label: `target-reality:${targetName}`, verdict: 'contradicting' });
          }
        } catch (err) {
          log.warn('target entity reality check threw', { error: err instanceof Error ? err.message : String(err) });
        }

        // Widen to unknown-map for optional runtime fields not in the Relation type
        // (Firestore documents may carry extra fields like sourceUrl, evidence)
        const relationExtra = relationData as Record<string, unknown>;

        // Check 2: Evidence text mentions both entity names (case-insensitive)
        // Prefer notes (typed), fall back to evidence (untyped runtime field)
        const evidenceText: string =
          (relationData.notes as string | undefined) ?? (relationExtra['evidence'] as string | undefined) ?? '';
        if (evidenceText.length > 0 && sourceName.length > 0 && targetName.length > 0) {
          const lower = evidenceText.toLowerCase();
          const mentionsSource = lower.includes(sourceName.toLowerCase());
          const mentionsTarget = lower.includes(targetName.toLowerCase());
          if (mentionsSource && mentionsTarget) {
            sources.push({ label: 'evidence-text-mentions-both', verdict: 'confirming' });
          } else {
            sources.push({ label: 'evidence-text-missing-one', verdict: 'contradicting' });
          }
        }

        // Check 3: sourceUrl HEAD-reachable (skip if no sourceUrl)
        const sourceUrl: string = (relationExtra['sourceUrl'] as string | undefined) ?? '';
        if (sourceUrl.length > 0) {
          try {
            const urlCheck = await verifyUrlsReachable([sourceUrl]);
            sources.push({ label: sourceUrl, verdict: urlCheck.ok ? 'confirming' : 'contradicting' });
          } catch (err) {
            log.warn('sourceUrl reachability check threw', { error: err instanceof Error ? err.message : String(err) });
          }
        }

        // VERIFY-001 replication and the canonical 0-100 scale live in the shared
        // contract, so this path and verify-entity cannot drift apart again.
        return summarizeVerificationSources(sources, 'defense-minister-v1-edge');
      };

      // ARUN-022 — best-effort capture of the two nested Gemini grounded searches.
      // Guard ONLY the instrumentation import: a load failure degrades to "no
      // sink" and verification still runs. doVerify's own errors always propagate.
      let withCapturedUsage:
        (<T>(fn: () => Promise<T>) => Promise<{ result: T; captured: CapturedProviderUsage[] }>) | undefined;
      try {
        ({ withCapturedUsage } = await import('@/lib/operation-receipt-instrument'));
      } catch (instrumentationError) {
        log.warn('operation-usage instrumentation unavailable; verifying without receipts', {
          error: instrumentationError instanceof Error ? instrumentationError.message : String(instrumentationError),
        });
      }
      if (withCapturedUsage) {
        const { result, captured } = await withCapturedUsage(doVerify);
        return { verificationResult: result, capturedUsage: captured };
      }
      return { verificationResult: await doVerify(), capturedUsage: [] as CapturedProviderUsage[] };
    });
    const verificationResult = verifyOutcome.verificationResult;
    const capturedUsage = verifyOutcome.capturedUsage;

    // Step 3: Write EdgeVerificationResult to Neo4j and return its minted id. This
    // step performs ONLY the verification write — no instrumentation — so a ledger
    // failure can never re-mint the result id or abort verification.
    // GRAPH-061: fail-closed — a verdict about a relation with no projected edge
    // would be permanently unanchored (EdgeVerificationResult carries no
    // relationship), so the writer raises VerificationTargetMissingError and
    // Inngest retries instead of persisting an orphan.
    const verificationResultId = await step.run('store-result', async () => {
      const { createEdgeVerificationResult } = await import('@/lib/graph/verification');
      const created = await createEdgeVerificationResult({
        relationId,
        sourceEntityId,
        targetEntityId,
        ...verificationResult,
      });
      return created.id;
    });

    // Step 4 (ARUN-022): record the captured nested provider spend as receipts
    // correlated to THIS run, the minted edge-result id (memoized → stable on
    // replay), and the exact relation target. A SEPARATE, fully try/caught step so
    // an instrumentation failure is non-fatal and never perturbs verification.
    if (capturedUsage.length > 0) {
      await step.run('record-usage-receipts', async () => {
        try {
          const { flushCapturedUsage } = await import('@/lib/operation-receipt-instrument');
          await flushCapturedUsage(
            {
              parentType: 'verification',
              owner: 'user:system',
              correlationId: `inngest-${runId}`,
              inngestRunId: runId,
              verificationResultId,
              relationId,
            },
            capturedUsage,
            verificationResultId,
            // A background verification has no parent headline to fold into.
            'standalone'
          );
        } catch (receiptError) {
          log.warn('operation-usage receipt flush failed (non-fatal)', {
            error: receiptError instanceof Error ? receiptError.message : String(receiptError),
            runId,
            relationId,
          });
        }
        return { recorded: capturedUsage.length };
      });
    }

    log.info('Edge verification complete', {
      relationId,
      sourceEntityId,
      targetEntityId,
      status: verificationResult.status,
      score: verificationResult.score,
    });

    return { relationId, sourceEntityId, targetEntityId, ...verificationResult };
  }
);
