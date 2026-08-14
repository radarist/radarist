'use client';

import { useEffect, useRef } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';
import type { EntityType } from '@/lib/types';

const log = createLogger('hooks/useTrackEntityView');
const TRACK_RETRY_DELAYS_MS = [0, 500, 1_000, 2_000, 4_000] as const;

interface TrackResponse {
  readonly tracked?: unknown;
  readonly reason?: unknown;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, delayMs);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

/**
 * POST /api/session/track when the component first sees a non-empty
 * (entityId, entityType) pair. A newly-created entity can reach the sheet
 * before its graph-sync event reaches Neo4j; the route reports that expected
 * race honestly as `{ tracked:false }`. Retry that result for a short, bounded
 * window and dedupe only after the server confirms the EXPLORED edge exists.
 *
 * Fire-and-forget: track failures never surface to the UI. This powers
 * the proactive-intelligence pipeline (Session + EXPLORED edges in Neo4j)
 * without which the dot-connector and insight detection cannot run.
 *
 * @param entityId   Firestore id of the entity the user is viewing
 * @param entityType 'company' | 'technology' | 'useCase' | ... (EntityType)
 */
export function useTrackEntityView(entityId: string | undefined | null, entityType: EntityType | undefined | null) {
  const lastTrackedRef = useRef<string | null>(null);
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!entityId || !entityType) return;
    if (loading || !user) return;

    // Exploration memory is user-scoped. Include the uid so an auth transition
    // on a still-mounted sheet cannot inherit another user's dedupe marker.
    const key = `${user.uid}:${entityType}:${entityId}`;
    if (lastTrackedRef.current === key) return;

    const controller = new AbortController();

    void (async () => {
      for (const delayMs of TRACK_RETRY_DELAYS_MS) {
        try {
          await waitForRetry(delayMs, controller.signal);
          const response = await fetchWithAuth('/api/session/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entityId, entityType }),
            signal: controller.signal,
          });

          if (!response.ok) {
            // Auth/validation failures are terminal. Transient server failures
            // receive the same bounded retry budget as a graph-sync race.
            if (response.status < 500) return;
            continue;
          }

          const payload = (await response.json()) as TrackResponse;
          if (payload.tracked === true) {
            lastTrackedRef.current = key;
            return;
          }

          // Graph-disabled/unconfigured is an intentional terminal mode, not
          // a graph-sync race. Mark it handled to avoid useless retries.
          if (payload.reason === 'graph-disabled' || payload.reason === 'graph-unconfigured') {
            lastTrackedRef.current = key;
            return;
          }
        } catch (error) {
          if (isAbortError(error)) return;
          log.debug('session track attempt failed (silent)', {
            err: error instanceof Error ? error.message : String(error),
          });
        }
      }

      log.warn('session track retry window exhausted', { entityId, entityType });
    })();

    return () => controller.abort();
  }, [entityId, entityType, loading, user]);
}
