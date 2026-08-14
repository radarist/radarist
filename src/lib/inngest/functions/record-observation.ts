/**
 * @file inngest/functions/record-observation.ts
 * @description Inngest handler that persists an entity observation to Neo4j.
 *
 * Triggered by: app/entity.observation.recorded
 *
 * The producer is already decoupled from mission completion. Write and link
 * failures therefore throw so Inngest can retry ambiguous or transient graph
 * failures without changing the completed mission outcome.
 *
 * @phase Smart Defense Minister — Task 2
 */

import { inngest } from '../client';
import { createLogger } from '@/lib/logger';

const log = createLogger('inngest:record-observation');

export const recordObservationJob = inngest.createFunction(
  {
    id: 'record-observation',
    retries: 1,
    onFailure: async ({ error }) => {
      log.error('record-observation failed permanently', error instanceof Error ? error : new Error(String(error)));
    },
  },
  { event: 'app/entity.observation.recorded' },
  async ({ event, step }) => {
    const { observationId, entityId, sourceUrl, verdict, agentType, missionId, observedAt } = event.data;
    if (observationId && !missionId) {
      throw new Error('Observation payload IDs require a mission identity');
    }
    let resolvedObservationId = observationId;
    if (missionId) {
      const { createMissionObservationId } = await import('@/lib/graph/observation-identity');
      const expectedId = createMissionObservationId({ missionId, entityId, sourceUrl });
      if (observationId && observationId !== expectedId) {
        throw new Error('Observation payload ID does not match its mission/entity/source identity');
      }
      // A custom event ID is mandatory on new payloads. Legacy queued events
      // did not carry observationId, so their Inngest-generated ID is ignored.
      if (observationId && event.id !== expectedId) {
        throw new Error('Observation event ID does not match its payload identity');
      }
      resolvedObservationId = expectedId;
    }

    const writeResult = await step.run('write-observation', async () => {
      const { recordObservation } = await import('@/lib/graph/observations');
      const observation = await recordObservation({
        id: resolvedObservationId,
        entityId,
        sourceUrl,
        verdict,
        agentType,
        missionId,
        observedAt,
      });
      log.info('Observation recorded', { id: observation.id, entityId, verdict, agentType });
      return { recorded: true as const, id: observation.id };
    });

    if (!missionId) {
      return writeResult;
    }

    // H13: land the observation in its mission's Episode via CONTAINS so the
    // episode memory ("what did this mission discover?") is traversable.
    // A failed link is retryable. The Observation write and CONTAINS MERGE are
    // idempotent, so retrying the handler cannot double-count the Episode.
    const linkResult = await step.run('link-observation-to-episode', async () => {
      const { getEpisodeIdByMissionId, addObservationToEpisode } = await import('@/lib/graph/episodes');
      const episodeId = await getEpisodeIdByMissionId(missionId);
      if (!episodeId) {
        log.warn('No episode found for mission — observation left unlinked', {
          missionId,
          observationId: writeResult.id,
        });
        return { episodeLinked: false as const, reason: 'no-episode-for-mission' };
      }
      await addObservationToEpisode(episodeId, writeResult.id);
      log.info('Observation linked to episode', { observationId: writeResult.id, episodeId, missionId });
      return { episodeLinked: true as const, episodeId };
    });

    return { ...writeResult, ...linkResult };
  }
);
