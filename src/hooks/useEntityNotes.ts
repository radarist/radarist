/**
 * @file useEntityNotes.ts
 * @description Shared notes state + handlers for library pages whose sheets
 * render the shared `NotesTab` (UX-002/003/004: prototypes, use cases,
 * strategies).
 *
 * Mirrors the proven company-notes wiring in `useCompaniesPage` — load on
 * entity selection, optimistic-enough local updates from committed values,
 * toast + rethrow on failure (NotesTab uses the rejection to surface its
 * autosave error state) — generalized over `entity-notes.ts`.
 */

import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  getEntityNotes,
  createEntityNote,
  updateEntityNote,
  deleteEntityNote,
  type NotesParentCollection,
} from '@/lib/entity-notes';
import type { Note as SheetNote } from '@/components/sheets/tabs';
import { createLogger } from '@/lib/logger';

const log = createLogger('use-entity-notes');

export interface UseEntityNotesResult {
  /** Notes for the selected entity, newest first ([] while none / unloaded). */
  notes: SheetNote[];
  /** Handlers in the exact optional shapes the entity sheets expect;
   * undefined while no entity is selected (sheets treat that as read-only). */
  onAddNote?: (content: string) => Promise<void>;
  onUpdateNote?: (id: string, content: string) => Promise<void>;
  onDeleteNote?: (id: string) => Promise<void>;
}

/**
 * Notes state + persistence handlers for the selected entity.
 *
 * @param parent - Parent Firestore collection ('prototypes' | 'use-cases' | 'strategies')
 * @param entityId - Selected entity id, or undefined when nothing is selected
 */
export function useEntityNotes(parent: NotesParentCollection, entityId: string | undefined): UseEntityNotesResult {
  const { toast } = useToast();
  const { user } = useAuth();
  const [notesByEntity, setNotesByEntity] = useState<Record<string, SheetNote[]>>({});

  const loadNotes = useCallback(
    async (id: string) => {
      try {
        const notes = await getEntityNotes(parent, id);
        setNotesByEntity((prev) => ({
          ...prev,
          [id]: notes.map((n) => ({
            id: n.id,
            content: n.content,
            createdAt: n.createdAt,
            updatedAt: n.updatedAt,
            createdBy: n.createdBy,
          })),
        }));
      } catch (error) {
        log.error('Failed to load notes', error instanceof Error ? error : new Error(String(error)), {
          parent,
          entityId: id,
        });
        // A silent failure here rendered a false "No notes yet." — say so.
        toast({
          title: 'Error',
          description: 'Failed to load notes. Close and reopen to retry.',
          variant: 'destructive',
        });
      }
    },
    [parent]
  );

  useEffect(() => {
    if (entityId && !notesByEntity[entityId]) {
      loadNotes(entityId);
    }
  }, [entityId, loadNotes]);

  // Surface the failure (log + toast). Only the UPDATE path rethrows: its
  // consumers handle rejection (useAutosave's error state; NotesTab's
  // manual-save keeps the editor open). Add/delete are fired from plain click
  // handlers with no rejection consumer — rethrowing there escaped as an
  // unhandled promise rejection — so they surface the toast and swallow,
  // matching the proven company-notes wiring in useCompaniesPage.
  const fail = (action: string, error: unknown, extra: Record<string, string>, rethrow: boolean) => {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error(`Failed to ${action} note`, err, { parent, ...extra });
    toast({
      title: 'Error',
      description: `Failed to ${action} note. Please try again.`,
      variant: 'destructive',
    });
    if (rethrow) throw err;
  };

  const historyLoaded = entityId ? Object.prototype.hasOwnProperty.call(notesByEntity, entityId) : false;

  const onAddNote = entityId
    ? async (content: string) => {
        try {
          const created = await createEntityNote(parent, entityId, content, user?.uid);
          if (!historyLoaded) {
            // The initial read failed (or never ran) — prepending onto an empty
            // list would present ONLY the new note as the complete history.
            // Re-fetch the authoritative list (which now includes the new note).
            await loadNotes(entityId);
            return;
          }
          setNotesByEntity((prev) => ({
            ...prev,
            [entityId]: [
              {
                id: created.id,
                content: created.content,
                createdAt: created.createdAt,
                updatedAt: created.updatedAt,
                createdBy: created.createdBy,
              },
              ...(prev[entityId] ?? []),
            ],
          }));
        } catch (error) {
          fail('add', error, { entityId }, false);
        }
      }
    : undefined;

  const onUpdateNote = entityId
    ? async (noteId: string, content: string) => {
        try {
          const { updatedAt } = await updateEntityNote(parent, entityId, noteId, content);
          setNotesByEntity((prev) => ({
            ...prev,
            [entityId]: (prev[entityId] ?? []).map((n) => (n.id === noteId ? { ...n, content, updatedAt } : n)),
          }));
        } catch (error) {
          fail('update', error, { entityId, noteId }, true);
        }
      }
    : undefined;

  const onDeleteNote = entityId
    ? async (noteId: string) => {
        try {
          await deleteEntityNote(parent, entityId, noteId);
          setNotesByEntity((prev) => ({
            ...prev,
            [entityId]: (prev[entityId] ?? []).filter((n) => n.id !== noteId),
          }));
        } catch (error) {
          fail('delete', error, { entityId, noteId }, false);
        }
      }
    : undefined;

  return {
    notes: entityId ? (notesByEntity[entityId] ?? []) : [],
    onAddNote,
    onUpdateNote,
    onDeleteNote,
  };
}
