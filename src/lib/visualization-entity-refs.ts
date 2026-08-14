/**
 * @file lib/visualization-entity-refs.ts
 * @description Bounded resolution of a visualization's entity references (AI-025).
 *
 * A visualization persists only {id, name, type} per referenced entity. This
 * module turns those stored references into display references:
 *
 *   live typed Firestore name  →  stored snapshot name  →  neutral unresolved
 *
 * Lookups are exact doc reads in each reference's own typed collection —
 * never a scan or a fan-out across every collection. 'unknown'-typed
 * references are display-only and are never fetched. Server-only (admin SDK):
 * import from API routes and tools, not from client components.
 */

import { db } from '@/lib/firebase-admin';
import { ENTITY_COLLECTIONS } from '@/lib/entity-collections';
import { createLogger } from '@/lib/logger';
import {
  MAX_VISUALIZATION_ENTITY_NAME_LENGTH,
  normalizeVisualizationDataSnapshot,
  type ResolvedVisualizationEntityRef,
  type VisualizationEntityType,
} from '@/lib/schemas/visualization';

const log = createLogger('visualization-entity-refs');

const FIRESTORE_GET_ALL_BATCH_SIZE = 100;

/**
 * Display-name field per canonical entity type. Kept next to the resolver so
 * capture (tool) and read (API) share one definition of "the entity's name".
 */
export const VISUALIZATION_ENTITY_NAME_FIELDS: Record<VisualizationEntityType, 'name' | 'title'> = {
  technology: 'name',
  company: 'name',
  useCase: 'title',
  strategy: 'name',
  prototype: 'name',
  signal: 'title',
  document: 'title',
  orgUnit: 'name',
  initiative: 'name',
  painPoint: 'title',
};

export interface TypedVisualizationEntityRef {
  id: string;
  type: VisualizationEntityType;
}

const refKey = (ref: TypedVisualizationEntityRef): string => `${ref.type}:${ref.id}`;

/**
 * Fetch current display names for exact typed references. One bounded batch of
 * direct doc reads per call — a reference is looked up ONLY in its own type's
 * collection. Fail-open: on a Firestore outage this returns what it has (or
 * nothing) so callers fall back to stored snapshot names.
 */
export async function fetchLiveVisualizationEntityNames(
  refs: ReadonlyArray<TypedVisualizationEntityRef>
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (refs.length === 0) return names;

  const unique = new Map<string, TypedVisualizationEntityRef>();
  for (const ref of refs) {
    if (!unique.has(refKey(ref))) unique.set(refKey(ref), ref);
  }
  const candidates = [...unique.values()];

  try {
    for (let offset = 0; offset < candidates.length; offset += FIRESTORE_GET_ALL_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + FIRESTORE_GET_ALL_BATCH_SIZE);
      const snapshots = await db.getAll(...batch.map((ref) => db.collection(ENTITY_COLLECTIONS[ref.type]).doc(ref.id)));
      snapshots.forEach((snapshot, index) => {
        if (!snapshot.exists) return;
        const ref = batch[index];
        const rawName = snapshot.data()?.[VISUALIZATION_ENTITY_NAME_FIELDS[ref.type]];
        const name = typeof rawName === 'string' ? rawName.trim().slice(0, MAX_VISUALIZATION_ENTITY_NAME_LENGTH) : '';
        if (name.length > 0) names.set(refKey(ref), name);
      });
    }
  } catch (error) {
    log.warn('live entity-name lookup failed — falling back to stored snapshot names', {
      refCount: candidates.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return names;
}

/**
 * Resolve a stored (possibly legacy/malformed) dataSnapshot into display
 * references. Normalizes in memory first, then overlays live typed names.
 */
export async function resolveVisualizationEntityReferences(
  rawDataSnapshot: unknown
): Promise<ResolvedVisualizationEntityRef[]> {
  const { entities } = normalizeVisualizationDataSnapshot(rawDataSnapshot);
  if (entities.length === 0) return [];

  const typedRefs = entities.filter(
    (entity): entity is { id: string; name: string; type: VisualizationEntityType } => entity.type !== 'unknown'
  );
  const liveNames = await fetchLiveVisualizationEntityNames(typedRefs);

  return entities.map((entity) => {
    const liveName = entity.type === 'unknown' ? undefined : liveNames.get(`${entity.type}:${entity.id}`);
    if (liveName) {
      return { id: entity.id, type: entity.type, name: liveName, resolution: 'live' };
    }
    if (entity.name.length > 0) {
      return { id: entity.id, type: entity.type, name: entity.name, resolution: 'snapshot' };
    }
    return { id: entity.id, type: entity.type, name: null, resolution: 'unresolved' };
  });
}
