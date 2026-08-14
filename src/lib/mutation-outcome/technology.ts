/**
 * @file lib/mutation-outcome/technology.ts
 * @description Saved-locally truth for technology writes (GRAPH-058).
 *
 * `resolveEntityMutationOutcome` already knew how to tell a rejected write from a
 * committed one whose graph handoff was lost; Company was simply the only type
 * wired to it. This is the technology wiring.
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
import {
  createTechnology,
  getTechnologyById,
  updateTechnology,
  updateTechnologyWithSync,
  type TRLSyncResult,
} from '@/lib/technology-service';
import type { Technology } from '@/lib/types';

export type TechnologyCreateInput = Parameters<typeof createTechnology>[0];
export type TechnologyUpdateInput = Parameters<typeof updateTechnology>[1];

export function resolveTechnologyCreateOutcome(
  input: TechnologyCreateInput
): Promise<EntityMutationOutcome<Technology>> {
  return resolveEntityMutationOutcome({
    entityType: 'technology',
    operation: 'create',
    mutate: () => createTechnology(input),
    readAuthoritative: getTechnologyById,
  });
}

export function resolveTechnologyUpdateOutcome(
  current: Pick<Technology, 'id'>,
  updates: TechnologyUpdateInput
): Promise<EntityMutationOutcome<Technology>> {
  return resolveEntityMutationOutcome({
    entityType: 'technology',
    operation: 'update',
    expectedEntityId: current.id,
    mutate: () => updateTechnology(current.id, updates),
    readAuthoritative: getTechnologyById,
  });
}

/**
 * The technology-sheet save, which also propagates TRL/TimeToImpact to radar
 * placements.
 *
 * `syncResult` is `null` exactly when the graph handoff was lost. The propagation
 * itself still ran (see `updateTechnologyWithSync`), but its result is not
 * observable through the rethrown dispatch error — and claiming a placement count
 * we did not receive would be worse than saying nothing.
 */
export async function resolveTechnologyUpdateWithPlacementSyncOutcome(
  current: Pick<Technology, 'id'>,
  updates: TechnologyUpdateInput
): Promise<{ outcome: EntityMutationOutcome<Technology>; syncResult: TRLSyncResult | null }> {
  let syncResult: TRLSyncResult | null = null;
  const outcome = await resolveEntityMutationOutcome<Technology>({
    entityType: 'technology',
    operation: 'update',
    expectedEntityId: current.id,
    mutate: async () => {
      const result = await updateTechnologyWithSync(current.id, updates);
      syncResult = result.syncResult;
      return result.technology;
    },
    readAuthoritative: getTechnologyById,
  });
  return { outcome, syncResult };
}
