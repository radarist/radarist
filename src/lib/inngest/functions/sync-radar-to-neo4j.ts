/**
 * Project the authoritative Firestore Radar document into Neo4j.
 *
 * Events carry only identity plus the committed source version. The worker
 * always reloads the full document so out-of-order create/update events
 * converge on the newest source state. The MERGE is replay-safe after duplicate
 * delivery, a partial retry, or a graph commit whose acknowledgement was lost.
 */

import { checkHealth, runWriteTransaction } from '@/lib/graph';
import { buildRadarGraphProjectionProperties } from '@/lib/graph/radar-projection-contract';
import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import { createRadarProjectionEvent } from '@/lib/radar-projection-sync';
import type { RadarData } from '@/lib/types';
import { inngest } from '../client';
import { extractFailureEventData } from '../utils';

const log = createLogger('inngest/sync-radar-to-neo4j');

const UPSERT_RADAR = `
  MERGE (radar:Radar {id: $radarId})
  ON CREATE SET radar.updatedAt = -1
  WITH radar
  WHERE radar.updatedAt IS NULL OR radar.updatedAt <= $updatedAt
  SET radar.name = $name,
      radar.slug = $slug,
      radar.description = $description,
      radar.ringSystem = $ringSystem,
      radar.quadrantIds = $quadrantIds,
      radar.quadrantNames = $quadrantNames,
      radar.quadrantCount = $quadrantCount,
      radar.createdAt = $createdAt,
      radar.updatedAt = $updatedAt
  RETURN radar.id AS radarId, radar.updatedAt AS updatedAt
`;

interface RadarProjectionResult {
  success: true;
  radarId: string;
  sourceUpdatedAt: number;
  dispatchKey: string;
  projectedUpdatedAt?: number;
  skipped?: 'source-missing';
}

async function loadRadarSource(radarId: string): Promise<RadarData | null> {
  const snapshot = await db.collection('radars').doc(radarId).get();
  if (!snapshot.exists) {
    return null;
  }
  return { ...(snapshot.data() as Omit<RadarData, 'id'>), id: snapshot.id } as RadarData;
}

export const syncRadarToNeo4jJob = inngest.createFunction(
  {
    id: 'sync-radar-to-neo4j',
    name: 'Sync Radar to Neo4j',
    retries: 3,
    throttle: {
      limit: 50,
      period: '1m',
    },
    // Create and immediate update events have different deterministic IDs, so
    // serialize versions of the same Radar while allowing different Radars to
    // project concurrently.
    concurrency: {
      key: 'event.data.radarId',
      limit: 1,
    },
    onFailure: async ({ error, event }) => {
      const data = extractFailureEventData<{
        radarId?: string;
        sourceUpdatedAt?: number;
        dispatchKey?: string;
      }>(event.data);
      const radarId = data.radarId || 'unknown';
      log.error('Radar projection final failure', new Error(error.message), { radarId });

      await inngest.send({
        name: 'app/radar.sync.failed',
        data: {
          radarId,
          sourceUpdatedAt: data.sourceUpdatedAt ?? 0,
          dispatchKey: data.dispatchKey || 'unknown',
          error: error.message,
          failedAt: Date.now(),
        },
      });
    },
  },
  { event: 'app/radar.sync.requested' },
  async ({ event, step }): Promise<RadarProjectionResult> => {
    const { radarId, sourceUpdatedAt, dispatchKey } = event.data;

    const expectedEventId = createRadarProjectionEvent(
      { id: radarId, updatedAt: sourceUpdatedAt },
      dispatchKey
    ).id;
    if (event.id !== expectedEventId) {
      throw new Error('Radar projection event ID does not match its payload identity');
    }

    await step.run('check-neo4j-health', async () => {
      const health = await checkHealth();
      if (!health.healthy) {
        throw new Error(`Neo4j not healthy: ${health.error}`);
      }
      return health;
    });

    const radar = await step.run('load-radar', async () => {
      return await loadRadarSource(radarId);
    });

    // A concurrent delete owns graph cleanup. Never resurrect a source that no
    // longer exists merely because an older projection event was delayed.
    if (!radar) {
      log.info('Skipping Radar projection because the source no longer exists', { radarId, sourceUpdatedAt });
      return { success: true, radarId, sourceUpdatedAt, dispatchKey, skipped: 'source-missing' };
    }

    const projection = await step.run('upsert-radar', async () => {
      // Re-read at the graph-write boundary. Inngest memoizes the earlier
      // load step, so relying on it during a retry could resurrect a Radar
      // whose Firestore document was deleted after that step completed.
      const current = await loadRadarSource(radarId);
      if (!current) {
        return null;
      }

      const graphProperties = buildRadarGraphProjectionProperties(current);
      const projectedUpdatedAt = graphProperties.updatedAt;
      const { id: projectedRadarId, ...projectionParameters } = graphProperties;
      if (projectedRadarId !== radarId) throw new Error('Radar projection source identity changed during reload');
      if (projectedUpdatedAt < sourceUpdatedAt) {
        throw new Error(
          `Radar ${radarId} source version ${projectedUpdatedAt} is older than requested version ${sourceUpdatedAt}`
        );
      }

      await runWriteTransaction(UPSERT_RADAR, {
        radarId,
        ...projectionParameters,
      });

      return { projectedUpdatedAt };
    });

    if (!projection) {
      log.info('Skipping Radar projection deleted after the initial source load', { radarId, sourceUpdatedAt });
      return { success: true, radarId, sourceUpdatedAt, dispatchKey, skipped: 'source-missing' };
    }

    const { projectedUpdatedAt } = projection;

    await step.run('send-completion', async () => {
      await inngest.send({
        name: 'app/radar.sync.completed',
        data: {
          radarId,
          sourceUpdatedAt,
          projectedUpdatedAt,
          dispatchKey,
          syncedAt: Date.now(),
        },
      });
    });

    return { success: true, radarId, sourceUpdatedAt, dispatchKey, projectedUpdatedAt };
  }
);
