/**
 * @file discovery/discovery-dispatch.ts
 * @description Dispatch an evaluation build-mission for a selected source entity:
 * compose the brief from the graph, create a `kind:'build', artifactKind:'evaluation'`
 * mission carrying the dimension-agnostic motivation, and fire the run event.
 *
 * The motivation now carries `sourceEntityId` + `entityType` (persisted because
 * P1a-T1b extended the schema), so the publish branch can route a non-technology
 * evaluation to the right proposed-* channel. Server-only.
 */
import 'server-only';
import { createLogger } from '@/lib/logger';
import { inngest } from '@/lib/inngest/client';
import type { SupportedEntityType } from '@/lib/schemas/proposed-entity';

const log = createLogger('discovery/discovery-dispatch');

/** Dispatch an evaluation for `sourceEntityId` of `entityType` on behalf of `userId`. */
export async function dispatchEvaluation(
  sourceEntityId: string,
  entityType: SupportedEntityType,
  userId: string
): Promise<{ missionId: string }> {
  const { composeEvaluationBrief } = await import('@/lib/build-mission-eval-brief');
  const { createMission } = await import('@/lib/missions');

  const composed = await composeEvaluationBrief(sourceEntityId, { entityType });
  const mission = await createMission(userId, {
    prompt: composed.brief,
    kind: 'build',
    artifactKind: 'evaluation',
    motivation: composed.motivation,
  });

  // Only fired AFTER the mission is durably created — a createMission failure
  // rejects before this line, so the run event never fires for a missing mission.
  await inngest.send({ name: 'app/build-mission.run.requested', data: { missionId: mission.id, userId } });
  log.info('dispatched evaluation', { sourceEntityId, entityType, missionId: mission.id });
  return { missionId: mission.id };
}

/**
 * Back-compat alias consumed by the P1b sweep. One implementation, two names;
 * defaults entityType to 'technology' (the flagship dimension).
 */
export const dispatchBenchmarkEvaluation = (
  sourceEntityId: string,
  userId: string,
  entityType: SupportedEntityType = 'technology'
): Promise<{ missionId: string }> => dispatchEvaluation(sourceEntityId, entityType, userId);
