'use client';

import * as React from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Plus, Trash2, Loader2, Check, AlertCircle, Edit2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { NotesTabSkeleton } from '../EntitySheetSkeleton';
import { useAutosave, type AutosaveStatus } from '@/hooks/useAutosave';

// ============================================================================
// TYPES
// ============================================================================

export interface Note {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
}

interface NotesTabProps {
  /** Array of notes */
  notes: Note[];
  /** Whether data is loading */
  isLoading?: boolean;
  /** Callback to add a note. When omitted, the add-note form is hidden (read-only). */
  onAddNote?: (content: string) => Promise<void>;
  /** Callback to update a note */
  onUpdateNote?: (id: string, content: string) => Promise<void>;
  /** Callback to delete a note */
  onDeleteNote?: (id: string) => Promise<void>;
  /** Whether in read-only mode */
  readOnly?: boolean;
  /** Placeholder text for new note */
  placeholder?: string;
  /** Enable autosave for note editing */
  enableAutosave?: boolean;
  /** Additional class names */
  className?: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * NotesTab
 *
 * Tab component for managing entity notes.
 * Supports adding, editing, and deleting notes.
 *
 * @example
 * ```tsx
 * <NotesTab
 *   notes={company.notes}
 *   isLoading={isLoading}
 *   onAddNote={handleAddNote}
 *   onDeleteNote={handleDeleteNote}
 * />
 * ```
 */
export function NotesTab({
  notes,
  isLoading = false,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  readOnly = false,
  placeholder = 'Add a note...',
  enableAutosave = false,
  className,
}: NotesTabProps) {
  const [newNote, setNewNote] = React.useState('');
  const [isAdding, setIsAdding] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const handleAddNote = async () => {
    if (!newNote.trim() || !onAddNote) return;

    setIsAdding(true);
    try {
      await onAddNote(newNote.trim());
      setNewNote('');
    } finally {
      setIsAdding(false);
    }
  };

  const handleDeleteNote = async (id: string) => {
    if (!onDeleteNote) return;

    setDeletingId(id);
    try {
      await onDeleteNote(id);
    } finally {
      setDeletingId(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault();
      handleAddNote();
    }
  };

  if (isLoading) {
    return <NotesTabSkeleton className={className} />;
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Add Note Form */}
      {!readOnly && onAddNote && (
        <div className="space-y-2">
          <Textarea
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={3}
            className="resize-none"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Press ⌘+Enter to save</span>
            <Button size="sm" onClick={handleAddNote} disabled={!newNote.trim() || isAdding}>
              {isAdding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Add Note
            </Button>
          </div>
        </div>
      )}

      {/* Notes List */}
      <ScrollArea className="flex-1">
        <div className="space-y-3">
          {notes.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No notes yet. {!readOnly && onAddNote && 'Add your first note above.'}
            </div>
          ) : (
            notes.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                onDelete={onDeleteNote ? () => handleDeleteNote(note.id) : undefined}
                onUpdate={onUpdateNote}
                isDeleting={deletingId === note.id}
                readOnly={readOnly}
                enableAutosave={enableAutosave}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ============================================================================
// NOTE CARD
// ============================================================================

interface NoteCardProps {
  note: Note;
  onDelete?: () => void;
  onUpdate?: (id: string, content: string) => Promise<void>;
  isDeleting?: boolean;
  readOnly?: boolean;
  enableAutosave?: boolean;
}

function NoteCard({ note, onDelete, onUpdate, isDeleting, readOnly, enableAutosave = false }: NoteCardProps) {
  const [isEditing, setIsEditing] = React.useState(false);
  const [editContent, setEditContent] = React.useState(note.content);

  // Autosave for edit mode
  const { status: autosaveStatus } = useAutosave({
    data: editContent,
    onSave: async (content) => {
      if (onUpdate && content !== note.content) {
        await onUpdate(note.id, content);
      }
    },
    debounceMs: 2000,
    enabled: enableAutosave && isEditing && !!onUpdate,
  });

  const handleStartEdit = () => {
    setEditContent(note.content);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setEditContent(note.content);
    setIsEditing(false);
  };

  const handleSaveEdit = async () => {
    if (onUpdate && editContent.trim() !== note.content) {
      try {
        await onUpdate(note.id, editContent.trim());
      } catch {
        // Handler already surfaced the error (toast). Keep the editor open so
        // the user's text isn't lost — and keep the rejection from escaping
        // the click handler as an unhandled promise rejection.
        return;
      }
    }
    setIsEditing(false);
  };

  return (
    <div className="group rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-2">
          {/* Note content */}
          {isEditing ? (
            <div className="space-y-2">
              <Textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={3}
                className="resize-none"
                autoFocus
              />
              {enableAutosave && <AutosaveIndicator status={autosaveStatus} />}
              {!enableAutosave && (
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={handleCancelEdit}>
                    <X className="mr-1 h-3 w-3" />
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleSaveEdit}>
                    <Check className="mr-1 h-3 w-3" />
                    Save
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm">{note.content}</p>
          )}

          {/* Metadata */}
          {!isEditing && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{formatDistanceToNow(note.createdAt, { addSuffix: true })}</span>
              {note.updatedAt > note.createdAt && (
                <>
                  <span>·</span>
                  <span>edited</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        {!readOnly && !isEditing && (
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {onUpdate && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleStartEdit}
                aria-label={`Edit note from ${formatDistanceToNow(note.createdAt, { addSuffix: true })}`}
              >
                <Edit2 className="h-4 w-4 text-muted-foreground hover:text-foreground" />
              </Button>
            )}
            {onDelete && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={onDelete}
                disabled={isDeleting}
                aria-label={`Delete note from ${formatDistanceToNow(note.createdAt, { addSuffix: true })}`}
              >
                {isDeleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                )}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// AUTOSAVE INDICATOR
// ============================================================================

function AutosaveIndicator({ status }: { status: AutosaveStatus }) {
  if (status === 'idle') return null;

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {status === 'saving' && (
        <>
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Saving...</span>
        </>
      )}
      {status === 'saved' && (
        <>
          <Check className="h-3 w-3 text-green-500" />
          <span>Saved</span>
        </>
      )}
      {status === 'error' && (
        <>
          <AlertCircle className="h-3 w-3 text-destructive" />
          <span>Failed to save</span>
        </>
      )}
    </div>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { NotesTabProps };
