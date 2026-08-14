'use client';

import { useCallback } from 'react';
import type { EntityMutationOutcome } from '@/lib/entity-mutation-outcome';
import type { LibraryEntityTypeWithMutationOutcome } from '@/lib/mutation-outcome/coverage';
import { createLogger } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';
import { useEntityGraphSyncRecoveries, type EntityGraphSyncRecovery } from '@/hooks/useEntityGraphSyncRecoveries';

const log = createLogger('hooks/useLibraryEntityGraphSync');

export interface LibraryEntityGraphSyncOptions<TEntity extends { id: string }> {
  /**
   * Narrowed to the types that provably have a saved-locally resolver
   * (`mutation-outcome/coverage.ts`), so a type with no resolver cannot be wired
   * to this notice and appear handled when it is not.
   */
  entityType: LibraryEntityTypeWithMutationOutcome;
  /** How to name the entity in prose — "technology", "pain point". */
  entityTypeLabel: string;
  /** Display name for a committed entity, used in the toast and the notice. */
  getName: (entity: TEntity) => string;
}

/**
 * The saved-locally half of a library page's write path.
 *
 * GRAPH-058: `useEntityGraphSyncRecoveries` already owned the durable-anchor
 * lifecycle, but every consumer still had to hand-write the same three
 * decisions — rethrow a rejection, record the debt and toast "Saved locally" on a
 * lost handoff, toast success otherwise — plus the retry's own two-outcome toast.
 * Company had them inline in its page hook. Repeating that seven times is how the
 * types would drift apart; the interesting per-page work is only `applyCommitted`.
 *
 * The one rule this encodes: a committed Firestore document is NEVER surfaced as
 * a failed write. `status: 'rejected'` throws (nothing was written);
 * `saved-locally` applies the authoritative entity and warns about the graph;
 * `saved-and-queued` is a plain success.
 */
export function useLibraryEntityGraphSync<TEntity extends { id: string }>(
  options: LibraryEntityGraphSyncOptions<TEntity>
) {
  const { entityType, entityTypeLabel, getName } = options;
  const { toast } = useToast();
  const { recoveries, recordRecovery, clearRecovery, clearRecoveries, retryGraphSync, maxRetryAttempts } =
    useEntityGraphSyncRecoveries<TEntity>({ entityType });

  /**
   * Apply one mutation outcome. `applyCommitted` receives the authoritative
   * entity for BOTH successful paths, because a saved-locally write is committed
   * and must appear in the list exactly like a fully-synced one.
   */
  const applyOutcome = useCallback(
    (
      outcome: EntityMutationOutcome<TEntity>,
      handlers: {
        applyCommitted: (entity: TEntity) => void;
        /**
         * The success toast, or `null` when the caller reports success itself
         * (a page on a different toast system would otherwise double-report,
         * while the saved-locally notice stays owned here so it cannot be
         * forgotten).
         */
        success: { title: string; description: string } | null;
      }
    ): 'saved-and-queued' | 'saved-locally' => {
      if (outcome.status === 'rejected') {
        throw outcome.error;
      }

      handlers.applyCommitted(outcome.entity);

      if (outcome.status === 'saved-locally') {
        recordRecovery(outcome, undefined);
        toast({
          title: 'Saved locally',
          description: `"${getName(outcome.entity)}" is saved in this workspace, but graph synchronization was not acknowledged.`,
        });
        return outcome.status;
      }

      if (handlers.success) toast(handlers.success);
      return outcome.status;
    },
    [getName, recordRecovery, toast]
  );

  const retry = useCallback(
    async (entityId: string) => {
      const result = await retryGraphSync(entityId);
      if (result.status === 'acknowledged') {
        toast({
          title: 'Graph sync acknowledged',
          description: `"${result.recovery.entity ? getName(result.recovery.entity) : result.recovery.entityId}" is queued; the notice clears once the graph write is confirmed.`,
        });
        return;
      }
      if (result.status === 'failed') {
        log.warn('Graph sync retry was not acknowledged', {
          entityType,
          entityId: result.recovery.entityId,
          operation: result.recovery.operation,
          attempt: result.recovery.retryAttempts,
          error: result.error instanceof Error ? result.error.message : String(result.error),
        });
        toast({
          title: 'Graph sync still unavailable',
          description: `The ${entityTypeLabel} remains saved locally. No ${entityTypeLabel} data was submitted again.`,
          variant: 'destructive',
        });
      }
    },
    [entityType, entityTypeLabel, getName, retryGraphSync, toast]
  );

  /** Label a recovery for display; a rehydrated record has no entity object. */
  const getRecoveryLabel = useCallback(
    (recovery: EntityGraphSyncRecovery<TEntity, unknown>) =>
      recovery.entity ? getName(recovery.entity) : recovery.entityId,
    [getName]
  );

  return {
    recoveries,
    maxRetryAttempts,
    entityTypeLabel,
    applyOutcome,
    retryGraphSync: retry,
    clearRecovery,
    clearRecoveries,
    getRecoveryLabel,
  };
}
