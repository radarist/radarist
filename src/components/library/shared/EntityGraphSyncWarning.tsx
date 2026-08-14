'use client';

import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { EntitySyncOperation } from '@/lib/entity-sync';

interface EntityGraphSyncWarningProps {
  entityLabel: string;
  /**
   * How to name the entity in prose — "company", "technology", "pain point".
   *
   * GRAPH-058: this used to be the literal word "company" inside a component
   * shared by every library page, so wiring a second entity type would have made
   * the notice lie about which record is saved locally.
   */
  entityTypeLabel: string;
  operation: Exclude<EntitySyncOperation, 'delete'>;
  retryAttempts: number;
  maxRetryAttempts: number;
  isRetrying: boolean;
  /** A retry reached the queue; the graph write is not yet confirmed. */
  awaitingConfirmation?: boolean;
  onRetry: () => void | Promise<void>;
}

export function EntityGraphSyncWarning({
  entityLabel,
  entityTypeLabel,
  operation,
  retryAttempts,
  maxRetryAttempts,
  isRetrying,
  awaitingConfirmation = false,
  onRetry,
}: EntityGraphSyncWarningProps) {
  const exhausted = retryAttempts >= maxRetryAttempts;
  const remaining = Math.max(0, maxRetryAttempts - retryAttempts);

  return (
    <Alert className="border-amber-500/50 bg-amber-500/5 text-foreground [&>svg]:text-amber-600">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Saved locally; graph sync not acknowledged</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p>
            &ldquo;{entityLabel}&rdquo; was {operation === 'create' ? 'created' : 'updated'} in this workspace. The
            saved {entityTypeLabel} data is shown, but Graph may remain stale until synchronization succeeds.
          </p>
          <p className="text-xs text-muted-foreground">
            {awaitingConfirmation
              ? 'A retry reached the queue. This notice clears once the graph write is confirmed — an accepted handoff is not yet a completed sync.'
              : exhausted
                ? 'The retry limit is reached. The local save is intact; Graph remains stale until a later reconciliation succeeds.'
                : `${remaining} graph sync ${remaining === 1 ? 'attempt' : 'attempts'} remaining for this save.`}
          </p>
        </div>
        {!exhausted && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={isRetrying}
            onClick={() => void onRetry()}
            aria-label={isRetrying ? 'Retrying graph sync' : 'Retry graph sync'}
          >
            {isRetrying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {isRetrying ? 'Retrying' : 'Retry graph sync'}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
