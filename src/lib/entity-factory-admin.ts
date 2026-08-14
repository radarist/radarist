/**
 * @file entity-factory-admin.ts
 * @description Admin-SDK twin of entity-factory.createEntity for SERVER-side callers.
 *
 * WHY: entity-factory.ts uses the Firebase CLIENT SDK (db from @/lib/firebase +
 * 'firebase/firestore'). When invoked server-side (API routes, AI-chat tool
 * executors, MCP servers, Inngest workers) it can throw
 * `FIRESTORE INTERNAL ASSERTION FAILED a540` and poison the in-process client.
 *
 * This module reproduces createEntity's behavior EXACTLY via the Admin SDK:
 * - same slug (generateSlug), same id format (generateEntityId), same audit
 *   fields (createdAt/updatedAt), same ENTITY_CONFIGS, same scoped-uniqueness,
 *   same DuplicateEntityError, same upsert semantics
 * - reads-before-writes transaction (Admin tx.get(query) then tx.set/update)
 * - same post-commit Inngest graph-sync + Defense-Minister events (best-effort)
 *
 * The pure helpers (ENTITY_CONFIGS / generateSlug / generateEntityId /
 * DuplicateEntityError / EntityConfigError) come from the runtime-neutral
 * entity-factory-shared module, so the two paths cannot drift and this server
 * module never loads the Firebase client runtime.
 */
import 'server-only';

import { db } from '@/lib/firebase-admin';
import {
  ENTITY_CONFIGS,
  generateSlug,
  generateEntityId,
  DuplicateEntityError,
  EntityConfigError,
  type EntityType,
  type CreateEntityOptions,
  type CreateEntityResult,
} from '@/lib/entity-factory-shared';
import { isLibraryEntitySyncType, triggerEntitySync } from '@/lib/entity-sync';
import { requestEntityGraphSyncServer, triggerEntityGraphSyncBestEffortServer } from '@/lib/entity-sync-server';
import { createLogger } from '@/lib/logger';
import type { EntityType as SyncableEntityType } from '@/lib/types';

const log = createLogger('entity-factory-admin');

type Created<T> = T & { id: string; slug: string; createdAt: number; updatedAt: number };

/** Fire the same post-commit graph-sync + verification events createEntity fires. */
async function fireSyncEvents(
  entityType: EntityType,
  entityId: string,
  operation: 'create' | 'update',
  mode: CreateEntityOptions['graphSync']
): Promise<void> {
  const syncableType = entityType as SyncableEntityType;
  // triggerEntitySync owns the event-name/id-field mapping (technologyId vs
  // entityId), the GRAPH_SYNC_ENABLED kill switch, and the radarPlacement
  // skip (placements sync via their dedicated event in radar-placement-*).
  // It never throws — graph sync is best-effort by contract.
  if (mode === 'required') {
    if (!isLibraryEntitySyncType(syncableType)) {
      throw new EntityConfigError(`Required graph sync is unsupported for entity type: ${entityType}`);
    }
    // Records its own recovery anchor before throwing (entity-sync-server).
    await requestEntityGraphSyncServer(syncableType, entityId, operation);
  } else if (isLibraryEntitySyncType(syncableType)) {
    await triggerEntityGraphSyncBestEffortServer(syncableType, entityId, operation);
  } else {
    await triggerEntitySync(syncableType, entityId, operation);
  }
  // Logged only once the handoff has actually been attempted. This previously
  // announced "Triggered graph sync" before the dispatch ran, so the line was
  // emitted identically whether or not anything reached the queue.
  log.info('Graph sync handoff attempted', { entityType, entityId, operation });

  // GRAPH-048: entity-created Defense Minister verification now dispatches
  // exclusively from the entity sync workers after the graph write commits
  // (single origin, deterministic event id — see entity-verification-dispatch).
  // The sync events fired above are what carry the create to that boundary.
}

/**
 * Admin-SDK equivalent of entity-factory.createEntity. Same contract, same
 * errors, safe to call from server routes / tool executors / workers.
 */
export async function adminCreateEntity<T extends Record<string, unknown>>(
  entityType: EntityType,
  data: T & { name?: string; title?: string },
  options: CreateEntityOptions = {}
): Promise<CreateEntityResult<Created<T>>> {
  const config = ENTITY_CONFIGS[entityType];
  if (!config) {
    throw new EntityConfigError(`Unknown entity type: ${entityType}`);
  }

  const nameOrTitle = data[config.nameField] as string | undefined;
  if (!nameOrTitle) {
    throw new EntityConfigError(`Entity must have a ${config.nameField} field for slug generation`);
  }

  const slug = generateSlug(nameOrTitle);
  if (!slug) {
    throw new EntityConfigError(`Could not generate slug from ${config.nameField}: "${nameOrTitle}"`);
  }

  // Dangerous escape hatch — mirrors createEntity's skipUniquenessCheck branch.
  if (options.skipUniquenessCheck) {
    log.warn('Skipping uniqueness check for - USE WITH CAUTION', { entityType });
    const id = generateEntityId(config.idPrefix);
    const now = Date.now();
    const entity = { ...data, id, slug, createdAt: now, updatedAt: now } as Created<T>;
    await db.collection(config.collection).doc(id).set(entity);
    await fireSyncEvents(entityType, id, 'create', options.graphSync);
    return { entity, created: true };
  }

  const result = await db.runTransaction(async (transaction) => {
    let uniqueQuery = db.collection(config.collection).where(config.uniqueField, '==', slug).limit(1);
    if (config.scopeField && options.scope) {
      uniqueQuery = db
        .collection(config.collection)
        .where(config.uniqueField, '==', slug)
        .where(config.scopeField, '==', options.scope)
        .limit(1);
    }

    const existingSnapshot = await transaction.get(uniqueQuery);

    if (!existingSnapshot.empty) {
      const existingDoc = existingSnapshot.docs[0];
      const existingId = existingDoc.id;
      const existingData = existingDoc.data();

      if (options.upsert) {
        const now = Date.now();
        const updates = { ...data, slug, updatedAt: now };
        const { id: _id, createdAt: _createdAt, ...cleanUpdates } = updates as Record<string, unknown>;
        transaction.update(db.collection(config.collection).doc(existingId), cleanUpdates);
        log.info('Upserted entity', { entityType, existingId, slug });
        return {
          entity: { ...existingData, ...cleanUpdates, id: existingId } as Created<T>,
          created: false,
          existingId,
        };
      }

      throw new DuplicateEntityError(entityType, config.uniqueField, slug, existingId);
    }

    const id = generateEntityId(config.idPrefix);
    const now = Date.now();
    const entity = { ...data, id, slug, createdAt: now, updatedAt: now } as Created<T>;
    transaction.set(db.collection(config.collection).doc(id), entity);
    log.info('Created entity', { entityType, id, slug });
    return { entity, created: true };
  });

  await fireSyncEvents(entityType, result.entity.id, result.created ? 'create' : 'update', options.graphSync);
  return result;
}

/** Admin-SDK equivalent of getOrCreateEntity (upsert). */
export async function adminGetOrCreateEntity<T extends Record<string, unknown>>(
  entityType: EntityType,
  data: T & { name?: string; title?: string },
  scope?: string
): Promise<CreateEntityResult<Created<T>>> {
  return adminCreateEntity<T>(entityType, data, { upsert: true, scope });
}

/**
 * Fetch the first entity whose `field` equals `value`, or null. For callers that
 * own a STRONGER identity than the slug — e.g. a build mission's 1:1
 * mission→prototype mapping keyed on `missionId` — so a re-publish updates the
 * SAME doc instead of colliding on slug with an unrelated same-named entity.
 * Admin queries are strongly consistent, mirroring adminGetDocumentBySourceRunId.
 */
export async function adminGetEntityByField<T extends Record<string, unknown>>(
  entityType: EntityType,
  field: string,
  value: string
): Promise<(T & { id: string }) | null> {
  const config = ENTITY_CONFIGS[entityType];
  if (!config) {
    throw new EntityConfigError(`Unknown entity type: ${entityType}`);
  }
  const snapshot = await db.collection(config.collection).where(field, '==', value).limit(1).get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { ...(doc.data() as T), id: doc.id };
}

/**
 * Update an existing entity by id (audit `updatedAt` refreshed, `slug` re-derived
 * from the name field so it never drifts), then fire the same graph-sync events a
 * create does. For callers that resolved the target via their own identity key
 * (see adminGetEntityByField) rather than the slug-uniqueness transaction. `id`
 * and `createdAt` in `data` are ignored — never rewrite immutable audit fields.
 */
export async function adminUpdateEntity<T extends Record<string, unknown>>(
  entityType: EntityType,
  id: string,
  data: T & { name?: string; title?: string }
): Promise<void> {
  const config = ENTITY_CONFIGS[entityType];
  if (!config) {
    throw new EntityConfigError(`Unknown entity type: ${entityType}`);
  }
  const { id: _id, createdAt: _createdAt, ...clean } = data as Record<string, unknown>;
  const updates: Record<string, unknown> = { ...clean, updatedAt: Date.now() };
  const nameOrTitle = data[config.nameField] as string | undefined;
  if (nameOrTitle) {
    const slug = generateSlug(nameOrTitle);
    if (slug) updates.slug = slug;
  }
  await db.collection(config.collection).doc(id).update(updates);
  log.info('Updated entity', { entityType, id });
  await fireSyncEvents(entityType, id, 'update', 'best-effort');
}
