/**
 * @file inngest/functions/verify-entity.ts
 * @description Inngest function to verify entity data via Defense Minister.
 *
 * Triggered by: app/entity.verification.requested
 * Steps:
 *   1. Load entity data from Firestore
 *   2. Run verification (smart observation-aggregation path with pragmatic
 *      web-reality fallback; gated by DEFENSE_MINISTER_ENABLED)
 *   3. Write VerificationResult to Neo4j
 *   4. Update entity's verifiedScore in Firestore
 *
 * @phase Impulse v1.0 — Phase 3: Defense Minister
 */

import { inngest } from '../client';
import { SKIP_REASONS } from '../skip-reasons';
import { createLogger } from '@/lib/logger';
import { ENTITY_COLLECTIONS } from '@/lib/entity-collections';
import { isEntityVerificationType } from '../entity-verification-dispatch';
import type { CapturedProviderUsage } from '@/lib/operation-context';
// OBS-007 — the ONE verification-output contract. Producing through it is what
// keeps the Jobs reader's parser and this payload on the same 0-100 scale.
import {
  buildSmartEntityVerificationOutput,
  summarizeVerificationSources,
  type VerificationSource,
} from '@/lib/verification-output-contract';

const log = createLogger('inngest:verify-entity');

export const verifyEntityJob = inngest.createFunction(
  {
    id: 'verify-entity',
    retries: 2,
    onFailure: async ({ error }) => {
      log.error('verify-entity failed permanently', error instanceof Error ? error : new Error(String(error)));
    },
  },
  { event: 'app/entity.verification.requested' },
  async ({ event, step, runId }) => {
    const { entityId, entityType } = event.data;

    // Master gate — defense in depth. Same env var as the trigger sites
    // (entity sync workers, impulse sweep, relation sync).
    // If any event leaks through (e.g. queued before the env was set), the
    // worker still no-ops here so no Gemini call is made.
    if (process.env.DEFENSE_MINISTER_ENABLED !== 'true') {
      log.info('Defense Minister disabled — skipping entity verification', {
        entityId,
        entityType,
      });
      return { entityId, skipped: true, reason: SKIP_REASONS.DEFENSE_MINISTER_DISABLED };
    }

    // Fail closed before any durable step, Firestore read, model call, or
    // Neo4j write. The active verifier is intentionally limited to externally
    // verifiable entities; internal artifacts and graph projections are not
    // suitable subjects for web-reality verification.
    if (!isEntityVerificationType(entityType)) {
      throw new Error(`Unsupported entity verification type: ${String(entityType)}`);
    }

    // Step 1: Load entity data from Firestore (admin SDK — server runtime)
    const entityData = await step.run('load-entity', async () => {
      const { db } = await import('@/lib/firebase-admin');
      const collectionName = ENTITY_COLLECTIONS[entityType];
      const snap = await db.collection(collectionName).doc(entityId).get();
      if (!snap.exists) throw new Error(`Entity ${entityId} not found`);
      return snap.data() as Record<string, unknown>;
    });

    // Step 2: Run verification. ARUN-022 — open an ambient operation-usage sink
    // so the nested Gemini grounded search (deep inside verifyEntityReality)
    // captures its provider spend. The captured usage is RETURNED as part of the
    // step result so it survives Inngest's step memoization (the correlation's
    // verificationResultId is not minted until Step 3, below).
    const verifyOutcome = await step.run('verify', async () => {
      const doVerify = async () => {
        // ----- Smart path: observation aggregation -----
        try {
          const { getObservationsForEntity, aggregateObservationScore } = await import('@/lib/graph/observations');
          const observations = await getObservationsForEntity(entityId, 180);
          const aggregate = aggregateObservationScore(observations);

          // M13 rubber-stamp guard: an observation set with zero non-confirming
          // verdicts always scores 100/verified — it cannot distinguish a truly
          // corroborated entity from a monoculture of unchecked 'confirming'
          // stamps. Require at least one contradicting/inconclusive observation
          // before trusting the smart aggregate; otherwise fall back to an
          // active web recheck.
          const hasNonConfirming = observations.some((o) => o.verdict !== 'confirming');

          if (!aggregate.sparse && hasNonConfirming) {
            return buildSmartEntityVerificationOutput(aggregate.smartScore);
          }
          if (!aggregate.sparse && !hasNonConfirming) {
            log.info('Observations all-confirming (rubber-stamp guard) — active recheck', {
              observationCount: observations.length,
            });
          } else {
            log.info('Observations sparse, falling back to active recheck', {
              observationCount: aggregate.sparse ? aggregate.observationCount : observations.length,
            });
          }
        } catch (err) {
          log.warn('Smart scoring failed, falling back', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // ----- Fallback: pragmatic-v1 active recheck -----
        const { verifyEntityReality } = await import('@/lib/entity-reality-check');
        const { verifyUrlsReachable } = await import('@/lib/scout-url-verifier');

        const name = (entityData.name as string) ?? (entityData.title as string) ?? '';
        const website = (entityData.website as string) ?? (entityData.websiteUrl as string) ?? '';
        const sources: VerificationSource[] = [];

        // 1. Web-presence reality check
        try {
          const realityVerdict = await verifyEntityReality(name);
          if (realityVerdict.ok && realityVerdict.reason === 'verified') {
            sources.push({ label: 'gemini-grounded-search', verdict: 'confirming' });
          } else if (realityVerdict.ok && realityVerdict.reason === 'inconclusive') {
            sources.push({ label: 'gemini-grounded-search', verdict: 'inconclusive' });
          } else {
            sources.push({ label: 'gemini-grounded-search', verdict: 'contradicting' });
          }
        } catch (err) {
          log.warn('reality check threw', { error: err instanceof Error ? err.message : String(err) });
        }

        // 2. URL reachability (only when entity provides a website)
        if (website && website.length > 0) {
          try {
            const urlCheck = await verifyUrlsReachable([website]);
            sources.push({ label: website, verdict: urlCheck.ok ? 'confirming' : 'contradicting' });
          } catch (err) {
            log.warn('url check threw', { error: err instanceof Error ? err.message : String(err) });
          }
        }

        // VERIFY-001 replication and the 0-100 scale now live in the shared
        // contract, so this path and verify-edge cannot drift apart again.
        return {
          ...summarizeVerificationSources(sources, 'defense-minister-v1-pragmatic'),
          strictnessLevel: 'standard' as const,
        };
      };

      // ARUN-022 — best-effort capture of the nested Gemini grounded search.
      // Guard ONLY the instrumentation import: a load failure degrades to "no
      // sink" and verification still runs. doVerify's own errors always propagate
      // (they are never caught here), so the ledger can neither abort nor mask
      // the real verification.
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

    // Step 3: Write result to Neo4j and return its minted id. This step performs
    // ONLY the verification write — no instrumentation — so a ledger failure can
    // never re-mint the result id or abort verification.
    // GRAPH-061: the writer is fail-closed — it raises
    // VerificationTargetMissingError rather than minting a verdict for an entity
    // that has no graph node. Letting that propagate is deliberate: Inngest
    // retries (the projection may simply be lagging Firestore), and until the
    // verdict is anchored the Firestore verifiedScore/verifiedStatus below must
    // not be written either.
    const verificationResultId = await step.run('store-result', async () => {
      const { createVerificationResult } = await import('@/lib/graph/verification');
      const created = await createVerificationResult({ entityId, ...verificationResult });
      return created.id;
    });

    // Step 4: Update entity in Firestore (admin SDK — server runtime)
    await step.run('update-entity', async () => {
      const { db } = await import('@/lib/firebase-admin');
      const collectionName = ENTITY_COLLECTIONS[entityType];
      await db.collection(collectionName).doc(entityId).update({
        verifiedScore: verificationResult.score,
        verifiedStatus: verificationResult.status,
        verifiedAt: new Date().toISOString(),
      });
    });

    // Step 5 (ARUN-022): record the captured nested provider spend as receipts
    // correlated to THIS run, the minted result id (memoized → stable on replay),
    // and the exact entity target. A SEPARATE, fully try/caught step so an
    // instrumentation failure is non-fatal and never perturbs verification; the
    // step only exists when a provider call was actually captured.
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
              entityId,
              entityType,
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
            entityId,
          });
        }
        return { recorded: capturedUsage.length };
      });
    }

    log.info('Entity verification complete', {
      entityId,
      entityType,
      status: verificationResult.status,
      name: entityData.name ?? entityData.title ?? 'unknown',
    });
    return { entityId, ...verificationResult };
  }
);
