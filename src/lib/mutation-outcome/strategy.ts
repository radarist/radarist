/**
 * @file lib/mutation-outcome/strategy.ts
 * @description Saved-locally truth for strategy writes (GRAPH-058).
 *
 * `resolveEntityMutationOutcome` already knew how to tell a rejected write from a
 * committed one whose graph handoff was lost; Company was simply the only type
 * wired to it. This is the strategy wiring.
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
import { createStrategy, getStrategyById, updateStrategy } from '@/lib/strategies';
import type { Strategy } from '@/lib/types';

export type StrategyCreateInput = Parameters<typeof createStrategy>[0];
export type StrategyUpdateInput = Parameters<typeof updateStrategy>[1];

export function resolveStrategyCreateOutcome(input: StrategyCreateInput): Promise<EntityMutationOutcome<Strategy>> {
  return resolveEntityMutationOutcome({
    entityType: 'strategy',
    operation: 'create',
    mutate: () => createStrategy(input),
    readAuthoritative: getStrategyById,
  });
}

export function resolveStrategyUpdateOutcome(
  current: Strategy,
  updates: StrategyUpdateInput
): Promise<EntityMutationOutcome<Strategy>> {
  return resolveEntityMutationOutcome({
    entityType: 'strategy',
    operation: 'update',
    expectedEntityId: current.id,
    mutate: async () => {
      await updateStrategy(current.id, updates);
      return { ...current, ...updates, id: current.id, updatedAt: Date.now() } as Strategy;
    },
    readAuthoritative: getStrategyById,
  });
}
