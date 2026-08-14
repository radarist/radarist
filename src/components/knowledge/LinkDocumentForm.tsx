/**
 * @file components/knowledge/LinkDocumentForm.tsx
 * @description Form for creating entity-document links
 *
 * Features:
 * - Document search and selection
 * - Relationship type selection
 * - Relevance level selection
 * - Tags and notes
 * - Validation with Zod
 *
 * @phase Knowledge Tab Sprint - Phase 2
 * @author Radarist Team
 * @created 2026-01-14
 */

'use client';

import { useState, useCallback, useMemo } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { FileText, Link2, Loader2, Search, CheckCircle2, Tag, X, Plus, Globe, FileIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/LinkDocumentForm');
import { getDocuments } from '@/lib/document-service';
import { createEntityDocumentLink } from '@/lib/entity-document-link-service';
import { describeEntityDocumentLinkGraphHandoff } from '@/lib/entity-document-link-handoff';
import {
  DOCUMENT_RELATIONSHIP_TYPE_LABELS,
  DOCUMENT_RELEVANCE_LABELS,
  DOCUMENT_RELEVANCE_COLORS,
} from '@/lib/schemas/entity-document-link';
import { documentKeys, entityDocumentLinkKeys } from '@/lib/query-keys';
import type { TransformationEntityType, DocumentRelationshipType, DocumentRelevance, Document } from '@/lib/types';

// ============================================================================
// TYPES
// ============================================================================

interface LinkDocumentFormProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: TransformationEntityType;
  entityId: string;
  entityName: string;
  /** Optional pre-selected document */
  preselectedDocument?: Document;
  /** Callback when link is created */
  onLinkCreated?: () => void;
}

// ============================================================================
// SCHEMA
// ============================================================================

const linkDocumentFormSchema = z.object({
  documentId: z.string().min(1, 'Please select a document'),
  relationshipType: z.enum([
    'documentation',
    'pitch_deck',
    'technical_spec',
    'case_study',
    'research_paper',
    'competitive_intel',
    'contract',
    'evidence',
    'other',
  ] as const),
  relevance: z.enum(['high', 'medium', 'low'] as const),
  tags: z.array(z.string()).default([]),
  note: z.string().optional(),
});

type LinkDocumentFormValues = z.infer<typeof linkDocumentFormSchema>;

// ============================================================================
// CONSTANTS
// ============================================================================

const DOCUMENT_TYPE_ICONS: Record<string, typeof FileText> = {
  pdf: FileIcon,
  docx: FileText,
  pptx: FileText,
  url: Globe,
  transcript: FileText,
  markdown: FileText,
  text: FileText,
};

// ============================================================================
// COMPONENT
// ============================================================================

export function LinkDocumentForm({
  isOpen,
  onOpenChange,
  entityType,
  entityId,
  entityName,
  preselectedDocument,
  onLinkCreated,
}: LinkDocumentFormProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Debug logging
  log.debug('Render state', { isOpen, entityType, entityId, entityName });

  const [searchQuery, setSearchQuery] = useState('');
  const [tagInput, setTagInput] = useState('');

  // Fetch documents
  const { data: documents, isLoading: isLoadingDocuments } = useQuery({
    queryKey: documentKeys.list({ status: 'processed' }),
    queryFn: () => getDocuments({ status: 'processed', limit: 100 }),
    enabled: isOpen,
  });

  // Filter documents by search
  const filteredDocuments = useMemo(() => {
    if (!documents) return [];
    if (!searchQuery) return documents;

    const query = searchQuery.toLowerCase();
    return documents.filter(
      (doc) =>
        doc.title.toLowerCase().includes(query) ||
        doc.description?.toLowerCase().includes(query) ||
        doc.domain?.toLowerCase().includes(query)
    );
  }, [documents, searchQuery]);

  // Form setup
  const form = useForm<LinkDocumentFormValues>({
    resolver: zodResolver(linkDocumentFormSchema),
    defaultValues: {
      documentId: preselectedDocument?.id || '',
      relationshipType: 'documentation',
      relevance: 'medium',
      tags: [],
      note: '',
    },
  });

  const selectedDocumentId = form.watch('documentId');
  const _selectedDocument = documents?.find((d) => d.id === selectedDocumentId);
  const tags = form.watch('tags');

  // Create link mutation
  const createLinkMutation = useMutation({
    mutationFn: (values: LinkDocumentFormValues) =>
      createEntityDocumentLink({
        entityType,
        entityId,
        documentId: values.documentId,
        relationshipType: values.relationshipType,
        relevance: values.relevance,
        tags: values.tags,
        note: values.note || undefined,
        createdBy: user?.uid || 'anonymous',
        workspaceId: 'default',
      }),
    onSuccess: ({ graphHandoff }) => {
      queryClient.invalidateQueries({
        queryKey: entityDocumentLinkKeys.byEntity(entityType, entityId),
      });
      queryClient.invalidateQueries({
        queryKey: documentKeys.detail(selectedDocumentId),
      });

      // GRAPH-069: the link is saved either way, but "Successfully linked" used
      // to be shown even when the graph handoff had silently failed. Say which.
      toast(
        graphHandoff.status === 'acknowledged'
          ? { title: 'Document linked', description: `Successfully linked document to ${entityName}` }
          : {
              title: 'Document linked — graph sync pending',
              description: `Saved to ${entityName}. ${describeEntityDocumentLinkGraphHandoff(graphHandoff)}`,
            }
      );

      onLinkCreated?.();
      handleClose();
    },
    onError: (error) => {
      log.error('Failed to create link', error instanceof Error ? error : undefined);

      const message =
        error instanceof Error && error.message.includes('already exists')
          ? 'This document is already linked to this entity'
          : 'Failed to create link. Please try again.';

      toast({
        title: 'Link failed',
        description: message,
        variant: 'destructive',
      });
    },
  });

  // Handle form submission
  const onSubmit = useCallback(
    (values: LinkDocumentFormValues) => {
      createLinkMutation.mutate(values);
    },
    [createLinkMutation]
  );

  // Handle tag addition
  const handleAddTag = useCallback(() => {
    const trimmed = tagInput.trim();
    if (trimmed && !tags.includes(trimmed)) {
      form.setValue('tags', [...tags, trimmed]);
      setTagInput('');
    }
  }, [tagInput, tags, form]);

  // Handle tag removal
  const handleRemoveTag = useCallback(
    (tagToRemove: string) => {
      form.setValue(
        'tags',
        tags.filter((t) => t !== tagToRemove)
      );
    },
    [tags, form]
  );

  // Handle open/close state changes
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        // Only reset state when closing
        form.reset();
        setSearchQuery('');
        setTagInput('');
      }
      onOpenChange(open);
    },
    [form, onOpenChange]
  );

  // Simple close helper
  const handleClose = useCallback(() => {
    handleOpenChange(false);
  }, [handleOpenChange]);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            Link Document
          </DialogTitle>
          <DialogDescription>
            Link a document to <span className="font-medium">{entityName}</span>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex-1 flex flex-col min-h-0">
          {/*
            UX-023 shape, applied here too: the dialog is bounded at 85vh, but the
            form body (document list + type/relevance/tags/note) had no scroll
            container, so on a short viewport it grew past the dialog and pushed
            the footer out of the viewport entirely — Playwright reported the
            submit button as "visible, enabled and stable" yet "outside of the
            viewport" on every scroll attempt, and an operator simply could not
            reach Link Document. The body scrolls; the footer stays pinned.
          */}
          <div className="flex-1 min-h-0 overflow-y-auto pr-1">
            {/* Document Selection */}
            <div className="space-y-3 mb-4">
              <Label>Select Document</Label>

              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search documents..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>

              {/* Document List */}
              <ScrollArea className="h-48 border rounded-lg">
                {isLoadingDocuments ? (
                  <div className="p-3 space-y-2">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                  </div>
                ) : filteredDocuments.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground">
                    {searchQuery ? 'No documents match your search' : 'No processed documents available'}
                  </div>
                ) : (
                  <div className="p-1">
                    {filteredDocuments.map((doc) => {
                      const Icon = DOCUMENT_TYPE_ICONS[doc.type] || FileText;
                      const isSelected = selectedDocumentId === doc.id;

                      return (
                        <button
                          key={doc.id}
                          type="button"
                          onClick={() => form.setValue('documentId', doc.id)}
                          className={cn(
                            'w-full flex items-center gap-3 p-3 rounded-md text-left transition-colors',
                            'hover:bg-muted/50',
                            isSelected && 'bg-primary/10 border border-primary/30'
                          )}
                        >
                          <Icon className="h-5 w-5 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate">{doc.title}</div>
                            <div className="text-xs text-muted-foreground flex items-center gap-2">
                              <span className="uppercase">{doc.type}</span>
                              {doc.domain && (
                                <>
                                  <span>•</span>
                                  <span className="truncate">{doc.domain}</span>
                                </>
                              )}
                            </div>
                          </div>
                          {isSelected && <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>

              {form.formState.errors.documentId && (
                <p className="text-sm text-destructive">{form.formState.errors.documentId.message}</p>
              )}
            </div>

            {/* Relationship Type & Relevance */}
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="space-y-2">
                <Label htmlFor="relationshipType">Relationship Type</Label>
                <Select
                  value={form.watch('relationshipType')}
                  onValueChange={(value) => form.setValue('relationshipType', value as DocumentRelationshipType)}
                >
                  <SelectTrigger id="relationshipType">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(DOCUMENT_RELATIONSHIP_TYPE_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="relevance">Relevance</Label>
                <Select
                  value={form.watch('relevance')}
                  onValueChange={(value) => form.setValue('relevance', value as DocumentRelevance)}
                >
                  <SelectTrigger id="relevance">
                    <SelectValue placeholder="Select relevance" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(DOCUMENT_RELEVANCE_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        <span className={DOCUMENT_RELEVANCE_COLORS[value as DocumentRelevance]}>{label}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Tags */}
            <div className="space-y-2 mb-4">
              <Label>Tags</Label>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Tag className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Add a tag..."
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddTag();
                      }
                    }}
                    className="pl-9"
                  />
                </div>
                <Button type="button" variant="outline" size="icon" onClick={handleAddTag} disabled={!tagInput.trim()}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="gap-1">
                      {tag}
                      <button type="button" onClick={() => handleRemoveTag(tag)} className="hover:text-destructive">
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Note */}
            <div className="space-y-2 mb-4">
              <Label htmlFor="note">Note (optional)</Label>
              <Textarea
                id="note"
                placeholder="Add context about this link..."
                {...form.register('note')}
                className="resize-none"
                rows={2}
              />
            </div>
          </div>

          {/* Footer */}
          <DialogFooter className="shrink-0 pt-4 border-t">
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={createLinkMutation.isPending || !selectedDocumentId}>
              {createLinkMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Linking...
                </>
              ) : (
                <>
                  <Link2 className="h-4 w-4 mr-2" />
                  Link Document
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
