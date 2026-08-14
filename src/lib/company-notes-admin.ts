/**
 * @file company-notes-admin.ts
 * @description Admin-SDK twin of the company-notes service for SERVER-side
 * callers (AI-chat tool executors — `company-tools.executeAddCompanyNote`).
 *
 * Why this exists: `src/lib/company-notes.ts` is a client-SDK module (it uses
 * `firebase/firestore` + `@/lib/firebase`). It is fine in the browser and in
 * `"use client"` components (NotesTimeline, useCompaniesPage), but when its
 * read/write paths run server-side in a stateless serverless function they
 * return `code: 'unavailable'` because the client SDK has no persistent
 * connection — the same failure mode seen in Inngest workers
 * and that `signals-admin.ts` / `companies-admin.ts` already solve via the
 * narrow admin-helper pattern.
 *
 * This module reproduces the company-notes CRUD semantics EXACTLY via the
 * Admin SDK. Notes are SUBCOLLECTION documents under
 * `companies/{companyId}/notes/{noteId}` — they are NOT top-level entities, so
 * the client `createNote` writes via `setDoc` directly (no slug, no audit
 * fields beyond `createdAt`, no entity-factory, no Neo4j sync). The admin twin
 * mirrors that precisely:
 * - same id format (`${type.toLowerCase()}-${Date.now()}`)
 * - same `createdAt: Date.now()` stamp, same full-document write semantics
 * - same `orderBy('createdAt', 'desc')` newest-first read ordering
 * - same return shapes (full `CompanyNote`, array, or null)
 *
 * No graph (Neo4j) sync exists on this path in the client service, so there is
 * deliberately none here — adding one would be a divergence from the source.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import type { CompanyNote } from '@/lib/types';

const log = createLogger('company-notes-admin');

/**
 * Creates a new note for a company. Admin-SDK mirror of `createNote`: same id
 * format (`${type.toLowerCase()}-${Date.now()}`), same `createdAt` stamp, same
 * subcollection write under `companies/{companyId}/notes/{id}`. Returns the
 * fully-materialized `CompanyNote`.
 */
export async function adminCreateNote(
  companyId: string,
  note: Omit<CompanyNote, 'id' | 'companyId' | 'createdAt'>
): Promise<CompanyNote> {
  // Generate ID from type and timestamp — identical to the client service.
  const id = `${note.type.toLowerCase()}-${Date.now()}`;
  const now = Date.now();

  const newNote: CompanyNote = {
    ...note,
    id,
    companyId,
    createdAt: now,
  };

  // Subcollection document under the parent company — no entity-factory, no
  // slug, no Neo4j sync (mirrors the client service's direct setDoc write).
  await db.collection('companies').doc(companyId).collection('notes').doc(id).set(newNote);
  log.info('Created company note (admin)', { companyId, noteId: id, type: note.type });
  return newNote;
}

/**
 * Fetches all notes for a company, newest-first. Admin-SDK mirror of
 * `getNotesByCompanyId`: `orderBy('createdAt', 'desc')` on the
 * `companies/{companyId}/notes` subcollection.
 */
export async function adminGetNotesByCompanyId(companyId: string): Promise<CompanyNote[]> {
  const snap = await db.collection('companies').doc(companyId).collection('notes').orderBy('createdAt', 'desc').get();
  return snap.docs.map((doc) => doc.data() as CompanyNote);
}

/**
 * Fetches a single note by id, or null if not found. Admin-SDK mirror of
 * `getNoteById`.
 */
export async function adminGetNoteById(companyId: string, noteId: string): Promise<CompanyNote | null> {
  const snap = await db.collection('companies').doc(companyId).collection('notes').doc(noteId).get();
  if (!snap.exists) return null;
  return snap.data() as CompanyNote;
}
