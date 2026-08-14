'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityMutationOutcome } from '@/lib/entity-mutation-outcome';
import {
  requestEntityGraphSync,
  type EntitySyncDispatchError,
  type EntitySyncOperation,
  type LibraryEntitySyncType,
} from '@/lib/entity-sync';
import { MAX_ENTITY_GRAPH_SYNC_ATTEMPTS } from '@/lib/entity-graph-sync-outbox';
import {
  advanceEntityGraphSyncAnchor,
  listEntityGraphSyncAnchors,
  markEntityGraphSyncAnchorDispatched,
  readEntityGraphSyncAnchor,
} from '@/lib/entity-graph-sync-outbox-client';

export const MAX_ENTITY_GRAPH_SYNC_RETRIES = MAX_ENTITY_GRAPH_SYNC_ATTEMPTS;
export const MAX_VISIBLE_GRAPH_SYNC_RECOVERIES = 10;

type SavedLocallyOutcome<TEntity extends { id: string }> = Extract<
  EntityMutationOutcome<TEntity>,
  { status: 'saved-locally' }
>;

/**
 * One outstanding graph-sync debt, as shown to the operator.
 *
 * GRAPH-056: recoveries are no longer purely in-session. A reload rehydrates
 * them from the durable anchor, so `entity` and `graphSyncError` are optional —
 * a rehydrated record knows the entity's identity and how stale it is, but not
 * the in-memory object or the original Error instance.
 */
export type EntityGraphSyncRecovery<TEntity extends { id: string }, TContext = undefined> = {
  status: 'saved-locally';
  entityType: LibraryEntitySyncType;
  entityId: string;
  operation: Exclude<EntitySyncOperation, 'delete'>;
  /** Absent when rehydrated from the durable anchor after a reload. */
  entity?: TEntity;
  /** Absent when rehydrated; `lastError` carries the stored message instead. */
  graphSyncError?: EntitySyncDispatchError;
  lastError?: string | null;
  retryAttempts: number;
  isRetrying: boolean;
  /**
   * A retry reached the queue but the graph write is not yet confirmed.
   *
   * The row deliberately stays visible: an acknowledged dispatch is not a
   * completed projection, and treating it as one is the defect this contract
   * exists to fix. The record disappears when the worker settles the anchor.
   */
  awaitingConfirmation: boolean;
  /** True when this record came from the durable anchor rather than this session. */
  rehydrated: boolean;
  context: TContext;
};

export type EntityGraphSyncRetryResult<TEntity extends { id: string }, TContext> =
  | { status: 'acknowledged'; recovery: EntityGraphSyncRecovery<TEntity, TContext> }
  | {
      status: 'failed';
      recovery: EntityGraphSyncRecovery<TEntity, TContext>;
      error: unknown;
    }
  | { status: 'ignored' };

export function useEntityGraphSyncRecoveries<TEntity extends { id: string }, TContext = undefined>(options?: {
  maxRecoveries?: number;
  maxRetryAttempts?: number;
  /** Limit rehydration to one entity type; omit to rehydrate every outstanding anchor. */
  entityType?: LibraryEntitySyncType;
  /** Context applied to rehydrated records, which carry none of their own. */
  rehydratedContext?: TContext;
}) {
  const maxRecoveries = options?.maxRecoveries ?? MAX_VISIBLE_GRAPH_SYNC_RECOVERIES;
  const maxRetryAttempts = options?.maxRetryAttempts ?? MAX_ENTITY_GRAPH_SYNC_RETRIES;
  const entityType = options?.entityType;
  const rehydratedContext = options?.rehydratedContext;
  const [recoveries, setRecoveriesState] = useState<Array<EntityGraphSyncRecovery<TEntity, TContext>>>([]);
  const recoveriesRef = useRef(recoveries);
  const inFlightRef = useRef(new Set<string>());

  const updateRecoveries = useCallback(
    (
      update: (
        current: Array<EntityGraphSyncRecovery<TEntity, TContext>>
      ) => Array<EntityGraphSyncRecovery<TEntity, TContext>>
    ) => {
      const next = update(recoveriesRef.current);
      recoveriesRef.current = next;
      setRecoveriesState(next);
      return next;
    },
    []
  );

  /**
   * Reconstruct outstanding operations from the durable anchor on mount.
   *
   * In-session records win: one written moments ago carries the live entity and
   * the original error, which a rehydrated record cannot.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const anchors = await listEntityGraphSyncAnchors(entityType);
      if (cancelled || anchors.length === 0) return;

      updateRecoveries((current) => {
        const known = new Set(current.map((recovery) => recovery.entityId));
        const restored = anchors
          .filter((anchor) => !known.has(anchor.entityId))
          .map<EntityGraphSyncRecovery<TEntity, TContext>>((anchor) => ({
            status: 'saved-locally',
            entityType: anchor.entityType,
            entityId: anchor.entityId,
            operation: anchor.operation,
            lastError: anchor.lastError,
            retryAttempts: anchor.attempt,
            isRetrying: false,
            awaitingConfirmation: anchor.lastDispatchedAt !== null,
            rehydrated: true,
            context: rehydratedContext as TContext,
          }));
        return [...current, ...restored].slice(0, Math.max(1, maxRecoveries));
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [entityType, maxRecoveries, rehydratedContext, updateRecoveries]);

  const recordRecovery = useCallback(
    (outcome: SavedLocallyOutcome<TEntity>, context: TContext) => {
      const recovery: EntityGraphSyncRecovery<TEntity, TContext> = {
        status: 'saved-locally',
        entityType: outcome.entityType,
        entityId: outcome.entityId,
        operation: outcome.operation,
        entity: outcome.entity,
        graphSyncError: outcome.graphSyncError,
        lastError: outcome.graphSyncError?.message ?? null,
        retryAttempts: 0,
        isRetrying: false,
        awaitingConfirmation: false,
        rehydrated: false,
        context,
      };
      updateRecoveries((current) =>
        [recovery, ...current.filter(({ entityId }) => entityId !== recovery.entityId)].slice(
          0,
          Math.max(1, maxRecoveries)
        )
      );
      return recovery;
    },
    [maxRecoveries, updateRecoveries]
  );

  /** Hide a row locally. Only server-side convergence may retire its anchor. */
  const clearRecovery = useCallback(
    (entityId: string) => {
      updateRecoveries((current) => current.filter((recovery) => recovery.entityId !== entityId));
    },
    [updateRecoveries]
  );

  const clearRecoveries = useCallback(
    (entityIds: Iterable<string>) => {
      const removed = new Set(entityIds);
      if (removed.size === 0) return;
      updateRecoveries((current) => current.filter((recovery) => !removed.has(recovery.entityId)));
    },
    [updateRecoveries]
  );

  const retryGraphSync = useCallback(
    async (entityId: string): Promise<EntityGraphSyncRetryResult<TEntity, TContext>> => {
      const recovery = recoveriesRef.current.find((candidate) => candidate.entityId === entityId);
      if (
        !recovery ||
        recovery.retryAttempts >= maxRetryAttempts ||
        recovery.isRetrying ||
        inFlightRef.current.has(entityId)
      ) {
        return { status: 'ignored' };
      }

      inFlightRef.current.add(entityId);
      updateRecoveries((current) =>
        current.map((candidate) => (candidate.entityId === entityId ? { ...candidate, isRetrying: true } : candidate))
      );

      // Capture the generation before dispatch. Retry metadata may update only
      // this exact debt; a concurrent mutation replaces the anchor with a
      // fresh generation that an older retry must never overwrite.
      const anchor = await readEntityGraphSyncAnchor(recovery.entityType, recovery.entityId);

      try {
        await requestEntityGraphSync(recovery.entityType, recovery.entityId, recovery.operation);
        if (anchor) {
          await markEntityGraphSyncAnchorDispatched(
            recovery.entityType,
            recovery.entityId,
            anchor.generation
          );
        }

        // Deliberately NOT cleared. The queue accepted the event; Neo4j has not
        // written it yet. The worker retires the anchor once the projection
        // provably matches the source, and the row disappears on the next load.
        let confirmed = recovery;
        updateRecoveries((current) =>
          current.map((candidate) => {
            if (candidate.entityId !== entityId) return candidate;
            confirmed = { ...candidate, isRetrying: false, awaitingConfirmation: true };
            return confirmed;
          })
        );
        return { status: 'acknowledged', recovery: confirmed };
      } catch (error) {
        if (anchor) {
          await advanceEntityGraphSyncAnchor(
            recovery.entityType,
            recovery.entityId,
            anchor.generation,
            error
          );
        }
        let failedRecovery = recovery;
        updateRecoveries((current) =>
          current.map((candidate) => {
            if (candidate.entityId !== entityId) return candidate;
            failedRecovery = {
              ...candidate,
              isRetrying: false,
              retryAttempts: Math.min(candidate.retryAttempts + 1, maxRetryAttempts),
            };
            return failedRecovery;
          })
        );
        return { status: 'failed', recovery: failedRecovery, error };
      } finally {
        inFlightRef.current.delete(entityId);
      }
    },
    [maxRetryAttempts, updateRecoveries]
  );

  return {
    recoveries,
    recordRecovery,
    clearRecovery,
    clearRecoveries,
    retryGraphSync,
    maxRetryAttempts,
  };
}
