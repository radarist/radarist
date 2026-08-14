/**
 * @file lib/mutation-outcome/initiative.ts
 * @description Saved-locally truth for initiative writes (GRAPH-058).
 *
 * `resolveEntityMutationOutcome` already knew how to tell a rejected write from a
 * committed one whose graph handoff was lost; Company was simply the only type
 * wired to it. This is the initiative wiring.
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
import { createInitiative, getInitiativeById, updateInitiative } from '@/lib/initiatives';
import type { Initiative } from '@/lib/types';

export type InitiativeCreateInput = Parameters<typeof createInitiative>[0];
export type InitiativeUpdateInput = Parameters<typeof updateInitiative>[1];

export function resolveInitiativeCreateOutcome(
  input: InitiativeCreateInput
): Promise<EntityMutationOutcome<Initiative>> {
  return resolveEntityMutationOutcome({
    entityType: 'initiative',
    operation: 'create',
    mutate: () => createInitiative(input),
    readAuthoritative: getInitiativeById,
  });
}

export function resolveInitiativeUpdateOutcome(
  current: Initiative,
  updates: InitiativeUpdateInput
): Promise<EntityMutationOutcome<Initiative>> {
  return resolveEntityMutationOutcome({
    entityType: 'initiative',
    operation: 'update',
    expectedEntityId: current.id,
    mutate: async () => {
      await updateInitiative(current.id, updates);
      return { ...current, ...updates, id: current.id, updatedAt: Date.now() } as Initiative;
    },
    readAuthoritative: getInitiativeById,
  });
}
