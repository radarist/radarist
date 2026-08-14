/**
 * @file entity-notes.ts
 * @description Generic data access layer for entity notes (UX-002/003/004).
 *
 * Prototype, Use Case, and Strategy sheets all render the shared `NotesTab`,
 * but until this module existed only companies persisted notes (via the
 * company-specific `company-notes.ts`). This is the same proven subcollection
 * pattern — `<collection>/<entityId>/notes/<noteId>` — generalized over the
 * parent collection so the three remaining library pages get real
 * add/edit/delete persistence without three near-copies of the company module.
 *
 * The note shape is deliberately minimal: exactly what the shared `NotesTab`
 * renders (`content`, `createdAt`, `updatedAt` for the "edited" marker, and an
 * optional author). Company notes keep their richer typed timeline
 * (`NoteType`) in `company-notes.ts`.
 *
 * Client-SDK module: library pages are client components, so this module must
 * not import server-only admin helpers.
 */

import { db } from '@/lib/firebase';
import { collection, doc, getDocs, setDoc, deleteDoc, updateDoc, query, orderBy } from 'firebase/firestore';
import { createLogger } from '@/lib/logger';
import type { NotesParentCollection } from '@/lib/entity-notes-cleanup';

export type { NotesParentCollection } from '@/lib/entity-notes-cleanup';

const log = createLogger('entity-notes');

/**
 * Parent collections wired to the shared NotesTab through this module.
 * Companies intentionally stay on `company-notes.ts` (typed timeline).
 */
/** A note stored under `<parent>/<entityId>/notes/<noteId>`. */
export interface EntityNote {
  /** Unique identifier for the note. */
  id: string;
  /** Parent entity ID (denormalized for convenience). */
  entityId: string;
  /** Note content (supports markdown). */
  content: string;
  /** User ID of the note author, when known. */
  createdBy?: string;
  /** Timestamp of creation (milliseconds since epoch). */
  createdAt: number;
  /** Timestamp of last edit; equals `createdAt` until the note is edited.
   * The shared NotesTab shows its "edited" marker when this exceeds createdAt. */
  updatedAt: number;
}

function notesCollection(parent: NotesParentCollection, entityId: string) {
  return collection(db, parent, entityId, 'notes');
}

/**
 * Fetches all notes for an entity, newest first.
 */
export async function getEntityNotes(parent: NotesParentCollection, entityId: string): Promise<EntityNote[]> {
  try {
    const q = query(notesCollection(parent, entityId), orderBy('createdAt', 'desc'));
    const snapshot = await getDocs(q);
    return snapshot.docs.map((d) => d.data() as EntityNote);
  } catch (error) {
    log.error('Failed to fetch entity notes', error instanceof Error ? error : new Error(String(error)), {
      parent,
      entityId,
    });
    throw new Error(`Failed to fetch notes for ${parent}/${entityId}`);
  }
}

/**
 * Creates a note under the entity. Returns the created note so callers can
 * update local state with the committed values instead of re-deriving them.
 */
export async function createEntityNote(
  parent: NotesParentCollection,
  entityId: string,
  content: string,
  createdBy?: string
): Promise<EntityNote> {
  try {
    const now = Date.now();
    const id = `note-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const note: EntityNote = {
      id,
      entityId,
      content,
      ...(createdBy ? { createdBy } : {}),
      createdAt: now,
      updatedAt: now,
    };
    // setDoc directly (not entity-factory): subcollection note without slug or
    // uniqueness requirements, mirroring company-notes.ts.
    await setDoc(doc(db, parent, entityId, 'notes', id), note);
    return note;
  } catch (error) {
    log.error('Failed to create entity note', error instanceof Error ? error : new Error(String(error)), {
      parent,
      entityId,
    });
    throw new Error(`Failed to create note for ${parent}/${entityId}`);
  }
}

/**
 * Updates a note's content and stamps `updatedAt` so the "edited" marker
 * survives reloads. Returns the committed `updatedAt`.
 */
export async function updateEntityNote(
  parent: NotesParentCollection,
  entityId: string,
  noteId: string,
  content: string
): Promise<{ updatedAt: number }> {
  try {
    const updatedAt = Date.now();
    await updateDoc(doc(db, parent, entityId, 'notes', noteId), { content, updatedAt });
    return { updatedAt };
  } catch (error) {
    log.error('Failed to update entity note', error instanceof Error ? error : new Error(String(error)), {
      parent,
      entityId,
      noteId,
    });
    throw new Error(`Failed to update note ${noteId}`);
  }
}

/**
 * Deletes a note.
 */
export async function deleteEntityNote(parent: NotesParentCollection, entityId: string, noteId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, parent, entityId, 'notes', noteId));
  } catch (error) {
    log.error('Failed to delete entity note', error instanceof Error ? error : new Error(String(error)), {
      parent,
      entityId,
      noteId,
    });
    throw new Error(`Failed to delete note ${noteId}`);
  }
}
