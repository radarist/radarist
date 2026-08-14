'use client';

import { EntityGraphSyncWarning } from './EntityGraphSyncWarning';
import type { EntityGraphSyncRecovery } from '@/hooks/useEntityGraphSyncRecoveries';

interface EntityGraphSyncRecoveryBannerProps<TEntity extends { id: string }> {
  recoveries: ReadonlyArray<EntityGraphSyncRecovery<TEntity, unknown>>;
  maxRetryAttempts: number;
  /** How to name the entity in prose — "technology", "pain point". */
  entityTypeLabel: string;
  /**
   * Display name for a recovery. A rehydrated record carries no entity object,
   * so the fallback to the raw id is deliberate: an operator needs SOMETHING
   * addressable after a reload, and inventing a friendly name would be a lie.
   */
  getLabel: (recovery: EntityGraphSyncRecovery<TEntity, unknown>) => string;
  onRetry: (entityId: string) => void | Promise<void>;
}

/**
 * The outstanding graph-sync debts for one library page.
 *
 * GRAPH-058: every library page needs the identical block, and the version that
 * existed lived inline in the companies page. Hand-copying it seven times is how
 * six of them would have ended up subtly different — one forgetting
 * `awaitingConfirmation`, another forgetting the retry ceiling. Renders nothing
 * when there is no debt.
 */
export function EntityGraphSyncRecoveryBanner<TEntity extends { id: string }>({
  recoveries,
  maxRetryAttempts,
  entityTypeLabel,
  getLabel,
  onRetry,
}: EntityGraphSyncRecoveryBannerProps<TEntity>) {
  if (recoveries.length === 0) return null;

  return (
    <div className="space-y-3 border-b border-border p-4" data-testid="entity-graph-sync-recoveries">
      {recoveries.map((recovery) => (
        <EntityGraphSyncWarning
          key={recovery.entityId}
          entityLabel={getLabel(recovery)}
          entityTypeLabel={entityTypeLabel}
          awaitingConfirmation={recovery.awaitingConfirmation}
          operation={recovery.operation}
          retryAttempts={recovery.retryAttempts}
          maxRetryAttempts={maxRetryAttempts}
          isRetrying={recovery.isRetrying}
          onRetry={() => onRetry(recovery.entityId)}
        />
      ))}
    </div>
  );
}
