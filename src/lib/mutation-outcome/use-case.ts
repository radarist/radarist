/**
 * @file lib/mutation-outcome/use-case.ts
 * @description Saved-locally truth for use case writes (GRAPH-058).
 *
 * `resolveEntityMutationOutcome` already knew how to tell a rejected write from a
 * committed one whose graph handoff was lost; Company was simply the only type
 * wired to it. This is the use case wiring.
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
import { createUseCase, getUseCaseById, updateUseCase } from '@/lib/use-cases';
import type { UseCase } from '@/lib/types';

export type UseCaseCreateInput = Parameters<typeof createUseCase>[0];
export type UseCaseUpdateInput = Parameters<typeof updateUseCase>[1];

export function resolveUseCaseCreateOutcome(input: UseCaseCreateInput): Promise<EntityMutationOutcome<UseCase>> {
  return resolveEntityMutationOutcome({
    entityType: 'useCase',
    operation: 'create',
    mutate: () => createUseCase(input),
    readAuthoritative: getUseCaseById,
  });
}

export function resolveUseCaseUpdateOutcome(
  current: UseCase,
  updates: UseCaseUpdateInput
): Promise<EntityMutationOutcome<UseCase>> {
  return resolveEntityMutationOutcome({
    entityType: 'useCase',
    operation: 'update',
    expectedEntityId: current.id,
    mutate: async () => {
      await updateUseCase(current.id, updates);
      return { ...current, ...updates, id: current.id, updatedAt: Date.now() } as UseCase;
    },
    readAuthoritative: getUseCaseById,
  });
}
