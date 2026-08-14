import 'server-only';

import { createHash } from 'node:crypto';
import { db } from '@/lib/firebase-admin';

export const MAX_DEPENDENT_INITIATIVE_REPLAYS = 100;

/**
 * Resolve the Initiative sources that depend on a graph target which has just
 * arrived. The +1 query makes the bound honest: an oversized fan-out fails
 * rather than silently leaving a partially projected graph.
 */
export async function loadDependentInitiativeIds(
  targetType: 'strategy' | 'painPoint',
  targetId: string
): Promise<string[]> {
  const referenceField = targetType === 'strategy' ? 'linkedStrategyIds' : 'linkedPainPointIds';
  const snapshot = await db
    .collection('initiatives')
    .where(referenceField, 'array-contains', targetId)
    .limit(MAX_DEPENDENT_INITIATIVE_REPLAYS + 1)
    .get();
  if (snapshot.size > MAX_DEPENDENT_INITIATIVE_REPLAYS) {
    throw new Error(
      `${targetType} ${targetId} has more than ${MAX_DEPENDENT_INITIATIVE_REPLAYS} dependent initiatives; refusing a partial replay`
    );
  }
  return [...new Set(snapshot.docs.map((document) => document.id))].sort();
}

export function buildInitiativeDependencyReplayEvent(
  parentEventId: string,
  targetType: 'strategy' | 'painPoint',
  targetId: string,
  initiativeId: string
) {
  const digest = createHash('sha256')
    .update(`${parentEventId}\u0000${targetType}\u0000${targetId}\u0000${initiativeId}`)
    .digest('hex');
  return {
    id: `initiative-dependency-replay:${digest}`,
    name: 'app/unified-entity.sync.requested' as const,
    data: {
      operation: 'update' as const,
      entityType: 'initiative' as const,
      entityId: initiativeId,
    },
  };
}
