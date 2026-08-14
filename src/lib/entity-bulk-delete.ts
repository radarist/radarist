/**
 * @file entity-bulk-delete.ts
 * @description Bounded, per-entity prerequisite accounting for bulk deletes.
 */

import { mapSettledWithBoundedConcurrency } from '@/lib/bounded-concurrency';

export const ENTITY_DELETE_MAX_CONCURRENCY = 8;

export interface PreparedEntityDeletion {
  id: string;
  relationsDeleted: number;
}

export interface FailedEntityDeletionPreparation {
  id: string;
  error: unknown;
}

/**
 * Runs all pre-parent-delete work with bounded concurrency and exact ID-level
 * outcomes. A failed prerequisite never enters the later Firestore batch.
 */
export async function prepareEntityDeletions(
  ids: readonly string[],
  prepare: (id: string) => Promise<number>
): Promise<{
  prepared: PreparedEntityDeletion[];
  failed: FailedEntityDeletionPreparation[];
}> {
  const outcomes = await mapSettledWithBoundedConcurrency(
    ids,
    ENTITY_DELETE_MAX_CONCURRENCY,
    prepare
  );

  const prepared: PreparedEntityDeletion[] = [];
  const failed: FailedEntityDeletionPreparation[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      prepared.push({ id: ids[index], relationsDeleted: outcome.value });
    } else {
      failed.push({ id: ids[index], error: outcome.reason });
    }
  });

  return { prepared, failed };
}
