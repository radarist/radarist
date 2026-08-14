/**
 * @file concept-admin.ts
 * @description Admin-SDK twin of `@/lib/concept-service` for SERVER-side callers
 * (the `sync-concept-to-neo4j` Inngest worker).
 *
 * Why this exists: `src/lib/concept-service.ts` is a client-SDK service module
 * (it uses `firebase/firestore` + `@/lib/firebase`). It is fine in the browser
 * and in `"use client"` components, but its read/update paths return
 * `code: 'unavailable'` in the stateless Inngest worker — the same failure mode
 * observed in Inngest workers and that `signals-admin.ts` /
 * `relations-admin.ts` / `document-admin.ts` already solve via the narrow
 * admin-helper pattern.
 *
 * Scope: this module reproduces — EXACTLY, via the Admin SDK — the
 * concept-service functions called from server-side contexts that hit the
 * client-SDK `code: 'unavailable'` failure:
 *
 * Inngest worker (`src/lib/inngest/functions/sync-concept-to-neo4j.ts`):
 * - `adminGetConceptById`        ← getConceptById        (load-concept-data step)
 * - `adminMarkConceptSynced`     ← markConceptSynced      (update-sync-status step)
 * - `adminMarkConceptSyncFailed` ← markConceptSyncFailed  (onFailure handler)
 *
 * Admin API route (`src/app/api/admin/backfill-concepts/route.ts`):
 * - `adminGetConcepts`              ← getConcepts            (status + sync handlers)
 * - `adminBulkGetOrCreateConcepts`  ← bulkGetOrCreateConcepts (backfill handler)
 * - `adminIncrementEntityCount`     ← incrementEntityCount   (backfill handler)
 *
 * AI knowledge tools (`src/lib/ai/tools/knowledge-tools.ts`):
 * - `adminGetConcepts`              ← getConcepts            (searchConceptsByQuery)
 *
 * The Firestore<->domain field mapping (`firestoreToConcept`) is reproduced 1:1
 * here. The only mechanical difference from the client service is that timestamps
 * are written with the ADMIN `Timestamp` (from `firebase-admin/firestore`)
 * instead of the client one; both expose `.toMillis()`, so admin-written docs
 * read back identically from the client `firestoreToConcept` and vice versa.
 *
 * `createConcept` in the client service does NOT go through the entity factory —
 * it writes a deterministic `concept-{slug}` doc via `setDoc`. The admin twin
 * therefore replicates that transaction directly (admin `set`), it does NOT call
 * `adminCreateEntity` (which would generate a random id + slug and emit a unified
 * sync event the client path never emits). `bulkGetOrCreateConcepts` is replayed
 * faithfully: same normalize → get-by-slug → add-new-aliases-or-create loop, same
 * `graphSyncStatus: 'pending'` stamping on alias updates (so the concept sync
 * worker re-picks the doc, exactly as in the client path).
 *
 * No sync event is fired here. None of the mirrored client functions fire any
 * Inngest / graph-sync event, so the admin twins fire nothing either — the
 * worker owns the `app/concept.sync.*` triggers, and concept docs are picked up
 * by polling `graphSyncStatus: 'pending'`, not by a per-write event.
 */

import 'server-only';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import type { Concept, ConceptType, CreateConceptInput, UpdateConceptInput } from '@/lib/types';
import type { ConceptFilters } from '@/lib/concept-service';
import { normalizeConceptArray } from '@/lib/utils/concept-normalize';

const log = createLogger('concept-admin');

// ============================================================================
// CONSTANTS
// ============================================================================

const COLLECTION_NAME = 'concepts';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert an Admin Firestore document snapshot to the `Concept` type. Admin-SDK
 * mirror of `firestoreToConcept` from `concept-service.ts` — same field set, same
 * `.toMillis?.()` millis coercion for timestamp fields, returns null when the
 * document does not exist.
 */
function firestoreToConcept(docSnap: FirebaseFirestore.DocumentSnapshot): Concept | null {
  if (!docSnap.exists) return null;

  const data = docSnap.data()!;
  return {
    id: docSnap.id,
    canonicalName: data.canonicalName,
    slug: data.slug,
    type: data.type,
    aliases: data.aliases || [],
    description: data.description,
    parentId: data.parentId,
    entityCount: data.entityCount || 0,
    graphSyncStatus: data.graphSyncStatus,
    lastSyncedAt: data.lastSyncedAt?.toMillis?.() ?? data.lastSyncedAt,
    createdAt: data.createdAt?.toMillis?.() ?? data.createdAt,
    updatedAt: data.updatedAt?.toMillis?.() ?? data.updatedAt,
  };
}

/**
 * Convert a (partial) `Concept` to its Firestore write shape. Admin-SDK mirror of
 * `conceptToFirestore` from `concept-service.ts` — same defined-field projection,
 * same `lastSyncedAt` → ADMIN `Timestamp.fromMillis` coercion. Does NOT stamp
 * `createdAt` / `updatedAt`; callers add those (matching the client service, which
 * spreads this output then overrides the audit timestamps).
 */
function conceptToFirestore(concept: Partial<Concept>): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  if (concept.canonicalName !== undefined) data.canonicalName = concept.canonicalName;
  if (concept.slug !== undefined) data.slug = concept.slug;
  if (concept.type !== undefined) data.type = concept.type;
  if (concept.aliases !== undefined) data.aliases = concept.aliases;
  if (concept.description !== undefined) data.description = concept.description;
  if (concept.parentId !== undefined) data.parentId = concept.parentId;
  if (concept.entityCount !== undefined) data.entityCount = concept.entityCount;
  if (concept.graphSyncStatus !== undefined) data.graphSyncStatus = concept.graphSyncStatus;
  if (concept.lastSyncedAt !== undefined) {
    data.lastSyncedAt = Timestamp.fromMillis(concept.lastSyncedAt);
  }

  return data;
}

/**
 * Generate concept ID from slug. Admin-SDK mirror of `generateConceptId` from
 * `concept-service.ts` — concepts use a deterministic `concept-{slug}` doc id
 * (NOT a factory-generated random id), which is what makes get-by-slug a single
 * point read.
 */
function generateConceptId(slug: string): string {
  return `concept-${slug}`;
}

// ============================================================================
// READ OPERATIONS
// ============================================================================

/**
 * Get a concept by its ID, or null if not found. Admin-SDK mirror of
 * `getConceptById` from `concept-service.ts`.
 *
 * @param id - The concept ID (format: "concept-{slug}")
 * @returns The concept or null if not found
 */
export async function adminGetConceptById(id: string): Promise<Concept | null> {
  try {
    const docSnap = await db.collection(COLLECTION_NAME).doc(id).get();
    return firestoreToConcept(docSnap);
  } catch (error) {
    log.error('Error getting concept', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

/**
 * Get a concept by its slug, or null if not found. Admin-SDK mirror of
 * `getConceptBySlug` from `concept-service.ts` — resolves the deterministic
 * `concept-{slug}` id then point-reads via {@link adminGetConceptById}.
 *
 * @param slug - The concept slug
 * @returns The concept or null if not found
 */
export async function adminGetConceptBySlug(slug: string): Promise<Concept | null> {
  const id = generateConceptId(slug);
  return adminGetConceptById(id);
}

/**
 * Get all concepts with optional filters. Admin-SDK mirror of `getConcepts` from
 * `concept-service.ts` — same `where` constraints (`type`, `parentId`,
 * `graphSyncStatus`), same `orderBy('canonicalName', 'asc')`, same server-side
 * `limit`, same client-side `search` (canonicalName / slug / aliases substring)
 * and `offset` slicing applied after the fetch.
 *
 * @param filters - Optional filters to apply
 * @returns Array of concepts matching filters
 */
export async function adminGetConcepts(filters: ConceptFilters = {}): Promise<Concept[]> {
  try {
    let q: FirebaseFirestore.Query = db.collection(COLLECTION_NAME);

    // Apply filters
    if (filters.type) {
      q = q.where('type', '==', filters.type);
    }
    if (filters.parentId) {
      q = q.where('parentId', '==', filters.parentId);
    }
    if (filters.graphSyncStatus) {
      q = q.where('graphSyncStatus', '==', filters.graphSyncStatus);
    }

    // Order by canonical name
    q = q.orderBy('canonicalName', 'asc');

    // Apply limit
    if (filters.limit) {
      q = q.limit(filters.limit);
    }

    const snapshot = await q.get();

    let concepts = snapshot.docs.map(firestoreToConcept).filter((c): c is Concept => c !== null);

    // Client-side search (Firestore doesn't support full-text search)
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      concepts = concepts.filter((concept) => {
        return (
          concept.canonicalName.toLowerCase().includes(searchLower) ||
          concept.slug.includes(searchLower) ||
          concept.aliases.some((alias) => alias.toLowerCase().includes(searchLower))
        );
      });
    }

    // Apply offset (client-side, not ideal for large datasets)
    if (filters.offset) {
      concepts = concepts.slice(filters.offset);
    }

    return concepts;
  } catch (error) {
    log.error('Error getting concepts', error instanceof Error ? error : new Error(String(error)), { filters });
    throw error;
  }
}

// ============================================================================
// CREATE OPERATIONS
// ============================================================================

/**
 * Create a new concept. Admin-SDK mirror of `createConcept` from
 * `concept-service.ts`.
 *
 * Replicates the client transaction directly (admin `set` on the deterministic
 * `concept-{slug}` doc) rather than delegating to `adminCreateEntity`: the client
 * `createConcept` does NOT use the entity factory — it writes a fixed id, fixed
 * `graphSyncStatus: 'pending'`, `entityCount: 0`, and audit timestamps via
 * `setDoc`, and fires no sync event. The returned `Concept` uses millis audit
 * fields (the doc stores them as ADMIN `Timestamp`), identical to the client.
 *
 * @param input - The concept data
 * @returns The created concept
 */
async function adminCreateConcept(input: CreateConceptInput): Promise<Concept> {
  const now = Date.now();
  const id = generateConceptId(input.slug);

  const concept: Concept = {
    id,
    canonicalName: input.canonicalName,
    slug: input.slug,
    type: input.type,
    aliases: input.aliases || [],
    description: input.description,
    parentId: input.parentId,
    entityCount: 0,
    graphSyncStatus: 'pending',
    createdAt: now,
    updatedAt: now,
  };

  await db
    .collection(COLLECTION_NAME)
    .doc(id)
    .set({
      ...conceptToFirestore(concept),
      createdAt: Timestamp.fromMillis(now),
      updatedAt: Timestamp.fromMillis(now),
    });

  return concept;
}

/**
 * Bulk create or update concepts from an array of tags. Admin-SDK mirror of
 * `bulkGetOrCreateConcepts` from `concept-service.ts`.
 *
 * Same loop as the client: normalize+dedupe inputs via `normalizeConceptArray`,
 * then per normalized concept either (a) append any not-yet-known original inputs
 * as aliases (each via {@link adminAddConceptAlias}, which marks the concept
 * `pending` for re-sync) or (b) create it via {@link adminCreateConcept}. Returns
 * the resulting concepts in normalized order. Fires no sync event (alias updates
 * stamp `graphSyncStatus: 'pending'`; the worker re-picks by polling).
 *
 * @param inputs - Array of raw tag inputs
 * @param type - The concept type (default: 'tag')
 * @returns Array of concepts (existing or newly created)
 */
export async function adminBulkGetOrCreateConcepts(inputs: string[], type: ConceptType = 'tag'): Promise<Concept[]> {
  try {
    const normalized = normalizeConceptArray(inputs);
    const concepts: Concept[] = [];

    for (const { slug, canonicalName, originalInputs } of normalized) {
      let concept = await adminGetConceptBySlug(slug);

      if (concept) {
        // Add any new aliases
        const newAliases = originalInputs.filter((a) => !concept!.aliases.includes(a));
        if (newAliases.length > 0) {
          for (const alias of newAliases) {
            concept = await adminAddConceptAlias(concept.id, alias);
          }
        }
      } else {
        // Create new concept
        concept = await adminCreateConcept({
          canonicalName,
          slug,
          type,
          aliases: originalInputs,
        });
      }

      concepts.push(concept);
    }

    return concepts;
  } catch (error) {
    log.error('Error bulk getting/creating concepts', error instanceof Error ? error : new Error(String(error)), {
      inputCount: inputs.length,
      type,
    });
    throw error;
  }
}

// ============================================================================
// UPDATE OPERATIONS
// ============================================================================

/**
 * Update a concept. Admin-SDK mirror of `updateConcept` from `concept-service.ts`
 * — applies the defined-field projection, bumps `updatedAt`, and re-marks
 * `graphSyncStatus: 'pending'` (so the change is re-synced to Neo4j), then
 * re-reads and throws if the doc vanished. Internal: only used by the alias path
 * of {@link adminBulkGetOrCreateConcepts}.
 *
 * @param id - The concept ID
 * @param updates - The updates to apply
 * @returns The updated concept
 */
async function adminUpdateConcept(id: string, updates: UpdateConceptInput): Promise<Concept> {
  const now = Date.now();

  await db
    .collection(COLLECTION_NAME)
    .doc(id)
    .update({
      ...conceptToFirestore(updates),
      updatedAt: Timestamp.fromMillis(now),
      graphSyncStatus: 'pending', // Mark for re-sync
    });

  const updated = await adminGetConceptById(id);
  if (!updated) {
    throw new Error(`Concept ${id} not found after update`);
  }

  return updated;
}

/**
 * Add an alias to a concept. Admin-SDK mirror of `addConceptAlias` from
 * `concept-service.ts` — no-op (returns the concept unchanged) when the trimmed
 * alias already exists, otherwise appends and persists via
 * {@link adminUpdateConcept}. Internal: only used by
 * {@link adminBulkGetOrCreateConcepts}.
 *
 * @param id - The concept ID
 * @param alias - The alias to add
 * @returns The updated concept
 */
async function adminAddConceptAlias(id: string, alias: string): Promise<Concept> {
  const concept = await adminGetConceptById(id);
  if (!concept) {
    throw new Error(`Concept ${id} not found`);
  }

  const trimmedAlias = alias.trim();
  if (concept.aliases.includes(trimmedAlias)) {
    return concept; // Already exists
  }

  const updatedAliases = [...concept.aliases, trimmedAlias];
  return adminUpdateConcept(id, { aliases: updatedAliases });
}

/**
 * Increment the entity count for a concept. Admin-SDK mirror of
 * `incrementEntityCount` from `concept-service.ts` — atomic `entityCount`
 * increment via admin `FieldValue.increment` and an `updatedAt` bump. Does NOT
 * touch `graphSyncStatus` (matching the client: a pure count change is not a
 * graph-relevant edit).
 *
 * @param id - The concept ID
 * @param delta - The amount to increment (default: 1, negative for decrement)
 */
export async function adminIncrementEntityCount(id: string, delta: number = 1): Promise<void> {
  try {
    await db
      .collection(COLLECTION_NAME)
      .doc(id)
      .update({
        entityCount: FieldValue.increment(delta),
        updatedAt: Timestamp.fromMillis(Date.now()),
      });
  } catch (error) {
    log.error('Error incrementing concept entity count', error instanceof Error ? error : new Error(String(error)), {
      id,
      delta,
    });
    throw error;
  }
}

/**
 * Mark a concept as synced to Neo4j. Admin-SDK mirror of `markConceptSynced`:
 * sets `graphSyncStatus: 'synced'`, stamps `lastSyncedAt` + `updatedAt` to the
 * same millis via the ADMIN `Timestamp`.
 *
 * @param id - The concept ID
 */
export async function adminMarkConceptSynced(id: string): Promise<void> {
  try {
    const now = Date.now();
    await db
      .collection(COLLECTION_NAME)
      .doc(id)
      .update({
        graphSyncStatus: 'synced',
        lastSyncedAt: Timestamp.fromMillis(now),
        updatedAt: Timestamp.fromMillis(now),
      });
  } catch (error) {
    log.error('Error marking concept synced', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

/**
 * Mark a concept's sync as failed. Admin-SDK mirror of `markConceptSyncFailed`:
 * sets `graphSyncStatus: 'failed'` and bumps `updatedAt`.
 *
 * @param id - The concept ID
 */
export async function adminMarkConceptSyncFailed(id: string): Promise<void> {
  try {
    await db
      .collection(COLLECTION_NAME)
      .doc(id)
      .update({
        graphSyncStatus: 'failed',
        updatedAt: Timestamp.fromMillis(Date.now()),
      });
  } catch (error) {
    log.error('Error marking concept sync failed', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}
