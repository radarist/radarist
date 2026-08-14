/**
 * @file lib/signals-autopilot-admin.ts
 * @description Narrow server-only admin-SDK helper for the signal-expansion
 * autopilot path (T1.3 of firebase-admin migration plan v2.4).
 *
 * Replaces the dynamic `await import('@/lib/signals-approval')` chain at
 * `src/lib/inngest/functions/expand-signal.ts:174,178`. Loading `signals-approval`
 * pulls the Firebase client SDK into the Inngest worker (the module statically
 * imports `@/lib/firebase` + `firebase/firestore`); when the autopilot path
 * fires, that triggers `code: 'unavailable'`.
 *
 * Scope: only the `targetType='technology'` branch of the manual
 * signal-to-entity conversion path that used to live in `signals-approval.ts`
 * (removed entirely along with its triage-page dialog, P-E1 — see git
 * history), which is the only branch the autopilot path uses. Track 2
 * (Tier 5a) will land the full `signals-approval.ts` admin split and this
 * helper can then be inlined or deleted.
 *
 * Skips (vs. the full removed manual conversion path):
 *   - radar-placement creation (autopilot never passes a radarId)
 *   - direct Neo4j sync (the caller durably invokes Technology sync followed
 *     by Signal sync after this transaction commits)
 *   - fire-and-forget concept linking (Type B reach — addressed in Track 2)
 * The Inngest function catches and warns on autopilot failures (see
 * `expand-signal.ts:199-205`), so missing fire-and-forget side-effects don't
 * fail the expansion.
 */
import 'server-only';
import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import type { Signal } from '@/lib/types';
import {
  evaluateSignalAutoApply,
  signalAutoApplyFingerprint,
  technologyIdForSignal,
} from '@/lib/signals/auto-apply-policy';
import { technologySchema } from '@/lib/schemas/technology-schema';

const log = createLogger('signals-autopilot-admin');

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Auto-approve a signal and import it as a Technology entity. Used only by
 * the signal-expansion autopilot path; not a general-purpose API.
 *
 * @returns The new Technology's `entityId` and `entityType`, mirroring the
 *   return shape the full (now-removed) manual conversion path used, so the
 *   Inngest caller can use it without conditional logic.
 */
export async function autoApproveAndImportTechnology(
  signalId: string,
  authorization: { expansionFingerprint: string; threshold: number }
): Promise<{ entityId: string; entityType: 'technology' }> {
  if (!/^[a-f0-9]{64}$/.test(authorization.expansionFingerprint)) {
    throw new Error('Signal auto-apply authorization fingerprint is invalid');
  }
  if (!Number.isInteger(authorization.threshold) || authorization.threshold < 0 || authorization.threshold > 100) {
    throw new Error('Signal auto-apply threshold must be an integer from 0 to 100');
  }
  const now = Date.now();
  const signalRef = db.collection('signals').doc(signalId);
  const result = await db.runTransaction(async (transaction) => {
    const signalSnap = await transaction.get(signalRef);
    if (!signalSnap.exists) throw new Error(`Signal not found: ${signalId}`);
    const signal = signalSnap.data() as Signal;
    const importedAs = signal.importedAs;
    if (importedAs && importedAs.type !== 'technology') {
      throw new Error(`Signal ${signalId} is already imported as ${importedAs.type}`);
    }

    if (signal.status === 'Rejected' || signal.status === 'Archived') {
      throw new Error(`Signal ${signalId} is ${signal.status} and cannot be auto-applied`);
    }

    // AUDIT-010 defense: legacy composite ids (`radarId:hash`) predate the
    // bare-id contract and must never be used as a doc id — the fallback
    // below would otherwise mint `technologies/<radarId>:<hash>` garbage.
    const importedAsId = importedAs?.id && !importedAs.id.includes(':') ? importedAs.id : undefined;
    const technologyId = importedAsId || technologyIdForSignal(signalId);
    const technologyRef = db.collection('technologies').doc(technologyId);
    const technologySnap = await transaction.get(technologyRef);
    if (importedAsId && technologySnap.exists && signal.status === 'Imported') {
      return { entityId: technologyId, entityType: 'technology' as const };
    }

    if (signalAutoApplyFingerprint(signal) !== authorization.expansionFingerprint) {
      throw new Error(`Signal ${signalId} changed after its auto-apply decision`);
    }
    const evaluationSignal =
      signal.status === 'Imported' && importedAs
        ? ({ ...signal, status: 'Approved' } as Signal)
        : signal;
    const evaluation = evaluateSignalAutoApply(evaluationSignal, authorization.threshold);
    if (!evaluation.eligible) {
      throw new Error(`Signal ${signalId} no longer qualifies for auto-apply: ${evaluation.reason}`);
    }

    if (!technologySnap.exists) {
      const name = signal.title.trim();
      const slug = generateSlug(name);
      const technology = technologySchema.parse({
        id: technologyId,
        name,
        slug,
        description: signal.description ?? '',
        tags: [],
        linkedCompanies: [],
        linkedUseCases: [],
        createdAt: now,
        updatedAt: now,
        createdBy: signal.metadata?.agentId ?? 'signal-autopilot',
      });

      // Match the canonical Technology service invariant. The query read is
      // inside this same transaction and occurs before either write.
      const slugQuery = db.collection('technologies').where('slug', '==', slug).limit(1);
      const slugSnapshot = (await transaction.get(slugQuery)) as {
        empty: boolean;
        docs: Array<{ id: string }>;
      };
      if (!slugSnapshot.empty && slugSnapshot.docs.some((document) => document.id !== technologyId)) {
        throw new Error(`A technology with slug "${slug}" already exists`);
      }

      transaction.set(technologyRef, technology);
    }

    // Approval and import are one atomic state transition. A transaction retry
    // reuses the deterministic ID and observes an already-complete import.
    transaction.update(signalRef, {
      status: 'Imported',
      reviewedAt: now,
      processedAt: now,
      importedAs: { type: 'technology', id: technologyId },
    });
    return { entityId: technologyId, entityType: 'technology' as const };
  });

  log.info('Auto-approved and imported signal as technology', {
    signalId,
    technologyId: result.entityId,
  });

  return result;
}
