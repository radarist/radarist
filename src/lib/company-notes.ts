/**
 * @file company-notes.ts
 * @description Data access layer for Company Notes in the Scouting feature.
 *
 * Notes provide a timeline of interactions, observations, and general information about companies.
 * They support markdown formatting and can be categorized by type (Meeting, Email, Demo, etc.).
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

import { db } from '@/lib/firebase';
import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  updateDoc,
  query,
  where,
  orderBy,
} from 'firebase/firestore';
import type { CompanyNote, NoteType } from '@/lib/types';

/**
 * Fetches all notes for a specific company, ordered by creation date (newest first).
 * Notes are stored as a subcollection under each company document.
 *
 * @param companyId - The ID of the parent company
 * @returns Promise resolving to an array of CompanyNote objects
 * @throws Error if Firestore query fails
 *
 * @example
 * const notes = await getNotesByCompanyId("datadog-123");
 * console.log(`${notes.length} notes for this company`);
 *
 * // Display notes timeline
 * notes.forEach(note => {
 *   console.log(`[${note.type}] ${new Date(note.createdAt).toLocaleDateString()}`);
 *   console.log(note.content);
 * });
 */
export async function getNotesByCompanyId(companyId: string): Promise<CompanyNote[]> {
  const notesRef = collection(db, 'companies', companyId, 'notes');

  // Create a query that orders by createdAt descending
  const q = query(notesRef, orderBy('createdAt', 'desc'));

  const querySnapshot = await getDocs(q);
  return querySnapshot.docs.map((doc) => doc.data() as CompanyNote);
}

/**
 * Fetches a single note by ID.
 *
 * @param companyId - The ID of the parent company
 * @param noteId - The ID of the note
 * @returns Promise resolving to the CompanyNote object or null if not found
 * @throws Error if Firestore query fails
 *
 * @example
 * const note = await getNoteById("datadog-123", "meeting-note-456");
 * if (note) {
 *   console.log(note.content);
 * }
 */
export async function getNoteById(companyId: string, noteId: string): Promise<CompanyNote | null> {
  const docRef = doc(db, 'companies', companyId, 'notes', noteId);
  const docSnap = await getDoc(docRef);

  if (docSnap.exists()) {
    return docSnap.data() as CompanyNote;
  }
  return null;
}

/**
 * Creates a new note for a company.
 * Automatically generates an ID and timestamp.
 *
 * @param companyId - The ID of the parent company
 * @param note - The note data without system-managed fields
 * @returns Promise resolving to the newly created CompanyNote object
 * @throws Error if Firestore operation fails
 *
 * @example
 * const newNote = await createNote("datadog-123", {
 *   content: "Great demo! Showed new APM features for microservices.",
 *   type: "Demo",
 *   userId: "user-123" // Optional: will be integrated with auth later
 * });
 *
 * // Markdown is supported in content
 * const detailedNote = await createNote("datadog-123", {
 *   content: `
 * # Meeting Notes
 *
 * **Date**: 2024-03-15
 * **Attendees**: John Doe, Jane Smith
 *
 * ## Key Points
 * - Discussed pricing model
 * - Reviewed integration options
 * - Next steps: schedule technical demo
 *   `,
 *   type: "Meeting"
 * });
 */
export async function createNote(
  companyId: string,
  note: Omit<CompanyNote, 'id' | 'companyId' | 'createdAt'>
): Promise<CompanyNote> {
  // Generate ID from type and timestamp
  const id = `${note.type.toLowerCase()}-${Date.now()}`;
  const now = Date.now();

  const newNote: CompanyNote = {
    ...note,
    id,
    companyId,
    createdAt: now,
  };

  // Uses setDoc directly (not entity-factory) — subcollection document under parent company.
  await setDoc(doc(db, 'companies', companyId, 'notes', id), newNote);
  return newNote;
}

/**
 * Updates an existing note.
 * Only the content and type can be edited; `createdAt` and IDs are immutable,
 * and `updatedAt` is stamped automatically on every update (UX-006).
 *
 * @param companyId - The ID of the parent company
 * @param noteId - The ID of the note to update
 * @param updates - An object containing the fields to update
 * @returns The committed `updatedAt` timestamp
 * @throws Error if Firestore operation fails
 *
 * @example
 * await updateNote("datadog-123", "meeting-note-456", {
 *   content: "Updated meeting notes with action items",
 *   type: "Meeting"
 * });
 */
export async function updateNote(
  companyId: string,
  noteId: string,
  updates: Partial<Pick<CompanyNote, 'content' | 'type'>>
): Promise<{ updatedAt: number }> {
  const docRef = doc(db, 'companies', companyId, 'notes', noteId);
  // UX-006: stamp updatedAt so the Notes tab "edited" marker survives reloads
  // (it renders when updatedAt > createdAt). Returned so callers can commit
  // the same value into local state instead of guessing.
  const updatedAt = Date.now();
  await updateDoc(docRef, { ...updates, updatedAt });
  return { updatedAt };
}

/**
 * Deletes a note from Firestore.
 *
 * @param companyId - The ID of the parent company
 * @param noteId - The ID of the note to delete
 * @returns Promise that resolves when deletion is complete
 * @throws Error if Firestore operation fails
 *
 * @example
 * await deleteNote("datadog-123", "meeting-note-456");
 */
export async function deleteNote(companyId: string, noteId: string): Promise<void> {
  await deleteDoc(doc(db, 'companies', companyId, 'notes', noteId));
}

/**
 * Fetches notes filtered by type.
 * Useful for getting all meetings, emails, demos, etc.
 *
 * @param companyId - The ID of the company
 * @param noteType - The type of notes to retrieve
 * @returns Promise resolving to an array of matching CompanyNote objects
 * @throws Error if Firestore query fails
 *
 * @example
 * // Get all meeting notes
 * const meetings = await getNotesByType("datadog-123", "Meeting");
 *
 * // Get all demo requests
 * const demos = await getNotesByType("datadog-123", "Demo");
 */
export async function getNotesByType(companyId: string, noteType: NoteType): Promise<CompanyNote[]> {
  const notesRef = collection(db, 'companies', companyId, 'notes');

  const q = query(notesRef, where('type', '==', noteType), orderBy('createdAt', 'desc'));

  const querySnapshot = await getDocs(q);
  return querySnapshot.docs.map((doc) => doc.data() as CompanyNote);
}

/**
 * Gets a count of notes by type for a company.
 * Useful for dashboard/summary views.
 *
 * @param companyId - The ID of the company
 * @returns Promise resolving to an object with counts by note type
 * @throws Error if Firestore query fails
 *
 * @example
 * const counts = await getNoteCountsByType("datadog-123");
 * console.log(`Meetings: ${counts.Meeting}, Emails: ${counts.Email}`);
 */
export async function getNoteCountsByType(companyId: string): Promise<Record<NoteType, number>> {
  const notes = await getNotesByCompanyId(companyId);

  const counts: Record<NoteType, number> = {
    Meeting: 0,
    Email: 0,
    Demo: 0,
    Evaluation: 0,
    General: 0,
  };

  notes.forEach((note) => {
    counts[note.type]++;
  });

  return counts;
}

/**
 * Gets the most recent note for a company.
 * Useful for displaying "last interaction" information.
 *
 * @param companyId - The ID of the company
 * @returns Promise resolving to the most recent CompanyNote or null if no notes exist
 * @throws Error if Firestore query fails
 *
 * @example
 * const lastNote = await getMostRecentNote("datadog-123");
 * if (lastNote) {
 *   console.log(`Last contact: ${lastNote.type} on ${new Date(lastNote.createdAt).toLocaleDateString()}`);
 * }
 */
export async function getMostRecentNote(companyId: string): Promise<CompanyNote | null> {
  const notes = await getNotesByCompanyId(companyId);
  return notes.length > 0 ? notes[0] : null;
}
