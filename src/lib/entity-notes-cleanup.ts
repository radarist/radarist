/**
 * @file entity-notes-cleanup.ts
 * @description Leaf helper for cascading entity-note deletion.
 *
 * The parent entity services already own the Firestore instance. Accepting it
 * here keeps cascade cleanup independent from the client Firebase bootstrap,
 * which must not depend back on the entity-service graph.
 */

import { collection, deleteDoc, getDocs, type Firestore } from 'firebase/firestore';
import { mapWithBoundedConcurrency } from '@/lib/bounded-concurrency';

const DELETE_CONCURRENCY = 25;

/**
 * Parent collections that use the shared entity-notes service. Values are the
 * exact Firestore collection names — note `painPoints` is camelCase while the
 * others are kebab-case (see the entity services in `src/lib/`).
 */
export type NotesParentCollection =
  | 'prototypes'
  | 'use-cases'
  | 'strategies'
  | 'org-units'
  | 'initiatives'
  | 'painPoints';

/** All parent collections with note subcollections, including typed company notes. */
export type NotesCleanupParentCollection = NotesParentCollection | 'companies';

/**
 * Deletes every note under an entity. Failures propagate so callers retain the
 * parent document as a retry anchor instead of orphaning an unreadable or
 * partially deleted notes subcollection.
 */
export async function deleteAllEntityNotes(
  database: Firestore,
  parent: NotesCleanupParentCollection,
  entityId: string
): Promise<number> {
  const snapshot = await getDocs(collection(database, parent, entityId, 'notes'));

  await mapWithBoundedConcurrency(
    snapshot.docs,
    DELETE_CONCURRENCY,
    (note) => deleteDoc(note.ref)
  );

  return snapshot.size;
}
