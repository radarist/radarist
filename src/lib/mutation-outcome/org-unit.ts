/**
 * @file lib/mutation-outcome/org-unit.ts
 * @description Saved-locally truth for org unit writes (GRAPH-058).
 *
 * `resolveEntityMutationOutcome` already knew how to tell a rejected write from a
 * committed one whose graph handoff was lost; Company was simply the only type
 * wired to it. This is the org unit wiring.
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
import { createOrgUnit, getOrgUnitById, updateOrgUnit } from '@/lib/org-units';
import type { OrgUnit } from '@/lib/types';

export type OrgUnitCreateInput = Parameters<typeof createOrgUnit>[0];
export type OrgUnitUpdateInput = Parameters<typeof updateOrgUnit>[1];

export function resolveOrgUnitCreateOutcome(input: OrgUnitCreateInput): Promise<EntityMutationOutcome<OrgUnit>> {
  return resolveEntityMutationOutcome({
    entityType: 'orgUnit',
    operation: 'create',
    mutate: () => createOrgUnit(input),
    readAuthoritative: getOrgUnitById,
  });
}

export function resolveOrgUnitUpdateOutcome(
  current: OrgUnit,
  updates: OrgUnitUpdateInput
): Promise<EntityMutationOutcome<OrgUnit>> {
  return resolveEntityMutationOutcome({
    entityType: 'orgUnit',
    operation: 'update',
    expectedEntityId: current.id,
    mutate: async () => {
      await updateOrgUnit(current.id, updates);
      return { ...current, ...updates, id: current.id, updatedAt: Date.now() } as OrgUnit;
    },
    readAuthoritative: getOrgUnitById,
  });
}
