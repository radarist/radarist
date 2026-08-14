/** Exact, bounded outcomes for UI bulk-delete flows. */

import { mapSettledWithBoundedConcurrency } from '@/lib/bounded-concurrency';

export const UI_ENTITY_DELETE_MAX_CONCURRENCY = 8;

export interface FailedEntityDelete {
  readonly id: string;
  readonly error: unknown;
}

export interface ExactEntityDeleteOutcome {
  readonly deletedIds: readonly string[];
  readonly failed: readonly FailedEntityDelete[];
}

/**
 * Run every requested delete and retain the exact outcome for each ID. The
 * function resolves even when individual deletes fail so callers can refresh
 * successful rows and keep only failed rows selected for retry.
 */
export async function deleteEntitiesWithExactOutcomes(
  ids: readonly string[],
  deleteEntity: (id: string) => Promise<void>,
  maxConcurrency = UI_ENTITY_DELETE_MAX_CONCURRENCY
): Promise<ExactEntityDeleteOutcome> {
  const outcomes = await mapSettledWithBoundedConcurrency(ids, maxConcurrency, deleteEntity);
  const deletedIds: string[] = [];
  const failed: FailedEntityDelete[] = [];

  outcomes.forEach((outcome, index) => {
    const id = ids[index];
    if (outcome.status === 'fulfilled') {
      deletedIds.push(id);
    } else {
      failed.push({ id, error: outcome.reason });
    }
  });

  return { deletedIds, failed };
}

/**
 * Selected Org Units must be removed child-first. Sequential execution then
 * lets a selected parent pass its ownership preflight only after its selected
 * descendants have actually been deleted.
 */
export function orderOrgUnitDeletionIds(
  ids: readonly string[],
  orgUnits: readonly { readonly id: string; readonly parentId?: string }[]
): string[] {
  const requested = new Set(ids);
  const parentById = new Map(orgUnits.map((orgUnit) => [orgUnit.id, orgUnit.parentId]));
  const depthById = new Map<string, number>();

  const selectedDepth = (id: string, visiting: Set<string>): number => {
    const cached = depthById.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;

    const parentId = parentById.get(id);
    if (!parentId || !requested.has(parentId)) {
      depthById.set(id, 0);
      return 0;
    }

    const nextVisiting = new Set(visiting);
    nextVisiting.add(id);
    const depth = selectedDepth(parentId, nextVisiting) + 1;
    depthById.set(id, depth);
    return depth;
  };

  return [...ids].sort(
    (left, right) =>
      selectedDepth(right, new Set()) - selectedDepth(left, new Set()) ||
      left.localeCompare(right)
  );
}
