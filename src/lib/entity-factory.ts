/**
 * @file entity-factory.ts
 * @description Centralized entity creation with uniqueness enforcement
 *
 * All entity creation MUST go through this factory to ensure:
 * 1. Slug-based identity (deterministic from name/title)
 * 2. Transactional uniqueness checks (race-condition safe)
 * 3. Consistent error handling
 * 4. Audit logging
 *
 * This module solves the duplicate entity problem where:
 * - ID = name + timestamp creates unique IDs but NOT unique entities
 * - Multiple creates of "AI Flavor Lab" would create multiple documents
 *
 * The solution uses Firestore transactions to:
 * - Generate a deterministic slug from name/title
 * - Check if entity with slug exists (within transaction)
 * - Only create if unique, otherwise throw or upsert
 *
 * @author Radarist Team
 * @created 2026-01-17
 */

import {
  runTransaction,
  collection,
  query,
  where,
  doc,
  getDocs,
  limit as firestoreLimit,
  Transaction,
} from 'firebase/firestore';
import { db } from './firebase';
import { isLibraryEntitySyncType, requestEntityGraphSync, triggerEntitySync } from './entity-sync';
import { createLogger } from '@/lib/logger';
import {
  DuplicateEntityError,
  EntityConfigError,
  ENTITY_CONFIGS,
  generateEntityId,
  generateSlug,
  type CreateEntityOptions,
  type CreateEntityResult,
  type EntityConfig,
  type EntityExistsResult,
  type EntityType,
} from './entity-factory-shared';
import type { EntityType as SyncableEntityType } from '@/lib/types';
export {
  DuplicateEntityError,
  EntityConfigError,
  ENTITY_CONFIGS,
  generateEntityId,
  generateSlug,
} from './entity-factory-shared';
export type {
  CreateEntityOptions,
  CreateEntityResult,
  EntityConfig,
  EntityExistsResult,
  EntityType,
} from './entity-factory-shared';

const log = createLogger('entity-factory');

async function dispatchEntityCreateSync(
  entityType: EntityType,
  entityId: string,
  operation: 'create' | 'update',
  mode: CreateEntityOptions['graphSync']
): Promise<void> {
  const syncableType = entityType as SyncableEntityType;
  if (mode === 'required') {
    if (!isLibraryEntitySyncType(syncableType)) {
      throw new EntityConfigError(`Required graph sync is unsupported for entity type: ${entityType}`);
    }
    await requestEntityGraphSync(syncableType, entityId, operation);
    return;
  }
  await triggerEntitySync(syncableType, entityId, operation);
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Create an entity with uniqueness enforcement.
 *
 * This function:
 * 1. Generates a slug from the entity's name/title
 * 2. Uses a Firestore transaction to check for existing entity
 * 3. Creates the entity only if no duplicate exists
 * 4. Optionally updates existing entity (upsert mode)
 *
 * @param entityType - Type of entity (e.g., 'prototype', 'company')
 * @param data - Entity data (must include name or title)
 * @param options - Creation options (upsert, scope, etc.)
 * @returns Created or updated entity with metadata
 * @throws DuplicateEntityError if entity exists and upsert is false
 * @throws EntityConfigError if entity type is not configured
 *
 * @example
 * // Create a new prototype
 * const result = await createEntity('prototype', {
 *   name: 'AI Flavor Lab',
 *   description: 'AI-powered flavor formulation',
 *   status: 'Ideation',
 * });
 *
 * // Upsert mode - update if exists
 * const result = await createEntity('company', data, { upsert: true });
 */
export async function createEntity<T extends Record<string, unknown>>(
  entityType: EntityType,
  data: T & { name?: string; title?: string },
  options: CreateEntityOptions = {}
): Promise<CreateEntityResult<T & { id: string; slug: string; createdAt: number; updatedAt: number }>> {
  const config = ENTITY_CONFIGS[entityType];
  if (!config) {
    throw new EntityConfigError(`Unknown entity type: ${entityType}`);
  }

  // Get name from the configured field
  const nameOrTitle = data[config.nameField] as string | undefined;
  if (!nameOrTitle) {
    throw new EntityConfigError(`Entity must have a ${config.nameField} field for slug generation`);
  }

  const slug = generateSlug(nameOrTitle);
  if (!slug) {
    throw new EntityConfigError(`Could not generate slug from ${config.nameField}: "${nameOrTitle}"`);
  }

  // Skip uniqueness check if explicitly requested (dangerous!)
  if (options.skipUniquenessCheck) {
    log.warn('Skipping uniqueness check for - USE WITH CAUTION', { entityType });
    const id = generateEntityId(config.idPrefix);
    const now = Date.now();
    const entity = {
      ...data,
      id,
      slug,
      createdAt: now,
      updatedAt: now,
    } as T & { id: string; slug: string; createdAt: number; updatedAt: number };

    const docRef = doc(db, config.collection, id);
    const { runTransaction: rt } = await import('firebase/firestore');
    await rt(db, async (transaction) => {
      transaction.set(docRef, entity);
    });


    // Fire graph sync event AFTER write commits. triggerEntitySync owns the
    // event-name/id-field mapping (technologyId vs entityId), the
    // GRAPH_SYNC_ENABLED kill switch, and the radarPlacement skip (placements
    // sync via their dedicated event in radar-placement-service). It never
    // throws — graph sync is best-effort by contract.
    await dispatchEntityCreateSync(entityType, id, 'create', options.graphSync);
    // Logged after the attempt: the previous line announced a triggered sync
    // before dispatch ran, so it read identically on a failed handoff.
    log.info('Graph sync handoff attempted', { entityType, entityId: id, operation: 'create' });

    // GRAPH-048: entity-created Defense Minister verification dispatches
    // server-side from the entity sync workers — the browser bundle can never
    // observe the non-NEXT_PUBLIC DEFENSE_MINISTER_ENABLED flag, so a client
    // dispatch here could never fire.

    return { entity, created: true };
  }

  // Use transaction to check + create atomically
  const result = await runTransaction(db, async (transaction: Transaction) => {
    // Build uniqueness query
    const collectionRef = collection(db, config.collection);
    let uniqueQuery = query(collectionRef, where(config.uniqueField, '==', slug), firestoreLimit(1));

    // Add scope if configured (e.g., radarId for placements)
    if (config.scopeField && options.scope) {
      uniqueQuery = query(
        collectionRef,
        where(config.uniqueField, '==', slug),
        where(config.scopeField, '==', options.scope),
        firestoreLimit(1)
      );
    }

    // Check for existing entity
    const existingSnapshot = await getDocs(uniqueQuery);

    if (!existingSnapshot.empty) {
      const existingDoc = existingSnapshot.docs[0];
      const existingId = existingDoc.id;
      const existingData = existingDoc.data();

      // Handle upsert mode
      if (options.upsert) {
        const now = Date.now();
        const updates = {
          ...data,
          slug,
          updatedAt: now,
        };

        // Remove id and createdAt from updates (shouldn't change)
        const { id: _id, createdAt: _createdAt, ...cleanUpdates } = updates as Record<string, unknown>;

        transaction.update(doc(db, config.collection, existingId), cleanUpdates);

        log.info('Upserted entity', { entityType, existingId, slug });

        return {
          entity: {
            ...existingData,
            ...cleanUpdates,
            id: existingId,
          } as T & { id: string; slug: string; createdAt: number; updatedAt: number },
          created: false,
          existingId,
        };
      }

      // Throw duplicate error
      throw new DuplicateEntityError(entityType, config.uniqueField, slug, existingId);
    }

    // Create new entity
    const id = generateEntityId(config.idPrefix);
    const now = Date.now();
    const entity = {
      ...data,
      id,
      slug,
      createdAt: now,
      updatedAt: now,
    } as T & { id: string; slug: string; createdAt: number; updatedAt: number };

    transaction.set(doc(db, config.collection, id), entity);

    log.info('Created entity', { entityType, id, slug });

    return {
      entity,
      created: true,
    };
  });

  // Fire graph sync event AFTER transaction commits. triggerEntitySync owns
  // the event-name/id-field mapping (technologyId vs entityId), the
  // GRAPH_SYNC_ENABLED kill switch, and the radarPlacement skip (placements
  // sync via their dedicated event in radar-placement-service). It never
  // throws — graph sync is best-effort by contract.
  await dispatchEntityCreateSync(entityType, result.entity.id, result.created ? 'create' : 'update', options.graphSync);
  // Logged after the attempt — see the note at the skipUniquenessCheck site.
  log.info('Graph sync handoff attempted', {
    entityType,
    entityId: result.entity.id,
    operation: result.created ? 'create' : 'update',
  });

  // GRAPH-048: entity-created Defense Minister verification dispatches
  // server-side from the entity sync workers (see entity-verification-dispatch).

  return result;
}

/**
 * Check if an entity with the given name/title already exists.
 *
 * Useful for:
 * - Validating forms before submission
 * - Checking before AI creates entities
 * - Providing helpful error messages
 *
 * @param entityType - Type of entity to check
 * @param nameOrTitle - The name or title to check
 * @param scope - Optional scope (e.g., radarId)
 * @returns Whether entity exists and its ID if so
 *
 * @example
 * const check = await entityExists('prototype', 'AI Flavor Lab');
 * if (check.exists) {
 *   console.log(`Already exists with ID: ${check.id}`);
 * }
 */
export async function entityExists(
  entityType: EntityType,
  nameOrTitle: string,
  scope?: string
): Promise<EntityExistsResult> {
  const config = ENTITY_CONFIGS[entityType];
  if (!config) {
    throw new EntityConfigError(`Unknown entity type: ${entityType}`);
  }

  const slug = generateSlug(nameOrTitle);
  if (!slug) {
    return { exists: false };
  }

  const collectionRef = collection(db, config.collection);
  let q = query(collectionRef, where(config.uniqueField, '==', slug), firestoreLimit(1));

  if (config.scopeField && scope) {
    q = query(
      collectionRef,
      where(config.uniqueField, '==', slug),
      where(config.scopeField, '==', scope),
      firestoreLimit(1)
    );
  }

  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    return { exists: false, slug };
  }

  return {
    exists: true,
    id: snapshot.docs[0].id,
    slug,
  };
}

/**
 * Get or create an entity (idempotent operation).
 *
 * Always returns an entity:
 * - If exists: returns existing entity (with updated fields if data differs)
 * - If not exists: creates and returns new entity
 *
 * This is the safest function for AI tools and automated processes
 * where you want to ensure an entity exists without errors.
 *
 * @param entityType - Type of entity
 * @param data - Entity data
 * @param scope - Optional scope
 * @returns The entity (existing or newly created)
 *
 * @example
 * // AI tool: ensure company exists
 * const result = await getOrCreateEntity('company', {
 *   name: 'OpenAI',
 *   description: 'AI research company',
 * });
 * // result.created tells you if it was new or existing
 */
export async function getOrCreateEntity<T extends Record<string, unknown>>(
  entityType: EntityType,
  data: T & { name?: string; title?: string },
  scope?: string
): Promise<CreateEntityResult<T & { id: string; slug: string; createdAt: number; updatedAt: number }>> {
  return createEntity<T>(entityType, data, { upsert: true, scope });
}

/**
 * Validate that a name/title would create a valid, unique slug.
 *
 * @param entityType - Type of entity
 * @param nameOrTitle - Name or title to validate
 * @param scope - Optional scope
 * @returns Validation result with slug and existence check
 */
export async function validateEntityName(
  entityType: EntityType,
  nameOrTitle: string,
  scope?: string
): Promise<{
  valid: boolean;
  slug: string;
  error?: string;
  existingId?: string;
}> {
  const slug = generateSlug(nameOrTitle);

  if (!slug) {
    return {
      valid: false,
      slug: '',
      error: 'Name must contain at least one alphanumeric character',
    };
  }

  if (slug.length < 2) {
    return {
      valid: false,
      slug,
      error: 'Name is too short (minimum 2 characters after normalization)',
    };
  }

  const exists = await entityExists(entityType, nameOrTitle, scope);

  if (exists.exists) {
    return {
      valid: false,
      slug,
      error: `A ${entityType} with this name already exists`,
      existingId: exists.id,
    };
  }

  return {
    valid: true,
    slug,
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get the configuration for an entity type.
 *
 * @param entityType - The entity type
 * @returns Entity configuration or undefined
 */
export function getEntityConfig(entityType: string): EntityConfig | undefined {
  return ENTITY_CONFIGS[entityType];
}

/**
 * Check if an entity type is configured.
 *
 * @param entityType - The entity type to check
 * @returns True if entity type is configured
 */
export function isEntityTypeConfigured(entityType: string): boolean {
  return entityType in ENTITY_CONFIGS;
}

/**
 * Get all configured entity types.
 *
 * @returns Array of entity type names
 */
export function getConfiguredEntityTypes(): EntityType[] {
  return Object.keys(ENTITY_CONFIGS) as EntityType[];
}
