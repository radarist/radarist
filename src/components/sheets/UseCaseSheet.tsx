'use client';

import * as React from 'react';
import { useForm, type DefaultValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Lightbulb,
  Link2,
  MessageSquare,
  AlertCircle,
  CheckCircle2,
  Target,
  Plus,
  X,
  Tag,
  FileText,
} from 'lucide-react';

import { EntitySheetShell } from './EntitySheetShell';
import { EntitySheetTabs, type SheetTab } from './EntitySheetTabs';
import { EntitySheetFooter } from './EntitySheetFooter';
import { EntitySheetSkeleton } from './EntitySheetSkeleton';
import { NotesTab, RelationsTab, KnowledgeTab, type Note } from './tabs';
import { useEntitySearch } from '@/hooks/useEntitySearch';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { cn } from '@/lib/utils';

import type { UseCase, Relation, EntityType, RelationType } from '@/lib/types';

// ============================================================================
// SCHEMA
// ============================================================================

const useCaseFormSchema = z.object({
  title: z.string().min(1, 'Use case title is required'),
  description: z.string().min(1, 'Description is required'),
  problem: z.string().optional(),
  solution: z.string().optional(),
  outcomes: z.array(z.string()),
  status: z.enum(['Proposed', 'In Progress', 'Implemented', 'Archived']),
  category: z.string().optional(),
  tags: z.array(z.string()),
});

type UseCaseFormValues = z.infer<typeof useCaseFormSchema>;

/**
 * Create-mode form defaults. react-hook-form's `reset(values)` (edit mode)
 * replaces the stored defaultValues, so a bare `form.reset()` would restore
 * the last-opened use case's data. Create mode must reset to this constant.
 */
const EMPTY_USE_CASE_FORM_VALUES: DefaultValues<UseCaseFormValues> = {
  title: '',
  description: '',
  problem: '',
  solution: '',
  outcomes: [],
  status: 'Proposed',
  category: '',
  tags: [],
};

// ============================================================================
// CONSTANTS
// ============================================================================

type UseCaseStatus = 'Proposed' | 'In Progress' | 'Implemented' | 'Archived';

const USE_CASE_STATUSES: UseCaseStatus[] = ['Proposed', 'In Progress', 'Implemented', 'Archived'];

const STATUS_COLORS: Record<UseCaseStatus, string> = {
  Proposed: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30',
  'In Progress': 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  Implemented: 'bg-green-500/10 text-green-600 border-green-500/30',
  Archived: 'bg-muted text-muted-foreground border-border',
};

const COMMON_CATEGORIES = [
  'Cost Optimization',
  'Revenue Growth',
  'Customer Experience',
  'Operational Efficiency',
  'Risk Management',
  'Innovation',
  'Sustainability',
  'Compliance',
];

// ============================================================================
// TYPES
// ============================================================================

interface UseCaseSheetProps {
  /** Controlled open state */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Use case data for edit mode (undefined for create mode) */
  useCase?: UseCase;
  /** Loading state */
  isLoading?: boolean;
  /** Callback on save */
  onSave: (data: UseCaseFormValues) => Promise<void>;
  /** Callback on delete */
  onDelete?: () => Promise<void>;
  /** Relations for the use case */
  relations?: Relation[];
  /** Notes for the use case */
  notes?: Note[];
  /** Callback to add a note */
  onAddNote?: (content: string) => Promise<void>;
  /** Callback to update a note's content */
  onUpdateNote?: (id: string, content: string) => Promise<void>;
  /** Callback to delete a note */
  onDeleteNote?: (id: string) => Promise<void>;
  /** Callback to add a relation */
  onAddRelation?: (targetId: string, targetType: EntityType, relationType: RelationType) => Promise<void>;
  /** Callback to remove a relation */
  onRemoveRelation?: (relationId: string) => Promise<void>;
  /** Callback when clicking on a related entity */
  onEntityClick?: (entityId: string, entityType: EntityType) => void;
  // ========== Phase 4: Evidence Tab Props ==========
  /** Claims data for this use case */
  claims?: import('@/lib/graph/types').EntityClaims;
  /** Loading state for claims */
  isLoadingClaims?: boolean;
  /** Error when fetching claims */
  claimsError?: string;
  /** Callback to refresh claims */
  onRefreshClaims?: () => Promise<void>;
  /** Callback to curate (approve/reject) a claim */
  onCurateClaim?: (claimId: string, action: 'approve' | 'reject') => Promise<void>;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * UseCaseSheet
 *
 * Sheet component for creating and editing use cases.
 * Includes tabs for Overview, Problem/Solution, Relations, and Notes.
 *
 * @example
 * ```tsx
 * <UseCaseSheet
 *   open={isOpen}
 *   onOpenChange={setIsOpen}
 *   useCase={selectedUseCase}
 *   onSave={handleSave}
 *   relations={useCaseRelations}
 * />
 * ```
 */
export function UseCaseSheet({
  open,
  onOpenChange,
  useCase,
  isLoading = false,
  onSave,
  onDelete,
  relations = [],
  notes = [],
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onAddRelation,
  onRemoveRelation,
  onEntityClick,
  // Phase 4: Evidence props
  claims,
  isLoadingClaims,
  claimsError: _claimsError,
  onRefreshClaims,
  onCurateClaim,
}: UseCaseSheetProps) {
  const [activeTab, setActiveTab] = React.useState('overview');

  // Reset to Overview whenever the sheet's subject changes (another entity or
  // create mode) — the mounted instance otherwise keeps the previous session's
  // tab, so "New Use Case" could open on a non-Overview tab.
  const subjectId = useCase?.id;
  React.useEffect(() => {
    setActiveTab('overview');
  }, [subjectId]);

  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const { searchEntities } = useEntitySearch();

  const isEditMode = !!useCase;

  const form = useForm<UseCaseFormValues>({
    resolver: zodResolver(useCaseFormSchema),
    mode: 'onChange', // Validate on change so isValid updates in real-time
    defaultValues: EMPTY_USE_CASE_FORM_VALUES,
  });

  // Reset form when useCase changes
  React.useEffect(() => {
    if (useCase) {
      form.reset({
        title: useCase.title,
        description: useCase.description,
        problem: useCase.problem || '',
        solution: useCase.solution || '',
        outcomes: useCase.outcomes || [],
        status: useCase.status,
        category: useCase.category || '',
        tags: useCase.tags || [],
      });
    } else {
      // Create mode: reset to the explicit empty defaults — a bare `reset()`
      // would restore the last-opened use case's data (see constant docs).
      form.reset(EMPTY_USE_CASE_FORM_VALUES);
    }
  }, [useCase, form]);

  const handleSave = async (data: UseCaseFormValues) => {
    setIsSaving(true);
    try {
      await onSave(data);
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    setIsDeleting(true);
    try {
      await onDelete();
      onOpenChange(false);
    } finally {
      setIsDeleting(false);
    }
  };

  const tabs: SheetTab[] = [
    {
      id: 'overview',
      label: 'Overview',
      icon: Lightbulb,
      content: <OverviewTab form={form} />,
    },
    {
      id: 'problem-solution',
      label: 'Problem & Solution',
      icon: Target,
      content: <ProblemSolutionTab form={form} />,
    },
    {
      id: 'relations',
      label: 'Relations',
      icon: Link2,
      badge: relations.length || undefined,
      content: useCase ? (
        <RelationsTab
          entityId={useCase.id}
          entityName={useCase.title}
          entityType="useCase"
          relations={relations}
          isLoading={isLoading}
          onAddRelation={onAddRelation}
          onRemoveRelation={onRemoveRelation}
          onEntityClick={onEntityClick}
          onSearchEntities={searchEntities}
        />
      ) : (
        <CreateModeNotice feature="relations" />
      ),
      disabled: !isEditMode,
    },
    {
      id: 'notes',
      label: 'Notes',
      icon: MessageSquare,
      badge: notes.length || undefined,
      content: useCase ? (
        <NotesTab
          notes={notes}
          isLoading={isLoading}
          onAddNote={onAddNote}
          onUpdateNote={onUpdateNote}
          onDeleteNote={onDeleteNote}
          placeholder="Add a note about this use case..."
        />
      ) : (
        <CreateModeNotice feature="notes" />
      ),
      disabled: !isEditMode,
    },
    {
      id: 'knowledge',
      label: 'Knowledge',
      icon: FileText,
      badge: claims?.totalCount || undefined,
      content: useCase ? (
        <KnowledgeTab
          entityType="useCase"
          entityId={useCase.id}
          entityName={useCase.title}
          claims={claims}
          claimsLoading={isLoadingClaims}
          onRefreshClaims={onRefreshClaims}
          onEntityClick={onEntityClick}
          onCurateClaim={onCurateClaim}
        />
      ) : (
        <CreateModeNotice feature="knowledge" />
      ),
      disabled: !isEditMode,
    },
  ];

  return (
    <EntitySheetShell
      title={isEditMode ? useCase.title : 'New Use Case'}
      entityType="useCase"
      entityId={isEditMode ? useCase.id : undefined}
      open={open}
      onOpenChange={onOpenChange}
      subtitle={
        isEditMode ? `${useCase.status}${useCase.category ? ` · ${useCase.category}` : ''}` : 'Create a new use case'
      }
      width="lg"
      aiContext={{
        description: form.watch('description'),
        existingRelations: relations.map((r) =>
          r.sourceSnapshot.id === useCase?.id ? r.targetSnapshot.name : r.sourceSnapshot.name
        ),
      }}
      footer={
        <EntitySheetFooter
          mode={isEditMode ? 'edit' : 'create'}
          onCancel={() => onOpenChange(false)}
          onSave={form.handleSubmit(handleSave)}
          onDelete={isEditMode && onDelete ? handleDelete : undefined}
          isSaving={isSaving}
          isDeleting={isDeleting}
          isDirty={form.formState.isDirty}
          isValid={form.formState.isValid}
          entityName={isEditMode ? useCase.title : 'use case'}
        />
      }
    >
      {isLoading ? (
        <EntitySheetSkeleton showTabs tabCount={5} fieldCount={5} />
      ) : (
        <EntitySheetTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
      )}
    </EntitySheetShell>
  );
}

// ============================================================================
// OVERVIEW TAB
// ============================================================================

interface OverviewTabProps {
  form: ReturnType<typeof useForm<UseCaseFormValues>>;
}

function OverviewTab({ form }: OverviewTabProps) {
  const [newTag, setNewTag] = React.useState('');

  const handleAddTag = () => {
    if (!newTag.trim()) return;
    const current = form.getValues('tags');
    if (!current.includes(newTag.trim())) {
      form.setValue('tags', [...current, newTag.trim()], { shouldDirty: true });
    }
    setNewTag('');
  };

  const handleRemoveTag = (tag: string) => {
    const current = form.getValues('tags');
    form.setValue(
      'tags',
      current.filter((t) => t !== tag),
      { shouldDirty: true }
    );
  };

  return (
    <Form {...form}>
      <form className="space-y-6">
        {/* Basic Info */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Basic Information</h3>

          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Title *</FormLabel>
                <FormControl>
                  <Input placeholder="Enter use case title" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description *</FormLabel>
                <FormControl>
                  <Textarea placeholder="Describe the use case and its business value..." rows={4} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {USE_CASE_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          <div className="flex items-center gap-2">
                            <div className={cn('h-2 w-2 rounded-full', STATUS_COLORS[status].split(' ')[0])} />
                            {status}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value || ''}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {COMMON_CATEGORIES.map((category) => (
                        <SelectItem key={category} value={category}>
                          {category}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Tags */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Tags</h3>

          <div className="flex flex-wrap gap-2">
            {form.watch('tags').map((tag) => (
              <Badge key={tag} variant="secondary" className="gap-1">
                <Tag className="h-3 w-3" />
                {tag}
                <X className="h-3 w-3 cursor-pointer hover:text-destructive" onClick={() => handleRemoveTag(tag)} />
              </Badge>
            ))}
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Add a tag..."
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddTag();
                }
              }}
            />
            <Button type="button" variant="outline" size="icon" onClick={handleAddTag}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}

// ============================================================================
// PROBLEM & SOLUTION TAB
// ============================================================================

function ProblemSolutionTab({ form }: OverviewTabProps) {
  const [newOutcome, setNewOutcome] = React.useState('');

  const handleAddOutcome = () => {
    if (!newOutcome.trim()) return;
    const current = form.getValues('outcomes');
    form.setValue('outcomes', [...current, newOutcome.trim()], { shouldDirty: true });
    setNewOutcome('');
  };

  const handleRemoveOutcome = (index: number) => {
    const current = form.getValues('outcomes');
    form.setValue(
      'outcomes',
      current.filter((_, i) => i !== index),
      { shouldDirty: true }
    );
  };

  return (
    <Form {...form}>
      <form className="space-y-6">
        {/* Problem */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-red-500" />
            <h3 className="text-sm font-medium">Problem Statement</h3>
          </div>

          <FormField
            control={form.control}
            name="problem"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Textarea
                    placeholder="What problem does this use case address? What pain points exist today?"
                    rows={4}
                    className="border-red-500/20 focus-visible:ring-red-500/30"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Solution */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <h3 className="text-sm font-medium">Proposed Solution</h3>
          </div>

          <FormField
            control={form.control}
            name="solution"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Textarea
                    placeholder="How can this problem be solved? What approach or technology would help?"
                    rows={4}
                    className="border-green-500/20 focus-visible:ring-green-500/30"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Expected Outcomes */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-blue-500" />
            <h3 className="text-sm font-medium">Expected Outcomes</h3>
          </div>

          <div className="space-y-2">
            {form.watch('outcomes').map((outcome, index) => (
              <div key={index} className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3">
                <CheckCircle2 className="h-4 w-4 text-blue-500 shrink-0" />
                <span className="flex-1 text-sm">{outcome}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => handleRemoveOutcome(index)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Add an expected outcome..."
              value={newOutcome}
              onChange={(e) => setNewOutcome(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddOutcome();
                }
              }}
            />
            <Button type="button" variant="outline" size="icon" onClick={handleAddOutcome}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}

// ============================================================================
// CREATE MODE NOTICE
// ============================================================================

/**
 * CreateModeNotice - Friendly notice shown in tabs during entity creation mode.
 * Displayed when features like relations/notes require the entity to be saved first.
 */
function CreateModeNotice({ feature }: { feature: string }) {
  return (
    <div className="py-8 text-center">
      <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
        <Plus className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground">
        {feature.charAt(0).toUpperCase() + feature.slice(1)} will be available after you save.
      </p>
      <p className="text-xs text-muted-foreground/70 mt-1">Fill in the overview details and click Save to continue.</p>
    </div>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { UseCaseSheetProps, UseCaseFormValues };
