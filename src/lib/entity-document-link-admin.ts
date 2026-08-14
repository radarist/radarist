/**
 * @file entity-document-link-admin.ts
 * @description Admin-SDK twin of the entity-document-link service for SERVER-side
 * callers — specifically the Inngest worker
 * `sync-entity-document-link-to-neo4j.ts`.
 *
 * Why this exists: `src/lib/entity-document-link-service.ts` is a client-SDK
 * service module (it uses `firebase/firestore` + `@/lib/firebase`). It is fine in
 * the browser and in `"use client"` components, but its read/update paths return
 * `code: 'unavailable'` in the stateless Inngest worker — the same failure mode
 * observed in Inngest workers and that `signals-admin.ts` /
 * `document-admin.ts` / `relations-admin.ts` already solve via the narrow
 * admin-helper pattern.
 *
 * This module reproduces the Firestore semantics EXACTLY via the Admin SDK for
 * the functions the Inngest sync worker AND the `/api/entity-document-links`
 * route handlers use:
 *
 * Read twins:
 * - `adminGetEntityDocumentLinks`      ← getEntityDocumentLinks
 * - `adminGetEntityDocumentLinkById`   ← getEntityDocumentLinkById
 * - `adminGetLinksForEntity`           ← getLinksForEntity
 * - `adminGetLinksForDocument`         ← getLinksForDocument
 * - `adminGetLinksWithDocuments`       ← getLinksWithDocuments
 * - `adminFindExistingLink`            ← findExistingLink
 * - `adminGetLinksPendingSync`         ← getLinksPendingSync
 * - `adminGetPendingAISuggestions`     ← getPendingAISuggestions
 *
 * Write twins:
 * - `adminCreateEntityDocumentLink`    ← createEntityDocumentLink
 * - `adminUpdateEntityDocumentLink`    ← updateEntityDocumentLink
 * - `adminDeleteEntityDocumentLink`    ← deleteEntityDocumentLink
 * - `adminApproveAISuggestion`         ← approveAISuggestion
 * - `adminRejectAISuggestion`          ← rejectAISuggestion
 *
 * Graph-sync twins (used by the Inngest worker):
 * - `adminMarkLinkSynced`              ← markLinkSynced
 * - `adminMarkLinkSyncFailed`          ← markLinkSyncFailed
 *
 * The Firestore<->domain field mappings are reproduced 1:1 across this module
 * and the server-only deletion leaf. The only mechanical difference from the
 * client service is that timestamps use the Admin `Timestamp`; both expose
 * `.toMillis()`, so Admin- and client-written docs remain interoperable.
 *
 * Behaviour parity notes:
 * - All twins mirror the client's try/catch + structured log + rethrow on error,
 *   returning null/[] for missing docs exactly as the client does.
 * - `adminMarkLinkSynced` / `adminMarkLinkSyncFailed` mirror the client's bare
 *   `updateDoc` (no try/catch) — errors propagate to the caller unchanged. The
 *   Inngest worker relies on this so a failed `markLinkSyncFailed` write surfaces.
 * - GRAPH-069: create and update no longer own a private best-effort trigger.
 *   Both call `deliverEntityDocumentLinkGraphHandoffServer` — the same primitive
 *   the browser reaches through `/api/graph/entity-document-link-sync` — and
 *   both return the handoff outcome alongside the row, so a server caller can
 *   no longer report a committed link as a completed projection. Destructive
 *   operations are re-exported from `entity-document-link-delete-admin`, which
 *   requires an acknowledged graph handoff BEFORE atomically deleting Firestore
 *   links and decrementing document counters.
 *
 * Linked-count behavior:
 * - Create atomically inserts the link and increments its document counter in
 *   one transaction, guarded by an injective endpoint-triple document ID.
 * - Delete uses the cycle-free deletion leaf to decrement in the same Firestore
 *   transaction that removes the link.
 */

import 'server-only';

import { Timestamp } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import { adminGetDocumentById } from '@/lib/document-admin';
import {
  adminDeleteEntityDocumentLink,
  adminDeleteLinksForDocument,
  adminDeleteLinksForEntity,
  adminFirestoreToEntityDocumentLink as firestoreToEntityDocumentLink,
} from '@/lib/entity-document-link-delete-admin';
import { deliverEntityDocumentLinkGraphHandoffServer } from '@/lib/entity-document-link-sync-server';
import type {
  EntityDocumentLinkCommitResult as HandoffCommitResult,
  EntityDocumentLinkHandoffOperation,
} from '@/lib/entity-document-link-handoff';
import type {
  EntityDocumentLink,
  EntityDocumentLinkWithDocument,
  CreateEntityDocumentLinkInput,
  UpdateEntityDocumentLinkInput,
  DocumentRelationshipType,
  DocumentRelevance,
  GraphSyncStatus,
  TransformationEntityType,
} from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('entity-document-link-admin');

export { adminDeleteEntityDocumentLink, adminDeleteLinksForDocument, adminDeleteLinksForEntity };

/** What a committed admin create/update returns: the row plus its graph state. */
export type EntityDocumentLinkCommitResult = HandoffCommitResult<EntityDocumentLink>;

/**
 * GRAPH-069 — the ONE post-commit graph handoff shared by admin create and
 * admin update.
 *
 * Replaces a private `triggerEntityDocumentLinkSyncSafely` that returned a
 * boolean nobody propagated: a false meant the link existed in Firestore with
 * `graphSyncStatus: 'pending'`, no durable anchor, and a caller that had
 * already answered "created". The shared primitive dispatches under a stable
 * replay identity, records the durable anchor when delivery fails, and returns
 * the outcome so every server caller reports the same reality the browser does.
 *
 * H6 remains in force through that primitive: the event is the DEDICATED
 * `app/entity-document-link.sync.requested`, never the unified entity event
 * (whose handler explicitly skips entityType 'document', which silently dropped
 * every link sync).
 */
async function handOffCommittedLink(
  link: EntityDocumentLink,
  operation: EntityDocumentLinkHandoffOperation
): Promise<EntityDocumentLinkCommitResult> {
  const graphHandoff = await deliverEntityDocumentLinkGraphHandoffServer(link, operation);
  if (graphHandoff.status === 'acknowledged') {
    log.info('Entity-document link graph handoff acknowledged', { id: link.id, operation });
  } else {
    log.warn('Entity-document link is committed but its graph projection is not', {
      id: link.id,
      operation,
      handoff: graphHandoff.status,
      reason: graphHandoff.reason,
    });
  }
  return { link, graphHandoff };
}

// ============================================================================
// CONSTANTS
// ============================================================================

const COLLECTION_NAME = 'entityDocumentLinks';
const LINK_ID_PREFIX = 'edl1_';
const FIRESTORE_DOCUMENT_ID_MAX_BYTES = 1500;

// ============================================================================
// FILTER TYPES
// ============================================================================

/**
 * Filter options for querying entity-document links. Admin-SDK mirror of
 * `EntityDocumentLinkFilters` from `entity-document-link-service.ts` so
 * `adminGetEntityDocumentLinks` is a drop-in.
 */
export interface EntityDocumentLinkFilters {
  /** Filter by entity type */
  entityType?: TransformationEntityType;
  /** Filter by entity ID */
  entityId?: string;
  /** Filter by document ID */
  documentId?: string;
  /** Filter by relationship type */
  relationshipType?: DocumentRelationshipType;
  /** Filter by relevance level */
  relevance?: DocumentRelevance;
  /** Filter by workspace */
  workspaceId?: string;
  /** Filter by AI-suggested links */
  aiSuggested?: boolean;
  /** Filter by sync status */
  graphSyncStatus?: GraphSyncStatus;
  /** Maximum results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert a (partial) `EntityDocumentLink` to Firestore write format. Admin-SDK
 * mirror of `entityDocumentLinkToFirestore` from
 * `entity-document-link-service.ts`: copies only defined fields (so update is
 * non-destructive) and converts the millis `lastSyncedAt` field to the ADMIN
 * `Timestamp`. Behaviour is identical to the client mapper apart from the
 * Timestamp implementation (both expose `.toMillis()`).
 */
function entityDocumentLinkToFirestore(link: Partial<EntityDocumentLink>): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  if (link.workspaceId !== undefined) data.workspaceId = link.workspaceId;
  if (link.entityType !== undefined) data.entityType = link.entityType;
  if (link.entityId !== undefined) data.entityId = link.entityId;
  if (link.documentId !== undefined) data.documentId = link.documentId;
  if (link.relationshipType !== undefined) data.relationshipType = link.relationshipType;
  if (link.tags !== undefined) data.tags = link.tags;
  if (link.relevance !== undefined) data.relevance = link.relevance;
  if (link.note !== undefined) data.note = link.note;
  if (link.aiSuggested !== undefined) data.aiSuggested = link.aiSuggested;
  if (link.aiConfidence !== undefined) data.aiConfidence = link.aiConfidence;
  if (link.createdBy !== undefined) data.createdBy = link.createdBy;
  if (link.graphSyncStatus !== undefined) data.graphSyncStatus = link.graphSyncStatus;
  if (link.lastSyncedAt !== undefined) {
    data.lastSyncedAt = Timestamp.fromMillis(link.lastSyncedAt);
  }

  return data;
}

/**
 * Builds an injective Firestore-safe identity for the same endpoint triple
 * used by `adminFindExistingLink`. JSON preserves tuple boundaries and escapes
 * lone UTF-16 surrogates; base64url is reversible and contains no `/`, so two
 * distinct triples cannot collapse onto one document ID. Oversized keys fail
 * closed instead of truncating or hashing into a possible collision.
 */
function buildEntityDocumentLinkId(
  input: Pick<CreateEntityDocumentLinkInput, 'entityType' | 'entityId' | 'documentId'>
): string {
  const tuple = JSON.stringify([input.entityType, input.entityId, input.documentId]);
  const id = `${LINK_ID_PREFIX}${Buffer.from(tuple, 'utf8').toString('base64url')}`;
  const encodedBytes = Buffer.byteLength(id, 'utf8');
  if (encodedBytes > FIRESTORE_DOCUMENT_ID_MAX_BYTES) {
    throw new Error(
      `Entity-document link identity encodes to ${encodedBytes} bytes; ` +
        `Firestore document IDs allow at most ${FIRESTORE_DOCUMENT_ID_MAX_BYTES}`
    );
  }
  return id;
}

function duplicateLinkError(
  input: Pick<CreateEntityDocumentLinkInput, 'entityType' | 'entityId' | 'documentId'>,
  id: string
): Error {
  return new Error(
    `Link already exists between ${input.entityType}:${input.entityId} and document:${input.documentId} (ID: ${id})`
  );
}

// ============================================================================
// READ OPERATIONS
// ============================================================================

/**
 * Get all entity-document links with optional filters. Admin-SDK mirror of
 * `getEntityDocumentLinks`: server-side `orderBy('createdAt','desc')` + at-most-one
 * equality filter (entityId > documentId > entityType > relationshipType >
 * workspaceId precedence), an over-fetch limit, then the SAME in-memory
 * client-side filtering and pagination the client service applies.
 *
 * @param filters - Optional filters to apply
 * @returns Array of links matching filters
 */
export async function adminGetEntityDocumentLinks(filters?: EntityDocumentLinkFilters): Promise<EntityDocumentLink[]> {
  try {
    let q: FirebaseFirestore.Query = db.collection(COLLECTION_NAME).orderBy('createdAt', 'desc');

    // Apply Firestore filters (limited to one inequality per query)
    // Priority: entityId > documentId > entityType > relationshipType
    if (filters?.entityId) {
      q = q.where('entityId', '==', filters.entityId);
    } else if (filters?.documentId) {
      q = q.where('documentId', '==', filters.documentId);
    } else if (filters?.entityType) {
      q = q.where('entityType', '==', filters.entityType);
    } else if (filters?.relationshipType) {
      q = q.where('relationshipType', '==', filters.relationshipType);
    } else if (filters?.workspaceId) {
      q = q.where('workspaceId', '==', filters.workspaceId);
    }

    // Apply limit (fetch extra for client-side filtering)
    const fetchLimit = (filters?.limit || 50) + (filters?.offset || 0) + 100;
    q = q.limit(fetchLimit);

    const snapshot = await q.get();
    let links = snapshot.docs.map(firestoreToEntityDocumentLink).filter((l): l is EntityDocumentLink => l !== null);

    // Apply client-side filters for complex queries
    if (filters?.entityId && filters?.entityType) {
      links = links.filter((l) => l.entityType === filters.entityType);
    }
    if (filters?.documentId && filters?.entityType) {
      links = links.filter((l) => l.entityType === filters.entityType);
    }
    if (filters?.relevance) {
      links = links.filter((l) => l.relevance === filters.relevance);
    }
    if (filters?.aiSuggested !== undefined) {
      links = links.filter((l) => l.aiSuggested === filters.aiSuggested);
    }
    if (filters?.graphSyncStatus) {
      links = links.filter((l) => l.graphSyncStatus === filters.graphSyncStatus);
    }
    if (
      filters?.workspaceId &&
      !filters?.entityId &&
      !filters?.documentId &&
      !filters?.entityType &&
      !filters?.relationshipType
    ) {
      // Already filtered by Firestore
    } else if (filters?.workspaceId) {
      links = links.filter((l) => l.workspaceId === filters.workspaceId);
    }

    // Apply pagination
    if (filters?.offset) {
      links = links.slice(filters.offset);
    }
    if (filters?.limit) {
      links = links.slice(0, filters.limit);
    }

    return links;
  } catch (error) {
    log.error('Error getting links', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Get an entity-document link by ID, or null if not found. Admin-SDK mirror of
 * `getEntityDocumentLinkById`: single `.doc(id).get()`, mapped through
 * `firestoreToEntityDocumentLink`. Mirrors the client's try/catch + structured
 * log + rethrow on error.
 *
 * @param id - Link ID
 * @returns Link or null if not found
 */
export async function adminGetEntityDocumentLinkById(id: string): Promise<EntityDocumentLink | null> {
  try {
    const docSnap = await db.collection(COLLECTION_NAME).doc(id).get();
    return firestoreToEntityDocumentLink(docSnap);
  } catch (error) {
    log.error('Error getting link', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

/**
 * Get all links for a specific entity. Admin-SDK mirror of `getLinksForEntity` —
 * thin wrapper over `adminGetEntityDocumentLinks({ entityType, entityId })`.
 *
 * @param entityType - Type of the entity
 * @param entityId - Entity ID
 * @returns Array of links for the entity
 */
export async function adminGetLinksForEntity(
  entityType: TransformationEntityType,
  entityId: string
): Promise<EntityDocumentLink[]> {
  return adminGetEntityDocumentLinks({ entityType, entityId });
}

/**
 * Get all links for a specific document. Admin-SDK mirror of `getLinksForDocument`
 * — thin wrapper over `adminGetEntityDocumentLinks({ documentId })`.
 *
 * @param documentId - Document ID
 * @returns Array of links for the document
 */
export async function adminGetLinksForDocument(documentId: string): Promise<EntityDocumentLink[]> {
  return adminGetEntityDocumentLinks({ documentId });
}

/**
 * Get links with enriched document information. Admin-SDK mirror of
 * `getLinksWithDocuments`: loads the entity's links, parallel-fetches each
 * linked document via `adminGetDocumentById`, and denormalizes the same
 * `{ title, type, status, originalUrl, domain, fileSize }` snapshot, dropping links whose
 * document is missing — identical to the client service.
 *
 * @param entityType - Type of the entity
 * @param entityId - Entity ID
 * @returns Array of links with document details
 */
export async function adminGetLinksWithDocuments(
  entityType: TransformationEntityType,
  entityId: string
): Promise<EntityDocumentLinkWithDocument[]> {
  try {
    const links = await adminGetLinksForEntity(entityType, entityId);

    // Parallel fetch of documents
    const documentPromises = links.map((link) => adminGetDocumentById(link.documentId));
    const documents = await Promise.all(documentPromises);

    const linksWithDocs: EntityDocumentLinkWithDocument[] = [];
    for (let i = 0; i < links.length; i++) {
      const document = documents[i];
      if (document) {
        linksWithDocs.push({
          ...links[i],
          document: {
            title: document.title,
            type: document.type,
            status: document.status,
            originalUrl: document.originalUrl,
            domain: document.domain,
            fileSize: document.fileSize,
          },
        });
      }
    }

    return linksWithDocs;
  } catch (error) {
    log.error('Error getting links with documents', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Check if a specific link already exists. Admin-SDK mirror of `findExistingLink`:
 * equality-queries `entityId` + `documentId`, then selects the matching
 * `entityType` client-side. The result is intentionally not limited before
 * that check: a legacy row for another entity type must not hide the matching
 * legacy link. Returns the link or null.
 *
 * @param entityType - Entity type
 * @param entityId - Entity ID
 * @param documentId - Document ID
 * @returns Existing link or null
 */
export async function adminFindExistingLink(
  entityType: TransformationEntityType,
  entityId: string,
  documentId: string
): Promise<EntityDocumentLink | null> {
  try {
    const snapshot = await db
      .collection(COLLECTION_NAME)
      .where('entityId', '==', entityId)
      .where('documentId', '==', documentId)
      .get();

    if (snapshot.empty) return null;

    for (const document of snapshot.docs) {
      const link = firestoreToEntityDocumentLink(document);
      if (link?.entityType === entityType) return link;
    }
    return null;
  } catch (error) {
    log.error('Error finding existing link', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Get links pending sync to Neo4j. Admin-SDK mirror of `getLinksPendingSync`:
 * equality-queries `graphSyncStatus == 'pending'` with a limit.
 *
 * @param limit - Maximum results
 * @returns Array of links pending sync
 */
export async function adminGetLinksPendingSync(limit = 100): Promise<EntityDocumentLink[]> {
  try {
    const snapshot = await db.collection(COLLECTION_NAME).where('graphSyncStatus', '==', 'pending').limit(limit).get();
    return snapshot.docs.map(firestoreToEntityDocumentLink).filter((l): l is EntityDocumentLink => l !== null);
  } catch (error) {
    log.error('Error getting links pending sync', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Get pending AI suggestions for review. Admin-SDK mirror of
 * `getPendingAISuggestions` — thin wrapper over
 * `adminGetEntityDocumentLinks({ aiSuggested: true, limit })`.
 *
 * @param limit - Maximum results
 * @returns Array of AI-suggested links
 */
export async function adminGetPendingAISuggestions(limit = 50): Promise<EntityDocumentLink[]> {
  return adminGetEntityDocumentLinks({ aiSuggested: true, limit });
}

// ============================================================================
// WRITE OPERATIONS
// ============================================================================

/**
 * Create a new entity-document link. Admin-SDK mirror of
 * `createEntityDocumentLink`: the preflight query preserves duplicate detection
 * for legacy random-ID rows, while a deterministic endpoint-triple document ID
 * serializes concurrent server creates. Link insertion and the document's
 * `linkedEntityCount` increment commit in one transaction, preventing duplicate
 * links, lost counter updates, and partial writes. The winning create returns
 * the record known to have committed without a fallible post-commit read, then
 * hands that record to the shared graph handoff. Duplicate callers retain the
 * recognizable route error.
 *
 * @param input - Link data
 * @returns The created link and its graph handoff outcome
 * @throws Error if link already exists
 */
export async function adminCreateEntityDocumentLink(
  input: CreateEntityDocumentLinkInput
): Promise<EntityDocumentLinkCommitResult> {
  try {
    // Check for existing link
    const existing = await adminFindExistingLink(input.entityType, input.entityId, input.documentId);
    if (existing) throw duplicateLinkError(input, existing.id);

    const now = Timestamp.now();
    const linkData = {
      ...entityDocumentLinkToFirestore(input),
      graphSyncStatus: 'pending' as GraphSyncStatus,
      createdAt: now,
      updatedAt: now,
    };

    const linkId = buildEntityDocumentLinkId(input);
    const linkRef = db.collection(COLLECTION_NAME).doc(linkId);
    const documentRef = db.collection('documents').doc(input.documentId);
    const createdHere = await db.runTransaction(async (transaction) => {
      // Firestore requires all reads before writes. Reading the document in the
      // same transaction also serializes distinct links contending on its count.
      const [linkSnapshot, documentSnapshot] = await transaction.getAll(linkRef, documentRef);

      if (linkSnapshot.exists) {
        const current = firestoreToEntityDocumentLink(linkSnapshot);
        if (
          !current ||
          current.entityType !== input.entityType ||
          current.entityId !== input.entityId ||
          current.documentId !== input.documentId
        ) {
          throw new Error(`Entity-document link identity collision at ${linkId}`);
        }
        return false;
      }

      if (!documentSnapshot.exists) {
        throw new Error(`Cannot link missing document: ${input.documentId}`);
      }
      const storedCount = documentSnapshot.data()?.linkedEntityCount;
      const currentCount = typeof storedCount === 'number' && Number.isFinite(storedCount) ? storedCount : 0;

      transaction.set(linkRef, linkData);
      transaction.update(documentRef, {
        linkedEntityCount: Math.max(0, currentCount + 1),
        updatedAt: now,
      });
      return true;
    });

    if (!createdHere) throw duplicateLinkError(input, linkId);

    const created: EntityDocumentLink = {
      ...input,
      id: linkId,
      graphSyncStatus: 'pending',
      createdAt: now.toMillis(),
      updatedAt: now.toMillis(),
    };

    log.info('Created link', {
      id: created.id,
      entityType: input.entityType,
      entityId: input.entityId,
      documentId: input.documentId,
    });

    return await handOffCommittedLink(created, 'create');
  } catch (error) {
    log.error('Error creating link', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Update an entity-document link. Admin-SDK mirror of `updateEntityDocumentLink`:
 * maps the partial via `entityDocumentLinkToFirestore`, forces
 * `graphSyncStatus: 'pending'` (re-sync on update), bumps `updatedAt`, writes via
 * `.update()`, then hands the re-read row to the SAME graph handoff primitive
 * create uses. Only relationship metadata is updated, not endpoints.
 *
 * The re-read is required, not incidental: the handoff asserts the endpoint
 * triple the server compares against authoritative Firestore, and the replay
 * identity is a fingerprint of the content that will actually be projected.
 *
 * @param id - Link ID
 * @param updates - Fields to update
 * @returns The updated link and its graph handoff outcome
 */
export async function adminUpdateEntityDocumentLink(
  id: string,
  updates: UpdateEntityDocumentLinkInput
): Promise<EntityDocumentLinkCommitResult> {
  try {
    const updateData = {
      ...entityDocumentLinkToFirestore(updates),
      graphSyncStatus: 'pending' as GraphSyncStatus, // Re-sync on update
      updatedAt: Timestamp.now(),
    };

    await db.collection(COLLECTION_NAME).doc(id).update(updateData);
    log.info('Updated link', { id });

    const updated = await adminGetEntityDocumentLinkById(id);
    if (!updated) {
      // The row was deleted between the update and the read-back. There is
      // nothing to project, so the handoff is refused rather than guessed at —
      // the delete path owns its own (pre-commit) graph removal.
      log.warn('Entity-document link disappeared before its graph handoff', { id, operation: 'update' });
      return {
        link: { id } as EntityDocumentLink,
        graphHandoff: { status: 'refused', reason: `Entity-document link ${id} no longer exists` },
      };
    }
    return await handOffCommittedLink(updated, 'update');
  } catch (error) {
    log.error('Error updating link', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

// ============================================================================
// AI SUGGESTION OPERATIONS
// ============================================================================

/**
 * Approve an AI suggestion (remove AI flag). Admin-SDK mirror of
 * `approveAISuggestion`: clears `aiSuggested`/`aiConfidence` via
 * `adminUpdateEntityDocumentLink` (which re-runs the graph handoff), then logs
 * and returns that handoff outcome so an approval cannot silently report a
 * projection it never queued.
 *
 * @param id - Link ID
 * @returns The approved link and its graph handoff outcome
 */
export async function adminApproveAISuggestion(id: string): Promise<EntityDocumentLinkCommitResult> {
  const result = await adminUpdateEntityDocumentLink(id, {
    aiSuggested: false,
    aiConfidence: undefined,
  });
  log.info('Approved AI suggestion', { id, handoff: result.graphHandoff.status });
  return result;
}

/**
 * Reject an AI suggestion (delete link). Admin-SDK mirror of
 * `rejectAISuggestion`: delegates to `adminDeleteEntityDocumentLink`, then logs.
 *
 * @param id - Link ID
 */
export async function adminRejectAISuggestion(id: string): Promise<void> {
  await adminDeleteEntityDocumentLink(id);
  log.info('Rejected AI suggestion', { id });
}

// ============================================================================
// GRAPH SYNC OPERATIONS
// ============================================================================

/**
 * Mark a link as synced to Neo4j. Admin-SDK mirror of `markLinkSynced`: bare
 * `.update()` setting `graphSyncStatus: 'synced'` and stamping `lastSyncedAt`
 * with the current time. No try/catch — errors propagate to the caller, exactly
 * as the client service does.
 *
 * @param id - Link ID
 */
export async function adminMarkLinkSynced(id: string): Promise<void> {
  await db
    .collection(COLLECTION_NAME)
    .doc(id)
    .update({
      graphSyncStatus: 'synced' as GraphSyncStatus,
      lastSyncedAt: Timestamp.now(),
    });
}

/**
 * Mark a link sync as failed. Admin-SDK mirror of `markLinkSyncFailed`: bare
 * `.update()` setting `graphSyncStatus: 'failed'`. No try/catch — errors
 * propagate to the caller, exactly as the client service does.
 *
 * @param id - Link ID
 */
export async function adminMarkLinkSyncFailed(id: string): Promise<void> {
  await db
    .collection(COLLECTION_NAME)
    .doc(id)
    .update({
      graphSyncStatus: 'failed' as GraphSyncStatus,
    });
}
