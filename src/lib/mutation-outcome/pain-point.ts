/**
 * @file lib/mutation-outcome/pain-point.ts
 * @description Saved-locally truth for pain point writes (GRAPH-058).
 *
 * `resolveEntityMutationOutcome` already knew how to tell a rejected write from a
 * committed one whose graph handoff was lost; Company was simply the only type
 * wired to it. This is the pain point wiring.
 *
 * One module per entity type, deliberately: a single registry importing all
 * seven services pulled every service's Firebase initialization into every
 * consumer — six unrelated services in each library page's module graph, and a
 * broken import chain for any test that mocked only its own service.
 * `coverage.ts` holds the exhaustiveness lock without importing anything.
 *
 * The update resolver keeps the caller's snapshot for the acknowledged fast path.
 * That optimistic merge is never load-bearing: a failed handoff always re-reads
 * Firestore through the shared contract, so the degraded path shows authoritative
 * state rather than a hopeful local one.
 */

import { resolveEntityMutationOutcome, type EntityMutationOutcome } from '@/lib/entity-mutation-outcome';
import { createPainPoint, getPainPointById, updatePainPoint } from '@/lib/pain-points';
import type { PainPoint } from '@/lib/types';

export type PainPointCreateInput = Parameters<typeof createPainPoint>[0];
export type PainPointUpdateInput = Parameters<typeof updatePainPoint>[1];

export function resolvePainPointCreateOutcome(input: PainPointCreateInput): Promise<EntityMutationOutcome<PainPoint>> {
  return resolveEntityMutationOutcome({
    entityType: 'painPoint',
    operation: 'create',
    mutate: () => createPainPoint(input),
    readAuthoritative: getPainPointById,
  });
}

export function resolvePainPointUpdateOutcome(
  current: PainPoint,
  updates: PainPointUpdateInput
): Promise<EntityMutationOutcome<PainPoint>> {
  return resolveEntityMutationOutcome({
    entityType: 'painPoint',
    operation: 'update',
    expectedEntityId: current.id,
    mutate: async () => {
      await updatePainPoint(current.id, updates);
      return { ...current, ...updates, id: current.id, updatedAt: Date.now() } as PainPoint;
    },
    readAuthoritative: getPainPointById,
  });
}
