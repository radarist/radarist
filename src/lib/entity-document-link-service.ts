/**
 * @file lib/entity-document-link-service.ts
 * @description Service for managing entity-document links in the Knowledge Tab.
 * Provides CRUD operations for linking entities to documents.
 *
 * EntityDocumentLinks create normalized relationships between any entity
 * (technology, company, signal, etc.) and documents in the Evidence Layer.
 *
 * @phase Knowledge Tab Sprint - Phase 2
 * @author Radarist Team
 * @created 2026-01-14
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  query,
  where,
  orderBy,
  limit as limitQuery,
  Timestamp,
  runTransaction,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type {
  EntityDocumentLink,
  CreateEntityDocumentLinkInput,
  UpdateEntityDocumentLinkInput,
  EntityDocumentLinkWithDocument,
  DocumentRelationshipType,
  DocumentRelevance,
  GraphSyncStatus,
  TransformationEntityType,
} from '@/lib/types';
import { updateLinkedEntityCount, getDocumentById } from './document-service';
import {
  chunkEntityDocumentLinks,
  toEntityDocumentLinkDeleteTarget,
  toEntityDocumentLinkType,
  type EntityDocumentLinkCascadeEntityType,
} from './entity-document-link-cascade';
import { requestEntityDocumentLinkGraphHandoff } from './entity-document-link-handoff-client';
import type {
  EntityDocumentLinkCommitResult as HandoffCommitResult,
  EntityDocumentLinkHandoffOperation,
} from './entity-document-link-handoff';
import { fetchWithAuth } from './fetch-with-auth';
import { createLogger } from '@/lib/logger';
const log = createLogger('entity-document-link-service');

/** What a committed create/update returns: the row plus its honest graph state. */
export type EntityDocumentLinkCommitResult = HandoffCommitResult<EntityDocumentLink>;

/**
 * GRAPH-069 — the ONE post-commit graph handoff shared by create and update.
 *
 * Replaces a per-call-site `inngest.send()` wrapped in `catch {}`. That send
 * could not work from a page at all (the browser bundle cannot see the
 * server-only `INNGEST_DEV` routing value, so the SDK addressed the hosted
 * service), and the swallow meant every link still resolved as a plain success.
 * Delivery now goes through the authenticated same-origin route, and the
 * outcome — acknowledged, pending-reconciliation, or refused — travels back to
 * the caller instead of being discarded.
 *
 * Takes the re-read row rather than an id: the handoff asserts the endpoint
 * triple the server compares against authoritative Firestore, so the caller
 * must already have proven the row exists.
 */
async function handOffCommittedLink(
  link: EntityDocumentLink,
  operation: EntityDocumentLinkHandoffOperation
): Promise<EntityDocumentLinkCommitResult> {
  const graphHandoff = await requestEntityDocumentLinkGraphHandoff(
    { linkId: link.id, entityId: link.entityId, documentId: link.documentId },
    operation
  );
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

// ============================================================================
// FILTER TYPES
// ============================================================================

/**
 * Filter options for querying entity-document links.
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
 * Convert Firestore document to EntityDocumentLink type.
 */
function firestoreToEntityDocumentLink(
  docSnap: import('firebase/firestore').DocumentSnapshot
): EntityDocumentLink | null {
  if (!docSnap.exists()) return null;

  const data = docSnap.data();
  return {
    id: docSnap.id,
    workspaceId: data.workspaceId || 'default',
    entityType: data.entityType,
    entityId: data.entityId,
    documentId: data.documentId,
    relationshipType: data.relationshipType,
    tags: data.tags || [],
    relevance: data.relevance,
    note: data.note,
    aiSuggested: data.aiSuggested,
    aiConfidence: data.aiConfidence,
    createdAt: data.createdAt?.toMillis?.() ?? data.createdAt,
    createdBy: data.createdBy,
    updatedAt: data.updatedAt?.toMillis?.() ?? data.updatedAt,
    graphSyncStatus: data.graphSyncStatus,
    lastSyncedAt: data.lastSyncedAt?.toMillis?.() ?? data.lastSyncedAt,
  };
}

/**
 * Convert EntityDocumentLink to Firestore format for writing.
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

// ============================================================================
// READ OPERATIONS
// ============================================================================

/**
 * Get all entity-document links with optional filters.
 *
 * @param filters - Optional filters to apply
 * @returns Array of links matching filters
 *
 * @example
 * ```typescript
 * // Get all links for a specific entity
 * const links = await getEntityDocumentLinks({
 *   entityType: 'technology',
 *   entityId: 'tech-123'
 * });
 *
 * // Get all high-relevance documentation links
 * const docs = await getEntityDocumentLinks({
 *   relationshipType: 'documentation',
 *   relevance: 'high'
 * });
 * ```
 */
export async function getEntityDocumentLinks(filters?: EntityDocumentLinkFilters): Promise<EntityDocumentLink[]> {
  try {
    const collectionRef = collection(db, COLLECTION_NAME);
    let q = query(collectionRef, orderBy('createdAt', 'desc'));

    // Apply Firestore filters (limited to one inequality per query)
    // Priority: entityId > documentId > entityType > relationshipType
    if (filters?.entityId) {
      q = query(q, where('entityId', '==', filters.entityId));
    } else if (filters?.documentId) {
      q = query(q, where('documentId', '==', filters.documentId));
    } else if (filters?.entityType) {
      q = query(q, where('entityType', '==', filters.entityType));
    } else if (filters?.relationshipType) {
      q = query(q, where('relationshipType', '==', filters.relationshipType));
    } else if (filters?.workspaceId) {
      q = query(q, where('workspaceId', '==', filters.workspaceId));
    }

    // Apply limit (fetch extra for client-side filtering)
    const fetchLimit = (filters?.limit || 50) + (filters?.offset || 0) + 100;
    q = query(q, limitQuery(fetchLimit));

    const snapshot = await getDocs(q);
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
 * Get an entity-document link by ID.
 *
 * @param id - Link ID
 * @returns Link or null if not found
 */
export async function getEntityDocumentLinkById(id: string): Promise<EntityDocumentLink | null> {
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    const docSnap = await getDoc(docRef);
    return firestoreToEntityDocumentLink(docSnap);
  } catch (error) {
    log.error('Error getting link', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

/**
 * Get all links for a specific entity.
 *
 * @param entityType - Type of the entity
 * @param entityId - Entity ID
 * @returns Array of links for the entity
 */
export async function getLinksForEntity(
  entityType: TransformationEntityType,
  entityId: string
): Promise<EntityDocumentLink[]> {
  return getEntityDocumentLinks({ entityType, entityId });
}

/**
 * Get all links for a specific document.
 *
 * @param documentId - Document ID
 * @returns Array of links for the document
 */
export async function getLinksForDocument(documentId: string): Promise<EntityDocumentLink[]> {
  return getEntityDocumentLinks({ documentId });
}

/** Dedicated unbounded query for destructive cascades; public list pagination is unchanged. */
async function getCascadeLinksForEntity(
  entityType: EntityDocumentLinkCascadeEntityType,
  entityId: string
): Promise<EntityDocumentLink[]> {
  const normalizedType = toEntityDocumentLinkType(entityType);
  const snapshot = await getDocs(query(collection(db, COLLECTION_NAME), where('entityId', '==', entityId)));
  return snapshot.docs
    .map(firestoreToEntityDocumentLink)
    .filter((link): link is EntityDocumentLink => link !== null && link.entityType === normalizedType);
}

/** Dedicated unbounded query for destructive cascades; public list pagination is unchanged. */
async function getCascadeLinksForDocument(documentId: string): Promise<EntityDocumentLink[]> {
  const collectionRef = collection(db, COLLECTION_NAME);
  const [documentEndpoint, entityEndpoint] = await Promise.all([
    getDocs(query(collectionRef, where('documentId', '==', documentId))),
    getDocs(query(collectionRef, where('entityId', '==', documentId))),
  ]);
  const links = [
    ...documentEndpoint.docs.map(firestoreToEntityDocumentLink),
    ...entityEndpoint.docs.map(firestoreToEntityDocumentLink).filter((link) => link?.entityType === 'document'),
  ].filter((link): link is EntityDocumentLink => link !== null);
  return [...new Map(links.map((link) => [link.id, link])).values()];
}

/**
 * Get links with enriched document information.
 *
 * @param entityType - Type of the entity
 * @param entityId - Entity ID
 * @returns Array of links with document details
 */
export async function getLinksWithDocuments(
  entityType: TransformationEntityType,
  entityId: string
): Promise<EntityDocumentLinkWithDocument[]> {
  try {
    const links = await getLinksForEntity(entityType, entityId);

    // Parallel fetch of documents
    const documentPromises = links.map((link) => getDocumentById(link.documentId));
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
 * Check if a specific link already exists.
 *
 * @param entityType - Entity type
 * @param entityId - Entity ID
 * @param documentId - Document ID
 * @returns Existing link or null
 */
export async function findExistingLink(
  entityType: TransformationEntityType,
  entityId: string,
  documentId: string
): Promise<EntityDocumentLink | null> {
  try {
    const collectionRef = collection(db, COLLECTION_NAME);
    const q = query(
      collectionRef,
      where('entityId', '==', entityId),
      where('documentId', '==', documentId),
      limitQuery(1)
    );
    const snapshot = await getDocs(q);

    if (snapshot.empty) return null;

    const link = firestoreToEntityDocumentLink(snapshot.docs[0]);
    // Verify entity type matches (client-side check)
    if (link && link.entityType !== entityType) return null;
    return link;
  } catch (error) {
    log.error('Error finding existing link', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

// ============================================================================
// WRITE OPERATIONS
// ============================================================================

/**
 * Create a new entity-document link.
 *
 * Returns the committed row AND the honest state of its graph projection
 * (GRAPH-069). A caller that renders "linked" must check `graphHandoff`: only
 * `acknowledged` means the projection is on its way.
 *
 * @param input - Link data
 * @returns The created link and its graph handoff outcome
 * @throws Error if the link already exists or the Firestore write fails
 *
 * @example
 * ```typescript
 * const { link, graphHandoff } = await createEntityDocumentLink({
 *   entityType: 'technology',
 *   entityId: 'tech-123',
 *   documentId: 'doc-456',
 *   relationshipType: 'documentation',
 *   relevance: 'high',
 *   createdBy: 'user-789',
 * });
 * ```
 */
export async function createEntityDocumentLink(
  input: CreateEntityDocumentLinkInput
): Promise<EntityDocumentLinkCommitResult> {
  try {
    // Check for existing link
    const existing = await findExistingLink(input.entityType, input.entityId, input.documentId);
    if (existing) {
      throw new Error(
        `Link already exists between ${input.entityType}:${input.entityId} and document:${input.documentId} (ID: ${existing.id})`
      );
    }

    const now = Timestamp.now();
    const linkData = {
      ...entityDocumentLinkToFirestore(input),
      graphSyncStatus: 'pending' as GraphSyncStatus,
      createdAt: now,
      updatedAt: now,
    };

    const collectionRef = collection(db, COLLECTION_NAME);
    const docRef = await addDoc(collectionRef, linkData);

    // Update document's linkedEntityCount
    await updateLinkedEntityCount(input.documentId, 1);

    log.info('Created link', {
      id: docRef.id,
      entityType: input.entityType,
      entityId: input.entityId,
      documentId: input.documentId,
    });

    const created = await getEntityDocumentLinkById(docRef.id);
    if (!created) {
      // A vanished row right after the write is a Firestore failure, not a
      // handoff outcome; the caller must not receive a half-built link.
      throw new Error('Failed to retrieve created link');
    }
    return await handOffCommittedLink(created, 'create');
  } catch (error) {
    log.error('Error creating link', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Update an entity-document link.
 * Only relationship metadata can be updated, not endpoints.
 *
 * Shares `handOffCommittedLink` with create, so both mutations reach Neo4j
 * through exactly one authenticated server-owned handoff and both report the
 * same honest committed-versus-pending result (GRAPH-069).
 *
 * @param id - Link ID
 * @param updates - Fields to update
 * @returns The updated link and its graph handoff outcome
 */
export async function updateEntityDocumentLink(
  id: string,
  updates: UpdateEntityDocumentLinkInput
): Promise<EntityDocumentLinkCommitResult> {
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    const updateData = {
      ...entityDocumentLinkToFirestore(updates),
      graphSyncStatus: 'pending' as GraphSyncStatus, // Re-sync on update
      updatedAt: Timestamp.now(),
    };

    await updateDoc(docRef, updateData);
    log.info('Updated link', { id });

    const updated = await getEntityDocumentLinkById(id);
    if (!updated) {
      // The row was deleted between the update and the read-back. There is
      // nothing to project, so the handoff is refused rather than guessed at —
      // and the delete path owns its own (pre-commit) graph removal.
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

/**
 * Delete an entity-document link.
 *
 * @param id - Link ID
 */
async function requestCascadeGraphDeletions(links: readonly EntityDocumentLink[]): Promise<void> {
  const targets = links.map(toEntityDocumentLinkDeleteTarget);
  const response = await fetchWithAuth('/api/graph/entity-document-link-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'delete', links: targets }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const detail = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new Error(`Entity-document link graph deletion handoff failed: ${detail}`);
  }

  const body = (await response.json().catch(() => null)) as { acknowledged?: unknown; failed?: unknown } | null;
  if (!Array.isArray(body?.acknowledged) || !Array.isArray(body.failed)) {
    throw new Error('Invalid entity-document link graph handoff acknowledgement');
  }
  const requested = new Set(targets.map(({ linkId }) => linkId));
  const acknowledged = body.acknowledged;
  const failed = body.failed;
  const allStrings = [...acknowledged, ...failed].every((id) => typeof id === 'string');
  const acknowledgedSet = new Set(acknowledged as string[]);
  const failedSet = new Set(failed as string[]);
  const complete =
    allStrings &&
    acknowledgedSet.size === acknowledged.length &&
    failedSet.size === failed.length &&
    [...acknowledgedSet].every((id) => requested.has(id) && !failedSet.has(id)) &&
    [...failedSet].every((id) => requested.has(id)) &&
    acknowledgedSet.size + failedSet.size === requested.size;
  if (!complete) {
    throw new Error('Incomplete entity-document link graph handoff acknowledgement');
  }
  if (failedSet.size > 0) {
    throw new Error(`Graph deletion handoff failed for ${failedSet.size} entity-document link(s)`);
  }
}

async function commitCascadeLinkChunk(links: readonly EntityDocumentLink[]): Promise<number> {
  return runTransaction(db, async (transaction) => {
    const linkRefs = links.map((link) => doc(db, COLLECTION_NAME, link.id));
    const linkSnapshots = await Promise.all(linkRefs.map((ref) => transaction.get(ref)));
    const liveLinks: Array<{ link: EntityDocumentLink; ref: (typeof linkRefs)[number] }> = [];

    linkSnapshots.forEach((snapshot, index) => {
      if (!snapshot.exists()) return;
      const current = firestoreToEntityDocumentLink(snapshot);
      const expected = links[index];
      if (
        !current ||
        current.entityType !== expected.entityType ||
        current.entityId !== expected.entityId ||
        current.documentId !== expected.documentId
      ) {
        throw new Error(`Entity-document link ${expected.id} changed endpoints during deletion`);
      }
      liveLinks.push({ link: current, ref: linkRefs[index] });
    });

    const removedByDocument = new Map<string, number>();
    for (const { link } of liveLinks) {
      removedByDocument.set(link.documentId, (removedByDocument.get(link.documentId) ?? 0) + 1);
    }
    const documentEntries = [...removedByDocument.entries()].map(([documentId, removed]) => ({
      documentId,
      removed,
      ref: doc(db, 'documents', documentId),
    }));
    const documentSnapshots = await Promise.all(documentEntries.map(({ ref }) => transaction.get(ref)));

    for (const { ref } of liveLinks) transaction.delete(ref);
    documentEntries.forEach(({ removed, ref }, index) => {
      const snapshot = documentSnapshots[index];
      if (!snapshot.exists()) return;
      const currentCount = snapshot.data()?.linkedEntityCount;
      const normalizedCount = typeof currentCount === 'number' && Number.isFinite(currentCount) ? currentCount : 0;
      transaction.update(ref, {
        linkedEntityCount: Math.max(0, normalizedCount - removed),
        updatedAt: Timestamp.now(),
      });
    });

    return liveLinks.length;
  });
}

async function deleteCascadeLinks(links: readonly EntityDocumentLink[]): Promise<number> {
  let deleted = 0;
  for (const chunk of chunkEntityDocumentLinks(links)) {
    // The event worker deletes by stable linkId, so replayed acknowledgements are
    // harmless. Dispatch comes first: a failed handoff retains every link in the
    // current chunk as the retry anchor for its parent deletion.
    await requestCascadeGraphDeletions(chunk);
    deleted += await commitCascadeLinkChunk(chunk);
  }
  return deleted;
}

export async function deleteEntityDocumentLink(id: string): Promise<void> {
  try {
    const link = await getEntityDocumentLinkById(id);
    if (!link) {
      log.warn('Link not found for deletion', { id });
      return;
    }
    await deleteCascadeLinks([link]);
    log.info('Deleted link after acknowledged graph handoff', { id });
  } catch (error) {
    log.error('Error deleting link', error instanceof Error ? error : new Error(String(error)), { id });
    throw error;
  }
}

/**
 * Delete all links for an entity.
 * Used when deleting an entity.
 *
 * @param entityType - Entity type
 * @param entityId - Entity ID
 * @returns Number of links deleted
 */
export async function deleteLinksForEntity(
  entityType: EntityDocumentLinkCascadeEntityType,
  entityId: string
): Promise<number> {
  try {
    const normalizedType = toEntityDocumentLinkType(entityType);
    const links = await getCascadeLinksForEntity(normalizedType, entityId);
    if (links.length === 0) return 0;
    const deleted = await deleteCascadeLinks(links);
    log.info('Deleted links for entity after acknowledged graph handoffs', {
      count: deleted,
      entityType: normalizedType,
      entityId,
    });
    return deleted;
  } catch (error) {
    log.error('Error deleting links for entity', error instanceof Error ? error : new Error(String(error)), {
      entityType,
      entityId,
    });
    throw error;
  }
}

/**
 * Delete all links for a document.
 * Used when deleting a document.
 *
 * @param documentId - Document ID
 * @returns Number of links deleted
 */
export async function deleteLinksForDocument(documentId: string): Promise<number> {
  try {
    const links = await getCascadeLinksForDocument(documentId);
    if (links.length === 0) return 0;
    const deleted = await deleteCascadeLinks(links);
    log.info('Deleted links for document after acknowledged graph handoffs', { count: deleted, documentId });
    return deleted;
  } catch (error) {
    log.error('Error deleting links for document', error instanceof Error ? error : new Error(String(error)), {
      documentId,
    });
    throw error;
  }
}

// ============================================================================
// AI SUGGESTION OPERATIONS
// ============================================================================

/**
 * Create an AI-suggested link.
 *
 * @param input - Link data
 * @param confidence - AI confidence score (0-100)
 * @returns Created link
 */
export async function createAISuggestedLink(
  input: Omit<CreateEntityDocumentLinkInput, 'aiSuggested' | 'aiConfidence'>,
  confidence: number
): Promise<EntityDocumentLinkCommitResult> {
  return createEntityDocumentLink({
    ...input,
    aiSuggested: true,
    aiConfidence: Math.min(100, Math.max(0, confidence)),
  });
}

/**
 * Get pending AI suggestions for review.
 *
 * @param limit - Maximum results
 * @returns Array of AI-suggested links
 */
export async function getPendingAISuggestions(limit = 50): Promise<EntityDocumentLink[]> {
  return getEntityDocumentLinks({ aiSuggested: true, limit });
}

/**
 * Approve an AI suggestion (remove AI flag).
 *
 * Returns the update's graph handoff outcome so the triage UI can distinguish
 * "approved and syncing" from "approved, projection pending".
 *
 * @param id - Link ID
 */
export async function approveAISuggestion(id: string): Promise<EntityDocumentLinkCommitResult> {
  const result = await updateEntityDocumentLink(id, {
    aiSuggested: false,
    aiConfidence: undefined,
  });
  log.info('Approved AI suggestion', { id, handoff: result.graphHandoff.status });
  return result;
}

/**
 * Reject an AI suggestion (delete link).
 *
 * @param id - Link ID
 */
export async function rejectAISuggestion(id: string): Promise<void> {
  await deleteEntityDocumentLink(id);
  log.info('Rejected AI suggestion', { id });
}

// ============================================================================
// GRAPH SYNC OPERATIONS
// ============================================================================

/**
 * Mark a link as synced to Neo4j.
 *
 * @param id - Link ID
 */
export async function markLinkSynced(id: string): Promise<void> {
  const docRef = doc(db, COLLECTION_NAME, id);
  await updateDoc(docRef, {
    graphSyncStatus: 'synced' as GraphSyncStatus,
    lastSyncedAt: Timestamp.now(),
  });
}

/**
 * Mark a link sync as failed.
 *
 * @param id - Link ID
 */
export async function markLinkSyncFailed(id: string): Promise<void> {
  const docRef = doc(db, COLLECTION_NAME, id);
  await updateDoc(docRef, {
    graphSyncStatus: 'failed' as GraphSyncStatus,
  });
}

/**
 * Get links pending sync to Neo4j.
 *
 * @param limit - Maximum results
 * @returns Array of links pending sync
 */
export async function getLinksPendingSync(limit = 100): Promise<EntityDocumentLink[]> {
  try {
    const collectionRef = collection(db, COLLECTION_NAME);
    const q = query(collectionRef, where('graphSyncStatus', '==', 'pending'), limitQuery(limit));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(firestoreToEntityDocumentLink).filter((l): l is EntityDocumentLink => l !== null);
  } catch (error) {
    log.error('Error getting links pending sync', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

// ============================================================================
// STATISTICS
// ============================================================================

/**
 * Get link statistics for an entity.
 *
 * @param entityType - Entity type
 * @param entityId - Entity ID
 * @returns Link counts by relationship type and relevance
 */
export async function getLinkStatsForEntity(
  entityType: TransformationEntityType,
  entityId: string
): Promise<{
  total: number;
  byRelationshipType: Record<DocumentRelationshipType, number>;
  byRelevance: Record<DocumentRelevance, number>;
  aiSuggestedCount: number;
}> {
  const links = await getLinksForEntity(entityType, entityId);

  const byRelationshipType: Record<DocumentRelationshipType, number> = {
    documentation: 0,
    pitch_deck: 0,
    technical_spec: 0,
    case_study: 0,
    research_paper: 0,
    competitive_intel: 0,
    contract: 0,
    evidence: 0,
    other: 0,
  };

  const byRelevance: Record<DocumentRelevance, number> = {
    high: 0,
    medium: 0,
    low: 0,
  };

  let aiSuggestedCount = 0;

  for (const link of links) {
    byRelationshipType[link.relationshipType]++;
    byRelevance[link.relevance]++;
    if (link.aiSuggested) aiSuggestedCount++;
  }

  return {
    total: links.length,
    byRelationshipType,
    byRelevance,
    aiSuggestedCount,
  };
}

/**
 * Get overall link statistics.
 *
 * @returns Global link counts
 */
export async function getGlobalLinkStats(): Promise<{
  total: number;
  byEntityType: Record<TransformationEntityType, number>;
  byRelationshipType: Record<DocumentRelationshipType, number>;
  pendingSyncCount: number;
}> {
  try {
    const links = await getEntityDocumentLinks({ limit: 10000 });

    const byEntityType: Record<TransformationEntityType, number> = {
      technology: 0,
      company: 0,
      useCase: 0,
      strategy: 0,
      prototype: 0,
      signal: 0,
      org_unit: 0,
      initiative: 0,
      pain_point: 0,
      document: 0,
    };

    const byRelationshipType: Record<DocumentRelationshipType, number> = {
      documentation: 0,
      pitch_deck: 0,
      technical_spec: 0,
      case_study: 0,
      research_paper: 0,
      competitive_intel: 0,
      contract: 0,
      evidence: 0,
      other: 0,
    };

    let pendingSyncCount = 0;

    for (const link of links) {
      byEntityType[link.entityType]++;
      byRelationshipType[link.relationshipType]++;
      if (link.graphSyncStatus === 'pending') pendingSyncCount++;
    }

    return {
      total: links.length,
      byEntityType,
      byRelationshipType,
      pendingSyncCount,
    };
  } catch (error) {
    log.error('Error getting global stats', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
