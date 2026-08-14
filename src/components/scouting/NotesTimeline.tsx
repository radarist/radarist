/**
 * @file NotesTimeline.tsx
 * @description Timeline component for displaying and managing company notes/interactions.
 *
 * This component shows a chronological timeline of all interactions with a company,
 * including meetings, emails, demos, evaluations, and general notes. Supports markdown.
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Calendar, Mail, Video, FileCheck, MessageSquare, Edit, Trash2 } from 'lucide-react';
import type { CompanyNote, NoteType } from '@/lib/types';
import { getNotesByCompanyId, createNote, updateNote, deleteNote } from '@/lib/company-notes';
import { NOTE_TYPES } from '@/lib/scouting-constants';
import { useToast } from '@/hooks/use-toast';
import { formatDistanceToNow } from 'date-fns';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/NotesTimeline');

interface NotesTimelineProps {
  /** Company ID */
  companyId: string;
}

/**
 * Gets the icon component for a note type.
 */
const getNoteIcon = (type: NoteType) => {
  const icons = {
    Meeting: Calendar,
    Email: Mail,
    Demo: Video,
    Evaluation: FileCheck,
    General: MessageSquare,
  };
  return icons[type] || MessageSquare;
};

/**
 * Gets the color class for a note type badge.
 */
const getNoteTypeColor = (type: NoteType): string => {
  const colors: Record<NoteType, string> = {
    Meeting: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
    Email: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
    Demo: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
    Evaluation: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
    General: 'bg-muted text-foreground',
  };
  return colors[type];
};

/**
 * NotesTimeline component.
 * Displays all notes for a company in chronological order.
 *
 * @param props - Component props
 * @returns The rendered notes timeline
 */
export function NotesTimeline({ companyId }: NotesTimelineProps) {
  const [notes, setNotes] = useState<CompanyNote[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<CompanyNote | null>(null);
  const [noteContent, setNoteContent] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('General');
  const { toast } = useToast();

  /**
   * Loads notes from Firestore.
   */
  const loadNotes = async () => {
    setIsLoading(true);
    try {
      const data = await getNotesByCompanyId(companyId);
      setNotes(data);
    } catch (error) {
      log.error('Failed to load notes', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to load notes.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadNotes();
  }, [companyId]);

  /**
   * Opens the dialog for adding a new note.
   */
  const handleAddNote = () => {
    setEditingNote(null);
    setNoteContent('');
    setNoteType('General');
    setIsDialogOpen(true);
  };

  /**
   * Opens the dialog for editing an existing note.
   */
  const handleEditNote = (note: CompanyNote) => {
    setEditingNote(note);
    setNoteContent(note.content);
    setNoteType(note.type);
    setIsDialogOpen(true);
  };

  /**
   * Handles form submission (create or update).
   */
  const handleSubmit = async () => {
    if (!noteContent.trim()) {
      toast({
        title: 'Validation Error',
        description: 'Note content is required.',
        variant: 'destructive',
      });
      return;
    }

    try {
      if (editingNote) {
        await updateNote(companyId, editingNote.id, {
          content: noteContent,
          type: noteType,
        });
        toast({ title: 'Note Updated', description: 'Note has been updated successfully.' });
      } else {
        await createNote(companyId, {
          content: noteContent,
          type: noteType,
        });
        toast({ title: 'Note Added', description: 'Note has been added successfully.' });
      }
      setIsDialogOpen(false);
      loadNotes();
    } catch (error) {
      log.error('Failed to save note', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to save note.',
        variant: 'destructive',
      });
    }
  };

  /**
   * Handles note deletion.
   */
  const handleDelete = async (noteId: string) => {
    if (!confirm('Are you sure you want to delete this note?')) return;

    try {
      await deleteNote(companyId, noteId);
      toast({ title: 'Note Deleted', description: 'Note has been removed successfully.' });
      loadNotes();
    } catch (error) {
      log.error('Failed to delete note', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to delete note.',
        variant: 'destructive',
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {notes.length} {notes.length === 1 ? 'note' : 'notes'}
        </p>
        <Button onClick={handleAddNote} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Add Note
        </Button>
      </div>

      {notes.length === 0 ? (
        <Card className="p-8 text-center">
          <MessageSquare className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-muted-foreground mb-4">No notes yet</p>
          <Button onClick={handleAddNote} variant="outline">
            <Plus className="h-4 w-4 mr-2" />
            Add First Note
          </Button>
        </Card>
      ) : (
        <div className="space-y-4">
          {/* Timeline */}
          <div className="relative space-y-4 before:absolute before:left-[15px] before:top-2 before:h-[calc(100%-1rem)] before:w-0.5 before:bg-border">
            {notes.map((note, _index) => {
              const Icon = getNoteIcon(note.type);
              return (
                <div key={note.id} className="relative pl-10">
                  {/* Timeline dot */}
                  <div className="absolute left-0 top-2 h-8 w-8 rounded-full bg-background border-2 border-primary flex items-center justify-center">
                    <Icon className="h-4 w-4 text-primary" />
                  </div>

                  <Card className="p-4">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Badge className={getNoteTypeColor(note.type)}>{note.type}</Badge>
                        <span className="text-sm text-muted-foreground">
                          {formatDistanceToNow(note.createdAt, { addSuffix: true })}
                        </span>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEditNote(note)}
                          aria-label={`Edit ${note.type} note`}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(note.id)}
                          aria-label={`Delete ${note.type} note`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="text-sm whitespace-pre-wrap text-muted-foreground">{note.content}</div>
                  </Card>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Note Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingNote ? 'Edit Note' : 'Add New Note'}</DialogTitle>
            <DialogDescription>
              {editingNote ? 'Update the note content or type' : 'Record a new interaction or observation'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="note-type">Type</Label>
              <Select value={noteType} onValueChange={(value) => setNoteType(value as NoteType)}>
                <SelectTrigger id="note-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTE_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="note-content">Note *</Label>
              <Textarea
                id="note-content"
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                placeholder="Enter your note here... (markdown supported)"
                rows={6}
              />
              <p className="text-xs text-muted-foreground mt-1">Markdown formatting is supported</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit}>{editingNote ? 'Update' : 'Add'} Note</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
