/**
 * @file entity-notes-cleanup-admin.ts
 * @description Server-only cascade deletion for entity note subcollections.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import type { NotesCleanupParentCollection } from '@/lib/entity-notes-cleanup';

const DELETE_BATCH_SIZE = 500;

/**
 * Deletes all notes under an entity in bounded Admin-SDK batches.
 *
 * Firestore does not cascade subcollections when a parent document is deleted.
 * Read or commit failures deliberately propagate so the parent survives and the
 * complete deletion can be replayed safely.
 */
export async function adminDeleteAllEntityNotes(
  parent: NotesCleanupParentCollection,
  entityId: string
): Promise<number> {
  const notes = db.collection(parent).doc(entityId).collection('notes');
  let deleted = 0;

  while (true) {
    const snapshot = await notes.limit(DELETE_BATCH_SIZE).get();
    if (snapshot.empty) return deleted;

    const batch = db.batch();
    for (const note of snapshot.docs) {
      batch.delete(note.ref);
    }
    await batch.commit();
    deleted += snapshot.size;
  }
}
