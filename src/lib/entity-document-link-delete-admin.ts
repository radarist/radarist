/**
 * @file entity-document-link-delete-admin.ts
 * @description Server-only leaf for destructive entity-document-link cascades.
 *
 * This module deliberately does not import `document-admin`. Document deletion
 * depends on this leaf, while the wider entity-document-link Admin service may
 * still depend on document reads for create/enrichment behavior.
 */

import 'server-only';

import { Timestamp } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import {
  chunkEntityDocumentLinks,
  toEntityDocumentLinkDeleteTarget,
  toEntityDocumentLinkType,
  type EntityDocumentLinkCascadeEntityType,
} from '@/lib/entity-document-link-cascade';
import { requestEntityDocumentLinkGraphDeletionsServer } from '@/lib/entity-document-link-sync-server';
import type { EntityDocumentLink } from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('entity-document-link-delete-admin');
const COLLECTION_NAME = 'entityDocumentLinks';

/** Shared Admin snapshot mapper for the full service and this deletion leaf. */
export function adminFirestoreToEntityDocumentLink(
  docSnap: FirebaseFirestore.DocumentSnapshot
): EntityDocumentLink | null {
  if (!docSnap.exists) return null;

  const data = docSnap.data()!;
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

async function getLinkById(id: string): Promise<EntityDocumentLink | null> {
  const snapshot = await db.collection(COLLECTION_NAME).doc(id).get();
  return adminFirestoreToEntityDocumentLink(snapshot);
}

async function getCascadeLinksForEntity(
  entityType: EntityDocumentLinkCascadeEntityType,
  entityId: string
): Promise<EntityDocumentLink[]> {
  const normalizedType = toEntityDocumentLinkType(entityType);
  const snapshot = await db.collection(COLLECTION_NAME).where('entityId', '==', entityId).get();
  return snapshot.docs
    .map(adminFirestoreToEntityDocumentLink)
    .filter((link): link is EntityDocumentLink => link !== null && link.entityType === normalizedType);
}

async function getCascadeLinksForDocument(documentId: string): Promise<EntityDocumentLink[]> {
  const [documentEndpoint, entityEndpoint] = await Promise.all([
    db.collection(COLLECTION_NAME).where('documentId', '==', documentId).get(),
    db.collection(COLLECTION_NAME).where('entityId', '==', documentId).get(),
  ]);
  const links = [
    ...documentEndpoint.docs.map(adminFirestoreToEntityDocumentLink),
    ...entityEndpoint.docs
      .map(adminFirestoreToEntityDocumentLink)
      .filter((link) => link?.entityType === 'document'),
  ].filter((link): link is EntityDocumentLink => link !== null);
  return [...new Map(links.map((link) => [link.id, link])).values()];
}

async function requestCascadeGraphDeletions(links: readonly EntityDocumentLink[]): Promise<void> {
  const result = await requestEntityDocumentLinkGraphDeletionsServer(
    links.map(toEntityDocumentLinkDeleteTarget)
  );
  if (result.failed.length > 0) {
    const first = result.failed[0];
    const detail = first.error instanceof Error ? first.error.message : String(first.error);
    throw new Error(
      `Graph deletion handoff failed for ${result.failed.length} entity-document link(s); ` +
        `first failure ${first.linkId}: ${detail}`
    );
  }
}

async function commitCascadeLinkChunk(links: readonly EntityDocumentLink[]): Promise<number> {
  return db.runTransaction(async (transaction) => {
    const linkRefs = links.map((link) => db.collection(COLLECTION_NAME).doc(link.id));
    const linkSnapshots = await Promise.all(linkRefs.map((ref) => transaction.get(ref)));
    const liveLinks: Array<{ link: EntityDocumentLink; ref: (typeof linkRefs)[number] }> = [];

    linkSnapshots.forEach((snapshot, index) => {
      if (!snapshot.exists) return;
      const current = adminFirestoreToEntityDocumentLink(snapshot);
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
      ref: db.collection('documents').doc(documentId),
    }));
    const documentSnapshots = await Promise.all(documentEntries.map(({ ref }) => transaction.get(ref)));

    for (const { ref } of liveLinks) transaction.delete(ref);
    documentEntries.forEach(({ removed, ref }, index) => {
      const snapshot = documentSnapshots[index];
      if (!snapshot.exists) return;
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
    await requestCascadeGraphDeletions(chunk);
    deleted += await commitCascadeLinkChunk(chunk);
  }
  return deleted;
}

export async function adminDeleteEntityDocumentLink(id: string): Promise<void> {
  try {
    const link = await getLinkById(id);
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

export async function adminDeleteLinksForEntity(
  entityType: EntityDocumentLinkCascadeEntityType,
  entityId: string
): Promise<number> {
  const normalizedType = toEntityDocumentLinkType(entityType);
  try {
    const links = await getCascadeLinksForEntity(normalizedType, entityId);
    const deleted = await deleteCascadeLinks(links);
    log.info('Deleted links for entity after acknowledged graph handoffs', {
      count: deleted,
      entityType: normalizedType,
      entityId,
    });
    return deleted;
  } catch (error) {
    log.error('Error deleting links for entity', error instanceof Error ? error : new Error(String(error)), {
      entityType: normalizedType,
      entityId,
    });
    throw error;
  }
}

export async function adminDeleteLinksForDocument(documentId: string): Promise<number> {
  try {
    const links = await getCascadeLinksForDocument(documentId);
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
