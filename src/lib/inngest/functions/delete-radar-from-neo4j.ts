/**
 * Remove the graph projection owned by a deleted Firestore radar.
 *
 * The event is keyed only by radarId so it can also repair placement nodes
 * left behind by an earlier failed per-placement dispatch. Every operation is
 * idempotent; an Inngest retry resumes safely after partial progress.
 */

import { checkHealth, deleteEntityFromGraph, runReadTransaction, runWriteTransaction } from '@/lib/graph';
import { createLogger } from '@/lib/logger';
import { inngest } from '../client';
import { extractFailureEventData } from '../utils';

const log = createLogger('inngest/delete-radar-from-neo4j');

const FIND_RADAR_PLACEMENTS = `
  MATCH (placement:RadarPlacement)
  WHERE placement.id IS NOT NULL
    AND (
      placement.radarId = $radarId
      OR EXISTS {
        MATCH (placement)-[:ON_RADAR]->(:Radar {id: $radarId})
      }
    )
  RETURN DISTINCT placement.id AS placementId
`;

const DELETE_RADAR_NODES = `
  OPTIONAL MATCH (radar:Radar {id: $radarId})
  WITH collect(radar) AS radars
  WITH radars, size(radars) AS radarNodesDeleted
  FOREACH (radar IN radars | DETACH DELETE radar)
  RETURN radarNodesDeleted
`;

export const deleteRadarFromNeo4jJob = inngest.createFunction(
  {
    id: 'delete-radar-from-neo4j',
    name: 'Delete Radar from Neo4j',
    retries: 3,
    onFailure: async ({ error, event }) => {
      const data = extractFailureEventData<{ radarId?: string }>(event.data);
      const radarId = data.radarId || 'unknown';
      log.error('Radar graph deletion final failure', new Error(error.message), { radarId });

      await inngest.send({
        name: 'app/radar.graph-delete.failed',
        data: { radarId, error: error.message, failedAt: Date.now() },
      });
    },
  },
  { event: 'app/radar.graph-delete.requested' },
  async ({ event, step }) => {
    const { radarId } = event.data;

    await step.run('check-neo4j-health', async () => {
      const health = await checkHealth();
      if (!health.healthy) {
        throw new Error(`Neo4j not healthy: ${health.error}`);
      }
      return health;
    });

    // Always sweep Neo4j by radarId. `cascade=false` is accepted by the source
    // only after Firestore reports zero placements, so any nodes found here are
    // graph-only drift and must not survive the Radar node deletion.
    const placementIds = await step.run('find-radar-placements', async () => {
      const result = await runReadTransaction<{ placementId: string }>(FIND_RADAR_PLACEMENTS, { radarId });
      return result.records.map(({ placementId }) => placementId);
    });

    const placementsDeleted = await step.run('delete-radar-placement-topology', async () => {
      let deleted = 0;
      for (const placementId of placementIds) {
        const result = await deleteEntityFromGraph(placementId, 'radarPlacement');
        deleted += result.endpointsDeleted;
      }
      return deleted;
    });

    const radarNodesDeleted = await step.run('delete-radar-nodes', async () => {
      const result = await runWriteTransaction<{ radarNodesDeleted: number }>(DELETE_RADAR_NODES, { radarId });
      return result.records[0]?.radarNodesDeleted ?? 0;
    });

    await step.run('send-completion', async () => {
      await inngest.send({
        name: 'app/radar.graph-delete.completed',
        data: {
          radarId,
          placementsDeleted,
          radarNodesDeleted,
          completedAt: Date.now(),
        },
      });
    });

    return { success: true, radarId, placementsDeleted, radarNodesDeleted };
  }
);
