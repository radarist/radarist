/**
 * @file lib/mutation-outcome/prototype.ts
 * @description Saved-locally truth for prototype writes (GRAPH-058).
 *
 * `resolveEntityMutationOutcome` already knew how to tell a rejected write from a
 * committed one whose graph handoff was lost; Company was simply the only type
 * wired to it. This is the prototype wiring.
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
import { createPrototype, getPrototypeById, updatePrototype } from '@/lib/prototypes';
import type { Prototype } from '@/lib/types';

export type PrototypeCreateInput = Parameters<typeof createPrototype>[0];
export type PrototypeUpdateInput = Parameters<typeof updatePrototype>[1];

export function resolvePrototypeCreateOutcome(input: PrototypeCreateInput): Promise<EntityMutationOutcome<Prototype>> {
  return resolveEntityMutationOutcome({
    entityType: 'prototype',
    operation: 'create',
    mutate: () => createPrototype(input),
    readAuthoritative: getPrototypeById,
  });
}

export function resolvePrototypeUpdateOutcome(
  current: Prototype,
  updates: PrototypeUpdateInput
): Promise<EntityMutationOutcome<Prototype>> {
  return resolveEntityMutationOutcome({
    entityType: 'prototype',
    operation: 'update',
    expectedEntityId: current.id,
    mutate: async () => {
      await updatePrototype(current.id, updates);
      return { ...current, ...updates, id: current.id, updatedAt: Date.now() } as Prototype;
    },
    readAuthoritative: getPrototypeById,
  });
}
