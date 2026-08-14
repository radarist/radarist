/**
 * @file components/knowledge/LinkEntityForm.tsx
 * @description Form for linking a document to entities (inverse of LinkDocumentForm)
 *
 * Features:
 * - Entity type selection
 * - Entity search and selection
 * - Relationship type selection
 * - Relevance level selection
 * - Tags and notes
 * - Validation with Zod
 *
 * @phase Knowledge Tab Sprint - Phase 2
 * @author Radarist Team
 * @created 2026-01-17
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Building2,
  Cpu,
  Target,
  Lightbulb,
  Workflow,
  Radio,
  AlertCircle,
  FileText,
  Link2,
  Loader2,
  Search,
  CheckCircle2,
  Tag,
  X,
  Plus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/LinkEntityForm');
import { createEntityDocumentLink } from '@/lib/entity-document-link-service';
import { describeEntityDocumentLinkGraphHandoff } from '@/lib/entity-document-link-handoff';
import {
  DOCUMENT_RELATIONSHIP_TYPE_LABELS,
  DOCUMENT_RELEVANCE_LABELS,
  DOCUMENT_RELEVANCE_COLORS,
} from '@/lib/schemas/entity-document-link';
import { entityDocumentLinkKeys, documentKeys } from '@/lib/query-keys';

// Entity fetchers
import { getCompanies } from '@/lib/companies';
import { getTechnologies } from '@/lib/technology-service';
import { getUseCases } from '@/lib/use-cases';
import { getStrategies } from '@/lib/strategies';
import { getPrototypes } from '@/lib/prototypes';
import { getSignals } from '@/lib/signals';
import { getOrgUnits } from '@/lib/org-units';
import { getInitiatives } from '@/lib/initiatives';
import { getPainPoints } from '@/lib/pain-points';
import { getDocuments } from '@/lib/document-service';

import type {
  TransformationEntityType,
  DocumentRelationshipType,
  DocumentRelevance,
} from '@/lib/types';

// ============================================================================
// TYPES
// ============================================================================

interface LinkEntityFormProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  documentId: string;
  documentTitle: string;
  /** Callback when link is created */
  onLinkCreated?: () => void;
}

interface EntityOption {
  id: string;
  name: string;
  description?: string;
}

// ============================================================================
// SCHEMA
// ============================================================================

const linkEntityFormSchema = z.object({
  entityType: z.enum([
    'technology',
    'company',
    'useCase',
    'strategy',
    'prototype',
    'signal',
    'org_unit',
    'initiative',
    'pain_point',
    'document',
  ] as const),
  entityId: z.string().min(1, 'Please select an entity'),
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

type LinkEntityFormValues = z.infer<typeof linkEntityFormSchema>;

// ============================================================================
// CONSTANTS
// ============================================================================

const ENTITY_TYPE_CONFIG: Record<
  TransformationEntityType,
  {
    label: string;
    icon: typeof Building2;
    color: string;
  }
> = {
  technology: { label: 'Technology', icon: Cpu, color: 'text-emerald-500' },
  company: { label: 'Company', icon: Building2, color: 'text-blue-500' },
  useCase: { label: 'Use Case', icon: Target, color: 'text-yellow-500' },
  strategy: { label: 'Strategy', icon: Workflow, color: 'text-purple-500' },
  prototype: { label: 'Prototype', icon: Lightbulb, color: 'text-green-500' },
  signal: { label: 'Signal', icon: Radio, color: 'text-orange-500' },
  org_unit: { label: 'Org Unit', icon: Building2, color: 'text-slate-500' },
  initiative: { label: 'Initiative', icon: Target, color: 'text-cyan-500' },
  pain_point: { label: 'Pain Point', icon: AlertCircle, color: 'text-red-500' },
  document: { label: 'Document', icon: FileText, color: 'text-muted-foreground' },
};

// ============================================================================
// ENTITY FETCHING HOOK
// ============================================================================

function useEntityOptions(entityType: TransformationEntityType | null) {
  return useQuery({
    queryKey: ['entities', entityType],
    queryFn: async (): Promise<EntityOption[]> => {
      if (!entityType) return [];

      switch (entityType) {
        case 'company': {
          const companies = await getCompanies();
          return companies.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
          }));
        }
        case 'technology': {
          // Uses technology-service.ts which returns Technology[] with unique tech-xxx IDs
          const technologies = await getTechnologies();
          return technologies.map((t) => ({
            id: t.id,  // Format: "tech-xxx" - canonical unique ID
            name: t.name,
            description: t.description,
          }));
        }
        case 'useCase': {
          const useCases = await getUseCases();
          return useCases.map((u) => ({
            id: u.id,
            name: u.title,
            description: u.description,
          }));
        }
        case 'strategy': {
          const strategies = await getStrategies();
          return strategies.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
          }));
        }
        case 'prototype': {
          const prototypes = await getPrototypes();
          return prototypes.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
          }));
        }
        case 'signal': {
          const signals = await getSignals();
          return signals.map((s) => ({
            id: s.id,
            name: s.title,
            description: s.description,
          }));
        }
        case 'org_unit': {
          const orgUnits = await getOrgUnits();
          return orgUnits.map((o) => ({
            id: o.id,
            name: o.name,
            description: o.description,
          }));
        }
        case 'initiative': {
          const initiatives = await getInitiatives();
          return initiatives.map((i) => ({
            id: i.id,
            name: i.name,
            description: i.description,
          }));
        }
        case 'pain_point': {
          const painPoints = await getPainPoints();
          return painPoints.map((p) => ({
            id: p.id,
            name: p.title,
            description: p.description,
          }));
        }
        case 'document': {
          const documents = await getDocuments({ status: 'processed', limit: 100 });
          return documents.map((d) => ({
            id: d.id,
            name: d.title,
            description: d.description,
          }));
        }
        default:
          return [];
      }
    },
    enabled: !!entityType,
    staleTime: 30000, // Cache for 30 seconds
  });
}

// ============================================================================
// COMPONENT
// ============================================================================

export function LinkEntityForm({
  isOpen,
  onOpenChange,
  documentId,
  documentTitle,
  onLinkCreated,
}: LinkEntityFormProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [searchQuery, setSearchQuery] = useState('');
  const [tagInput, setTagInput] = useState('');

  // Form setup
  const form = useForm<LinkEntityFormValues>({
    resolver: zodResolver(linkEntityFormSchema),
    defaultValues: {
      entityType: 'company',
      entityId: '',
      relationshipType: 'documentation',
      relevance: 'medium',
      tags: [],
      note: '',
    },
  });

  const selectedEntityType = form.watch('entityType');
  const selectedEntityId = form.watch('entityId');
  const tags = form.watch('tags');

  // Fetch entities based on selected type
  const { data: entities, isLoading: isLoadingEntities } = useEntityOptions(selectedEntityType);

  // Filter entities by search
  const filteredEntities = useMemo(() => {
    if (!entities) return [];
    if (!searchQuery) return entities;

    const query = searchQuery.toLowerCase();
    return entities.filter(
      (entity) =>
        entity.name.toLowerCase().includes(query) ||
        entity.description?.toLowerCase().includes(query)
    );
  }, [entities, searchQuery]);

  const selectedEntity = entities?.find((e) => e.id === selectedEntityId);

  // Create link mutation
  const createLinkMutation = useMutation({
    mutationFn: (values: LinkEntityFormValues) =>
      createEntityDocumentLink({
        entityType: values.entityType,
        entityId: values.entityId,
        documentId,
        relationshipType: values.relationshipType,
        relevance: values.relevance,
        tags: values.tags,
        note: values.note || undefined,
        createdBy: user?.uid || 'anonymous',
        workspaceId: 'default',
      }),
    onSuccess: ({ graphHandoff }) => {
      // Invalidate document links
      queryClient.invalidateQueries({
        queryKey: entityDocumentLinkKeys.byDocument(documentId),
      });
      // Invalidate entity links
      queryClient.invalidateQueries({
        queryKey: entityDocumentLinkKeys.byEntity(selectedEntityType, selectedEntityId),
      });
      // Invalidate document detail (for linkedEntityCount)
      queryClient.invalidateQueries({
        queryKey: documentKeys.detail(documentId),
      });

      // GRAPH-069: the link is saved either way, but "Successfully linked" used
      // to be shown even when the graph handoff had silently failed. Say which.
      const entityLabel = selectedEntity?.name || 'entity';
      toast(
        graphHandoff.status === 'acknowledged'
          ? { title: 'Entity linked', description: `Successfully linked ${entityLabel} to this document` }
          : {
              title: 'Entity linked — graph sync pending',
              description: `Saved ${entityLabel} to this document. ${describeEntityDocumentLinkGraphHandoff(graphHandoff)}`,
            }
      );

      onLinkCreated?.();
      handleClose();
    },
    onError: (error) => {
      log.error('Failed to create link', error instanceof Error ? error : undefined);

      const message =
        error instanceof Error && error.message.includes('already exists')
          ? 'This entity is already linked to this document'
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
    (values: LinkEntityFormValues) => {
      createLinkMutation.mutate(values);
    },
    [createLinkMutation]
  );

  // Handle entity type change - reset entity selection
  const handleEntityTypeChange = useCallback(
    (value: TransformationEntityType) => {
      form.setValue('entityType', value);
      form.setValue('entityId', ''); // Reset entity selection
      setSearchQuery(''); // Reset search
    },
    [form]
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

  // Handle close
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        form.reset();
        setSearchQuery('');
        setTagInput('');
      }
      onOpenChange(open);
    },
    [form, onOpenChange]
  );

  const handleClose = useCallback(() => {
    handleOpenChange(false);
  }, [handleOpenChange]);

  const EntityIcon = ENTITY_TYPE_CONFIG[selectedEntityType]?.icon || Building2;
  const entityColor = ENTITY_TYPE_CONFIG[selectedEntityType]?.color || 'text-muted-foreground';

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            Link Entity
          </DialogTitle>
          <DialogDescription>
            Link an entity to <span className="font-medium">{documentTitle}</span>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex-1 flex flex-col min-h-0">
          {/* Entity Type Selection */}
          <div className="space-y-2 mb-4">
            <Label>Entity Type</Label>
            <Select value={selectedEntityType} onValueChange={handleEntityTypeChange}>
              <SelectTrigger>
                <SelectValue placeholder="Select entity type" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ENTITY_TYPE_CONFIG).map(([type, config]) => {
                  const Icon = config.icon;
                  return (
                    <SelectItem key={type} value={type}>
                      <div className="flex items-center gap-2">
                        <Icon className={cn('h-4 w-4', config.color)} />
                        {config.label}
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Entity Selection */}
          <div className="space-y-3 mb-4">
            <Label>Select {ENTITY_TYPE_CONFIG[selectedEntityType]?.label || 'Entity'}</Label>

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={`Search ${ENTITY_TYPE_CONFIG[selectedEntityType]?.label?.toLowerCase() || 'entities'}...`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            {/* Entity List */}
            <ScrollArea className="h-40 border rounded-lg">
              {isLoadingEntities ? (
                <div className="p-3 space-y-2">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : filteredEntities.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  {searchQuery
                    ? 'No entities match your search'
                    : `No ${ENTITY_TYPE_CONFIG[selectedEntityType]?.label?.toLowerCase() || 'entities'} available`}
                </div>
              ) : (
                <div className="p-1">
                  {filteredEntities.map((entity) => {
                    const isSelected = selectedEntityId === entity.id;

                    return (
                      <button
                        key={`${selectedEntityType}-${entity.id}`}
                        type="button"
                        onClick={() => form.setValue('entityId', entity.id)}
                        className={cn(
                          'w-full flex items-center gap-3 p-3 rounded-md text-left transition-colors',
                          'hover:bg-muted/50',
                          isSelected && 'bg-primary/10 border border-primary/30'
                        )}
                      >
                        <EntityIcon className={cn('h-5 w-5 shrink-0', entityColor)} />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{entity.name}</div>
                          {entity.description && (
                            <div className="text-xs text-muted-foreground truncate">
                              {entity.description}
                            </div>
                          )}
                        </div>
                        {isSelected && (
                          <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </ScrollArea>

            {form.formState.errors.entityId && (
              <p className="text-sm text-destructive">
                {form.formState.errors.entityId.message}
              </p>
            )}
          </div>

          {/* Relationship Type & Relevance */}
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="space-y-2">
              <Label htmlFor="relationshipType">Relationship Type</Label>
              <Select
                value={form.watch('relationshipType')}
                onValueChange={(value) =>
                  form.setValue('relationshipType', value as DocumentRelationshipType)
                }
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
                      <span className={DOCUMENT_RELEVANCE_COLORS[value as DocumentRelevance]}>
                        {label}
                      </span>
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
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleAddTag}
                disabled={!tagInput.trim()}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1">
                    {tag}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      className="hover:text-destructive"
                    >
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

          {/* Footer */}
          <DialogFooter className="mt-auto pt-4 border-t">
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createLinkMutation.isPending || !selectedEntityId}
            >
              {createLinkMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Linking...
                </>
              ) : (
                <>
                  <Link2 className="h-4 w-4 mr-2" />
                  Link Entity
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
