/**
 * Durable, replay-safe handoff for projecting a Firestore Radar into Neo4j.
 *
 * The Firestore document is the retry anchor. Callers invoke this only after
 * their write commits and must propagate failures so they never report graph
 * convergence that was not acknowledged. A deterministic event id collapses
 * ambiguous/repeated sends for the same source version; the Neo4j worker is
 * independently idempotent for replays outside Inngest's deduplication window.
 */

import 'server-only';

import { createHash } from 'node:crypto';
import type { RadarData } from '@/lib/types';

const RADAR_PROJECTION_EVENT_NAMESPACE = 'radarist.radar-projection.v1';

export interface RadarProjectionSource {
  id: string;
  updatedAt?: number;
  createdAt?: number;
}

export interface RadarProjectionEvent {
  id: string;
  name: 'app/radar.sync.requested';
  data: {
    radarId: string;
    sourceUpdatedAt: number;
    dispatchKey: string;
  };
}

export class RadarProjectionDispatchError extends Error {
  readonly radarId: string;
  readonly sourceUpdatedAt: number;

  constructor(radarId: string, sourceUpdatedAt: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Radar ${radarId} was saved in Firestore, but its graph projection handoff was not acknowledged: ${detail}. ` +
        'Do not recreate it; reconciliation will retry from the committed Radar.'
    );
    this.name = 'RadarProjectionDispatchError';
    this.radarId = radarId;
    this.sourceUpdatedAt = sourceUpdatedAt;
    this.cause = cause;
  }
}

/** Return the persisted source version used for event identity and stale checks. */
export function getRadarProjectionVersion(radar: RadarProjectionSource): number {
  const version = radar.updatedAt ?? radar.createdAt ?? 0;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`Radar ${radar.id} has an invalid projection version`);
  }
  return version;
}

/**
 * Build one byte-stable event for one committed Radar version and dispatch.
 *
 * Admin writes use the default `source` key, so ambiguous acknowledgements
 * replay the same event ID. Each reconciliation execution supplies its own
 * stable key, allowing a new worker run after an earlier run exhausted retries.
 */
export function createRadarProjectionEvent(
  radar: RadarProjectionSource,
  dispatchKey = 'source'
): RadarProjectionEvent {
  if (radar.id.trim().length === 0) {
    throw new Error('Radar projection id must not be empty');
  }
  if (dispatchKey.trim().length === 0) {
    throw new Error('Radar projection dispatch key must not be empty');
  }

  const sourceUpdatedAt = getRadarProjectionVersion(radar);
  const digest = createHash('sha256')
    .update(JSON.stringify([RADAR_PROJECTION_EVENT_NAMESPACE, radar.id, sourceUpdatedAt, dispatchKey]))
    .digest('hex');

  return {
    id: `radar-sync-v1-${digest}`,
    name: 'app/radar.sync.requested',
    data: { radarId: radar.id, sourceUpdatedAt, dispatchKey },
  };
}

/**
 * Await Inngest acceptance. A rejected or ambiguously acknowledged send is a
 * caller-visible failure; the already-committed Radar remains replayable.
 */
export async function requestRadarGraphProjection(
  radar: Pick<RadarData, 'id' | 'updatedAt' | 'createdAt'>
): Promise<void> {
  const event = createRadarProjectionEvent(radar);

  try {
    const { inngest } = await import('@/lib/inngest/send-client');
    const accepted = await inngest.send(event);
    if (!accepted.ids?.length) {
      throw new Error('Inngest accepted no event (graph synchronization may be disabled)');
    }
  } catch (error) {
    throw new RadarProjectionDispatchError(radar.id, event.data.sourceUpdatedAt, error);
  }
}
